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
import { resolveHetznerLocation } from '../drivers/hetzner/config'
import { resolveSiteKind, siteInstallBase } from './site-target'
import { describeSshKeys } from './ssh-config-editor'

const PROBED_SERVICES = ['rpx-gateway', 'nginx', 'php8.3-fpm', 'php8.2-fpm', 'mysql', 'mariadb', 'postgresql', 'redis', 'redis-server', 'meilisearch']
const UNKNOWN = '-'

interface LocalState {
  provider?: string
  serverName?: string
  publicIp?: string
  sshUser?: string
}

interface ProbedService {
  name: string
  status: string
  memBytes?: number
  enabled?: string
  since?: string
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
    `for s in ${PROBED_SERVICES.join(' ')}; do st=$(systemctl is-active "$s" 2>/dev/null); if [ -n "$st" ] && [ "$st" != "inactive" ] && [ "$st" != "unknown" ]; then mem=$(systemctl show "$s" -p MemoryCurrent --value 2>/dev/null); en=$(systemctl is-enabled "$s" 2>/dev/null); since=$(systemctl show "$s" -p ActiveEnterTimestamp --value 2>/dev/null); echo "SVC=$s=$st=$mem=$en=$since"; fi; done`,
    'true',
  ]
}

export function parseBlock(output: string): Record<string, string> & { services: ProbedService[] } {
  const kv: any = { services: [] }
  for (const line of output.split('\n')) {
    const l = line.trim()
    if (l.startsWith('SVC=')) {
      const [, name, status, memBytes, enabled, since] = /^SVC=([^=]+)=([^=]+)(?:=([^=]*)(?:=([^=]*)(?:=(.*))?)?)?$/.exec(l) ?? []
      if (name) {
        kv.services.push({
          name,
          status,
          memBytes: Number(memBytes || 0),
          enabled: enabled || UNKNOWN,
          since: since || UNKNOWN,
        })
      }
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
  // Resolve through the same chain the Hetzner driver uses, so the cockpit
  // cannot report a location the box is not actually in.
  if (configuredProvider(config) === 'hetzner')
    return resolveHetznerLocation(config)

  return config.project.region ?? 'us-east-1'
}

function loadLocalState(config: CloudConfig, environment: EnvironmentType): LocalState | null {
  const statePath = join(process.cwd(), 'storage', 'cloud', 'state', `${config.project.slug}-${environment}.json`)
  if (!existsSync(statePath))
    return null

  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as LocalState
  }
  catch {
    return null
  }
}

function configuredWorkers(config: CloudConfig): Array<{ name: string, site: string, processes: number, status: string }> {
  const sites = config.sites ?? {}
  const workers: Array<{ name: string, site: string, processes: number, status: string }> = []
  for (const [siteName, site] of Object.entries(sites) as Array<[string, any]>) {
    const queues = site.queues ?? site.workers
    if (Array.isArray(queues)) {
      for (const queue of queues) {
        if (typeof queue === 'string')
          workers.push({ name: `${siteName}:${queue}`, site: siteName, processes: 1, status: 'configured' })
        else if (queue?.name)
          workers.push({ name: `${siteName}:${queue.name}`, site: siteName, processes: queue.processes ?? 1, status: 'configured' })
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
  // A redirect ships nothing — label it as such rather than falling through to
  // the 'bucket' default below (resolveSiteKind returns 'redirect' for these).
  if (kind === 'redirect')
    return 'redirect'
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
  if (kind === 'redirect')
    return '—'
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
  if (kind === 'redirect')
    return 'redirect'
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

function deployHistoryScript(siteNames: string[], slug: string): string[] {
  if (siteNames.length === 0)
    return ['true']

  return [
    'set +e',
    ...siteNames.map((siteName) => {
      const historyPath = shellSingleQuote(`${siteInstallBase(slug, siteName)}/.ts-cloud/deploy-history.log`)
      const prefix = sedReplacement(siteName)
      return `TS_CLOUD_HISTORY=${historyPath}; { [ -f "$TS_CLOUD_HISTORY" ] && tail -n 24 "$TS_CLOUD_HISTORY" | sed "s/^/DEPLOY=${prefix}\\t/"; } || true`
    }),
    'true',
  ]
}

function siteDomains(config: CloudConfig): string[] {
  return [...new Set(Object.values(config.sites ?? {})
    .map((site: any) => site.domain)
    .filter((domain): domain is string => typeof domain === 'string' && domain.length > 0))]
}

function securityScript(config: CloudConfig): string[] {
  const domains = siteDomains(config)
  return [
    'set +e',
    'if command -v ss >/dev/null 2>&1; then ss -H -lntup 2>/dev/null | while read -r proto _state _recv _send local _peer rest; do [ -n "$proto" ] && [ -n "$local" ] && printf "PORT=%s\\t%s\\t%s\\n" "$proto" "$local" "$rest"; done; fi',
    'if command -v ufw >/dev/null 2>&1; then ufw status numbered 2>/dev/null | sed "s/^/FIREWALL=/"; else echo "FIREWALL=ufw unavailable"; fi',
    'journalctl _COMM=sshd --no-pager -n 30 -o short-iso 2>/dev/null | sed "s/^/AUTH=/" || true',
    ...domains.map((domain) => {
      const quoted = shellSingleQuote(domain)
      return `TS_CLOUD_DOMAIN=${quoted}; TS_CLOUD_EXPIRY=$(echo | timeout 8 openssl s_client -servername "$TS_CLOUD_DOMAIN" -connect "$TS_CLOUD_DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2-); [ -n "$TS_CLOUD_EXPIRY" ] && printf "CERT=%s\\t%s\\n" "$TS_CLOUD_DOMAIN" "$TS_CLOUD_EXPIRY" || printf "CERT=%s\\tunavailable\\n" "$TS_CLOUD_DOMAIN"`
    }),
    'true',
  ]
}

interface ServerLogSource {
  /** journalctl `-u` pattern (a unit name or a glob like `acme-web-queue-*`). */
  pattern: string
  /** Clean source label shown + filtered on in the UI. */
  label: string
}

/**
 * Every log source on the box: the web server, each managed service, and per
 * server-app site the app service PLUS its queue workers and daemons (collected
 * via journalctl unit globs so all worker instances are covered, not just the
 * main service). Deduped by label.
 */
export function serverLogSources(config: CloudConfig): ServerLogSource[] {
  const byLabel = new Map<string, ServerLogSource>()
  const add = (pattern: string, label: string): void => {
    if (pattern && label && !byLabel.has(label))
      byLabel.set(label, { pattern, label })
  }
  const compute = config.infrastructure?.compute as any
  const slug = config.project.slug

  if (compute?.webServer === 'rpx' || compute?.proxy?.engine === 'rpx')
    add('rpx-gateway', 'rpx-gateway')
  else
    add('nginx', 'nginx')

  for (const svc of configuredServices(config))
    add(svc.name, svc.name)

  for (const [siteName, site] of Object.entries(config.sites ?? {}) as Array<[string, any]>) {
    if (resolveSiteKind(site) !== 'server-app')
      continue
    add(`${slug}-${siteName}`, `${slug}-${siteName}`)
    if (Array.isArray(site.queues ?? site.workers) && (site.queues ?? site.workers).length)
      add(`${slug}-${siteName}-queue-*`, `${slug}-${siteName}-queues`)
    if (Array.isArray(site.daemons) && site.daemons.length)
      add(`${slug}-${siteName}-daemon-*`, `${slug}-${siteName}-daemons`)
  }

  return [...byLabel.values()]
}

function serverLogsScript(config: CloudConfig): string[] {
  const sources = serverLogSources(config)
  if (sources.length === 0)
    return ['true']

  return [
    'set +e',
    // journalctl-backed units (the web server, services, app/workers/daemons).
    ...sources.map((source) => {
      const quoted = shellSingleQuote(source.pattern)
      const prefix = sedReplacement(source.label)
      return `journalctl -u ${quoted} --no-pager -n 150 -o short-iso 2>/dev/null | sed "s/^/LOG=${prefix}\\t/" || true`
    }),
    // The scheduled-backup runner logs to a file, not the journal.
    `[ -f /var/log/ts-cloud-backup.log ] && tail -n 60 /var/log/ts-cloud-backup.log 2>/dev/null | sed "s/^/LOG=backups\\t/" || true`,
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

  return records.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 600)
}

function listenerExposure(listen: string): 'loopback' | 'private' | 'public' {
  if (/^(?:127\.|localhost:|\[?::1\]?)/.test(listen))
    return 'loopback'
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|\[?f[cd][0-9a-f:])/i.test(listen))
    return 'private'
  return 'public'
}

function portTone(listen: string): 'ok' | 'warn' | 'bad' {
  const exposure = listenerExposure(listen)
  if (exposure !== 'public')
    return 'ok'
  if (/:(?:22|80|443)$/.test(listen) || /^\*:(?:22|80|443)$/.test(listen))
    return 'ok'
  return 'warn'
}

function certStatus(daysRemaining: number | null): 'ok' | 'warn' | 'bad' {
  if (daysRemaining == null)
    return 'warn'
  if (daysRemaining < 8)
    return 'bad'
  if (daysRemaining < 30)
    return 'warn'
  return 'ok'
}

export function parseServerSecurity(output: string): Record<string, any> {
  const ports: Array<Record<string, any>> = []
  const firewallLines: string[] = []
  const authEvents: Array<Record<string, any>> = []
  const tlsCertificates: Array<Record<string, any>> = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('PORT=')) {
      const [proto = '', listen = '', process = ''] = line.slice(5).split('\t')
      if (proto && listen) {
        ports.push({
          proto,
          listen,
          processName: process || UNKNOWN,
          exposure: listenerExposure(listen),
          tone: portTone(listen),
        })
      }
    }
    else if (line.startsWith('FIREWALL=')) {
      const value = line.slice(9).trim()
      if (value)
        firewallLines.push(value)
    }
    else if (line.startsWith('AUTH=')) {
      const raw = line.slice(5)
      const match = /^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(\S+)\s+(.*)$/.exec(raw)
      const message = (match?.[3] ?? raw).trim()
      if (message) {
        authEvents.push({
          timestamp: match?.[1] ?? '',
          when: match?.[1] ? relativeTime(match[1]) : UNKNOWN,
          host: match?.[2] ?? '',
          message,
          level: inferLogLevel(message),
        })
      }
    }
    else if (line.startsWith('CERT=')) {
      const [domain = '', expiresRaw = ''] = line.slice(5).split('\t')
      if (!domain)
        continue
      const expiresAt = new Date(expiresRaw)
      const daysRemaining = Number.isNaN(expiresAt.getTime())
        ? null
        : Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000)
      tlsCertificates.push({
        domain,
        expires: Number.isNaN(expiresAt.getTime()) ? expiresRaw || UNKNOWN : expiresAt.toISOString().slice(0, 10),
        daysRemaining,
        status: certStatus(daysRemaining),
      })
    }
  }

  const firewallEnabled = firewallLines.some(line => /Status:\s*active/i.test(line))
  const firewallUnavailable = firewallLines.some(line => /unavailable/i.test(line))
  return {
    ports: ports.slice(0, 80),
    firewall: {
      status: firewallEnabled ? 'active' : (firewallUnavailable ? 'unavailable' : 'inactive'),
      summary: firewallEnabled ? 'ufw active' : (firewallUnavailable ? 'ufw unavailable' : 'ufw inactive or not configured'),
      rules: firewallLines.filter(line => line && !/^Status:/i.test(line)).slice(0, 60),
    },
    tlsCertificates,
    authEvents: authEvents.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 30),
  }
}

