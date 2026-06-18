/**
 * Resolve REAL server-dashboard data for a provisioned compute box. Runs a small
 * metrics script over the active driver (SSM/SSH), parses the KEY=VALUE output,
 * and derives sites/SSH/workers from the cloud config. Everything is best-effort:
 * if no box is reachable it returns null and the dashboard renders sample data.
 */

import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { createCloudDriver } from '../drivers'

const PROBED_SERVICES = ['nginx', 'php8.3-fpm', 'php8.2-fpm', 'mysql', 'mariadb', 'postgresql', 'redis', 'redis-server', 'meilisearch']

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

export async function resolveServerDashboardData(config: CloudConfig, environment: EnvironmentType): Promise<Record<string, any> | null> {
  if (!config.infrastructure?.compute) return null
  let driver: ReturnType<typeof createCloudDriver>
  try {
    driver = createCloudDriver({ config })
  }
  catch {
    return null
  }

  let parsed: ReturnType<typeof parseBlock> | null = null
  let instanceCount = 0
  try {
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

  const out: Record<string, any> = {}
  const num = (v: string | undefined, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d }

  out.server = {
    name: `${config.project.slug}-${environment}-app`,
    provider: (config.infrastructure?.compute as any)?.provider ?? 'aws',
    region: config.project.region ?? 'us-east-1',
    ip: '—',
    os: parsed?.OS || 'Linux',
    uptime: parsed?.UPTIME || '—',
  }
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
  if (config.sites) {
    const sites = Object.entries(config.sites).map(([name, s]: [string, any]) => ({
      name, domain: s.domain ?? '—', type: s.type ?? (s.static ? 'static' : 'laravel'),
      php: s.php ?? s.phpVersion ?? '8.3', ssl: s.ssl !== false, status: 'live', lastDeploy: '—',
    }))
    if (sites.length) {
      out.sites = sites
      out.sitesDetail = sites.map(s => ({ ...s, root: `/var/www/${s.name}/current`, branch: 'main' }))
    }
  }
  const sshKeys = (config.infrastructure as any)?.ssh?.keys ?? (config.infrastructure as any)?.sshKeys
  if (Array.isArray(sshKeys) && sshKeys.length) {
    out.sshKeys = sshKeys.map((k: any, i: number) => ({ name: k.name ?? `key-${i + 1}`, fingerprint: '—', type: 'ssh', added: '—' }))
  }

  out._serverReachable = instanceCount > 0 && !!parsed
  return out
}
