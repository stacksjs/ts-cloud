import { describe, expect, it } from 'bun:test'
import { addFirewallPort, isValidPort, normalizePorts, removeFirewallPort, setFirewallPorts } from './firewall-config-editor'

const withFirewall = `const config = {
  infrastructure: {
    compute: {
      provider: 'hetzner',
      firewall: { enabled: true, allowedPorts: [8080] },
    },
  },
}`

const noFirewall = `const config = {
  infrastructure: {
    compute: {
      provider: 'aws',
    },
  },
}`

describe('normalizePorts', () => {
  it('strips always-open ports, dedupes, sorts, drops invalid', () => {
    expect(normalizePorts([443, 8080, 22, 80, 8080, 6379, 70000, 0])).toEqual([6379, 8080])
  })
})

describe('isValidPort', () => {
  it('validates the 1-65535 range', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(3.5)).toBe(false)
  })
})

describe('addFirewallPort', () => {
  it('adds a port to an existing allowedPorts array (sorted, deduped)', () => {
    const out = addFirewallPort(withFirewall, 6379, [8080])
    expect(out).toContain('allowedPorts: [6379, 8080]')
  })

  it('creates the firewall block when none exists', () => {
    const out = addFirewallPort(noFirewall, 9000, [])
    expect(out).toContain('firewall: {')
    expect(out).toContain('allowedPorts: [9000]')
  })

  it('rejects always-open ports and invalid ports', () => {
    expect(() => addFirewallPort(withFirewall, 443, [8080])).toThrow(/always open/i)
    expect(() => addFirewallPort(withFirewall, 70000, [8080])).toThrow(/between 1 and 65535/i)
  })
})

describe('removeFirewallPort', () => {
  it('removes a port from allowedPorts', () => {
    const out = removeFirewallPort(withFirewall, 8080, [6379, 8080])
    expect(out).toContain('allowedPorts: [6379]')
  })

  it('is a no-op-safe when the port is absent', () => {
    const out = removeFirewallPort(withFirewall, 1234, [8080])
    expect(out).toContain('allowedPorts: [8080]')
  })
})

describe('setFirewallPorts', () => {
  it('is idempotent across repeated edits (no comma accumulation)', () => {
    let text = withFirewall
    text = setFirewallPorts({ configText: text, ports: [6379, 8080] })
    text = setFirewallPorts({ configText: text, ports: [6379, 8080] })
    expect(text.match(/allowedPorts/g)?.length).toBe(1)
    expect(text).toContain('allowedPorts: [6379, 8080]')
    // Config remains parseable.
    expect(() => new Function(`${text}; return config`)).not.toThrow()
  })
})