function configuredSecurity(config: CloudConfig): Record<string, any> {
  const compute = config.infrastructure?.compute as any
  const firewall = compute?.firewall ?? {}
  const allowedPorts = [...new Set([22, 80, 443, ...(firewall.allowedPorts ?? [])])]
  const domains = siteDomains(config)
  return {
    ports: allowedPorts.map(port => ({
      proto: 'tcp',
      listen: `0.0.0.0:${port}`,
      processName: 'configured firewall',
      exposure: 'public',
      tone: [22, 80, 443].includes(Number(port)) ? 'ok' : 'warn',
    })),
    firewall: {
      status: firewall.enabled === false ? 'disabled' : 'configured',
      summary: firewall.enabled === false ? 'host firewall disabled in config' : 'host firewall configured declaratively',
      rules: allowedPorts.map(port => `ALLOW ${port}/tcp`),
    },
    tlsCertificates: domains.map(domain => ({
      domain,
      expires: UNKNOWN,
      daysRemaining: null,
      status: 'warn',
    })),
    authEvents: [],
  }
}

function diagnosticChecks(config: CloudConfig, data: Record<string, any>): Array<Record<string, any>> {
  const security = data.security ?? configuredSecurity(config)
  const live = !!data._serverReachable && !data.metricsUnavailable
  const sites = data.sites ?? []
  const shadowed = sites.filter((site: any) => site.status === 'shadowed')
  const failedServices = (data.services ?? []).filter((service: any) => ['failed', 'stopped'].includes(service.status))
  const expiringCerts = (security.tlsCertificates ?? []).filter((cert: any) => cert.status !== 'ok')
  const sshKeys = data.sshKeys ?? []

  return [
    {
      name: 'Live server probe',
      status: live ? 'pass' : 'warn',
      detail: live ? 'Metrics and remote checks are coming from the compute box.' : 'The dashboard is rendering config/state data until the box probe succeeds.',
    },
    {
      name: 'Managed services',
      status: failedServices.length ? 'fail' : 'pass',
      detail: failedServices.length ? `${failedServices.length} service(s) need attention.` : `${(data.services ?? []).length} service(s) reported healthy or configured.`,
    },
    {
      name: 'Route conflicts',
      status: shadowed.length ? 'warn' : 'pass',
      detail: shadowed.length ? `${shadowed.map((site: any) => site.name).join(', ')} is shadowed by an earlier route.` : `${sites.length} site route(s) are unshadowed.`,
    },
    {
      name: 'SSH access',
      status: sshKeys.length ? 'pass' : 'warn',
      detail: sshKeys.length ? `${sshKeys.length} declarative authorized key(s) configured.` : 'No declarative SSH keys are configured.',
    },
    {
      name: 'Firewall',
      status: ['active', 'configured'].includes(security.firewall?.status) ? 'pass' : 'warn',
      detail: security.firewall?.summary ?? 'Firewall status unavailable.',
    },
    {
      name: 'TLS certificates',
      status: expiringCerts.length ? 'warn' : 'pass',
      detail: expiringCerts.length ? `${expiringCerts.length} certificate(s) need renewal visibility.` : `${(security.tlsCertificates ?? []).length} certificate(s) look healthy.`,
    },
  ]
}

