/**
 * Resolve REAL server-dashboard data for a provisioned compute box. Runs a small
 * metrics script over the active driver (SSM/SSH), parses the KEY=VALUE output,
 * and derives sites/SSH/workers from the cloud config. Everything is best-effort:
 * if no box is reachable it returns config-derived data marked unavailable.
 */

import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCloudDriver } from '../drivers'
import { resolveSiteKind } from './site-target'
import { describeSshKeys } from './ssh-config-editor'

const PROBED_SERVICES = ['nginx', 'php8.3-fpm', 'php8.2-fpm', 'mysql', 'mariadb', 'postgresql', 'redis', 'redis-server', 'meilisearch']
const UNKNOWN = '-'

interface LocalState {
  provider?: string
  serverName?: string
  publicIp?: string
  sshUser?: string
}

/** Shell script that emits a parseable metrics block (no jq/printf-JSON needed). */
function metricsScript(): string[] {
  return [
    'set +e',
    'echo "CPUS=$(nproc 2>/dev/null || echo 1)"',
    'echo "LOAD=$(cut -d\' \' -f1 /proc/loadavg 2>/dev/null || echo 0)"',
    'echo "MEMTOTAL=$(free -m 2>/dev/null | awk \'/^Mem:/{print $2}\')"',
    'echo "MEMUSED=$(free -m 2>/dev/null | awk \'/^Mem:/{print $3}\')"',
    'echo "DISKPCT=$(df -P / 2>/dev/null | awk \'NR==2{gsub("%","",$5);print $5}\')"',
    'echo "DISKUSEDG=$(df -BG / 2>/dev/null | awk \'NR==2{gsub("G","",$3);print $3}\')"',
    'echo "DISKTOTG=$(df -BG / 2>/dev/null | awk \'NR==2{gsub("G","",$2);print $2}\')"',
    'echo "UPTIME=$(uptime -p 2>/dev/null | sed \'s/^up //\' || echo unknown)"',
    'echo "OS=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"',
    `for s in ${PROBED_SERVICES.join(' ')}; do st=$(systemctl is-active "$s" 2>/dev/null); [ -n "$st" ] && [ "$st" != "inactive" ] && [ "$st" != "unknown" ] && echo "SVC=$s=$st"; done`,
    'true',
  ]
}

export function parseBlock(output: string): Record<string, string> & { services: Array<{ name: string, status: string }> } {
  const kv: any = { services: [] }
  for (const line of output.split('\n')) {
    const l = line.trim()
    if (l.startsWith('SVC=')) {
      const [, name, status] = /^SVC=([^=]+)=(.+)$/.exec(l) ?? []
      if (name) kv.services.push({ name, status })
    }
    else {
      const eq = l.indexOf('=')
      if (eq > 0) kv[l.slice(0, eq)] = l.slice(eq + 1)
    }
  }
  return kv
}

function configuredServices(config: CloudConfig): Array<{ name: string, status: string }> {
  const compute = config.infrastructure?.compute as any
  const services: Array<{ name: string, status: string }> = []

  if (compute?.webServer === 'rpx' || compute?.proxy?.engine === 'rpx')
    services.push({ name: 'rpx-gateway', status: 'configured' })
  else if (compute?.webServer === 'nginx' || compute?.webServer == null)
    services.push({ name: 'ts-cloud-nginx', status: 'configured' })

  const phpVersions = compute?.php?.versions ?? (compute?.runtime === 'php' ? ['8.3'] : [])
  for (const version of phpVersions)
    services.push({ name: `php${version}-fpm`, status: 'configured' })

  const managed = compute?.managedServices ?? {}
  const serviceNames: Array<[string, string]> = [
    ['mysql', 'mysql'],
    ['mariadb', 'mariadb'],
    ['postgres', 'postgresql'],
    ['redis', 'redis'],
    ['memcached', 'memcached'],
    ['meilisearch', 'meilisearch'],
  ]
  for (const [key, name] of serviceNames) {
    if (managed[key])
      services.push({ name, status: 'configured' })
  }

  return services
}

