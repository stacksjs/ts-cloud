import type { EnforcementAction, UsageDelta } from './model'
import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { runEnforcement, planEnforcement } from './enforcement'
import { evaluateBudget } from './evaluator'
import { SpendService } from './service'
import { DEFAULT_THRESHOLDS, SpendStore } from './store'

const HOUR = 3_600_000
const stores: ControlPlaneStore[] = []

function fixture(now: Date = new Date('2026-07-16T12:00:00Z')) {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  stores.push(controlPlane)
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'app', name: 'App' })
  const environment = controlPlane.createEnvironment({
    projectId: project.id,
    slug: 'production',
    name: 'Production',
    kind: 'production',
  })
  const store = new SpendStore(controlPlane, { now: () => now })
  return { controlPlane, organization, project, environment, store, service: new SpendService(store), now }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function egress(organizationId: string, projectId: string, gigabytes: number, at: string): UsageDelta {
  return {
    organizationId,
    projectId,
    provider: 'aws',
    region: 'us-east-1',
    meter: 'edge.egress_gb',
    quantity: gigabytes,
    timestamp: at,
  }
}

describe('schema', () => {
  it('creates the spend tables at the current schema version', () => {
    const { controlPlane } = fixture()
    const tables = controlPlane.database
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'spend_%' ORDER BY name")
      .all() as Array<{ name: string }>
    expect(tables.map((row) => row.name)).toEqual([
      'spend_anomalies',
      'spend_budgets',
      'spend_decisions',
      'spend_enforcements',
      'spend_usage',
      'spend_usage_receipts',
    ])
  })
})

describe('budget records', () => {
  it('requires at least one limit', () => {
    const { store, organization } = fixture()
    expect(() => store.createBudget({ organizationId: organization.id, name: 'No limit', period: 'monthly' })).toThrow(
      'soft limit, a hard limit, or both',
    )
  })

  it('rejects a soft limit above the hard limit', () => {
    const { store, organization } = fixture()
    expect(() =>
      store.createBudget({
        organizationId: organization.id,
        name: 'Backwards',
        period: 'monthly',
        softLimitCents: 200,
        hardLimitCents: 100,
      }),
    ).toThrow('must not exceed')
  })

  it('rejects an unknown timezone rather than silently billing in UTC', () => {
    const { store, organization } = fixture()
    expect(() =>
      store.createBudget({
        organizationId: organization.id,
        name: 'Mars',
        period: 'monthly',
        hardLimitCents: 100,
        timezone: 'Mars/Olympus',
      }),
    ).toThrow('Unknown timezone')
  })

  it('requires an environment budget to name its project', () => {
    const { store, organization, environment } = fixture()
    expect(() =>
      store.createBudget({
        organizationId: organization.id,
        environmentId: environment.id,
        name: 'Env only',
        period: 'monthly',
        hardLimitCents: 100,
      }),
    ).toThrow('must also name its project')
  })

  it('applies the default ladder when none is supplied', () => {
    const { store, organization } = fixture()
    const budget = store.createBudget({
      organizationId: organization.id,
      name: 'Default',
      period: 'monthly',
      hardLimitCents: 10_000,
    })
    expect(budget.thresholds).toEqual([...DEFAULT_THRESHOLDS])
  })

  it('refuses a stale optimistic update', () => {
    const { store, organization } = fixture()
    const budget = store.createBudget({
      organizationId: organization.id,
      name: 'Default',
      period: 'monthly',
      hardLimitCents: 10_000,
    })
    store.updateBudget(budget.id, { hardLimitCents: 20_000 })
    expect(() => store.updateBudget(budget.id, { hardLimitCents: 30_000 }, budget.version)).toThrow('concurrently')
  })

  it('includes org-wide budgets when listing a project, so nothing looks uncapped', () => {
    const { store, organization, project } = fixture()
    store.createBudget({ organizationId: organization.id, name: 'Org', period: 'monthly', hardLimitCents: 100_000 })
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Project',
      period: 'monthly',
      hardLimitCents: 10_000,
    })
    expect(store.listBudgets({ organizationId: organization.id, projectId: project.id })).toHaveLength(2)
  })

  it('orders scope budgets broadest first', () => {
    const { store, organization, project, environment } = fixture()
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      name: 'Env',
      period: 'monthly',
      hardLimitCents: 1_000,
    })
    store.createBudget({ organizationId: organization.id, name: 'Org', period: 'monthly', hardLimitCents: 100_000 })
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Project',
      period: 'monthly',
      hardLimitCents: 10_000,
    })
    const scoped = store.budgetsForScope(organization.id, project.id, environment.id)
    expect(scoped.map((budget) => budget.name)).toEqual(['Org', 'Project', 'Env'])
  })

  it('excludes budgets scoped to a different project', () => {
    const { store, controlPlane, organization, project } = fixture()
    const other = controlPlane.createProject({ organizationId: organization.id, slug: 'other', name: 'Other' })
    store.createBudget({
      organizationId: organization.id,
      projectId: other.id,
      name: 'Other',
      period: 'monthly',
      hardLimitCents: 1_000,
    })
    expect(store.budgetsForScope(organization.id, project.id)).toHaveLength(0)
  })
})

