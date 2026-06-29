/**
 * Resolve REAL server-dashboard data for a provisioned compute box. Runs a small
 * metrics script over the active driver (SSM/SSH), parses the KEY=VALUE output,
 * and derives sites/SSH/workers from the cloud config. Everything is best-effort:
 * if no box is reachable it returns null and the dashboard renders sample data.
 */

import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { createCloudDriver } from '../drivers'
import { resolveSiteKind } from './site-target'

const PROBED_SERVICES = ['nginx', 'php8.3-fpm', 'php8.2-fpm', 'mysql', 'mariadb', 'postgresql', 'redis', 'redis-server', 'meilisearch']
const UNKNOWN = '-'

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

export function resolveConfigOnlyServerDashboardData(config: CloudConfig, environment: EnvironmentType): Record<string, any> {
  const services = configuredServices(config)
  const sites = configuredSites(config)
  return {
    server: {
      name: `${config.project.slug}-${environment}-app`,
      provider: (config.infrastructure?.compute as any)?.provider ?? (config.cloud as any)?.provider ?? 'aws',
      region: config.project.region ?? 'us-east-1',
      ip: UNKNOWN,
      os: 'Linux',
      uptime: UNKNOWN,
    },
    systemMetrics: {
      load: 0,
      cpus: Math.max(1, Number((config.infrastructure?.compute as any)?.instances ?? 1)),
      memUsedMb: 0,
      memTotalMb: 1,
      diskUsedPct: 0,
      diskUsedGb: 0,
      diskTotalGb: Math.max(1, Number((config.infrastructure?.compute as any)?.disk?.size ?? 1)),
    },
    services,
    servicesDetail: services.map(s => ({ ...s, since: UNKNOWN, memMb: 0, auto: true })),
    backup: configuredBackup(config),
    backupHistory: [],
    workers: configuredWorkers(config),
    serverScheduler: { enabled: false, lastRun: 'not configured' },
    serverDeployments: [],
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
  if (driver) try {
    const targets = await driver.findComputeTargets({ slug: config.project.slug, environment, role: 'app' })
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

  // Sites + SSH keys are declarative — derive from config (no box needed).
  const sshKeys = (config.infrastructure as any)?.ssh?.keys ?? (config.infrastructure as any)?.sshKeys
  if (Array.isArray(sshKeys) && sshKeys.length) {
    out.sshKeys = sshKeys.map((k: any, i: number) => ({ name: k.name ?? `key-${i + 1}`, fingerprint: UNKNOWN, type: 'ssh', added: UNKNOWN }))
  }

  out._serverReachable = instanceCount > 0 && !!parsed
  return out
}
