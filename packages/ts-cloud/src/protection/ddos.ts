/**
 * Layer 3/4 DDoS mitigation for a box we control.
 *
 * ts-cloud has no anycast scrubbing network, and pretending otherwise would be
 * dishonest - a 500 Gbps flood saturates the uplink before any of this runs.
 * What this does cover is the attack traffic that actually reaches most
 * self-hosted infrastructure: SYN floods, connection exhaustion, slow-loris,
 * amplified UDP, and single-source hammering. Those are stopped in the kernel,
 * for free, and stopping them there is the difference between a box that
 * degrades and a box that falls over.
 *
 * Everything here *generates configuration* rather than executing it, which is
 * the pattern the rest of the driver layer already uses (see `ufw.ts` and
 * `image-recipe.ts`): the deploy renders it, ships it, and reconciles it, so a
 * rule survives a reprovision instead of living only in a live `iptables`
 * table that the next boot discards.
 */

export interface DdosThresholds {
  /** New connections per second, per source IP, before the source is dropped. */
  newConnectionsPerSecond: number
  /** Concurrent established connections allowed from one source IP. */
  concurrentPerSource: number
  /** SYN packets per second accepted platform-wide before SYN cookies do the work. */
  synPerSecond: number
  /** Burst allowance on top of the per-second rates. */
  burst: number
  /** ICMP echo requests per second. Ping stays useful; ping floods do not. */
  icmpPerSecond: number
  /** Seconds a source stays in the drop set once it trips a limit. */
  banSeconds: number
}

export const DEFAULT_DDOS_THRESHOLDS: DdosThresholds = {
  newConnectionsPerSecond: 50,
  concurrentPerSource: 100,
  synPerSecond: 2_000,
  burst: 100,
  icmpPerSecond: 5,
  banSeconds: 600,
}

export interface DdosConfig {
  enabled?: boolean
  thresholds?: Partial<DdosThresholds>
  /** Ports the ruleset protects. 80 and 443 unless told otherwise. */
  ports?: number[]
  /** CIDRs that bypass every limit: monitoring, office IPs, a load balancer. */
  allowlist?: string[]
  /** CIDRs dropped outright. */
  blocklist?: string[]
  /**
   * Count without dropping. The way to deploy a ruleset on a live box and see
   * what it *would* have blocked before it blocks anything.
   */
  monitorOnly?: boolean
  /** Also drop traffic that reaches the box bypassing the CDN, when one is used. */
  originProtection?: { enabled: boolean; cdnRanges: string[] }
}

function resolveThresholds(config: DdosConfig): DdosThresholds {
  return { ...DEFAULT_DDOS_THRESHOLDS, ...config.thresholds }
}

const CIDR_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$|^[0-9a-f:]+(?:\/\d{1,3})?$/i

/**
 * Validate a CIDR before it reaches a generated ruleset.
 *
 * The list is operator-supplied and goes straight into a file the kernel
 * parses; an unvalidated entry is both a syntax error that bricks the ruleset
 * and an injection vector into the generated script.
 */
export function isValidCidr(value: string): boolean {
  if (!CIDR_PATTERN.test(value)) return false
  const [address, prefix] = value.split('/')
  if (address.includes(':')) return prefix == null || (Number(prefix) >= 0 && Number(prefix) <= 128)
  const octets = address.split('.')
  if (octets.length !== 4 || octets.some((octet) => Number(octet) > 255 || octet === '')) return false
  return prefix == null || (Number(prefix) >= 0 && Number(prefix) <= 32)
}

function validCidrs(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(isValidCidr))]
}

function validPorts(values: readonly number[] | undefined): number[] {
  const ports = (values ?? [80, 443]).filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535)
  return [...new Set(ports)].sort((a, b) => a - b)
}

/**
 * Kernel tunables that make a box survive a flood.
 *
 * `syncookies` is the important one: without it, a SYN flood fills the backlog
 * with half-open connections and the box stops accepting anything, at a packet
 * rate a single host can produce. The rest bound how much memory an attacker
 * can make the kernel hold on their behalf.
 */
