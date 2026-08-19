import type { Budget, BudgetThreshold, BudgetWindow } from './model'
import { describe, expect, it } from 'bun:test'
import { evaluateBudget, governingLimitCents, mergeDecisions, MIN_PROJECTION_CONFIDENCE } from './evaluator'
import { isOperationAllowed, planEnforcement, strongestActiveAction } from './enforcement'
import { formatTimeToExhaustion, percentOfLimit, projectSpend } from './projection'

const HOUR = 3_600_000

function window(elapsedHours: number, totalHours: number = 720): BudgetWindow {
  const start = new Date('2026-07-01T00:00:00Z')
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + totalHours * HOUR).toISOString(),
    elapsedMs: elapsedHours * HOUR,
    totalMs: totalHours * HOUR,
    label: 'July 2026',
  }
}

/** A flat cost series: `hours` buckets each costing `perHour` cents. */
function flatSeries(hours: number, perHour: number): Array<{ bucketStart: string; costCents: number }> {
  const start = new Date('2026-07-01T00:00:00Z').getTime()
  return Array.from({ length: hours }, (_, index) => ({
    bucketStart: new Date(start + index * HOUR).toISOString(),
    costCents: perHour,
  }))
}

function budget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: 'budget-1',
    organizationId: 'org-1',
    name: 'Monthly',
    period: 'monthly',
    timezone: 'UTC',
    currency: 'USD',
    hardLimitCents: 100_000,
    thresholds: [
      { atPercent: 80, actions: ['notify'] },
      { atPercent: 100, actions: ['notify', 'block_builds', 'block_deployments'] },
      { atPercent: 120, actions: ['notify', 'block_builds', 'block_deployments', 'throttle_requests'] },
    ] satisfies BudgetThreshold[],
    meters: [],
    graceSeconds: 0,
    hysteresisPercent: 10,
    dryRun: false,
    enabled: true,
    version: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('projection', () => {
  it('extrapolates a flat burn to the end of the window', () => {
    const projection = projectSpend({ window: window(360), actualCents: 50_000, series: flatSeries(360, 138.9) })
    expect(projection.projectedCents).toBeGreaterThan(95_000)
    expect(projection.projectedCents).toBeLessThan(105_000)
  })

  it('reports low confidence early in a window and high confidence late', () => {
    const early = projectSpend({ window: window(1), actualCents: 500, series: flatSeries(1, 500) })
    const late = projectSpend({ window: window(700), actualCents: 90_000, series: flatSeries(700, 128) })
    expect(early.confidence).toBeLessThan(MIN_PROJECTION_CONFIDENCE)
    expect(late.confidence).toBeGreaterThan(0.9)
  })

  it('reacts to a late spike rather than averaging it away', () => {
    const quiet = flatSeries(200, 10)
    const spiking = [...quiet, ...flatSeries(10, 5_000)]
    const flat = projectSpend({ window: window(210), actualCents: 52_000, series: quiet, recencyWeight: 0 })
    const weighted = projectSpend({ window: window(210), actualCents: 52_000, series: spiking })
    expect(weighted.projectedCents).toBeGreaterThan(flat.projectedCents * 2)
  })

  it('predicts when a limit will be hit, and only when it will be hit in-window', () => {
    const soon = projectSpend({
      window: window(360),
      actualCents: 90_000,
      series: flatSeries(360, 250),
      limitCents: 100_000,
    })
    expect(soon.exhaustionAt).toBeDefined()
    expect(formatTimeToExhaustion(soon.timeToExhaustionMs)).toMatch(/^\d+[dhm]/)

    const never = projectSpend({
      window: window(360),
      actualCents: 100,
      series: flatSeries(360, 0.3),
      limitCents: 100_000,
    })
    expect(never.exhaustionAt).toBeUndefined()
  })

  it('reports an already-exhausted budget as exhausted now', () => {
    const projection = projectSpend({
      window: window(360),
      actualCents: 120_000,
      series: flatSeries(360, 333),
      limitCents: 100_000,
    })
    expect(projection.timeToExhaustionMs).toBe(0)
    expect(formatTimeToExhaustion(projection.timeToExhaustionMs)).toBe('now')
  })

  it('treats a zero limit as fully consumed rather than dividing by zero', () => {
    expect(percentOfLimit(10, 0)).toBe(Infinity)
    expect(percentOfLimit(0, 0)).toBe(0)
    expect(percentOfLimit(10, undefined)).toBe(0)
  })
})