describe('usage ingest', () => {
  it('rolls usage into hourly buckets and prices it', () => {
    const { store, organization, project } = fixture()
    const result = store.ingestUsage([
      { ...egress(organization.id, project.id, 60, '2026-07-16T10:05:00Z'), key: 'a' },
      { ...egress(organization.id, project.id, 60, '2026-07-16T10:45:00Z'), key: 'b' },
    ])
    expect(result.applied).toBe(2)
    // 120 GB with a 100 GB allowance = 20 GB at 8.5c.
    expect(result.costCents).toBeCloseTo(170, 4)
    const rollups = store.listRollups({
      organizationId: organization.id,
      from: '2026-07-16T00:00:00Z',
      to: '2026-07-17T00:00:00Z',
    })
    expect(rollups).toHaveLength(1)
    expect(rollups[0]).toMatchObject({ quantity: 120, sampleCount: 2, bucketStart: '2026-07-16T10:00:00.000Z' })
  })

  it('ignores a replayed delta instead of double-billing', () => {
    const { store, organization, project } = fixture()
    const delta = { ...egress(organization.id, project.id, 200, '2026-07-16T10:05:00Z'), key: 'stable-key' }
    const first = store.ingestUsage([delta])
    const second = store.ingestUsage([delta])
    expect(first.applied).toBe(1)
    expect(second).toMatchObject({ applied: 0, duplicates: 1, costCents: 0 })
    const summary = store.summarizeUsage({
      organizationId: organization.id,
      from: '2026-07-16T00:00:00Z',
      to: '2026-07-17T00:00:00Z',
    })
    expect(summary.byMeter[0].quantity).toBe(200)
  })

  it('derives a key when none is supplied, so identical batches still dedupe', () => {
    const { store, organization, project } = fixture()
    const delta = egress(organization.id, project.id, 50, '2026-07-16T10:05:00Z')
    store.ingestUsage([delta])
    expect(store.ingestUsage([delta]).duplicates).toBe(1)
  })

  it('crosses a free allowance exactly once across separate batches', () => {
    const { store, organization, project } = fixture()
    // 100 GB free, then 8.5c/GB. Three 50 GB batches = 50 billable = 425c.
    let total = 0
    for (let index = 0; index < 3; index++)
      total += store.ingestUsage([
        { ...egress(organization.id, project.id, 50, `2026-07-16T1${index}:00:00Z`), key: `k${index}` },
      ]).costCents
    expect(total).toBeCloseTo(425, 4)
  })

  it('resets the allowance at the month boundary', () => {
    const { store, organization, project } = fixture()
    store.ingestUsage([{ ...egress(organization.id, project.id, 150, '2026-06-20T10:00:00Z'), key: 'june' }])
    const july = store.ingestUsage([{ ...egress(organization.id, project.id, 90, '2026-07-02T10:00:00Z'), key: 'july' }])
    expect(july.costCents).toBe(0)
  })

  it('flags a meter with no price entry', () => {
    const { store, organization, project } = fixture()
    const result = store.ingestUsage([
      {
        organizationId: organization.id,
        projectId: project.id,
        meter: 'quantum.flux',
        quantity: 10,
        timestamp: '2026-07-16T10:00:00Z',
      },
    ])
    expect(result.unpricedMeters).toEqual(['quantum.flux'])
  })

  it('skips zero and non-finite quantities', () => {
    const { store, organization, project } = fixture()
    const result = store.ingestUsage([
      egress(organization.id, project.id, 0, '2026-07-16T10:00:00Z'),
      egress(organization.id, project.id, Number.NaN, '2026-07-16T10:00:00Z'),
    ])
    expect(result.applied).toBe(0)
  })

  it('summarizes per meter and emits an hourly cost series', () => {
    const { store, organization, project } = fixture()
    store.ingestUsage([
      { ...egress(organization.id, project.id, 200, '2026-07-16T10:00:00Z'), key: 'a' },
      {
        organizationId: organization.id,
        projectId: project.id,
        provider: 'aws',
        meter: 'edge.requests',
        quantity: 5_000_000,
        timestamp: '2026-07-16T11:00:00Z',
        key: 'b',
      },
    ])
    const summary = store.summarizeUsage({
      organizationId: organization.id,
      from: '2026-07-16T00:00:00Z',
      to: '2026-07-17T00:00:00Z',
    })
    expect(summary.byMeter.map((item) => item.meter)).toContain('edge.egress_gb')
    expect(summary.series).toHaveLength(2)
    expect(summary.totalCents).toBeGreaterThan(0)
  })

  it('prunes old rollups and receipts on different clocks', () => {
    const { store, organization, project } = fixture()
    store.ingestUsage([{ ...egress(organization.id, project.id, 10, '2026-01-01T00:00:00Z'), key: 'old' }])
    // Receipts age out after a week; rollups only after the retention window.
    expect(store.pruneUsage(90, new Date('2026-07-16T12:00:00Z'))).toEqual({ rollups: 1, receipts: 0 })
    expect(store.pruneUsage(90, new Date('2026-08-01T12:00:00Z'))).toEqual({ rollups: 0, receipts: 1 })
  })
})

