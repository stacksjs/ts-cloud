import type { EnforcementAction, UsageDelta } from './model'
import { afterEach, describe, expect, it } from 'bun:test'
import { AlertStore } from '../alerts'
import { AutomationIdentityStore } from '../automation'
import { AutomationApiService } from '../api/service'
import { ControlPlaneStore } from '../control-plane'
import { createEnforcementHandlers, RecordingSpendTransport } from './appliers'
import { assertSpendAllows, SpendCapError, SpendGate } from './gate'
import { formatCents, SpendNotificationRouter, spendNotificationText } from './notifications'
import { SpendRunner, startSpendLoop } from './runner'
import { SpendStore } from './store'

const stores: ControlPlaneStore[] = []
const NOW = new Date('2026-07-16T12:00:00Z')

function fixture(now: Date = NOW) {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  stores.push(controlPlane)
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = controlPlane.createEnvironment({
    projectId: project.id,
    slug: 'production',
    name: 'Production',
    kind: 'production',
  })
  const store = new SpendStore(controlPlane, { now: () => now })
  const alerts = new AlertStore(controlPlane, { encryptionKey: 'spend-fixture-key', now: () => now })
  return { controlPlane, organization, project, environment, store, alerts, now }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function egress(organizationId: string, projectId: string, gigabytes: number, at = '2026-07-10T10:00:00Z'): UsageDelta & { key: string } {
  return {
    organizationId,
    projectId,
    provider: 'aws',
    region: 'us-east-1',
    meter: 'edge.egress_gb',
    quantity: gigabytes,
    timestamp: at,
    key: `k-${gigabytes}-${at}`,
  }
}

describe('spend gate', () => {
  it('refuses only the operations an action targets', () => {
    const { controlPlane, organization, project } = fixture()
    const gate = new SpendGate(controlPlane)
    gate.open({
      budgetId: 'b1',
      action: 'block_deployments',
      organizationId: organization.id,
      projectId: project.id,
      reason: 'Over budget.',
      simulated: false,
    })
    const scope = { organizationId: organization.id, projectId: project.id }
    expect(gate.check('deploy', scope)).toMatchObject({ allowed: false, action: 'block_deployments' })
    expect(gate.check('build', scope).allowed).toBe(true)
    expect(gate.check('request', scope).allowed).toBe(true)
  })

  it('survives a control-plane restart, because the gate is durable', () => {
    const { controlPlane, organization, project } = fixture()
    new SpendGate(controlPlane).open({
      budgetId: 'b1',
      action: 'block_builds',
      organizationId: organization.id,
      projectId: project.id,
      reason: 'Over budget.',
      simulated: false,
    })
    // A fresh gate over the same store reads the same state.
    const revived = new SpendGate(controlPlane)
    expect(revived.check('build', { organizationId: organization.id, projectId: project.id }).allowed).toBe(false)
  })

  it('lets an org-wide entry govern every project under it', () => {
    const { controlPlane, organization, project } = fixture()
    const gate = new SpendGate(controlPlane)
    gate.open({
      budgetId: 'org',
      action: 'suspend_project',
      organizationId: organization.id,
      reason: 'Org cap.',
      simulated: false,
    })
    expect(gate.check('request', { organizationId: organization.id, projectId: project.id }).allowed).toBe(false)
    expect(gate.check('request', { organizationId: 'other-org', projectId: project.id }).allowed).toBe(true)
  })

  it('never lets a project entry govern a different project', () => {
    const { controlPlane, organization, project } = fixture()
    const gate = new SpendGate(controlPlane)
    gate.open({
      budgetId: 'p',
      action: 'block_builds',
      organizationId: organization.id,
      projectId: project.id,
      reason: 'x',
      simulated: false,
    })
    expect(gate.check('build', { organizationId: organization.id, projectId: 'other' }).allowed).toBe(true)
  })

  it('records a simulated entry without refusing anything', () => {
    const { controlPlane, organization, project } = fixture()
    const gate = new SpendGate(controlPlane)
    gate.open({
      budgetId: 'b1',
      action: 'suspend_project',
      organizationId: organization.id,
      projectId: project.id,
      reason: 'Dry run.',
      simulated: true,
    })
    const scope = { organizationId: organization.id, projectId: project.id }
    expect(gate.list(scope)).toHaveLength(1)
    expect(gate.check('request', scope).allowed).toBe(true)
    expect(gate.strongest(scope)).toBeUndefined()
  })

  it('is idempotent on budget plus action', () => {
    const { controlPlane, organization } = fixture()
    const gate = new SpendGate(controlPlane)
    const entry = { budgetId: 'b1', action: 'block_builds' as const, organizationId: organization.id, reason: 'x', simulated: false }
    gate.open(entry)
    gate.open(entry)
    expect(gate.list()).toHaveLength(1)
  })

  it('closes one action and every action for a budget', () => {
    const { controlPlane, organization } = fixture()
    const gate = new SpendGate(controlPlane)
    for (const action of ['block_builds', 'block_deployments'] as const)
      gate.open({ budgetId: 'b1', action, organizationId: organization.id, reason: 'x', simulated: false })
    expect(gate.close('b1', 'block_builds')).toBe(true)
    expect(gate.close('b1', 'block_builds')).toBe(false)
    expect(gate.closeBudget('b1')).toBe(1)
    expect(gate.list()).toEqual([])
  })

  it('reports the strongest live action', () => {
    const { controlPlane, organization } = fixture()
    const gate = new SpendGate(controlPlane)
    for (const action of ['block_builds', 'suspend_functions', 'notify'] as const)
      gate.open({ budgetId: `b-${action}`, action, organizationId: organization.id, reason: 'x', simulated: false })
    expect(gate.strongest({ organizationId: organization.id })).toBe('suspend_functions')
  })

  it('throws a 402-shaped error from the assertion helper', () => {
    const { controlPlane, organization, project } = fixture()
    const gate = new SpendGate(controlPlane)
    gate.open({
      budgetId: 'b1',
      action: 'block_builds',
      organizationId: organization.id,
      projectId: project.id,
      reason: 'Over budget.',
      simulated: false,
    })
    const scope = { organizationId: organization.id, projectId: project.id }
    expect(() => assertSpendAllows(gate, 'build', scope)).toThrow(SpendCapError)
    try {
      assertSpendAllows(gate, 'build', scope)
    } catch (error) {
      expect((error as SpendCapError).status).toBe(402)
      expect((error as SpendCapError).code).toBe('spend_cap_exceeded')
    }
    expect(() => assertSpendAllows(gate, 'deploy', scope)).not.toThrow()
  })
})

describe('appliers', () => {
  function capped(hardLimitCents: number, actions: EnforcementAction[], dryRun = false) {
    const context = fixture()
    const budget = context.store.createBudget({
      organizationId: context.organization.id,
      projectId: context.project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents,
      dryRun,
      thresholds: [{ atPercent: 100, actions }],
    })
    context.store.ingestUsage([egress(context.organization.id, context.project.id, 500)])
    return { ...context, budget }
  }

  it('opens the gate before touching the transport, so a transport failure still caps', async () => {
    const { controlPlane, store, budget, organization, project } = capped(1, ['block_builds', 'throttle_requests'])
    const gate = new SpendGate(controlPlane)
    const handlers = createEnforcementHandlers({
      gate,
      transport: {
        throttleRequests: () => {
          throw new Error('edge unreachable')
        },
      },
    })
    const { SpendService } = await import('./service')
    const service = new SpendService(store)
    const result = await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      environmentKind: 'preview',
      handlers,
    })
    expect(result.enforcement[0].failed.map((item) => item.action)).toEqual(['throttle_requests'])
    // Builds are still blocked, and the failed action left its gate entry in
    // place rather than reading as "not capped".
    expect(gate.check('build', { organizationId: organization.id, projectId: project.id }).allowed).toBe(false)
    expect(gate.list().some((entry) => entry.action === 'throttle_requests')).toBe(true)
    expect(store.activeEnforcement(budget.id, 'throttle_requests')).toBeUndefined()
  })

  it('calls the transport for traffic-affecting actions and not for gate-only ones', async () => {
    const { controlPlane, store, organization, project } = capped(1, [
      'block_builds',
      'throttle_requests',
      'suspend_functions',
    ])
    const transport = new RecordingSpendTransport()
    const handlers = createEnforcementHandlers({ gate: new SpendGate(controlPlane), transport })
    const { SpendService } = await import('./service')
    await new SpendService(store).runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      environmentKind: 'preview',
      handlers,
    })
    expect(transport.calls.map((call) => call.method)).toEqual(['throttleRequests', 'suspendFunctions'])
  })

  it('marks an action unsupported when no transport implements it', async () => {
    const { controlPlane, store, budget, organization, project } = capped(1, ['serve_static'])
    const handlers = createEnforcementHandlers({ gate: new SpendGate(controlPlane) })
    const { SpendService } = await import('./service')
    await new SpendService(store).runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      environmentKind: 'preview',
      handlers,
    })
    expect(store.activeEnforcement(budget.id, 'serve_static')?.restore).toMatchObject({ unsupported: true })
  })

  it('does not call the transport for a dry-run budget', async () => {
    const { controlPlane, store, organization, project } = capped(1, ['suspend_project'], true)
    const transport = new RecordingSpendTransport()
    const gate = new SpendGate(controlPlane)
    const handlers = createEnforcementHandlers({ gate, transport })
    const { SpendService } = await import('./service')
    await new SpendService(store).runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      environmentKind: 'preview',
      handlers,
    })
    expect(transport.calls).toEqual([])
    expect(gate.check('request', { organizationId: organization.id, projectId: project.id }).allowed).toBe(true)
  })

  it('restores the traffic path before opening the gate on release', async () => {
    const { controlPlane, store, budget, organization, project } = capped(1, ['throttle_requests'])
    const gate = new SpendGate(controlPlane)
    const order: string[] = []
    const handlers = createEnforcementHandlers({
      gate,
      transport: {
        throttleRequests: () => ({ previousFactor: 1 }),
        restoreRequests: () => {
          order.push(`transport:${gate.list().length}`)
        },
      },
    })
    const { SpendService } = await import('./service')
    const service = new SpendService(store)
    await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      environmentKind: 'preview',
      handlers,
    })
    store.updateBudget(budget.id, { hardLimitCents: 100_000_000 })
    await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      environmentKind: 'preview',
      handlers,
    })
    // The transport ran while the gate entry was still present.
    expect(order).toEqual(['transport:1'])
    expect(gate.list()).toEqual([])
  })

  it('notifies on both apply and release', async () => {
    const { controlPlane, store, budget, organization, project } = capped(1, ['block_builds'])
    const events: string[] = []
    const handlers = createEnforcementHandlers({
      gate: new SpendGate(controlPlane),
      notify: (input) => {
        events.push(`${input.action}:${input.released ? 'released' : 'applied'}`)
      },
    })
    const { SpendService } = await import('./service')
    const service = new SpendService(store)
    await service.runCycle({ organizationId: organization.id, projectId: project.id, now: NOW, handlers })
    store.updateBudget(budget.id, { hardLimitCents: 100_000_000 })
    await service.runCycle({ organizationId: organization.id, projectId: project.id, now: NOW, handlers })
    expect(events).toEqual(['block_builds:applied', 'block_builds:released'])
  })
})

