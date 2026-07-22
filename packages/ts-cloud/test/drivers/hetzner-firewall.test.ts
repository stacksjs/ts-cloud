import { describe, expect, it } from 'bun:test'
import { buildHetznerFirewallRules } from '../../src/drivers/hetzner/firewall-rules'

describe('buildHetznerFirewallRules', () => {
  it('opens 80/443 and site ports by default', () => {
    const rules = buildHetznerFirewallRules({ sitePorts: [3000, 3008] })
    const ports = rules.map((rule) => rule.port).sort()
    expect(ports).toEqual(['3000', '3008', '443', '80'])
  })

  it('includes SSH when allowSsh is true', () => {
    const rules = buildHetznerFirewallRules({ allowSsh: true, sitePorts: [] })
    expect(rules.some((rule) => rule.port === '22')).toBe(true)
  })

  it('keeps explicit operator-owned service ports during reconciliation', () => {
    const rules = buildHetznerFirewallRules({
      allowSsh: true,
      sitePorts: [3000],
      allowedPorts: [25, 143, 465, 587, 993, 8008, 8443],
    })
    expect(rules.map((rule) => Number(rule.port)).sort((a, b) => a - b)).toEqual([
      22, 25, 80, 143, 443, 465, 587, 993, 3000, 8008, 8443,
    ])
  })
})
