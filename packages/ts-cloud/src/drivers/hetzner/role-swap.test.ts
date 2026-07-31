import { describe, expect, it } from 'bun:test'
import { canMigrateTo, fits, planRoleSwap, resizeAdvice, type SwapServer } from './role-swap'

/**
 * Swapping two servers' roles is the answer when a server type has been retired
 * and the instance you hold is the only one you will get. The plan is checked
 * before anything is powered off, because the failure modes all share a shape:
 * both boxes down, addresses detached, and the reason only visible halfway
 * through.
 */
function server(overrides: Partial<SwapServer> = {}): SwapServer {
  return {
    id: 1,
    name: 'alpha',
    datacenter: 'fsn1-dc14',
    serverType: 'cx33',
    diskSizeGb: 80,
    usedGb: 20,
    primaryIpId: 11,
    primaryIp: '10.0.0.1',
    ...overrides,
  }
}

const big = server({ id: 2, name: 'beta', serverType: 'cx43', diskSizeGb: 160, usedGb: 11, primaryIpId: 22, primaryIp: '10.0.0.2' })

describe('fits', () => {
  it('accepts a workload with room to restore', () => {
    expect(fits(11, 80)).toBe(true)
  })

  it('refuses a workload that only just fits', () => {
    // 70GB into an 80GB disk leaves nothing for the archive and its expansion.
    expect(fits(70, 80)).toBe(false)
  })

  it('refuses a workload larger than the disk', () => {
    expect(fits(100, 80)).toBe(false)
  })

  it('honours a caller-supplied margin', () => {
    expect(fits(70, 80, 1.0)).toBe(true)
  })
})

describe('planRoleSwap', () => {
  it('plans a swap between two compatible servers', () => {
    const plan = planRoleSwap(server(), big)

    expect(plan.ok).toBe(true)
    expect(plan.blockers).toEqual([])
  })

  it('powers both off before either address moves', () => {
    // Detaching one address while the other box is still up leaves a server
    // running that nobody can reach.
    const plan = planRoleSwap(server(), big)
    const firstUnassign = plan.steps.findIndex(s => s.kind === 'unassign-ip')
    const powerOffs = plan.steps.filter((s, i) => s.kind === 'power-off' && i < firstUnassign)

    expect(powerOffs).toHaveLength(2)
  })

  it('detaches both addresses before attaching either', () => {
    const plan = planRoleSwap(server(), big)
    const lastUnassign = plan.steps.map(s => s.kind).lastIndexOf('unassign-ip')
    const firstAssign = plan.steps.map(s => s.kind).indexOf('assign-ip')

    expect(firstAssign).toBeGreaterThan(lastUnassign)
  })

  it('crosses the addresses over', () => {
    const plan = planRoleSwap(server(), big)
    const assigns = plan.steps.filter(s => s.kind === 'assign-ip')

    expect(assigns.find(s => s.serverId === 2)?.ipId).toBe(11)
    expect(assigns.find(s => s.serverId === 1)?.ipId).toBe(22)
  })

  it('swaps the names so the console stops lying about which box serves what', () => {
    const plan = planRoleSwap(server(), big)
    const renames = plan.steps.filter(s => s.kind === 'rename')

    expect(renames.find(s => s.serverId === 1)?.name).toBe('beta')
    expect(renames.find(s => s.serverId === 2)?.name).toBe('alpha')
  })

  it('powers both back on last', () => {
    const plan = planRoleSwap(server(), big)

    expect(plan.steps.slice(-2).every(s => s.kind === 'power-on')).toBe(true)
  })

  it('refuses a swap across datacenters', () => {
    const elsewhere = server({ id: 2, name: 'beta', datacenter: 'nbg1-dc3', primaryIpId: 22 })
    const plan = planRoleSwap(server(), elsewhere)

    expect(plan.ok).toBe(false)
    expect(plan.blockers.join()).toContain('datacenters')
    expect(plan.steps).toEqual([])
  })

  it('refuses when a workload would not fit', () => {
    const full = server({ id: 2, name: 'beta', diskSizeGb: 160, usedGb: 120, primaryIpId: 22 })
    const plan = planRoleSwap(server({ diskSizeGb: 80 }), full)

    expect(plan.ok).toBe(false)
    expect(plan.blockers.join()).toContain('does not fit')
  })

  it('refuses when either server has no primary IP', () => {
    const plan = planRoleSwap(server({ primaryIpId: null, primaryIp: null }), big)

    expect(plan.ok).toBe(false)
    expect(plan.blockers.join()).toContain('primary IP')
  })

  it('refuses to swap a server with itself', () => {
    expect(planRoleSwap(server(), server()).ok).toBe(false)
  })

  it('reports every blocker at once rather than the first', () => {
    const bad = server({ id: 2, name: 'beta', datacenter: 'nbg1-dc3', primaryIpId: null, primaryIp: null, usedGb: 500 })
    const plan = planRoleSwap(server(), bad)

    expect(plan.blockers.length).toBeGreaterThanOrEqual(2)
  })

  it('emits no steps at all when blocked', () => {
    const plan = planRoleSwap(server(), server({ id: 2, datacenter: 'other', primaryIpId: 22 }))

    expect(plan.steps).toEqual([])
  })
})

describe('canMigrateTo', () => {
  it('reads available_for_migration, not available', () => {
    // The distinction that makes a doomed change_type look like bad luck.
    const dc = { server_types: { available_for_migration: [115] } }

    expect(canMigrateTo(dc, 115)).toBe(true)
    expect(canMigrateTo(dc, 116)).toBe(false)
  })

  it('treats a missing list as nothing migratable', () => {
    expect(canMigrateTo({}, 1)).toBe(false)
  })
})

describe('resizeAdvice', () => {
  it('says to retry when the type exists elsewhere', () => {
    expect(resizeAdvice({ targetType: 'cx43', migratableAnywhere: true, ownedInstances: 0 })).toContain('retry')
  })

  it('says to swap roles when the type is retired and one is already owned', () => {
    const advice = resizeAdvice({ targetType: 'cx43', migratableAnywhere: false, ownedInstances: 1 })

    expect(advice).toContain('swap roles')
    expect(advice).toContain('no more can be obtained')
  })

  it('says to choose another type when none is owned', () => {
    expect(resizeAdvice({ targetType: 'cx43', migratableAnywhere: false, ownedInstances: 0 })).toContain('Choose a type')
  })
})
