import type { RateLimitRule } from './ratelimit'
import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { renderNftablesRuleset } from './ddos'
import {
  applyControlsToDdos,
  applyControlsToRateLimits,
  describePosture,
  MAX_CONTROL_HOURS,
  ProtectionControlStore,
} from './controls'

const stores: ControlPlaneStore[] = []
const NOW = new Date('2026-07-16T12:00:00Z')

function fixture(now: Date = NOW) {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  stores.push(controlPlane)
  return new ProtectionControlStore(controlPlane, { now: () => now })
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('attack mode', () => {
  it('is off until someone turns it on', () => {
    expect(fixture().current().attackMode).toBeUndefined()
  })

  it('turns on for a bounded window', () => {
    const control = fixture().enableAttackMode({ reason: 'Traffic spike from one ASN.' })
    expect(control.enabled).toBe(true)
    expect(new Date(control.expiresAt).getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('expires on its own, so forgetting is not a slow outage', () => {
    let now = NOW
    const store = new ProtectionControlStore(
      (() => {
        const cp = new ControlPlaneStore({ path: ':memory:' })
        stores.push(cp)
        return cp
      })(),
      { now: () => now },
    )
    store.enableAttackMode({ hours: 1, reason: 'spike' })
    expect(store.current().attackMode).toBeDefined()
    now = new Date(NOW.getTime() + 2 * 3_600_000)
    // Nobody had to remember: it simply stops being in force.
    expect(store.current().attackMode).toBeUndefined()
  })

  it('never lasts longer than the ceiling', () => {
    const control = fixture().enableAttackMode({ hours: 1000, reason: 'spike' })
    const hours = (new Date(control.expiresAt).getTime() - NOW.getTime()) / 3_600_000
    expect(hours).toBe(MAX_CONTROL_HOURS)
  })

  it('can be turned off early', () => {
    const store = fixture()
    store.enableAttackMode({ reason: 'spike' })
    expect(store.disableAttackMode()).toBe(true)
    expect(store.current().attackMode).toBeUndefined()
    expect(store.disableAttackMode()).toBe(false)
  })

  it('records who turned it on and why', () => {
    const control = fixture().enableAttackMode({ reason: 'Credential stuffing', actorId: 'actor-1' })
    expect(control).toMatchObject({ reason: 'Credential stuffing', actorId: 'actor-1' })
  })
})

describe('pausing mitigations', () => {
  it('insists on a reason, because it costs money while it is on', () => {
    expect(() => fixture().pauseMitigations({ reason: '   ' })).toThrow('requires a reason')
  })

  it('is capped at the ceiling', () => {
    const control = fixture().pauseMitigations({ hours: 999, reason: 'Black Friday proxy traffic' })
    expect((new Date(control.expiresAt).getTime() - NOW.getTime()) / 3_600_000).toBe(MAX_CONTROL_HOURS)
  })

  it('can be resumed early', () => {
    const store = fixture()
    store.pauseMitigations({ reason: 'proxy' })
    expect(store.resumeMitigations()).toBe(true)
    expect(store.current().mitigationPause).toBeUndefined()
  })
})

describe('IP rules', () => {
  it('validates before storing', () => {
    expect(() => fixture().addIpRule('block', 'not-an-ip')).toThrow('Not a valid IP or CIDR')
    expect(() => fixture().addIpRule('block', '10.0.0.0/8; rm -rf /')).toThrow('Not a valid IP or CIDR')
  })

  it('stores and removes entries', () => {
    const store = fixture()
    expect(store.addIpRule('block', '203.0.113.0/24').block).toEqual(['203.0.113.0/24'])
    expect(store.removeIpRule('block', '203.0.113.0/24').block).toEqual([])
  })

  it('deduplicates', () => {
    const store = fixture()
    store.addIpRule('allow', '10.0.0.0/8')
    expect(store.addIpRule('allow', '10.0.0.0/8').allow).toEqual(['10.0.0.0/8'])
  })

  it('never leaves a CIDR on both lists', () => {
    const store = fixture()
    store.addIpRule('block', '10.0.0.0/8')
    const rules = store.addIpRule('allow', '10.0.0.0/8')
    // The ruleset checks allow first, so a surviving block entry would be dead
    // and the UI would imply protection that is not there.
    expect(rules.allow).toEqual(['10.0.0.0/8'])
    expect(rules.block).toEqual([])
  })
})

describe('posture', () => {
  it('describes the normal case', () => {
    expect(describePosture(fixture().current()).summary).toContain('normal posture')
  })

  it('says plainly that paused mitigation means billed traffic', () => {
    const store = fixture()
    store.pauseMitigations({ reason: 'proxy' })
    const posture = describePosture(store.current())
    expect(posture.mitigationPaused).toBe(true)
    expect(posture.summary).toContain('billed')
  })

  it('reports a pause ahead of attack mode, since it is the riskier state', () => {
    const store = fixture()
    store.enableAttackMode({ reason: 'spike' })
    store.pauseMitigations({ reason: 'proxy' })
    expect(describePosture(store.current()).summary).toContain('paused')
  })
})

describe('applying controls to rate limits', () => {
  const rules: RateLimitRule[] = [
    { id: 'global', limit: 600, windowMs: 60_000, burst: 100, action: 'deny' },
    { id: 'api', limit: 120, windowMs: 60_000, burst: 30 },
  ]

  it('leaves rules alone in the normal posture', () => {
    expect(applyControlsToRateLimits(rules, fixture().current())).toEqual(rules)
  })

  it('challenges rather than tightening the numbers under attack mode', () => {
    const store = fixture()
    store.enableAttackMode({ reason: 'spike' })
    const applied = applyControlsToRateLimits(rules, store.current())
    // A limit low enough to stop an attack by counting also stops real users.
    expect(applied[1].action).toBe('challenge')
    expect(applied[1].limit).toBe(120)
  })

  it('keeps an explicit deny a deny', () => {
    const store = fixture()
    store.enableAttackMode({ reason: 'spike' })
    expect(applyControlsToRateLimits(rules, store.current())[0].action).toBe('deny')
  })

  it('still allows a small burst so API clients are not broken on the first call', () => {
    const store = fixture()
    store.enableAttackMode({ reason: 'spike' })
    expect(applyControlsToRateLimits(rules, store.current())[0].burst).toBe(5)
  })

  it('disables the rules outright when mitigation is paused', () => {
    const store = fixture()
    store.pauseMitigations({ reason: 'proxy' })
    expect(applyControlsToRateLimits(rules, store.current()).every((rule) => rule.enabled === false)).toBe(true)
  })
})

describe('applying controls to the firewall', () => {
  it('merges the operator IP rules into the generated ruleset', () => {
    const store = fixture()
    store.addIpRule('allow', '10.0.0.0/8')
    store.addIpRule('block', '203.0.113.0/24')
    const config = applyControlsToDdos({ ports: [80, 443] }, store.current())
    const ruleset = renderNftablesRuleset(config)
    expect(ruleset).toContain('10.0.0.0/8')
    expect(ruleset).toContain('203.0.113.0/24')
  })

  it('tightens per-source limits under attack mode', () => {
    const store = fixture()
    store.enableAttackMode({ reason: 'spike' })
    const config = applyControlsToDdos({ thresholds: { newConnectionsPerSecond: 50, concurrentPerSource: 100 } }, store.current())
    expect(config.thresholds?.newConnectionsPerSecond).toBe(10)
    expect(config.thresholds?.concurrentPerSource).toBe(20)
  })

  it('never tightens a limit below one', () => {
    const store = fixture()
    store.enableAttackMode({ reason: 'spike' })
    const config = applyControlsToDdos({ thresholds: { newConnectionsPerSecond: 2 } }, store.current())
    expect(config.thresholds?.newConnectionsPerSecond).toBe(1)
  })

  it('switches to monitoring rather than removing rules when paused', () => {
    const store = fixture()
    store.pauseMitigations({ reason: 'proxy' })
    const config = applyControlsToDdos({ ports: [80] }, store.current())
    // Counters stay useful for deciding whether it is safe to resume.
    expect(config.monitorOnly).toBe(true)
    expect(renderNftablesRuleset(config)).toContain('counter\n')
  })
})

describe('persistence', () => {
  it('survives a restart', () => {
    const controlPlane = new ControlPlaneStore({ path: ':memory:' })
    stores.push(controlPlane)
    new ProtectionControlStore(controlPlane, { now: () => NOW }).enableAttackMode({ reason: 'spike' })
    expect(new ProtectionControlStore(controlPlane, { now: () => NOW }).current().attackMode).toBeDefined()
  })

  it('ignores a malformed record rather than trusting it', () => {
    const controlPlane = new ControlPlaneStore({ path: ':memory:' })
    stores.push(controlPlane)
    controlPlane.setSetting('protection.controls', 'nonsense')
    const store = new ProtectionControlStore(controlPlane, { now: () => NOW })
    expect(store.current()).toEqual({ attackMode: undefined, mitigationPause: undefined, ipRules: { allow: [], block: [] } })
  })
})