export function sysctlHardening(config: DdosConfig = {}): Record<string, string> {
  const thresholds = resolveThresholds(config)
  return {
    // Answer SYNs statelessly once the backlog fills, instead of queueing.
    'net.ipv4.tcp_syncookies': '1',
    'net.ipv4.tcp_max_syn_backlog': String(Math.max(4_096, thresholds.synPerSecond * 4)),
    'net.ipv4.tcp_synack_retries': '2',
    'net.ipv4.tcp_abort_on_overflow': '1',
    // Reclaim half-dead sockets quickly; slow-loris exists to hold them open.
    'net.ipv4.tcp_fin_timeout': '15',
    'net.ipv4.tcp_keepalive_time': '300',
    'net.ipv4.tcp_keepalive_intvl': '30',
    'net.ipv4.tcp_keepalive_probes': '3',
    'net.core.somaxconn': '4096',
    'net.core.netdev_max_backlog': '16384',
    // Drop spoofed source addresses at the interface (RFC 3704 strict mode).
    'net.ipv4.conf.all.rp_filter': '1',
    'net.ipv4.conf.default.rp_filter': '1',
    // Never act as a router or honour source routing / redirects.
    'net.ipv4.conf.all.accept_source_route': '0',
    'net.ipv4.conf.all.accept_redirects': '0',
    'net.ipv4.conf.all.send_redirects': '0',
    'net.ipv6.conf.all.accept_redirects': '0',
    'net.ipv6.conf.all.accept_source_route': '0',
    // Do not answer broadcast pings: that is the smurf amplifier.
    'net.ipv4.icmp_echo_ignore_broadcasts': '1',
    'net.ipv4.icmp_ignore_bogus_error_responses': '1',
    // Room for the conntrack entries a flood creates before it is dropped.
    'net.netfilter.nf_conntrack_max': '262144',
    'net.netfilter.nf_conntrack_tcp_timeout_established': '3600',
  }
}

/** Render the tunables as a drop-in sysctl file. */
export function renderSysctlFile(config: DdosConfig = {}): string {
  const lines = [
    '# Managed by ts-cloud. Edits are overwritten on the next deploy.',
    '# Network hardening against L3/L4 floods.',
    '',
  ]
  for (const [key, value] of Object.entries(sysctlHardening(config))) lines.push(`${key} = ${value}`)
  return `${lines.join('\n')}\n`
}

/**
 * Render an nftables ruleset.
 *
 * nftables rather than iptables: sets and rate meters are first-class, so
 * per-source limiting is one rule against a hash table instead of a chain that
 * grows with the attack. The generated table is named and flushed atomically,
 * which is what makes a redeploy idempotent instead of additive.
 */