function configuredBackup(config: CloudConfig): Record<string, any> {
  const backup = (config.infrastructure?.compute as any)?.backups
  const enabled = !!backup?.enabled
  const schedule = backup?.schedule ?? '0 2 * * *'
  return {
    enabled,
    schedule,
    destination: enabled ? (backup?.bucket ?? 'local') : 'off',
    retention: enabled ? (backup?.retentionCount ?? 5) : 0,
    last: enabled ? 'pending first run' : 'not configured',
    size: enabled ? UNKNOWN : '0 MB',
  }
}

function configuredProvider(config: CloudConfig): string {
  return (config.infrastructure?.compute as any)?.provider
    ?? (config.cloud as any)?.provider
    ?? (config as any).provider
    ?? 'aws'
}

function configuredRegion(config: CloudConfig): string {
  const provider = configuredProvider(config)
  if (provider === 'hetzner') {
    return (config.hetzner as any)?.location
      ?? process.env.HCLOUD_LOCATION
      ?? process.env.HETZNER_LOCATION
      ?? 'fsn1'
  }

  return config.project.region ?? 'us-east-1'
}

function loadLocalState(config: CloudConfig, environment: EnvironmentType): LocalState | null {
  const statePath = join(process.cwd(), '.ts-cloud', 'state', `${config.project.slug}-${environment}.json`)
  if (!existsSync(statePath))
    return null

  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as LocalState
  }
  catch {
    return null
  }
}

function configuredWorkers(config: CloudConfig): Array<{ name: string, processes: number, status: string }> {
  const sites = config.sites ?? {}
  const workers: Array<{ name: string, processes: number, status: string }> = []
  for (const [siteName, site] of Object.entries(sites) as Array<[string, any]>) {
    const queues = site.queues ?? site.workers
    if (Array.isArray(queues)) {
      for (const queue of queues) {
        if (typeof queue === 'string')
          workers.push({ name: `${siteName}:${queue}`, processes: 1, status: 'configured' })
        else if (queue?.name)
          workers.push({ name: `${siteName}:${queue.name}`, processes: queue.processes ?? 1, status: 'configured' })
      }
    }
  }
  return workers
}

function normalizeSitePath(path: string | undefined): string {
  if (!path || path === '')
    return '/'
  return path.startsWith('/') ? path : `/${path}`
}

function siteRoute(site: any): { route: string, href?: string } {
  const path = normalizeSitePath(site.path)
  if (!site.domain)
    return { route: 'internal' }
  return {
    route: path === '/' ? site.domain : `${site.domain}${path}`,
    href: `https://${site.domain}${path === '/' ? '' : path}`,
  }
}

function siteKindLabel(name: string, site: any): string {
  const kind = resolveSiteKind(site)
  const build = String(site.build ?? '').toLowerCase()
  const start = String(site.start ?? '').toLowerCase()
  if (name === 'main' || start.includes('buddy/src/cli.ts serve'))
    return 'stacks'
  if (name === 'api' || start.includes('/serve/api'))
    return 'api'
  if (build.includes('buildblog'))
    return 'bunpress blog'
  if (build.includes('bunpress'))
    return 'bunpress'
  if (build.includes('site:build') || build.includes('stx'))
    return 'stx static'
  if (kind === 'server-static')
    return site.spa ? 'spa' : 'static'
  if (kind === 'server-app')
    return 'app'
  if (kind === 'server-php')
    return site.type ?? 'php'
  return 'bucket'
}

function siteRuntime(site: any): string {
  const kind = resolveSiteKind(site)
  const command = `${site.start ?? ''} ${site.build ?? ''}`.toLowerCase()
  if (kind === 'server-static')
    return command.includes('bunpress') || command.includes('bun ') || command.includes('bunx ') ? 'static/bun' : 'static'
  if (kind === 'server-app')
    return command.includes('bun') ? 'bun' : 'node'
  if (kind === 'server-php')
    return `php ${site.php ?? site.phpVersion ?? '8.3'}`
  return 'static'
}