describe('threshold ladder', () => {
  it('stays quiet below the first threshold', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 40_000 })
    expect(decision.level).toBe('ok')
    expect(decision.actions).toEqual([])
    expect(evaluateBudget({ budget: budget(), window: window(360), actualCents: 60_000 }).level).toBe('warning')
  })

  it('notifies at 80% without enforcing', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 85_000 })
    expect(decision.actions).toEqual(['notify'])
    expect(decision.level).not.toBe('hard_capped')
  })

  it('blocks builds and deploys at the hard limit', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 100_000 })
    expect(decision.actions).toEqual(['notify', 'block_builds', 'block_deployments'])
    expect(decision.level).toBe('hard_capped')
  })

  it('escalates past the limit', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 130_000 })
    expect(decision.actions).toContain('throttle_requests')
  })

  it('orders actions from least to most disruptive', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 130_000 })
    expect(decision.actions).toEqual(['notify', 'block_builds', 'block_deployments', 'throttle_requests'])
  })

  it('measures percentages against the hard limit when both limits exist', () => {
    const both = budget({ softLimitCents: 50_000, hardLimitCents: 100_000 })
    expect(governingLimitCents(both)).toBe(100_000)
    const decision = evaluateBudget({ budget: both, window: window(360), actualCents: 50_000 })
    expect(decision.usedPercent).toBe(50)
    expect(decision.level).toBe('soft_capped')
  })
})

describe('projection-based thresholds', () => {
  const projecting = budget({
    thresholds: [{ atPercent: 100, actions: ['notify', 'block_builds'], onProjection: true }],
  })

  it('enforces on the forecast once the forecast is trustworthy', () => {
    const decision = evaluateBudget({
      budget: projecting,
      window: window(360),
      actualCents: 60_000,
      series: flatSeries(360, 167),
    })
    expect(decision.projection.confidence).toBeGreaterThanOrEqual(MIN_PROJECTION_CONFIDENCE)
    expect(decision.projectedPercent).toBeGreaterThan(100)
    expect(decision.actions).toContain('block_builds')
  })

  it('refuses to enforce on a forecast built from ten minutes of data', () => {
    const decision = evaluateBudget({
      budget: projecting,
      window: window(0.2),
      actualCents: 500,
      series: flatSeries(1, 500),
    })
    expect(decision.projectedPercent).toBeGreaterThan(100)
    expect(decision.projection.confidence).toBeLessThan(MIN_PROJECTION_CONFIDENCE)
    expect(decision.actions).toEqual([])
  })

  it('still notifies on an untrusted forecast, because a warning is free', () => {
    const notifying = budget({ thresholds: [{ atPercent: 100, actions: ['notify'], onProjection: true }] })
    const decision = evaluateBudget({
      budget: notifying,
      window: window(0.2),
      actualCents: 500,
      series: flatSeries(1, 500),
    })
    expect(decision.actions).toEqual(['notify'])
  })
})

describe('grace period', () => {
  const graced = budget({ graceSeconds: 300 })
  const now = new Date('2026-07-16T00:00:00Z')

  it('holds enforcement while the breach is younger than the grace period', () => {
    const decision = evaluateBudget({
      budget: graced,
      window: window(360),
      actualCents: 110_000,
      breachingSince: new Date(now.getTime() - 60_000).toISOString(),
      now,
    })
    expect(decision.actions).toEqual(['notify'])
    expect(decision.breaches.length).toBeGreaterThan(0)
  })

  it('enforces once the breach has persisted', () => {
    const decision = evaluateBudget({
      budget: graced,
      window: window(360),
      actualCents: 110_000,
      breachingSince: new Date(now.getTime() - 600_000).toISOString(),
      now,
    })
    expect(decision.actions).toContain('block_deployments')
  })
})

describe('hysteresis', () => {
  it('keeps an action in force while spend hovers just under its threshold', () => {
    const decision = evaluateBudget({
      budget: budget(),
      window: window(360),
      actualCents: 96_000, // 96%, under the 100% rung but inside the 10% margin
      activeActions: ['block_builds', 'block_deployments'],
    })
    // The 80% rung still notifies; what matters is that nothing is lifted.
    expect(decision.actions).toEqual(['notify'])
    expect(decision.releases).toEqual([])
  })

  it('releases once spend falls clear of the margin', () => {
    const decision = evaluateBudget({
      budget: budget(),
      window: window(360),
      actualCents: 85_000, // 85% <= 100% * 0.9
      activeActions: ['block_builds', 'block_deployments'],
    })
    expect(decision.releases).toEqual(['block_builds', 'block_deployments'])
  })

  it('releases an action no rung arms any more', () => {
    const decision = evaluateBudget({
      budget: budget({ thresholds: [{ atPercent: 100, actions: ['notify'] }] }),
      window: window(360),
      actualCents: 10_000,
      activeActions: ['suspend_project'],
    })
    expect(decision.releases).toEqual(['suspend_project'])
  })
})