describe('end-to-end cap', () => {
  async function capped(hardLimitCents: number, gigabytes: number, dryRun = false) {
    const now = new Date('2026-07-16T12:00:00Z')
    const context = fixture(now)
    const budget = context.store.createBudget({
      organizationId: context.organization.id,
      projectId: context.project.id,
      name: 'Egress cap',
      period: 'monthly',
      hardLimitCents,
      dryRun,
      thresholds: [
        { atPercent: 80, actions: ['notify'] },
        { atPercent: 100, actions: ['notify', 'block_builds', 'block_deployments'] },
      ],
    })
    // Spread usage across the elapsed part of the window so the series is real.
    const deltas: Array<UsageDelta & { key: string }> = []
    const start = new Date('2026-07-01T00:00:00Z').getTime()
    const hours = Math.floor((now.getTime() - start) / HOUR)
    for (let hour = 0; hour < hours; hour++)
      deltas.push({
        ...egress(context.organization.id, context.project.id, gigabytes / hours, new Date(start + hour * HOUR).toISOString()),
        key: `h${hour}`,
      })
    context.store.ingestUsage(deltas)
    return { ...context, budget }
  }

  it('leaves a project alone below the ladder', async () => {
    const { service, organization, project, budget, now } = await capped(1_000_000, 200)
    const result = await service.runCycle({ organizationId: organization.id, projectId: project.id, now })
    expect(result.actions).toEqual([])
    expect(result.statuses.find((status) => status.budget.id === budget.id)?.decision.level).not.toBe('hard_capped')
  })

  it('blocks builds and deploys once real spend passes the hard limit', async () => {
    const { service, organization, project, now } = await capped(500, 300)
    const result = await service.runCycle({ organizationId: organization.id, projectId: project.id, now })
    expect(result.level).toBe('hard_capped')
    expect(result.actions).toEqual(['notify', 'block_builds', 'block_deployments'])
  })

  it('records the decision so the history is auditable', async () => {
    const { service, store, organization, project, budget, now } = await capped(500, 300)
    await service.runCycle({ organizationId: organization.id, projectId: project.id, now })
    const decisions = store.listDecisions(budget.id)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ level: 'hard_capped' })
  })

  it('reports a dry-run cap without enforcing it', async () => {
    const { service, organization, project, now } = await capped(500, 300, true)
    const applied: EnforcementAction[] = []
    const result = await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now,
      handlers: {
        apply: (action) => {
          applied.push(action)
          return {}
        },
        release: () => {},
      },
    })
    expect(result.actions).toEqual(['notify'])
    expect(applied).toEqual([])
    expect(result.enforcement[0].applied.every((record) => record.simulated)).toBe(true)
  })

  it('applies and then lifts enforcement as spend recovers', async () => {
    const { service, store, organization, project, budget, now } = await capped(500, 300)
    const applied: EnforcementAction[] = []
    const released: EnforcementAction[] = []
    const handlers = {
      apply: (action: EnforcementAction) => {
        applied.push(action)
        return { previous: 'enabled' as const }
      },
      release: (action: EnforcementAction) => {
        released.push(action)
      },
    }
    await service.runCycle({ organizationId: organization.id, projectId: project.id, now, handlers })
    expect(applied).toContain('block_deployments')
    expect(store.listEnforcements({ organizationId: organization.id, activeOnly: true })).toHaveLength(3)

    // Raise the cap far above spend: the ladder should unwind.
    store.updateBudget(budget.id, { hardLimitCents: 100_000_000 })
    await service.runCycle({ organizationId: organization.id, projectId: project.id, now, handlers })
    expect(released).toContain('block_deployments')
    expect(store.listEnforcements({ organizationId: organization.id, activeOnly: true })).toHaveLength(0)
  })

  it('does not re-apply an enforcement that is already live', async () => {
    const { service, organization, project, now } = await capped(500, 300)
    const applied: EnforcementAction[] = []
    const handlers = {
      apply: (action: EnforcementAction) => {
        applied.push(action)
        return {}
      },
      release: () => {},
    }
    await service.runCycle({ organizationId: organization.id, projectId: project.id, now, handlers })
    const first = applied.length
    await service.runCycle({ organizationId: organization.id, projectId: project.id, now, handlers })
    expect(applied).toHaveLength(first)
  })

  it('leaves a failed apply visibly failed rather than pretending the cap is on', async () => {
    const { store, budget, now } = await capped(500, 300)
    const { window, summary } = store.budgetSpendCents(budget, now)
    const decision = evaluateBudget({ budget, window, actualCents: summary.totalCents, series: summary.series, now })
    const plan = planEnforcement(decision)
    const result = await runEnforcement(store, budget, decision, plan, {
      apply: (action) => {
        if (action === 'block_deployments') throw new Error('driver unreachable')
        return {}
      },
      release: () => {},
    })
    expect(result.failed).toEqual([{ action: 'block_deployments', error: 'driver unreachable' }])
    expect(store.activeEnforcement(budget.id, 'block_deployments')).toBeUndefined()
    expect(store.activeEnforcement(budget.id, 'block_builds')?.state).toBe('active')
  })

  it('keeps an action in force when lifting it fails', async () => {
    const { service, store, organization, project, budget, now } = await capped(500, 300)
    await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now,
      handlers: { apply: () => ({}), release: () => {} },
    })
    store.updateBudget(budget.id, { hardLimitCents: 100_000_000 })
    const result = await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now,
      handlers: {
        apply: () => ({}),
        release: () => {
          throw new Error('gateway timeout')
        },
      },
    })
    expect(result.enforcement[0].failed.length).toBeGreaterThan(0)
    const still = store.listEnforcements({ organizationId: organization.id, activeOnly: true })
    expect(still.every((record) => record.state === 'releasing')).toBe(true)
  })

  it('withholds user-visible actions on production', async () => {
    const { service, store, organization, project, budget, now } = await capped(500, 300)
    store.updateBudget(budget.id, {
      thresholds: [{ atPercent: 100, actions: ['notify', 'throttle_requests'] }],
    })
    const result = await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      environmentKind: 'production',
      now,
      handlers: { apply: () => ({}), release: () => {} },
    })
    expect(result.enforcement[0].withheld.map((step) => step.action)).toEqual(['throttle_requests'])
  })
})

