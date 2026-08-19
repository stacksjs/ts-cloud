import { describe, expect, it } from 'bun:test'
import { buildDdosScript, buildProtectionScript, buildWafScript } from './protection'
import { buildComputeProvisionScripts } from './compute-provision'

describe('DDoS provisioning', () => {
  it('is on by default, so a box is protected without anyone opting in', () => {
    const lines = buildDdosScript().join('\n')
    expect(lines).toContain('nftables')
    expect(lines).toContain('tcp dport { 80, 443 }')
  })

  it('can be turned off entirely', () => {
    expect(buildDdosScript(false)).toEqual([])
    expect(buildDdosScript({ enabled: false })).toEqual([])
  })

  it('protects the ports the firewall opened, not just the web ones', () => {
    // A port UFW opens is a port an attacker can reach; leaving it out of the
    // rate limits would make opening a port silently remove its protection.
    expect(buildProtectionScript({}, [8443]).join('\n')).toContain('tcp dport { 80, 443, 8443 }')
  })

  it('passes an allowlist and thresholds through', () => {
    const lines = buildDdosScript({
      allowlist: ['10.0.0.0/8'],
      thresholds: { newConnectionsPerSecond: 25 },
    }).join('\n')
    expect(lines).toContain('10.0.0.0/8')
    expect(lines).toContain('limit rate over 25/second')
  })

  it('creates the directory it writes into', () => {
    // The ruleset lands in /etc/nftables.d, which does not exist on a stock box.
    expect(buildDdosScript().join('\n')).toContain('install -d -m 0755 /etc/ts-cloud /etc/nftables.d')
  })

  it('survives a reboot by including itself from nftables.conf', () => {
    // Applying a ruleset is not the same as persisting it; without the include
    // the box comes back up unprotected and nothing says so.
    const lines = buildDdosScript().join('\n')
    expect(lines).toContain('include "/etc/nftables.d/ts-cloud-ddos.nft"')
    expect(lines).toContain('grep -q')
  })
})

describe('WAF provisioning', () => {
  it('is on by default but only in detection mode', () => {
    const lines = buildWafScript().join('\n')
    expect(lines).toContain('SecRuleEngine DetectionOnly')
    expect(lines).not.toContain('SecRuleEngine On')
  })

  it('can be turned off', () => {
    expect(buildWafScript(false)).toEqual([])
    expect(buildWafScript({ mode: 'off' })).toEqual([])
  })

  it('validates the config before activating it', () => {
    expect(buildWafScript().join('\n')).toContain('validate')
  })

  it('honours an explicit blocking mode', () => {
    expect(buildWafScript({ mode: 'blocking' }).join('\n')).toContain('SecRuleEngine On')
  })
})

describe('script isolation', () => {
  const lines = buildProtectionScript()

  it('runs each generator as its own file rather than splicing its lines', () => {
    // The generators set `set -euo pipefail`; inlining them would apply that to
    // every later provisioning command and abort the bootstrap on any non-zero.
    expect(lines.some((line) => line.startsWith('cat > /tmp/ts-cloud-ddos.sh'))).toBe(true)
    expect(lines.some((line) => line.startsWith('bash /tmp/ts-cloud-ddos.sh'))).toBe(true)
  })

  it('cleans up after itself', () => {
    expect(lines).toContain('rm -f /tmp/ts-cloud-ddos.sh')
    expect(lines).toContain('rm -f /tmp/ts-cloud-waf.sh')
  })

  it('never fails the deploy when protection cannot install', () => {
    // A box that is up without mitigation is recoverable. A deploy that will
    // not finish because nftables is missing is an outage of its own.
    expect(lines.filter((line) => line.startsWith('bash /tmp/')).every((line) => line.includes('|| echo'))).toBe(true)
  })

  it('brings the packet filter up before the WAF', () => {
    // The kernel drops for free; the WAF parses. Reversing this spends CPU
    // inspecting traffic the kernel was about to discard.
    expect(lines.findIndex((line) => line.includes('ts-cloud-ddos'))).toBeLessThan(
      lines.findIndex((line) => line.includes('ts-cloud-waf')),
    )
  })
})

describe('the provision path applies protection', () => {
  const config = {
    project: { slug: 'acme' },
    infrastructure: { compute: { runtime: 'bun' } },
  } as never

  it('includes both layers for an ordinary box', () => {
    const provision = buildComputeProvisionScripts(config)
    const script = (provision.servicesProvision ?? []).join('\n')
    expect(script).toContain('ts-cloud-ddos.sh')
    expect(script).toContain('ts-cloud-waf.sh')
  })

  it('honours an opt-out in the config', () => {
    const disabled = {
      project: { slug: 'acme' },
      infrastructure: { compute: { runtime: 'bun', ddos: false, waf: false } },
    } as never
    const script = (buildComputeProvisionScripts(disabled).servicesProvision ?? []).join('\n')
    expect(script).not.toContain('ts-cloud-ddos.sh')
    expect(script).not.toContain('ts-cloud-waf.sh')
  })

  it('protects a box even when UFW is off, which is the default for non-PHP boxes', () => {
    // UFW defaults off outside PHP boxes. Flood mitigation is on regardless -
    // the two answer different questions, and "no port policy" is not "no
    // protection".
    const script = (buildComputeProvisionScripts(config).servicesProvision ?? []).join('\n')
    expect(script).not.toContain('ufw --force enable')
    expect(script).toContain('ts-cloud-ddos.sh')
  })

  it('layers under UFW rather than replacing it on a PHP box', () => {
    const php = {
      project: { slug: 'acme' },
      infrastructure: { compute: { runtime: 'php' } },
    } as never
    const script = (buildComputeProvisionScripts(php).servicesProvision ?? []).join('\n')
    expect(script).toContain('ufw --force enable')
    expect(script).toContain('ts-cloud-ddos.sh')
    // The nftables hook sits at priority -150 with `policy accept`, so it runs
    // before UFW's filter chain and drops floods without overriding UFW's
    // port policy. Two firewalls that both set a policy would fight.
    expect(script).toContain('priority -150; policy accept;')
  })
})
