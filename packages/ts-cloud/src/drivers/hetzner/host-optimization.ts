import type { CloudConfig } from '@ts-cloud/core'
import type { RemoteExecOptions } from '../shared/remote-exec'
import type { HetznerResizeManifest } from './resize-remote'
import { buildAutoUpdatesScript } from '../shared/maintenance'
import { buildMonitoringScript } from '../shared/monitoring'
import { sshExecOrThrow } from '../shared/remote-exec'
import { usesRpxProxy } from '../shared/rpx-gateway'
import { buildUfwScript } from '../shared/ufw'

export interface HetznerHostOptimizationPlan {
  firewallPorts: number[]
  monitoring: boolean
  autoUpdates: boolean
  swapGb: number
  sshPasswordAuthentication: false
  journalMaxUse: string
  journalRetention: string
}

export interface HetznerHostOptimizationReport {
  firewallActive: boolean
  firewallPorts: number[]
  passwordAuthentication: boolean
  rootPasswordLogin: boolean
  fail2banActive: boolean
  unattendedUpgradesActive: boolean
  metricsTimerActive: boolean
  metricsSnapshotFresh: boolean
  swapBytes: number
  journalBytes: number
  failedUnits: string[]
  publicTcpPorts: number[]
}

export interface HetznerHostOptimizationOptions extends RemoteExecOptions {
  host: string
}

export interface HetznerHostContinuityFailures {
  stoppedServices: string[]
  changedRouteFragments: string[]
  missingRouteIds: string[]
  changedReleaseLinks: string[]
  missingData: string[]
}

function entryName(value: string): string {
  return value.split('=', 1)[0] ?? value
}

function serviceWorkload(value: string): string {
  return value.replace(/@[^.]+(?=\.service$)/, '')
}

/**
 * Compare workload identities rather than immutable release values.
 *
 * Host optimization does not stop application services, but a normal deploy
 * may finish while its package installs and system services are being
 * reconciled. In that case `api@old.service` becoming `api@new.service`, a
 * `current` link advancing, or a route fragment being atomically rewritten is
 * healthy continuity, not loss. Exact route IDs and data catalog entries still
 * have to survive, and a workload with no replacement still fails closed.
 */
export function verifyHetznerHostContinuity(
  before: HetznerResizeManifest,
  after: HetznerResizeManifest,
): HetznerHostContinuityFailures {
  const services = new Set(after.runningServices.map(serviceWorkload))
  const routeFragments = new Set(after.routeFragments.map(entryName))
  const releaseLinks = new Set(after.releaseLinks.map(entryName))
  const routeIds = new Set(after.routeIds)
  const data = new Set(after.dataCatalog)

  return {
    stoppedServices: before.runningServices.filter(service => !services.has(serviceWorkload(service))),
    changedRouteFragments: before.routeFragments.filter(fragment => !routeFragments.has(entryName(fragment))),
    missingRouteIds: before.routeIds.filter(route => !routeIds.has(route)),
    changedReleaseLinks: before.releaseLinks.filter(link => !releaseLinks.has(entryName(link))),
    missingData: before.dataCatalog.filter(value => !data.has(value)),
  }
}

function computeConfig(config: CloudConfig) {
  return config.infrastructure?.compute ?? {}
}

export function resolveHetznerHostOptimizationPlan(config: CloudConfig): HetznerHostOptimizationPlan {
  const compute = computeConfig(config)
  const monitoring = compute.monitoring
  const firewallPorts = [...new Set([22, 80, 443, ...(compute.firewall?.allowedPorts ?? [])])]
    .filter(port => Number.isInteger(port) && port >= 1 && port <= 65535)
    .sort((a, b) => a - b)

  return {
    firewallPorts,
    monitoring: monitoring !== false && (typeof monitoring !== 'object' || monitoring.enabled !== false),
    autoUpdates: compute.autoUpdates !== false,
    swapGb: Math.max(0, Math.floor(compute.swapGb ?? 2)),
    sshPasswordAuthentication: false,
    journalMaxUse: '256M',
    journalRetention: '14day',
  }
}