describe('grace period across cycles', () => {
  it('holds the first cycle and enforces once the breach persists', async () => {
    const now = new Date('2026-07-16T12:00:00Z')
    const { store, service, organization, project } = fixture(now)
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Graced',
      period: 'monthly',
      hardLimitCents: 100,
      graceSeconds: 600,
      thresholds: [{ atPercent: 100, actions: ['notify', 'block_builds'] }],
    })
    store.ingestUsage([{ ...egress(organization.id, project.id, 300, '2026-07-16T10:00:00Z'), key: 'burst' }])
    const first = await service.runCycle({ organizationId: organization.id, projectId: project.id, now })
    expect(first.actions).toEqual(['notify'])
    const later = await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: new Date(now.getTime() + 15 * 60_000),
    })
    expect(later.actions).toContain('block_builds')
  })
})

describe('anomalies', () => {
  function seedFlatThenSpike(spikeCents: number) {
    const now = new Date('2026-07-15T12:00:00Z')
    const context = fixture(now)
    const deltas: Array<UsageDelta & { key: string }> = []
    // 10 days of a steady 1 GB/hour, then one hour with a large burst.
    const start = new Date('2026-07-05T12:00:00Z').getTime()
    // Detection only judges complete hours, so the spike goes in the last one
    // that closed before `now` rather than the hour `now` sits inside.
    const hours = Math.floor((now.getTime() - start) / HOUR)
    for (let hour = 0; hour < hours - 1; hour++)
      deltas.push({
        ...egress(context.organization.id, context.project.id, 20, new Date(start + hour * HOUR).toISOString()),
        key: `flat-${hour}`,
      })
    deltas.push({
      ...egress(
        context.organization.id,
        context.project.id,
        spikeCents,
        new Date(start + (hours - 1) * HOUR).toISOString(),
      ),
      key: 'spike',
    })
    context.store.ingestUsage(deltas)
    return context
  }

  it('flags an hour far outside its own seasonal history', () => {
    const { service, organization, project, now } = seedFlatThenSpike(20_000)
    const anomalies = service.detectAnomalies({ organizationId: organization.id, projectId: project.id, signals: ['cost'] }, now)
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]).toMatchObject({ signal: 'cost', direction: 'spike' })
    expect(anomalies[0].observed).toBeGreaterThan(anomalies[0].expected)
  })

  it('does not re-record the same anomaly on the next cycle', () => {
    const { service, store, organization, project, now } = seedFlatThenSpike(20_000)
    service.detectAnomalies({ organizationId: organization.id, projectId: project.id, signals: ['cost'] }, now)
    const second = service.detectAnomalies({ organizationId: organization.id, projectId: project.id, signals: ['cost'] }, now)
    expect(second).toEqual([])
    expect(store.listAnomalies({ organizationId: organization.id })).toHaveLength(1)
  })

  it('stays quiet on ordinary variation', () => {
    const { service, organization, project, now } = seedFlatThenSpike(21)
    expect(service.detectAnomalies({ organizationId: organization.id, projectId: project.id, signals: ['cost'] }, now)).toEqual([])
  })

  it('acknowledges an anomaly exactly once', () => {
    const { service, store, organization, project, now } = seedFlatThenSpike(20_000)
    const [anomaly] = service.detectAnomalies({ organizationId: organization.id, projectId: project.id, signals: ['cost'] }, now)
    expect(store.acknowledgeAnomaly(anomaly.id)).toBe(true)
    expect(store.acknowledgeAnomaly(anomaly.id)).toBe(false)
    expect(store.listAnomalies({ organizationId: organization.id, unacknowledgedOnly: true })).toEqual([])
  })
})

