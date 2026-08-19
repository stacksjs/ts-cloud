import type { ServerRenameEffects } from './server-rename'
import { describe, expect, it } from 'bun:test'
import { applyPlan, formatPlan, resolvePlan } from './plan'
import { buildSetHostnameScript, planServerRename, validateServerName } from './server-rename'

/** A fully-capable server: provider record, state pin, reachable box, inventory. */
function world(name = 'bughq') {
  const state = { provider: name, pin: name, hostname: name, inventory: name, taken: [name, 'statushq'] }
  const effects: ServerRenameEffects = {
    takenNames: async () => state.taken,
    providerName: async () => state.provider,
    renameProvider: async (next) => { state.provider = next },
    stateName: async () => state.pin,
    writeStateName: async (next) => { state.pin = next },
    remoteHostname: async () => state.hostname,
    setRemoteHostname: async (next) => { state.hostname = next },
    inventoryName: () => state.inventory,
    renameInventory: (next) => { state.inventory = next },
  }
  return { state, effects }
}

describe('validateServerName', () => {
  it('accepts a hostname', () => {
    expect(() => validateServerName('hq-production-server')).not.toThrow()
    expect(() => validateServerName('hq.example.com')).not.toThrow()
  })

  it('refuses what a provider or /etc/hostname would refuse', () => {
    expect(() => validateServerName('')).toThrow('cannot be empty')
    expect(() => validateServerName('-leading')).toThrow('not a valid hostname label')
    expect(() => validateServerName('trailing-')).toThrow('not a valid hostname label')
    expect(() => validateServerName('under_score')).toThrow('not a valid hostname label')
    expect(() => validateServerName('a..b')).toThrow('empty label')
    expect(() => validateServerName(`${'a'.repeat(64)}.com`)).toThrow('63 characters')
  })
})

describe('planServerRename preconditions', () => {
  it('refuses a name another server already holds', async () => {
    await expect(planServerRename('bughq', 'statushq', world().effects)).rejects.toThrow('already taken')
  })

  it('refuses a no-op rename', async () => {
    await expect(planServerRename('bughq', 'bughq', world().effects)).rejects.toThrow('already named that')
  })

  /**
   * A precondition is not a unit of work: an illegal name must fail before the
   * plan exists, not on its first step with the provider already renamed.
   */
  it('refuses an illegal name before building any step', async () => {
    await expect(planServerRename('bughq', 'not_a_hostname', world().effects)).rejects.toThrow('valid hostname')
  })
})

describe('planServerRename', () => {
  it('covers all four records, provider before the state pin', async () => {
    const plan = await planServerRename('bughq', 'hq-production-server', world().effects)
    expect(plan.steps.map(step => step.id)).toEqual(['provider', 'state-pin', 'hostname', 'inventory'])
  })

  it('renames every record when applied', async () => {
    const { state, effects } = world()
    const plan = await planServerRename('bughq', 'hq-production-server', effects)
    const outcome = await applyPlan(plan, await resolvePlan(plan))
    expect(outcome.success).toBe(true)
    expect(state).toMatchObject({
      provider: 'hq-production-server',
      pin: 'hq-production-server',
      hostname: 'hq-production-server',
      inventory: 'hq-production-server',
    })
  })

  it('needs no confirmation — a rename is undone by renaming back', async () => {
    const plan = await planServerRename('bughq', 'hq-production-server', world().effects)
    expect(plan.steps.some(step => step.destructive)).toBe(false)
  })

  /**
   * The point of resumability: a rename that died after the provider call is
   * re-run, and the provider step skips itself instead of being attempted again.
   */
  it('resumes a half-finished rename without redoing the finished half', async () => {
    const { state, effects } = world()
    state.provider = 'hq-production-server'
    let providerCalls = 0
    const plan = await planServerRename('bughq', 'hq-production-server', {
      ...effects,
      renameProvider: async (next) => { providerCalls++; state.provider = next },
    })
    const resolved = await resolvePlan(plan)
    expect(resolved[0].state).toBe('satisfied')
    const outcome = await applyPlan(plan, resolved)
    expect(providerCalls).toBe(0)
    expect(outcome.steps[0].state).toBe('skipped')
    expect(state.inventory).toBe('hq-production-server')
  })

  it('is a clean no-op when re-run after finishing', async () => {
    const { effects } = world()
    const plan = await planServerRename('bughq', 'hq-production-server', effects)
    await applyPlan(plan, await resolvePlan(plan))
    const again = await resolvePlan(plan)
    expect(formatPlan(plan, again).join('\n')).toContain('Nothing to do')
  })

  /**
   * A server enrolled by hand has no provider record, a project deploying purely
   * from labels has no pin, and an unpinned host key means no SSH. Each missing
   * capability drops its step rather than failing the rename.
   */
  it('drops the steps whose capability is missing', async () => {
    const { state } = world()
    const plan = await planServerRename('bughq', 'hq-production-server', {
      takenNames: async () => state.taken,
      inventoryName: () => state.inventory,
      renameInventory: (next) => { state.inventory = next },
    })
    expect(plan.steps.map(step => step.id)).toEqual(['inventory'])
    expect((await applyPlan(plan, await resolvePlan(plan))).success).toBe(true)
    expect(state.inventory).toBe('hq-production-server')
  })

  /** A project with no pin at all must not gain one it never asked for. */
  it('treats an absent state pin as nothing to update', async () => {
    const { state, effects } = world()
    let wrote = false
    const plan = await planServerRename('bughq', 'hq-production-server', {
      ...effects,
      stateName: async () => undefined,
      writeStateName: async () => { wrote = true },
    })
    await applyPlan(plan, await resolvePlan(plan))
    expect(wrote).toBe(false)
    expect(state.inventory).toBe('hq-production-server')
  })
})

describe('buildSetHostnameScript', () => {
  it('sets the hostname persistently with a fallback', () => {
    const script = buildSetHostnameScript('hq-production-server')
    expect(script).toContain("hostnamectl set-hostname 'hq-production-server'")
    expect(script).toContain('/etc/hostname')
  })

  /** Two 127.0.1.1 lines would leave the box resolving its own name two ways. */
  it('replaces the existing 127.0.1.1 line rather than appending a second', () => {
    const script = buildSetHostnameScript('hq-production-server')
    expect(script).toContain('s/^127\\.0\\.1\\.1.*/127.0.1.1\\thq-production-server/')
    expect(script).toContain('if grep -q "127.0.1.1" /etc/hosts; then')
  })
})
