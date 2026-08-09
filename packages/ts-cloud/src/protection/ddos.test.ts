import type { TrafficSignals } from './ddos'
import { describe, expect, it } from 'bun:test'
import {
  applyMitigationFactor,
  DEFAULT_DDOS_THRESHOLDS,
  isValidCidr,
  planMitigation,
  renderDdosInstallScript,
  renderNftablesRuleset,
  renderSysctlFile,
  sysctlHardening,
} from './ddos'

describe('CIDR validation', () => {
  it('accepts real IPv4 and IPv6 CIDRs', () => {
    for (const cidr of ['10.0.0.0/8', '203.0.113.5', '192.168.1.0/24', '2001:db8::/32', 'fe80::1'])
      expect(isValidCidr(cidr)).toBe(true)
  })

  it('rejects malformed input and shell metacharacters', () => {
    for (const cidr of ['10.0.0.256/8', '10.0.0.0/33', 'not-an-ip', '10.0.0.0/8; rm -rf /', '10.0.0.0/8\nnft flush ruleset', ''])
      expect(isValidCidr(cidr)).toBe(false)
  })

  it('keeps an injected element out of the generated ruleset', () => {
    const ruleset = renderNftablesRuleset({ allowlist: ['10.0.0.0/8', '1.2.3.4; nft flush ruleset'] })
    expect(ruleset).toContain('10.0.0.0/8')
    expect(ruleset).not.toContain('flush ruleset')
  })
})

describe('sysctl hardening', () => {
  it('enables SYN cookies and reverse-path filtering', () => {
    const tunables = sysctlHardening()
    expect(tunables['net.ipv4.tcp_syncookies']).toBe('1')
    expect(tunables['net.ipv4.conf.all.rp_filter']).toBe('1')
    expect(tunables['net.ipv4.icmp_echo_ignore_broadcasts']).toBe('1')
  })

  it('scales the SYN backlog with the configured rate', () => {
    const tuned = sysctlHardening({ thresholds: { synPerSecond: 10_000 } })
    expect(Number(tuned['net.ipv4.tcp_max_syn_backlog'])).toBe(40_000)
    // Never below a sane floor, however low the threshold is set.
    const low = sysctlHardening({ thresholds: { synPerSecond: 1 } })
    expect(Number(low['net.ipv4.tcp_max_syn_backlog'])).toBe(4_096)
  })

  it('renders a valid sysctl.d file', () => {
    const file = renderSysctlFile()
    expect(file).toContain('net.ipv4.tcp_syncookies = 1')
    expect(file.split('\n').filter((line) => line && !line.startsWith('#')).every((line) => line.includes(' = '))).toBe(true)
  })
})

describe('nftables ruleset', () => {
  it('is idempotent: it deletes its own table before recreating it', () => {
    const ruleset = renderNftablesRuleset()
    expect(ruleset).toContain('delete table inet ts_cloud_ddos')
    expect(ruleset.indexOf('delete table')).toBeLessThan(ruleset.indexOf('table inet ts_cloud_ddos {'))
  })

  it('accepts established traffic before doing any per-source work', () => {
    const ruleset = renderNftablesRuleset()
    expect(ruleset.indexOf('ct state established,related accept')).toBeLessThan(ruleset.indexOf('meter conn_rate4'))
  })

  it('rate-limits new connections per source and bans repeat offenders', () => {
    const ruleset = renderNftablesRuleset({ thresholds: { newConnectionsPerSecond: 25, banSeconds: 300 } })
    expect(ruleset).toContain('limit rate over 25/second')
    expect(ruleset).toContain('timeout 300s')
    expect(ruleset).toContain('add @banned4')
  })

  it('counts without dropping in monitor mode', () => {
    const monitoring = renderNftablesRuleset({ monitorOnly: true })
    expect(monitoring).toContain('add @banned4 { ip saddr } counter\n')
    expect(monitoring).not.toContain('add @banned4 { ip saddr } counter drop')
  })

  it('covers the configured ports', () => {
    const ruleset = renderNftablesRuleset({ ports: [443, 8080] })
    expect(ruleset).toContain('tcp dport { 443, 8080 }')
  })

  it('drops nonsense TCP flag combinations', () => {
    const ruleset = renderNftablesRuleset()
    expect(ruleset).toContain('tcp flags & (fin|syn) == (fin|syn) counter drop')
  })

  it('separates IPv4 and IPv6 allowlist entries into their own sets', () => {
    const ruleset = renderNftablesRuleset({ allowlist: ['10.0.0.0/8', '2001:db8::/32'] })
    expect(ruleset).toContain('set allow4 { type ipv4_addr; flags interval; elements = { 10.0.0.0/8 } }')
    expect(ruleset).toContain('set allow6 { type ipv6_addr; flags interval; elements = { 2001:db8::/32 } }')
  })

  it('omits an allowlist set entirely when there is nothing to put in it', () => {
    expect(renderNftablesRuleset()).not.toContain('set allow4')
  })

  it('drops traffic that skipped the CDN when origin protection is on', () => {
    const ruleset = renderNftablesRuleset({
      originProtection: { enabled: true, cdnRanges: ['198.51.100.0/24'] },
    })
    expect(ruleset).toContain('set cdn4')
    expect(ruleset).toContain('ip saddr != @cdn4 counter drop')
  })

  it('leaves origin protection out when it is disabled', () => {
    expect(renderNftablesRuleset({ originProtection: { enabled: false, cdnRanges: ['198.51.100.0/24'] } })).not.toContain('@cdn4')
  })
})