describe('dry run', () => {
  it('reports what would happen but strips every enforcing action', () => {
    const decision = evaluateBudget({ budget: budget({ dryRun: true }), window: window(360), actualCents: 130_000 })
    expect(decision.simulated).toBe(true)
    expect(decision.actions).toEqual(['notify'])
    expect(decision.breaches.some((breach) => breach.actions.includes('throttle_requests'))).toBe(true)
  })
})

describe('overlapping budgets', () => {
  it('takes the strictest action set and the worst level', () => {
    const org = evaluateBudget({ budget: budget({ id: 'org' }), window: window(360), actualCents: 130_000 })
    const project = evaluateBudget({
      budget: budget({ id: 'proj', hardLimitCents: 1_000_000 }),
      window: window(360),
      actualCents: 130_000,
    })
    const merged = mergeDecisions([project, org])
    expect(merged.actions).toContain('throttle_requests')
    expect(merged.level).toBe('hard_capped')
  })

  it('does not release an action another budget still wants', () => {
    const releasing = evaluateBudget({
      budget: budget({ id: 'a', hardLimitCents: 1_000_000 }),
      window: window(360),
      actualCents: 10_000,
      activeActions: ['block_builds'],
    })
    const holding = evaluateBudget({ budget: budget({ id: 'b' }), window: window(360), actualCents: 130_000 })
    const merged = mergeDecisions([releasing, holding])
    expect(merged.releases).toEqual([])
    expect(merged.actions).toContain('block_builds')
  })
})

describe('enforcement planning', () => {
  it('applies least-disruptive-first and releases most-disruptive-first', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 130_000 })
    const plan = planEnforcement({ ...decision, releases: ['block_builds', 'suspend_project'] })
    expect(plan.apply.map((step) => step.action)).toEqual([
      'notify',
      'block_builds',
      'block_deployments',
      'throttle_requests',
    ])
    expect(plan.release.map((step) => step.action)).toEqual(['suspend_project', 'block_builds'])
  })

  it('withholds user-visible actions on production but still applies the invisible ones', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 130_000 })
    const plan = planEnforcement(decision, { environmentKind: 'production' })
    expect(plan.apply.map((step) => step.action)).toEqual(['notify', 'block_builds', 'block_deployments'])
    expect(plan.withheld.map((step) => step.action)).toEqual(['throttle_requests'])
  })

  it('applies visible actions unattended on a preview environment', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 130_000 })
    const plan = planEnforcement(decision, { environmentKind: 'preview' })
    expect(plan.apply.map((step) => step.action)).toContain('throttle_requests')
  })

  it('honours an explicit automatic ceiling', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 130_000 })
    const plan = planEnforcement(decision, { maxAutomaticAction: 'block_builds' })
    expect(plan.apply.map((step) => step.action)).toEqual(['notify', 'block_builds'])
    expect(plan.withheld.map((step) => step.action)).toEqual(['block_deployments', 'throttle_requests'])
  })

  it('never requires approval to lift an action', () => {
    const decision = evaluateBudget({ budget: budget(), window: window(360), actualCents: 10_000 })
    const plan = planEnforcement({ ...decision, releases: ['suspend_project'] }, { environmentKind: 'production' })
    expect(plan.release[0]).toMatchObject({ action: 'suspend_project', requiresApproval: false })
  })
})

describe('operation gating', () => {
  const record = (action: string, state = 'active', simulated = false): any => ({ action, state, simulated })

  it('blocks the operations an action targets and nothing else', () => {
    const active = [record('block_builds')]
    expect(isOperationAllowed('build', active)).toMatchObject({ allowed: false, blockedBy: 'block_builds' })
    expect(isOperationAllowed('deploy', active).allowed).toBe(true)
    expect(isOperationAllowed('request', active).allowed).toBe(true)
  })

  it('lets a suspended project block everything', () => {
    const active = [record('suspend_project')]
    for (const operation of ['build', 'deploy', 'function_invoke', 'request'] as const)
      expect(isOperationAllowed(operation, active).allowed).toBe(false)
  })

  it('ignores simulated and non-active enforcement', () => {
    expect(isOperationAllowed('build', [record('block_builds', 'active', true)]).allowed).toBe(true)
    expect(isOperationAllowed('build', [record('block_builds', 'pending')]).allowed).toBe(true)
    expect(isOperationAllowed('build', [record('block_builds', 'released')]).allowed).toBe(true)
  })

  it('reports the strongest live action', () => {
    expect(strongestActiveAction([record('block_builds'), record('suspend_functions'), record('notify')])).toBe(
      'suspend_functions',
    )
    expect(strongestActiveAction([record('block_builds', 'released')])).toBeUndefined()
  })
})
