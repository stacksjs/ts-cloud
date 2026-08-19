import type { OperationPlan, OperationStep } from './plan'
import { describe, expect, it } from 'bun:test'
import { applyPlan, formatPlan, pendingSteps, planIsDestructive, resolvePlan } from './plan'

function step(overrides: Partial<OperationStep> & { id: string }): OperationStep {
  return {
    title: `step ${overrides.id}`,
    satisfied: async () => false,
    apply: async () => {},
    ...overrides,
  }
}

const plan = (steps: OperationStep[]): OperationPlan => ({ operation: 'server:rename', target: 'bughq', steps })

describe('resolvePlan', () => {
  it('separates what would run from what is already done', async () => {
    const resolved = await resolvePlan(
      plan([step({ id: 'a', satisfied: async () => true }), step({ id: 'b' })]),
    )
    expect(resolved.map(item => item.state)).toEqual(['satisfied', 'pending'])
    expect(pendingSteps(resolved).map(item => item.step.id)).toEqual(['b'])
  })

  /**
   * Not being able to check is a reason to run the step and say so, not a reason
   * to refuse the operator a plan.
   */
  it('marks a step whose check throws as unknown rather than failing the plan', async () => {
    const resolved = await resolvePlan(
      plan([step({ id: 'a', satisfied: async () => { throw new Error('token expired') } })]),
    )
    expect(resolved[0].state).toBe('unknown')
    expect(resolved[0].reason).toBe('token expired')
    // Unknown is never skipped.
    expect(pendingSteps(resolved)).toHaveLength(1)
  })
})

describe('formatPlan', () => {
  it('shows each change as from → to, in declaration order', async () => {
    const p = plan([
      step({ id: 'provider', title: 'Rename at the provider', change: { from: 'bughq', to: 'hq-production' } }),
      step({ id: 'inventory', title: 'Rename the record', satisfied: async () => true }),
    ])
    const lines = formatPlan(p, await resolvePlan(p)).join('\n')
    expect(lines).toContain('server:rename bughq')
    expect(lines).toContain('→   Rename at the provider')
    expect(lines).toContain('bughq → hq-production')
    expect(lines).toContain('ok  Rename the record [already done]')
    expect(lines).toContain('1 step(s) would run')
  })

  it('says so plainly when a fully-applied operation is re-run', async () => {
    const p = plan([step({ id: 'a', satisfied: async () => true })])
    expect(formatPlan(p, await resolvePlan(p)).join('\n')).toContain('Nothing to do')
  })

  it('names the confirmation an irreversible step needs', async () => {
    const p = plan([step({ id: 'delete', title: 'Delete the drained server', destructive: true })])
    expect(formatPlan(p, await resolvePlan(p)).join('\n')).toContain('1 irreversible — re-run with --confirm bughq')
  })

  it('does not demand confirmation for an irreversible step that is already done', async () => {
    const p = plan([step({ id: 'delete', destructive: true, satisfied: async () => true })])
    const resolved = await resolvePlan(p)
    expect(planIsDestructive(resolved)).toBe(false)
  })
})

describe('applyPlan', () => {
  it('runs pending steps and skips satisfied ones', async () => {
    const ran: string[] = []
    const p = plan([
      step({ id: 'a', satisfied: async () => true, apply: async () => { ran.push('a') } }),
      step({ id: 'b', apply: async () => { ran.push('b') } }),
    ])
    const outcome = await applyPlan(p, await resolvePlan(p))
    expect(ran).toEqual(['b'])
    expect(outcome.success).toBe(true)
    expect(outcome.steps.map(s => s.state)).toEqual(['skipped', 'applied'])
  })

  /**
   * A topology change half-applied and reported is recoverable; one silently
   * rolled back to a state nobody has verified is not.
   */
  it('stops at the first failure and leaves earlier steps applied', async () => {
    const ran: string[] = []
    const p = plan([
      step({ id: 'a', apply: async () => { ran.push('a') } }),
      step({ id: 'b', apply: async () => { throw new Error('provider said no') } }),
      step({ id: 'c', apply: async () => { ran.push('c') } }),
    ])
    const outcome = await applyPlan(p, await resolvePlan(p))
    expect(ran).toEqual(['a'])
    expect(outcome.success).toBe(false)
    expect(outcome.steps.map(s => s.state)).toEqual(['applied', 'failed'])
    expect(outcome.steps[1].error).toBe('provider said no')
  })

  it('re-runs as a clean no-op once everything is satisfied', async () => {
    let applied = false
    const p = plan([step({ id: 'a', satisfied: async () => applied, apply: async () => { applied = true } })])
    expect((await applyPlan(p, await resolvePlan(p))).steps[0].state).toBe('applied')
    expect((await applyPlan(p, await resolvePlan(p))).steps[0].state).toBe('skipped')
  })

  it('refuses an irreversible step without the exact target as confirmation', async () => {
    const p = plan([step({ id: 'delete', destructive: true })])
    const resolved = await resolvePlan(p)
    await expect(applyPlan(p, resolved)).rejects.toThrow('--confirm bughq')
    await expect(applyPlan(p, resolved, { confirm: 'wrong' })).rejects.toThrow('--confirm bughq')
    expect((await applyPlan(p, resolved, { confirm: 'bughq' })).success).toBe(true)
  })

  /**
   * The start is recorded before the step runs, because a run that dies mid-step
   * is exactly the case an operator is trying to reconstruct afterwards.
   */
  it('audits each step starting and finishing', async () => {
    const events: string[] = []
    const p = plan([step({ id: 'a' }), step({ id: 'b', apply: async () => { throw new Error('boom') } })])
    await applyPlan(p, await resolvePlan(p), { audit: e => events.push(`${e.step}:${e.state}`) })
    expect(events).toEqual(['a:started', 'a:applied', 'b:started', 'b:failed'])
  })
})