function siteDeployLabel(site: any): string {
  const kind = resolveSiteKind(site)
  if (kind === 'server-app')
    return 'service'
  if (kind === 'server-static')
    return 'server static'
  if (kind === 'server-php')
    return 'php release'
  return 'bucket'
}

function configuredSites(config: CloudConfig): Array<Record<string, any>> {
  const seenRoutes = new Map<string, string>()
  return Object.entries(config.sites ?? {}).map(([name, site]: [string, any]) => {
    const path = normalizeSitePath(site.path)
    const { route, href } = siteRoute(site)
    const routeKey = site.domain ? `${site.domain}${path}` : ''
    const shadowedBy = routeKey ? seenRoutes.get(routeKey) : undefined
    if (routeKey && !shadowedBy)
      seenRoutes.set(routeKey, name)

    return {
      name,
      route,
      href,
      domain: site.domain ?? 'internal',
      path,
      kind: siteKindLabel(name, site),
      type: siteKindLabel(name, site),
      runtime: siteRuntime(site),
      deploy: siteDeployLabel(site),
      tls: site.domain ? (site.ssl === false ? 'http' : 'https') : 'loopback',
      ssl: site.domain ? site.ssl !== false : false,
      status: shadowedBy ? 'shadowed' : 'live',
      shadowedBy,
      lastDeploy: UNKNOWN,
    }
  })
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

function sedReplacement(value: string): string {
  return value.replace(/[\\&/]/g, '\\$&')
}

function deployHistoryScript(siteNames: string[]): string[] {
  if (siteNames.length === 0)
    return ['true']

  return [
    'set +e',
    ...siteNames.map((siteName) => {
      const historyPath = shellSingleQuote(`/var/www/${siteName}/.ts-cloud/deploy-history.log`)
      const prefix = sedReplacement(siteName)
      return `TS_CLOUD_HISTORY=${historyPath}; { [ -f "$TS_CLOUD_HISTORY" ] && tail -n 24 "$TS_CLOUD_HISTORY" | sed "s/^/DEPLOY=${prefix}\\t/"; } || true`
    }),
    'true',
  ]
}

function serverLogUnits(config: CloudConfig): string[] {
  const units = new Set<string>()
  const compute = config.infrastructure?.compute as any

  if (compute?.webServer === 'rpx' || compute?.proxy?.engine === 'rpx')
    units.add('rpx-gateway')
  else
    units.add('nginx')

  for (const svc of configuredServices(config))
    units.add(svc.name)

  for (const [siteName, site] of Object.entries(config.sites ?? {}) as Array<[string, any]>) {
    if (resolveSiteKind(site) === 'server-app')
      units.add(`${config.project.slug}-${siteName}`)
  }

  return [...units].filter(Boolean)
}

function serverLogsScript(config: CloudConfig): string[] {
  const units = serverLogUnits(config)
  if (units.length === 0)
    return ['true']

  return [
    'set +e',
    ...units.map((unit) => {
      const quoted = shellSingleQuote(unit)
      const prefix = sedReplacement(unit)
      return `journalctl -u ${quoted} --no-pager -n 80 -o short-iso 2>/dev/null | sed "s/^/LOG=${prefix}\\t/" || true`
    }),
    'true',
  ]
}

function relativeTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return iso || UNKNOWN
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000))
  if (seconds < 60)
    return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48)
    return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function inferLogLevel(message: string): 'error' | 'warn' | 'info' {
  if (/(?:error|failed|panic|fatal|exception|denied|unhealthy)/i.test(message))
    return 'error'
  if (/(?:warn|warning|retry|restart|deprecated|timeout)/i.test(message))
    return 'warn'
  return 'info'
}

export function parseServerLogs(output: string): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('LOG='))
      continue

    const tab = line.indexOf('\t')
    if (tab < 0)
      continue

    const source = line.slice(4, tab)
    const raw = line.slice(tab + 1)
    const match = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(\S+)\s+(.*)$/.exec(raw)
    const timestamp = match?.[1] ?? ''
    const host = match?.[2] ?? ''
    const message = (match?.[3] ?? raw).trim()
    if (!message)
      continue

    records.push({
      source,
      timestamp,
      when: timestamp ? relativeTime(timestamp) : UNKNOWN,
      host,
      message,
      level: inferLogLevel(message),
    })
  }

  return records.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 240)
}