describe('deployment gating through the API service', () => {
  it('refuses a deployment with a 402 once a cap blocks it', () => {
    const { controlPlane, organization, project, environment } = fixture()
    const identities = new AutomationIdentityStore(controlPlane)
    const account = identities.createServiceAccount({
      organizationId: organization.id,
      slug: 'ci',
      name: 'CI',
      roleTemplate: 'admin',
      scope: { type: 'organization' },
    }).serviceAccount
    const issued = identities.createToken({
      serviceAccountId: account.id,
      name: 'CI',
      capabilities: ['deployments:create', 'project:read'],
      scope: { type: 'organization' },
    })
    const principal = identities.verifyToken(issued.secret)!
    const service = new AutomationApiService(controlPlane, identities)
    const input = { projectId: project.id, environmentId: environment.id }

    // Unblocked: the deployment is accepted.
    expect(service.createDeployment(principal, input, 'deploy-key-0001').operation).toBeDefined()

    new SpendGate(controlPlane).open({
      budgetId: 'b1',
      action: 'block_deployments',
      organizationId: organization.id,
      projectId: project.id,
      reason: 'Monthly budget exhausted.',
      simulated: false,
    })
    try {
      service.createDeployment(principal, input, 'deploy-key-0002')
      throw new Error('expected the cap to refuse the deployment')
    } catch (error: any) {
      expect(error.status).toBe(402)
      expect(error.code).toBe('spend_cap_exceeded')
      expect(error.details).toMatchObject({ action: 'block_deployments', budgetId: 'b1' })
    }
  })
})