function activityFeed(data: Record<string, any>): Array<Record<string, any>> {
  const activity: Array<Record<string, any>> = []
  for (const deploy of data.serverDeploymentsDetail ?? data.serverDeployments ?? []) {
    activity.push({
      type: 'deploy',
      tone: deploy.status === 'failed' ? 'bad' : 'ok',
      title: `${deploy.site} deployed ${deploy.sha}`,
      detail: `${deploy.branch} · ${deploy.status}`,
      when: deploy.when,
      timestamp: deploy.timestamp,
    })
  }
  for (const log of data.serverLogs ?? []) {
    if (log.level === 'error' || log.level === 'warn') {
      activity.push({
        type: 'log',
        tone: log.level === 'error' ? 'bad' : 'warn',
        title: `${log.source} ${log.level}`,
        detail: log.message,
        when: log.when,
        timestamp: log.timestamp,
      })
    }
  }
  for (const key of data.sshKeys ?? []) {
    activity.push({
      type: 'ssh',
      tone: 'ok',
      title: `${key.name} authorized`,
      detail: key.fingerprint,
      when: key.added ?? UNKNOWN,
      timestamp: '',
    })
  }
  return activity
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 80)
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
  const out: Record<string, any> = {
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
    security: configuredSecurity(config),
    securityEmptyReason: 'Live security checks are unavailable until the dashboard can reach the compute box.',
    sites,
    sitesDetail: sites.map((s) => {
      const site = (config.sites as any)?.[s.name] ?? {}
      const kind = resolveSiteKind(site)
      return {
        ...s,
        root: kind === 'server-static' ? siteInstallBase(config.project.slug, s.name) : `${siteInstallBase(config.project.slug, s.name)}/current`,
        branch: kind === 'server-static' ? 'build artifact' : 'main',
        build: site.build,
        php: site.php ?? site.phpVersion,
        aliases: Array.isArray(site.aliases) ? site.aliases : [],
        redirects: site.redirects && typeof site.redirects === 'object' ? site.redirects : {},
        envKeys: Object.keys(site.env ?? site.environment ?? {}),
      }
    }),
    sshKeys: describeSshKeys((config.infrastructure?.compute as any)?.sshKeys ?? []),
    _serverReachable: false,
    _metricsStatus: 'unavailable',
  }
  out.diagnostics = diagnosticChecks(config, out)
  out.activity = activityFeed(out)
  return out
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
      out.servicesDetail = parsed.services.map(s => ({
        name: s.name,
        status: s.status === 'active' ? 'running' : s.status,
        since: s.since && s.since !== UNKNOWN ? s.since : out.server.uptime,
        memMb: Math.max(0, Math.round(Number(s.memBytes ?? 0) / 1024 / 1024)),
        auto: s.enabled ? !['disabled', 'static', 'masked'].includes(s.enabled) : true,
      }))
    }
  }

  if (driver && targets.length) {
    try {
      const siteNames = Object.keys(config.sites ?? {})
      const historyResult = await driver.runRemoteDeploy({
        targets: [targets[0]],
        commands: deployHistoryScript(siteNames, config.project.slug),
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

  if (driver && targets.length) {
    try {
      const securityResult = await driver.runRemoteDeploy({
        targets: [targets[0]],
        commands: securityScript(config),
        comment: `ts-cloud dashboard:security ${config.project.slug}`,
        tags: { Project: config.project.slug, Environment: environment, Role: 'app' },
      })
      const securityOutput = securityResult.perInstance?.[0]?.output ?? ''
      const liveSecurity = parseServerSecurity(securityOutput)
      const declaredSecurity = configuredSecurity(config)
      if (!liveSecurity.ports.length)
        liveSecurity.ports = declaredSecurity.ports
      if (!liveSecurity.tlsCertificates.length)
        liveSecurity.tlsCertificates = declaredSecurity.tlsCertificates
      out.security = liveSecurity
      out.securityEmptyReason = undefined
    }
    catch {
      out.securityEmptyReason = 'Server security checks could not be read from the box.'
    }
  }

  // Sites + SSH keys are declarative — derive from config (no box needed).
  const sshKeys = (config.infrastructure?.compute as any)?.sshKeys ?? (config.infrastructure as any)?.ssh?.keys ?? (config.infrastructure as any)?.sshKeys
  if (Array.isArray(sshKeys) && sshKeys.length) {
    out.sshKeys = describeSshKeys(sshKeys)
  }

  out._serverReachable = instanceCount > 0 && !!parsed
  out.diagnostics = diagnosticChecks(config, out)
  out.activity = activityFeed(out)
  return out
}