export function parseDeployHistory(output: string, sites: Record<string, any> = {}): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('DEPLOY='))
      continue

    const parts = line.split('\t')
    const site = parts[0]?.replace(/^DEPLOY=/, '') ?? ''
    const [timestamp, releaseId, commit, status, rcPart] = parts.slice(1)
    if (!site || !timestamp || !releaseId)
      continue

    const siteConfig = sites[site] ?? {}
    const kind = resolveSiteKind(siteConfig)
    const sha = (commit || releaseId).slice(0, 7)
    records.push({
      sha,
      release: releaseId,
      commit: commit || releaseId,
      site,
      branch: siteConfig.branch ?? (kind === 'server-static' ? 'build artifact' : 'main'),
      status: status || 'unknown',
      when: relativeTime(timestamp),
      timestamp,
      took: '-',
      by: 'ts-cloud',
      rc: rcPart?.replace(/^rc=/, '') ?? '',
      steps: kind === 'server-static'
        ? ['upload artifact', 'publish static files']
        : ['upload artifact', 'restart service'],
    })
  }

  return records.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
}

export function resolveConfigOnlyServerDashboardData(config: CloudConfig, environment: EnvironmentType): Record<string, any> {
  const state = loadLocalState(config, environment)
  const services = configuredServices(config)
  const sites = configuredSites(config)
  const diskSize = Math.max(1, Number((config.infrastructure?.compute as any)?.disk?.size ?? 1))
  return {
    server: {
      name: state?.serverName ?? `${config.project.slug}-${environment}-app`,
      provider: state?.provider ?? configuredProvider(config),
      region: configuredRegion(config),
      ip: state?.publicIp ?? UNKNOWN,
      os: 'Linux',
      uptime: UNKNOWN,
      probeStatus: 'unavailable',
    },
    systemMetrics: {
      load: 0,
      cpus: Math.max(1, Number((config.infrastructure?.compute as any)?.instances ?? 1)),
      memUsedMb: 0,
      memTotalMb: 0,
      diskUsedPct: 0,
      diskUsedGb: 0,
      diskTotalGb: diskSize,
    },
    metricsUnavailable: true,
    services,
    servicesDetail: services.map(s => ({ ...s, since: UNKNOWN, memMb: 0, auto: true })),
    backup: configuredBackup(config),
    backupHistory: [],
    workers: configuredWorkers(config),
    serverScheduler: { enabled: false, lastRun: 'not configured' },
    serverDeployments: [],
    serverDeploymentsDetail: [],
    deploymentsEmptyReason: 'No deployment history has been recorded yet. Future server deploys will write /var/www/<site>/.ts-cloud/deploy-history.log.',
    serverLogs: [],
    serverLogsEmptyReason: 'Live server logs are unavailable until the dashboard can reach the compute box.',
    sites,
    sitesDetail: sites.map((s) => {
      const site = (config.sites as any)?.[s.name] ?? {}
      const kind = resolveSiteKind(site)
      return {
        ...s,
        root: kind === 'server-static' ? `/var/www/${s.name}` : `/var/www/${s.name}/current`,
        branch: kind === 'server-static' ? 'build artifact' : 'main',
        build: site.build,
      }
    }),
    sshKeys: describeSshKeys((config.infrastructure?.compute as any)?.sshKeys ?? []),
    _serverReachable: false,
    _metricsStatus: 'unavailable',
  }
}