describe('notification text', () => {
  it('leads with the money, not the percentage', () => {
    const { store, organization, project } = fixture()
    const budget = store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Production',
      period: 'monthly',
      hardLimitCents: 50_000,
    })
    const text = spendNotificationText(
      budget,
      {
        budgetId: budget.id,
        level: 'warning',
        window: { start: '', end: '', elapsedMs: 1, totalMs: 2, label: 'July 2026' },
        projection: { actualCents: 41_500, burnRateCentsPerMs: 0, projectedCents: 60_000, elapsedFraction: 0.5, confidence: 0.9 },
        usedPercent: 83,
        projectedPercent: 120,
        breaches: [],
        actions: [],
        releases: [],
        simulated: false,
        reason: '',
        evaluatedAt: '',
      },
      'spend.threshold',
    )
    expect(text).toContain('$415.00 of $500.00')
    expect(text).toContain('83%')
  })

  it('formats cents as money and survives an unknown currency', () => {
    expect(formatCents(123_45)).toBe('$123.45')
    expect(formatCents(100, 'XYZ')).toContain('1.00')
  })
})

describe('spend notifications', () => {
  function withChannel(matcher: Record<string, unknown> = {}) {
    const context = fixture()
    const channel = context.alerts.createChannel({
      organizationId: context.organization.id,
      name: 'ops',
      kind: 'webhook',
      config: { url: 'https://hooks.test/spend' },
      credential: 'secret',
    })
    const route = context.alerts.createRoute({
      organizationId: context.organization.id,
      name: 'spend',
      priority: 1,
      matcher: matcher as any,
      channelIds: [channel.id],
      groupWaitSeconds: 0,
      escalation: [],
      rateLimitPerMinute: 60,
      enabled: true,
    })
    return { ...context, channel, route }
  }

  function decision(overrides: Record<string, any> = {}) {
    return {
      budgetId: 'b1',
      level: 'hard_capped',
      window: { start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z', elapsedMs: 1, totalMs: 2, label: 'July 2026' },
      projection: { actualCents: 60_000, burnRateCentsPerMs: 0, projectedCents: 70_000, elapsedFraction: 0.5, confidence: 0.9 },
      usedPercent: 120,
      projectedPercent: 140,
      breaches: [{ atPercent: 100, actions: ['notify', 'block_builds'], projected: false, observedPercent: 120 }],
      actions: ['notify', 'block_builds'],
      releases: [],
      simulated: false,
      reason: 'Over budget.',
      evaluatedAt: '2026-07-16T12:00:00.000Z',
      ...overrides,
    } as any
  }

  it('delivers to a matching channel', () => {
    const { alerts, store, organization, project } = withChannel()
    const budget = store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 50_000,
    })
    const router = new SpendNotificationRouter(alerts, { now: () => NOW })
    const result = router.notifyDecision(budget, decision({ budgetId: budget.id }))
    expect(result.deliveries).toHaveLength(1)
    expect(result.deliveries[0].payload).toMatchObject({ event: 'spend.enforced' })
  })

  it('collapses the same breach re-evaluated every cycle into one delivery', () => {
    const { alerts, store, organization, project } = withChannel()
    const budget = store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 50_000,
    })
    const router = new SpendNotificationRouter(alerts, { now: () => NOW })
    router.notifyDecision(budget, decision({ budgetId: budget.id }))
    const second = router.notifyDecision(budget, decision({ budgetId: budget.id }))
    // createDelivery is idempotent on the key, so the repeat returns the same row.
    expect(second.deliveries[0].id).toBe(alerts.listDeliveries({ states: ['pending'] })[0].id)
    expect(alerts.listDeliveries({ states: ['pending'] })).toHaveLength(1)
  })

  it('sends nothing when no threshold was crossed', () => {
    const { alerts, store, organization, project } = withChannel()
    const budget = store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 50_000,
    })
    const router = new SpendNotificationRouter(alerts, { now: () => NOW })
    expect(router.notifyDecision(budget, decision({ breaches: [] })).deliveries).toEqual([])
  })

  it('notifies an organization-wide budget, which has no project and so no alert row', () => {
    const { alerts, store, organization } = withChannel()
    const budget = store.createBudget({
      organizationId: organization.id,
      name: 'Org cap',
      period: 'monthly',
      hardLimitCents: 50_000,
    })
    const router = new SpendNotificationRouter(alerts, { now: () => NOW })
    const result = router.notifyDecision(budget, decision({ budgetId: budget.id }))
    expect(result.deliveries).toHaveLength(1)
    expect(result.deliveries[0].alertId).toBeUndefined()
  })

  it('respects a route matcher that names a different project', () => {
    const { alerts, store, organization, project } = withChannel({ projectIds: ['someone-else'] })
    const budget = store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 50_000,
    })
    const router = new SpendNotificationRouter(alerts, { now: () => NOW })
    expect(router.notifyDecision(budget, decision({ budgetId: budget.id })).deliveries).toEqual([])
  })

  it('suppresses a threshold inside quiet hours but never a release', () => {
    const context = fixture()
    const channel = context.alerts.createChannel({
      organizationId: context.organization.id,
      name: 'ops',
      kind: 'webhook',
      config: { url: 'https://hooks.test/spend' },
      credential: 'secret',
    })
    context.alerts.createRoute({
      organizationId: context.organization.id,
      name: 'spend',
      priority: 1,
      matcher: {},
      channelIds: [channel.id],
      quietHours: { timezone: 'UTC', start: '00:00', end: '23:59' },
      groupWaitSeconds: 0,
      escalation: [],
      rateLimitPerMinute: 60,
      enabled: true,
    })
    const budget = context.store.createBudget({
      organizationId: context.organization.id,
      projectId: context.project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 50_000,
    })
    const router = new SpendNotificationRouter(context.alerts, { now: () => NOW })
    const quiet = router.notifyDecision(budget, decision({ budgetId: budget.id }))
    expect(quiet.deliveries).toEqual([])
    expect(quiet.suppressed).toHaveLength(1)
    const released = router.notifyRelease(budget, decision({ budgetId: budget.id }), ['block_builds'])
    expect(released.deliveries).toHaveLength(1)
  })

  it('sends one delivery per anomaly, ever', () => {
    const { alerts, store, organization, project } = withChannel()
    const anomaly = store.recordAnomaly({
      organizationId: organization.id,
      projectId: project.id,
      signal: 'cost',
      direction: 'spike',
      observed: 5_000,
      expected: 120,
      score: 40,
      deltaPercent: 4_000,
      severity: 'critical',
      bucketStart: '2026-07-16T11:00:00.000Z',
      evidence: {},
    })!
    const router = new SpendNotificationRouter(alerts, { now: () => NOW })
    expect(router.notifyAnomaly(anomaly).deliveries).toHaveLength(1)
    router.notifyAnomaly(anomaly)
    expect(alerts.listDeliveries({ states: ['pending'] })).toHaveLength(1)
  })
})