export function renderNftablesRuleset(config: DdosConfig = {}): string {
  const thresholds = resolveThresholds(config)
  const ports = validPorts(config.ports)
  const allowlist = validCidrs(config.allowlist)
  const blocklist = validCidrs(config.blocklist)
  const verdict = config.monitorOnly ? 'counter' : 'counter drop'
  const cdnRanges = config.originProtection?.enabled ? validCidrs(config.originProtection.cdnRanges) : []
  const ipv4Allow = allowlist.filter((cidr) => !cidr.includes(':'))
  const ipv6Allow = allowlist.filter((cidr) => cidr.includes(':'))
  const ipv4Block = blocklist.filter((cidr) => !cidr.includes(':'))

  const lines: string[] = [
    '#!/usr/sbin/nft -f',
    '# Managed by ts-cloud. Edits are overwritten on the next deploy.',
    '',
    'table inet ts_cloud_ddos',
    'delete table inet ts_cloud_ddos',
    '',
    'table inet ts_cloud_ddos {',
    '  # Sources that tripped a limit, with a timeout so a ban self-expires.',
    `  set banned4 { type ipv4_addr; flags timeout; timeout ${thresholds.banSeconds}s; }`,
    `  set banned6 { type ipv6_addr; flags timeout; timeout ${thresholds.banSeconds}s; }`,
  ]

  if (ipv4Allow.length > 0) lines.push(`  set allow4 { type ipv4_addr; flags interval; elements = { ${ipv4Allow.join(', ')} } }`)
  if (ipv6Allow.length > 0) lines.push(`  set allow6 { type ipv6_addr; flags interval; elements = { ${ipv6Allow.join(', ')} } }`)
  if (ipv4Block.length > 0) lines.push(`  set block4 { type ipv4_addr; flags interval; elements = { ${ipv4Block.join(', ')} } }`)
  if (cdnRanges.length > 0)
    lines.push(`  set cdn4 { type ipv4_addr; flags interval; elements = { ${cdnRanges.filter((cidr) => !cidr.includes(':')).join(', ')} } }`)

  lines.push(
    '',
    '  chain input {',
    '    type filter hook input priority -150; policy accept;',
    '',
    '    # Established traffic is already paid for; never re-inspect it.',
    '    ct state established,related accept',
    '    iif lo accept',
    '',
    '    # Invalid packets are never legitimate and are cheap to drop early.',
    '    ct state invalid counter drop',
  )

  if (ipv4Allow.length > 0) lines.push('    ip saddr @allow4 accept')
  if (ipv6Allow.length > 0) lines.push('    ip6 saddr @allow6 accept')
  if (ipv4Block.length > 0) lines.push('    ip saddr @block4 counter drop')
  lines.push('    ip saddr @banned4 counter drop', '    ip6 saddr @banned6 counter drop', '')

  lines.push(
    '    # Nonsense TCP flag combinations: scanners and stack fingerprinting.',
    '    tcp flags & (fin|syn) == (fin|syn) counter drop',
    '    tcp flags & (syn|rst) == (syn|rst) counter drop',
    '    tcp flags & (fin|rst) == (fin|rst) counter drop',
    '    tcp flags & (fin|ack) == fin counter drop',
    '    tcp flags & (syn|fin|ack|rst|psh|urg) == 0x0 counter drop',
    '',
    `    # Ping stays usable, ping floods do not.`,
    `    ip protocol icmp icmp type echo-request limit rate ${thresholds.icmpPerSecond}/second burst ${thresholds.burst} packets accept`,
    '    ip protocol icmp icmp type echo-request counter drop',
    '',
  )

  if (ports.length > 0) {
    const portSet = ports.join(', ')
    lines.push(
      `    # Platform-wide SYN ceiling. Above it the kernel falls back to cookies.`,
      `    tcp dport { ${portSet} } ct state new limit rate ${thresholds.synPerSecond}/second burst ${thresholds.burst} packets accept`,
      '',
      `    # Per-source new-connection rate. This is what stops one host hammering.`,
      `    tcp dport { ${portSet} } ct state new meter conn_rate4 { ip saddr limit rate over ${thresholds.newConnectionsPerSecond}/second burst ${thresholds.burst} packets } add @banned4 { ip saddr } ${verdict}`,
      `    tcp dport { ${portSet} } ct state new meter conn_rate6 { ip6 saddr limit rate over ${thresholds.newConnectionsPerSecond}/second burst ${thresholds.burst} packets } add @banned6 { ip6 saddr } ${verdict}`,
      '',
      `    # Concurrency ceiling per source: the slow-loris defence.`,
      `    tcp dport { ${portSet} } ct state new meter conn_count4 { ip saddr ct count over ${thresholds.concurrentPerSource} } ${verdict}`,
      `    tcp dport { ${portSet} } ct state new meter conn_count6 { ip6 saddr ct count over ${thresholds.concurrentPerSource} } ${verdict}`,
      '',
    )
    if (cdnRanges.length > 0)
      lines.push(
        '    # Origin protection: reject traffic that skipped the CDN and came',
        '    # straight to the box, which is how an attacker bypasses the edge.',
        `    tcp dport { ${portSet} } ip saddr != @cdn4 counter drop`,
        '',
      )
  }

  lines.push('  }', '}', '')
  return lines.join('\n')
}

/**
 * A script that installs the ruleset and the tunables.
 *
 * The validation step is not optional: an nftables file with one bad line
 * leaves the box with no rules at all, and finding that out during an attack
 * is the worst possible time. `nft -c` checks before anything is applied.
 */
export function renderDdosInstallScript(config: DdosConfig = {}): string {
  return `#!/usr/bin/env bash
# Managed by ts-cloud. Installs L3/L4 flood mitigation.
set -euo pipefail

if ! command -v nft >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nftables
fi

install -d -m 0755 /etc/ts-cloud /etc/nftables.d
cat > /etc/sysctl.d/90-ts-cloud-ddos.conf <<'SYSCTL_EOF'
${renderSysctlFile(config)}SYSCTL_EOF
sysctl --system >/dev/null

cat > /etc/nftables.d/ts-cloud-ddos.nft.new <<'NFT_EOF'
${renderNftablesRuleset(config)}NFT_EOF

# Syntax-check before applying: a bad ruleset would leave the box unprotected.
if ! nft -c -f /etc/nftables.d/ts-cloud-ddos.nft.new; then
  echo "ts-cloud: generated nftables ruleset failed validation, keeping the previous one" >&2
  rm -f /etc/nftables.d/ts-cloud-ddos.nft.new
  exit 1
fi

mv /etc/nftables.d/ts-cloud-ddos.nft.new /etc/nftables.d/ts-cloud-ddos.nft
nft -f /etc/nftables.d/ts-cloud-ddos.nft

# Applying the ruleset does not survive a reboot on its own: nftables.service
# loads /etc/nftables.conf, so the file has to be included from there or the box
# comes back up unprotected and nothing says so.
touch /etc/nftables.conf
if ! grep -q 'ts-cloud-ddos.nft' /etc/nftables.conf; then
  printf '\ninclude "/etc/nftables.d/ts-cloud-ddos.nft"\n' >> /etc/nftables.conf
fi
systemctl enable nftables >/dev/null 2>&1 || true
echo "ts-cloud: L3/L4 mitigation active"
`
}