export async function resolveServerDashboardData(config: CloudConfig, environment: EnvironmentType): Promise<Record<string, any> | null> {
  if (!config.infrastructure?.compute) return null
  let driver: ReturnType<typeof createCloudDriver> | null = null
  try {
    driver = createCloudDriver({ config })
  }
  catch {
    driver = null
  }

  let parsed: ReturnType<typeof parseBlock> | null = null
  let instanceCount = 0
  let targets: any[] = []
  if (driver) try {
    targets = await driver.findComputeTargets({ slug: config.project.slug, environment, role: 'app' })
    instanceCount = targets.length
    if (targets.length) {
      const result = await driver.runRemoteDeploy({
        targets: [targets[0]],
        commands: metricsScript(),
        comment: `ts-cloud dashboard:build ${config.project.slug}`,
        tags: { Project: config.project.slug, Environment: environment, Role: 'app' },
      })
      const output = result.perInstance?.[0]?.output
      if (output) parsed = parseBlock(output)
    }
  }
  catch {
    /* box unreachable — fall through to config-only data */
  }

  const out: Record<string, any> = resolveConfigOnlyServerDashboardData(config, environment)
  const num = (v: string | undefined, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d }

  out.server.os = parsed?.OS || out.server.os
  out.server.uptime = parsed?.UPTIME || out.server.uptime
  if (parsed) {
    out.server.probeStatus = 'live'
    out.metricsUnavailable = false
    out._metricsStatus = 'live'
    out.systemMetrics = {
      load: num(parsed.LOAD), cpus: num(parsed.CPUS, 1),
      memUsedMb: num(parsed.MEMUSED), memTotalMb: num(parsed.MEMTOTAL, 1),
      diskUsedPct: num(parsed.DISKPCT), diskUsedGb: num(parsed.DISKUSEDG), diskTotalGb: num(parsed.DISKTOTG, 1),
    }
    if (parsed.services.length) {
      out.services = parsed.services.map(s => ({ name: s.name, status: s.status === 'active' ? 'running' : s.status }))
      out.servicesDetail = parsed.services.map(s => ({ name: s.name, status: s.status === 'active' ? 'running' : s.status, since: out.server.uptime, memMb: 0, auto: true }))
    }
  }

  if (driver && targets.length) {
    try {
      const siteNames = Object.keys(config.sites ?? {})
      const historyResult = await driver.runRemoteDeploy({
        targets: [targets[0]],
        commands: deployHistoryScript(siteNames),
        comment: `ts-cloud dashboard:deploy-history ${config.project.slug}`,
        tags: { Project: config.project.slug, Environment: environment, Role: 'app' },
      })
      const historyOutput = historyResult.perInstance?.[0]?.output ?? ''
      const records = parseDeployHistory(historyOutput, config.sites as any)
      out.serverDeployments = records.slice(0, 5)
      out.serverDeploymentsDetail = records.slice(0, 50)
      out.deploymentsEmptyReason = records.length
        ? undefined
        : 'No deployment history was found on the server yet. Deploy again to populate this timeline.'
    }
    catch {
      out.deploymentsEmptyReason = 'Deployment history could not be read from the server.'
    }
  }
  else if (driver && instanceCount === 0) {
    out.deploymentsEmptyReason = 'No app server target was found for this environment.'
  }

  if (driver && targets.length) {
    try {
      const logsResult = await driver.runRemoteDeploy({
        targets: [targets[0]],
        commands: serverLogsScript(config),
        comment: `ts-cloud dashboard:server-logs ${config.project.slug}`,
        tags: { Project: config.project.slug, Environment: environment, Role: 'app' },
      })
      const logsOutput = logsResult.perInstance?.[0]?.output ?? ''
      const records = parseServerLogs(logsOutput)
      out.serverLogs = records
      out.serverLogsEmptyReason = records.length
        ? undefined
        : 'No recent journal entries were found for the managed server units.'
    }
    catch {
      out.serverLogsEmptyReason = 'Server logs could not be read from the box.'
    }
  }

  // Sites + SSH keys are declarative — derive from config (no box needed).
  const sshKeys = (config.infrastructure?.compute as any)?.sshKeys ?? (config.infrastructure as any)?.ssh?.keys ?? (config.infrastructure as any)?.sshKeys
  if (Array.isArray(sshKeys) && sshKeys.length) {
    out.sshKeys = describeSshKeys(sshKeys)
  }

  out._serverReachable = instanceCount > 0 && !!parsed
  return out
}