function hardeningScript(plan: HetznerHostOptimizationPlan): string[] {
  return [
    'install -d -m 0755 /etc/ssh/sshd_config.d /etc/systemd/journald.conf.d /etc/sysctl.d /etc/fail2ban/jail.d',
    `cat > /etc/ssh/sshd_config.d/99-ts-cloud-hardening.conf <<'TS_CLOUD_SSH_EOF'`,
    '# Managed by ts-cloud host optimization.',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitRootLogin prohibit-password',
    'MaxAuthTries 4',
    'LoginGraceTime 30',
    'TS_CLOUD_SSH_EOF',
    'sshd -t',
    'systemctl reload ssh',
    `cat > /etc/systemd/journald.conf.d/99-ts-cloud-retention.conf <<'TS_CLOUD_JOURNAL_EOF'`,
    '[Journal]',
    `SystemMaxUse=${plan.journalMaxUse}`,
    `MaxRetentionSec=${plan.journalRetention}`,
    'Compress=yes',
    'TS_CLOUD_JOURNAL_EOF',
    'systemctl restart systemd-journald',
    'journalctl --vacuum-size=256M --vacuum-time=14d >/dev/null',
    `cat > /etc/sysctl.d/99-ts-cloud-production.conf <<'TS_CLOUD_SYSCTL_EOF'`,
    '# Managed by ts-cloud host optimization.',
    'vm.swappiness=10',
    'vm.dirty_background_ratio=5',
    'vm.dirty_ratio=15',
    'net.core.somaxconn=4096',
    'net.ipv4.tcp_max_syn_backlog=4096',
    'net.ipv4.tcp_fin_timeout=30',
    'net.ipv4.tcp_keepalive_time=300',
    'net.ipv4.tcp_keepalive_intvl=30',
    'net.ipv4.tcp_keepalive_probes=5',
    'fs.inotify.max_user_watches=524288',
    'TS_CLOUD_SYSCTL_EOF',
    'sysctl --system >/dev/null',
    'export DEBIAN_FRONTEND=noninteractive',
    'command -v fail2ban-client >/dev/null 2>&1 || apt-get install -y fail2ban',
    `cat > /etc/fail2ban/jail.d/99-ts-cloud-sshd.conf <<'TS_CLOUD_FAIL2BAN_EOF'`,
    '[sshd]',
    'enabled = true',
    'backend = systemd',
    'bantime = 1h',
    'findtime = 10m',
    'maxretry = 5',
    'TS_CLOUD_FAIL2BAN_EOF',
    'systemctl enable --now fail2ban',
    'systemctl restart fail2ban',
  ]
}

function swapScript(sizeGb: number): string[] {
  if (sizeGb === 0) return []
  return [
    `if ! swapon --show=NAME --noheadings 2>/dev/null | grep -qx '/swapfile'; then`,
    `  if [ ! -f /swapfile ]; then fallocate -l ${sizeGb}G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=${sizeGb * 1024} status=none; fi`,
    '  chmod 600 /swapfile',
    '  mkswap /swapfile >/dev/null',
    '  swapon /swapfile',
    'fi',
    `grep -qE '^/swapfile\\s' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab`,
  ]
}

export function buildHetznerHostOptimizationScript(config: CloudConfig): string[] {
  const compute = computeConfig(config)
  const plan = resolveHetznerHostOptimizationPlan(config)
  const monitoring = compute.monitoring ?? true
  const firewall = compute.firewall ?? { enabled: true }

  return [
    'set -euo pipefail',
    ...(usesRpxProxy(compute)
      ? [
          'systemctl disable --now nginx.service bun-gateway.service ts-cloud-nginx.service 2>/dev/null || true',
          'systemctl reset-failed nginx.service bun-gateway.service ts-cloud-nginx.service 2>/dev/null || true',
        ]
      : []),
    ...swapScript(plan.swapGb),
    ...buildAutoUpdatesScript(plan.autoUpdates),
    ...buildMonitoringScript(monitoring),
    ...hardeningScript(plan),
    ...buildUfwScript(firewall),
    'systemctl daemon-reload',
    'systemctl reset-failed',
  ]
}