describe('install script', () => {
  it('validates the ruleset before applying it and keeps the old one on failure', () => {
    const script = renderDdosInstallScript()
    expect(script).toContain('nft -c -f')
    expect(script.indexOf('nft -c -f')).toBeLessThan(script.indexOf('nft -f /etc/nftables.d/ts-cloud-ddos.nft\n'))
    expect(script).toContain('keeping the previous one')
    expect(script).toContain('set -euo pipefail')
  })
})

describe('adaptive mitigation', () => {
  function signals(overrides: Partial<TrafficSignals> = {}): TrafficSignals {
    return {
      requestsPerSecond: 100,
      baselineRequestsPerSecond: 100,
      errorRate: 0.01,
      uniqueSources: 500,
      topSourceShare: 0.02,
      concurrentConnections: 200,
      ...overrides,
    }
  }

  it('does nothing to ordinary traffic', () => {
    const plan = planMitigation(signals())
    expect(plan.level).toBe('off')
    expect(plan.rateLimitFactor).toBe(1)
  })

  it('only observes a legitimate surge: many sources, low errors', () => {
    // A launch: 10x traffic, spread wide, everything succeeding.
    const plan = planMitigation(signals({ requestsPerSecond: 1000, uniqueSources: 8000, topSourceShare: 0.01 }))
    expect(plan.level).toBe('monitor')
    expect(plan.rateLimitFactor).toBe(1)
    expect(plan.challengeEnabled).toBe(false)
  })

  it('rate-limits a surge concentrated on one source', () => {
    const plan = planMitigation(signals({ requestsPerSecond: 1000, uniqueSources: 400, topSourceShare: 0.4 }))
    expect(plan.level).toBe('rate_limit')
    expect(plan.reasons.join(' ')).toContain('40%')
  })

  it('rate-limits a surge whose per-source rate is inhuman', () => {
    // 10x traffic from 15 sources: 66 req/s each, which no browser produces.
    const plan = planMitigation(signals({ requestsPerSecond: 1000, uniqueSources: 15, topSourceShare: 0.1 }))
    expect(plan.level).toBe('rate_limit')
  })

  it('challenges a surge that is driving errors', () => {
    const plan = planMitigation(signals({ requestsPerSecond: 1000, uniqueSources: 9000, errorRate: 0.4 }))
    expect(plan.level).toBe('challenge')
    expect(plan.challengeEnabled).toBe(true)
  })

  it('challenges a surge of requests with no browser agent', () => {
    const plan = planMitigation(
      signals({ requestsPerSecond: 1000, uniqueSources: 9000, suspiciousAgentShare: 0.9 }),
    )
    expect(plan.level).toBe('challenge')
  })

  it('locks down an extreme, attack-shaped surge', () => {
    const plan = planMitigation(
      signals({ requestsPerSecond: 5000, uniqueSources: 200, topSourceShare: 0.5, errorRate: 0.6 }),
      ['203.0.113.9'],
    )
    expect(plan.level).toBe('lockdown')
    expect(plan.staticOnly).toBe(true)
    expect(plan.banCandidates).toEqual(['203.0.113.9'])
  })

  it('does not lock down an extreme but well-shaped surge', () => {
    // 50x traffic, spread across many sources, succeeding: a viral moment.
    const plan = planMitigation(signals({ requestsPerSecond: 5000, uniqueSources: 100_000, topSourceShare: 0.001 }))
    expect(plan.level).toBe('monitor')
  })

  it('acts on a single dominant source even without an overall surge', () => {
    const plan = planMitigation(signals({ requestsPerSecond: 150, uniqueSources: 20, topSourceShare: 0.7 }))
    expect(plan.level).toBe('rate_limit')
  })

  it('never proposes banning an unparseable source', () => {
    const plan = planMitigation(
      signals({ requestsPerSecond: 5000, uniqueSources: 200, topSourceShare: 0.5, errorRate: 0.6 }),
      ['203.0.113.9', 'not-an-ip'],
    )
    expect(plan.banCandidates).toEqual(['203.0.113.9'])
  })

  it('scales a rate limit by the plan, never below one', () => {
    const lockdown = planMitigation(
      signals({ requestsPerSecond: 5000, uniqueSources: 200, topSourceShare: 0.5, errorRate: 0.6 }),
    )
    expect(applyMitigationFactor(600, lockdown)).toBe(60)
    expect(applyMitigationFactor(1, lockdown)).toBe(1)
  })

  it('exposes sane defaults', () => {
    expect(DEFAULT_DDOS_THRESHOLDS.newConnectionsPerSecond).toBeGreaterThan(0)
    expect(DEFAULT_DDOS_THRESHOLDS.banSeconds).toBeGreaterThan(0)
  })
})