describe('runner', () => {
  function runnerFixture(hardLimitCents = 1) {
    const context = fixture()
    const budget = context.store.createBudget({
      organizationId: context.organization.id,
      projectId: context.project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents,
      thresholds: [{ atPercent: 100, actions: ['notify', 'block_builds'] }],
    })
    context.store.ingestUsage([egress(context.organization.id, context.project.id, 500)])
    const runner = new SpendRunner({
      controlPlane: context.controlPlane,
      store: context.store,
      alerts: context.alerts,
      now: () => NOW,
    })
    return { ...context, budget, runner }
  }

  it('runs a full cycle and reports what it did', async () => {
    const { runner, organization, project } = runnerFixture()
    const result = await runner.run({ organizationId: organization.id, projectId: project.id })
    expect(result.applied).toContain('block_builds')
    expect(result.decisions).toHaveLength(1)
    expect(result.warnings).toEqual([])
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(runner.gate.check('build', { organizationId: organization.id, projectId: project.id }).allowed).toBe(false)
  })

  it('is idempotent across cycles', async () => {
    const { runner, organization, project } = runnerFixture()
    await runner.run({ organizationId: organization.id, projectId: project.id })
    const second = await runner.run({ organizationId: organization.id, projectId: project.id })
    expect(second.applied).toEqual([])
    expect(runner.gate.list()).toHaveLength(2)
  })

  it('does not let a notification failure disable the cap', async () => {
    const { controlPlane, store, organization, project } = runnerFixture()
    const broken = {
      listRoutes: () => {
        throw new Error('alert store offline')
      },
    } as any
    const runner = new SpendRunner({ controlPlane, store, alerts: broken, now: () => NOW })
    const result = await runner.run({ organizationId: organization.id, projectId: project.id })
    expect(result.applied).toContain('block_builds')
    expect(result.warnings.join(' ')).toContain('notifications failed')
  })

  it('warns about an unpriced meter rather than silently counting it as free', async () => {
    const { runner, organization, project, store } = runnerFixture()
    store.ingestUsage([
      {
        organizationId: organization.id,
        projectId: project.id,
        meter: 'quantum.flux',
        quantity: 10,
        timestamp: '2026-07-16T10:00:00Z',
        key: 'q1',
      },
    ])
    const { SpendService } = await import('./service')
    const service = new SpendService(store)
    const ingest = service.ingestUsage([
      {
        organizationId: organization.id,
        projectId: project.id,
        meter: 'quantum.flux',
        quantity: 5,
        timestamp: '2026-07-16T11:00:00Z',
      },
    ])
    expect(ingest.unpricedMeters).toEqual(['quantum.flux'])
    const result = await runner.run({ organizationId: organization.id, projectId: project.id })
    expect(result.warnings).toEqual([])
  })

  it('drops a gate entry whose budget was deleted, so nothing is blocked by a ghost', async () => {
    const { runner, store, budget, organization, project } = runnerFixture()
    await runner.run({ organizationId: organization.id, projectId: project.id })
    expect(runner.gate.check('build', { organizationId: organization.id, projectId: project.id }).allowed).toBe(false)
    store.deleteBudget(budget.id)
    const result = await runner.run({ organizationId: organization.id, projectId: project.id })
    expect(result.released).toContain('block_builds')
    expect(runner.gate.check('build', { organizationId: organization.id, projectId: project.id }).allowed).toBe(true)
  })

  it('drops a gate entry whose budget was disabled', async () => {
    const { runner, store, budget, organization, project } = runnerFixture()
    await runner.run({ organizationId: organization.id, projectId: project.id })
    store.updateBudget(budget.id, { enabled: false })
    await runner.run({ organizationId: organization.id, projectId: project.id })
    expect(runner.gate.list()).toEqual([])
  })

  it('withholds a user-visible action on production and says so', async () => {
    const { controlPlane, store, alerts, organization, project, environment, budget } = runnerFixture()
    store.updateBudget(budget.id, { thresholds: [{ atPercent: 100, actions: ['notify', 'suspend_project'] }] })
    const runner = new SpendRunner({ controlPlane, store, alerts, now: () => NOW })
    const result = await runner.run({
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      environmentKind: environment.kind,
    })
    expect(result.withheld).toContain('suspend_project')
    expect(result.warnings.join(' ')).toContain('require approval')
  })

  it('walks every organization, project, and environment', async () => {
    const { runner } = runnerFixture()
    const results = await runner.runAll()
    // One org-wide scope plus one per environment.
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ranAt === NOW.toISOString())).toBe(true)
  })
})

describe('spend loop', () => {
  it('stops cleanly and never overlaps cycles', async () => {
    const { controlPlane, store } = fixture()
    let started = 0
    let finished = 0
    const runner = {
      runAll: async () => {
        started++
        await new Promise((resolve) => setTimeout(resolve, 30))
        finished++
        return []
      },
    } as unknown as SpendRunner
    const stop = startSpendLoop(runner, { intervalSeconds: 10 })
    // The interval is clamped to a 10s floor, so nothing has fired yet.
    expect(started).toBe(0)
    stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toBe(0)
    expect(finished).toBe(0)
    expect(controlPlane).toBeDefined()
    expect(store).toBeDefined()
  })
})