const REPORT_SCRIPT = String.raw`
const text = (command) => {
  const result = Bun.spawnSync(['bash', '-lc', command], { stdout: 'pipe', stderr: 'pipe' })
  return result.stdout.toString().trim()
}
const lines = command => text(command).split('\n').map(value => value.trim()).filter(Boolean)
const number = value => Number.parseInt(value || '0', 10) || 0
const ssh = Object.fromEntries(lines("sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin) '").map(line => line.split(/\s+/, 2)))
const firewallPorts = lines("ufw status 2>/dev/null | awk '/ALLOW/{print $1}'")
  .flatMap(value => value.startsWith('OpenSSH') ? [22] : (value.match(/^\d+/) ? [number(value)] : []))
const publicTcpPorts = lines("ss -lntH | awk '{print $4}'")
  .filter(address => !address.startsWith('127.') && !address.startsWith('[::1]'))
  .flatMap(address => {
    const match = address.match(/:(\d+)$/)
    return match ? [number(match[1])] : []
  })
const metricsMtime = number(text("stat -c %Y /var/lib/ts-cloud/metrics.json 2>/dev/null"))
console.log(JSON.stringify({
  firewallActive: text("ufw status 2>/dev/null | head -1").includes('active'),
  firewallPorts: [...new Set(firewallPorts)].sort((a, b) => a - b),
  passwordAuthentication: ssh.passwordauthentication !== 'no',
  rootPasswordLogin: ssh.permitrootlogin === 'yes',
  fail2banActive: text('systemctl is-active fail2ban 2>/dev/null') === 'active',
  unattendedUpgradesActive: text('systemctl is-active unattended-upgrades 2>/dev/null') === 'active',
  metricsTimerActive: text('systemctl is-active ts-cloud-metrics.timer 2>/dev/null') === 'active',
  metricsSnapshotFresh: metricsMtime > 0 && Math.floor(Date.now() / 1000) - metricsMtime < 180,
  swapBytes: number(text("free -b | awk '/^Swap:/{print $2}'")),
  journalBytes: number(text("journalctl --disk-usage 2>/dev/null | grep -Eo '[0-9.]+[KMG]' | tail -1 | numfmt --from=iec 2>/dev/null")),
  failedUnits: lines("systemctl --failed --type=service --no-legend --plain | awk '{print $1}'"),
  publicTcpPorts: [...new Set(publicTcpPorts)].sort((a, b) => a - b),
}))
`

function remoteBunCommand(script: string): string {
  return `printf %s ${Buffer.from(script).toString('base64')} | base64 -d | bun -`
}

export async function applyHetznerHostOptimization(
  config: CloudConfig,
  options: HetznerHostOptimizationOptions,
): Promise<void> {
  const script = buildHetznerHostOptimizationScript(config).join('\n')
  const command = `printf %s ${Buffer.from(script).toString('base64')} | base64 -d | bash`
  await sshExecOrThrow(options.host, command, options)
}

export async function collectHetznerHostOptimizationReport(
  options: HetznerHostOptimizationOptions,
): Promise<HetznerHostOptimizationReport> {
  const raw = await sshExecOrThrow(options.host, remoteBunCommand(REPORT_SCRIPT), options)
  return JSON.parse(raw) as HetznerHostOptimizationReport
}

export function verifyHetznerHostOptimization(
  plan: HetznerHostOptimizationPlan,
  report: HetznerHostOptimizationReport,
): string[] {
  const failures: string[] = []
  const actualPorts = new Set(report.firewallPorts)
  const missingPorts = plan.firewallPorts.filter(port => !actualPorts.has(port))
  const unexpectedPorts = report.firewallPorts.filter(port => !plan.firewallPorts.includes(port))

  if (!report.firewallActive) failures.push('UFW is not active')
  if (missingPorts.length > 0) failures.push(`UFW is missing ports: ${missingPorts.join(', ')}`)
  if (unexpectedPorts.length > 0) failures.push(`UFW has unexpected ports: ${unexpectedPorts.join(', ')}`)
  if (report.passwordAuthentication) failures.push('SSH password authentication remains enabled')
  if (report.rootPasswordLogin) failures.push('SSH root password login remains enabled')
  if (!report.fail2banActive) failures.push('fail2ban is not active')
  if (plan.autoUpdates && !report.unattendedUpgradesActive) failures.push('unattended upgrades are not active')
  if (plan.monitoring && !report.metricsTimerActive) failures.push('metrics timer is not active')
  if (plan.monitoring && !report.metricsSnapshotFresh) failures.push('metrics snapshot is stale')
  if (plan.swapGb > 0 && report.swapBytes < plan.swapGb * 1024 ** 3 * 0.9) failures.push('configured swap is missing')
  if (report.failedUnits.length > 0) failures.push(`failed services: ${report.failedUnits.join(', ')}`)
  return failures
}