// ---------------------------------------------------------------- adaptive

export type MitigationLevel = 'off' | 'monitor' | 'rate_limit' | 'challenge' | 'lockdown'

export interface TrafficSignals {
  /** Requests per second at the edge right now. */
  requestsPerSecond: number
  /** The same figure under normal conditions, for comparison. */
  baselineRequestsPerSecond: number
  /** Share of requests currently failing, 0-1. */
  errorRate: number
  /** Distinct source IPs seen in the sampling window. */
  uniqueSources: number
  /** Share of traffic from the single busiest source, 0-1. */
  topSourceShare: number
  /** Established connections on the box. */
  concurrentConnections: number
  /** Share of requests with no or an obviously scripted user agent, 0-1. */
  suspiciousAgentShare?: number
}

export interface MitigationPlan {
  level: MitigationLevel
  reasons: string[]
  /** Rate-limit multiplier to apply to normal limits; 1 means unchanged. */
  rateLimitFactor: number
  /** Ask suspicious clients to prove they are a browser. */
  challengeEnabled: boolean
  /** Only serve cached and static responses; skip dynamic rendering. */
  staticOnly: boolean
  /** Sources worth adding to the drop set. */
  banCandidates: string[]
}

const LEVEL_ORDER: readonly MitigationLevel[] = ['off', 'monitor', 'rate_limit', 'challenge', 'lockdown']

/**
 * Choose a mitigation level from live signals.
 *
 * Traffic volume alone is a bad trigger: a launch and an attack look identical
 * on a request-rate graph, and mitigating a launch is a self-inflicted outage.
 * The distinguishing signals are *shape* - a real surge arrives from many
 * sources with a normal error rate, an attack concentrates on few sources, or
 * drives errors, or both. Escalation needs volume plus at least one shape
 * signal; volume by itself only ever reaches `monitor`.
 */
export function planMitigation(signals: TrafficSignals, topSources: readonly string[] = []): MitigationPlan {
  const reasons: string[] = []
  const baseline = Math.max(1, signals.baselineRequestsPerSecond)
  const ratio = signals.requestsPerSecond / baseline
  // Tracked as an index rather than the union: escalation only ever moves up,
  // and comparing positions makes that impossible to get wrong.
  let levelIndex = 0

  const escalate = (next: MitigationLevel, reason: string): void => {
    reasons.push(reason)
    levelIndex = Math.max(levelIndex, LEVEL_ORDER.indexOf(next))
  }

  const surging = ratio >= 3
  if (surging) escalate('monitor', `Traffic is ${ratio.toFixed(1)}x the baseline.`)

  // Shape signals. Each is enough to turn a surge into a mitigation.
  const concentrated = signals.topSourceShare >= 0.25
  const failing = signals.errorRate >= 0.25
  const scripted = (signals.suspiciousAgentShare ?? 0) >= 0.5
  const thinlySpread = signals.uniqueSources > 0 && signals.requestsPerSecond / signals.uniqueSources >= 50

  if (surging && concentrated)
    escalate('rate_limit', `One source accounts for ${(signals.topSourceShare * 100).toFixed(0)}% of traffic.`)
  if (surging && thinlySpread)
    escalate('rate_limit', 'Request rate per unique source is far above what a browser produces.')
  if (surging && failing) escalate('challenge', `Error rate is ${(signals.errorRate * 100).toFixed(0)}% under load.`)
  if (surging && scripted) escalate('challenge', 'Most requests carry no recognisable browser agent.')
  if (ratio >= 20 && (concentrated || failing || scripted || thinlySpread))
    escalate('lockdown', `Traffic is ${ratio.toFixed(0)}x the baseline with attack-shaped characteristics.`)

  // Concentration alone matters even without a surge: one host can exhaust
  // connections at a request rate that never registers as a spike.
  if (!surging && signals.topSourceShare >= 0.6 && signals.requestsPerSecond > baseline)
    escalate('rate_limit', 'A single source dominates traffic without an overall surge.')

  const level = LEVEL_ORDER[levelIndex]
  const factor = { off: 1, monitor: 1, rate_limit: 0.5, challenge: 0.25, lockdown: 0.1 }[level]
  return {
    level,
    reasons,
    rateLimitFactor: factor,
    challengeEnabled: level === 'challenge' || level === 'lockdown',
    staticOnly: level === 'lockdown',
    banCandidates: level === 'off' || level === 'monitor' ? [] : validCidrs(topSources),
  }
}

/** Scale a rate limit by a mitigation plan, never below 1. */
export function applyMitigationFactor(limit: number, plan: MitigationPlan): number {
  return Math.max(1, Math.floor(limit * plan.rateLimitFactor))
}