describe('usage report', () => {
  it('answers the question an agent actually asks: how much headroom is left', () => {
    const now = new Date('2026-07-16T12:00:00Z')
    const { store, service, organization, project } = fixture(now)
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Monthly',
      period: 'monthly',
      hardLimitCents: 10_000,
    })
    store.ingestUsage([{ ...egress(organization.id, project.id, 200, '2026-07-10T10:00:00Z'), key: 'a' }])
    const report = service.usageReport({ organizationId: organization.id, projectId: project.id, now }) as any
    expect(report.currency).toBe('USD')
    expect(report.window).toMatchObject({ start: '2026-07-01T00:00:00.000Z', label: 'July 2026' })
    expect(report.totalCents).toBeCloseTo(850, 4)
    expect(report.budgets[0]).toMatchObject({ name: 'Monthly', limitCents: 10_000 })
    expect(report.budgets[0].remainingCents).toBeCloseTo(9_150, 4)
    expect(report.enforcement.strongestAction).toBeNull()
  })

  it('surfaces the strongest live enforcement', async () => {
    const now = new Date('2026-07-16T12:00:00Z')
    const { store, service, organization, project } = fixture(now)
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Tiny',
      period: 'monthly',
      hardLimitCents: 1,
      thresholds: [{ atPercent: 100, actions: ['notify', 'block_builds', 'suspend_functions'] }],
    })
    store.ingestUsage([{ ...egress(organization.id, project.id, 500, '2026-07-10T10:00:00Z'), key: 'a' }])
    await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now,
      handlers: { apply: () => ({}), release: () => {} },
    })
    const report = service.usageReport({ organizationId: organization.id, projectId: project.id, now }) as any
    expect(report.enforcement.strongestAction).toBe('suspend_functions')
    expect(report.budgets[0].level).toBe('hard_capped')
  })
})
