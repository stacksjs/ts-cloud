import { afterEach, describe, expect, it } from 'bun:test'
import { AutomationIdentityStore } from '../automation'
import { createApiV1Handler } from '../api/handler'
import { openApiDocument } from '../api/openapi'
import { ControlPlaneStore } from '../control-plane'
import { SpendService } from './service'
import { SpendStore } from './store'

const stores: ControlPlaneStore[] = []
const NOW = new Date('2026-07-16T12:00:00Z')

function fixture(capabilities: string[] = ['billing:read', 'billing:manage', 'project:read']) {
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
    capabilities: capabilities as any,
    scope: { type: 'organization' },
  })
  const store = new SpendStore(controlPlane, { now: () => NOW })
  const service = new SpendService(store)
  const handler = createApiV1Handler({
    controlPlane,
    identities,
    now: () => NOW,
    spend: { store, service },
  })
  const call = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
    const response = await handler(
      new Request(`https://api.test${path}`, {
        ...init,
        headers: { authorization: `Bearer ${issued.secret}`, 'content-type': 'application/json', ...init.headers },
      }),
    )
    return { status: response!.status, body: await response!.json() }
  }
  return { controlPlane, organization, project, environment, store, service, call }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function seedUsage(store: SpendStore, organizationId: string, projectId: string, gigabytes: number) {
  store.ingestUsage([
    {
      organizationId,
      projectId,
      provider: 'aws',
      region: 'us-east-1',
      meter: 'edge.egress_gb',
      quantity: gigabytes,
      timestamp: '2026-07-10T10:00:00Z',
      key: 'seed',
    },
  ])
}

describe('openapi', () => {
  it('documents the spend surface alongside the rest of the API', () => {
    const paths = (openApiDocument() as any).paths
    expect(paths['/api/v1/usage']).toBeDefined()
    expect(paths['/api/v1/spend/budgets']).toBeDefined()
    expect(paths['/api/v1/spend/allowance']).toBeDefined()
    // The pre-existing routes are still there.
    expect(paths['/api/v1/projects']).toBeDefined()
  })
})

describe('GET /api/v1/usage', () => {
  it('answers with headroom, not just a total', async () => {
    const { call, store, organization, project } = fixture()
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Monthly',
      period: 'monthly',
      hardLimitCents: 10_000,
    })
    seedUsage(store, organization.id, project.id, 200)
    const { status, body } = await call(`/api/v1/usage?projectId=${project.id}`)
    expect(status).toBe(200)
    expect(body.totalCents).toBeCloseTo(850, 4)
    expect(body.budgets[0]).toMatchObject({ name: 'Monthly', limitCents: 10_000 })
    expect(body.budgets[0].remainingCents).toBeCloseTo(9_150, 4)
    expect(body.budgets[0]).toHaveProperty('projectionConfidence')
    expect(body.window.label).toBe('July 2026')
  })

  it('rejects an unknown period', async () => {
    const { call } = fixture()
    const { status, body } = await call('/api/v1/usage?period=hourly')
    expect(status).toBe(422)
    expect(body.error.code).toBe('validation_error')
  })

  it('refuses a caller without billing:read', async () => {
    const { call } = fixture(['project:read'])
    expect((await call('/api/v1/usage')).status).toBe(403)
  })
})

describe('GET /api/v1/usage/rollups', () => {
  it('returns itemized rollups for a window', async () => {
    const { call, store, organization, project } = fixture()
    seedUsage(store, organization.id, project.id, 200)
    const { status, body } = await call(
      `/api/v1/usage/rollups?projectId=${project.id}&from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z`,
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ meter: 'edge.egress_gb', quantity: 200 })
  })

  it('requires a bounded window rather than scanning everything', async () => {
    const { call } = fixture()
    expect((await call('/api/v1/usage/rollups')).status).toBe(422)
  })

  it('rejects an unparseable timestamp', async () => {
    const { call } = fixture()
    const { status, body } = await call('/api/v1/usage/rollups?from=yesterday&to=today')
    expect(status).toBe(422)
    expect(body.error.message).toContain('ISO-8601')
  })
})

describe('budget CRUD', () => {
  it('creates a budget in dry run unless the caller opts out', async () => {
    const { call, project } = fixture()
    const created = await call('/api/v1/spend/budgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cap', period: 'monthly', hardLimitCents: 5000, projectId: project.id }),
    })
    expect(created.status).toBe(200)
    expect(created.body.data.dryRun).toBe(true)

    const enforcing = await call('/api/v1/spend/budgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'Enforcing', period: 'monthly', hardLimitCents: 5000, dryRun: false }),
    })
    expect(enforcing.body.data.dryRun).toBe(false)
  })

  it('surfaces a validation failure as a 422', async () => {
    const { call } = fixture()
    const { status, body } = await call('/api/v1/spend/budgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'No limit', period: 'monthly' }),
    })
    expect(status).toBe(422)
    expect(body.error.message).toContain('soft limit')
  })

  it('rejects a negative limit', async () => {
    const { call } = fixture()
    const { status } = await call('/api/v1/spend/budgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'Negative', period: 'monthly', hardLimitCents: -5 }),
    })
    expect(status).toBe(422)
  })

  it('lists budgets governing a scope', async () => {
    const { call, store, organization, project } = fixture()
    store.createBudget({ organizationId: organization.id, name: 'Org', period: 'monthly', hardLimitCents: 1000 })
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Project',
      period: 'monthly',
      hardLimitCents: 500,
    })
    const { body } = await call(`/api/v1/spend/budgets?projectId=${project.id}`)
    expect(body.data.map((budget: any) => budget.name).sort()).toEqual(['Org', 'Project'])
  })

  it('updates a budget and enforces optimistic concurrency', async () => {
    const { call, store, organization } = fixture()
    const budget = store.createBudget({
      organizationId: organization.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 1000,
    })
    const updated = await call(`/api/v1/spend/budgets/${budget.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ hardLimitCents: 2000, expectedVersion: budget.version }),
    })
    expect(updated.body.data.hardLimitCents).toBe(2000)
    const stale = await call(`/api/v1/spend/budgets/${budget.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ hardLimitCents: 3000, expectedVersion: budget.version }),
    })
    expect(stale.status).toBe(409)
  })

  it('deletes a budget', async () => {
    const { call, store, organization } = fixture()
    const budget = store.createBudget({
      organizationId: organization.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 1000,
    })
    const { body } = await call(`/api/v1/spend/budgets/${budget.id}`, { method: 'DELETE' })
    expect(body.data.deleted).toBe(true)
    expect(store.getBudget(budget.id)).toBeUndefined()
  })

  it('does not leak another organization budget', async () => {
    const { call, controlPlane, store } = fixture()
    const other = controlPlane.createOrganization({ slug: 'other', name: 'Other' })
    const foreign = store.createBudget({
      organizationId: other.id,
      name: 'Foreign',
      period: 'monthly',
      hardLimitCents: 1,
    })
    expect((await call(`/api/v1/spend/budgets/${foreign.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('refuses a mutation from a read-only token', async () => {
    const { call } = fixture(['billing:read', 'project:read'])
    const { status } = await call('/api/v1/spend/budgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cap', period: 'monthly', hardLimitCents: 100 }),
    })
    expect(status).toBe(403)
  })
})

describe('GET /api/v1/spend/allowance', () => {
  it('allows an operation when nothing is enforced', async () => {
    const { call, project } = fixture()
    const { status, body } = await call(`/api/v1/spend/allowance?operation=deploy&projectId=${project.id}`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ operation: 'deploy', allowed: true, blockedBy: null })
  })

  it('refuses a deploy once a cap has blocked deployments', async () => {
    const { call, store, service, organization, project } = fixture()
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Tiny',
      period: 'monthly',
      hardLimitCents: 1,
      thresholds: [{ atPercent: 100, actions: ['notify', 'block_deployments'] }],
    })
    seedUsage(store, organization.id, project.id, 500)
    await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      handlers: { apply: () => ({}), release: () => {} },
    })
    const { body } = await call(`/api/v1/spend/allowance?operation=deploy&projectId=${project.id}`)
    expect(body.allowed).toBe(false)
    expect(body.blockedBy).toBe('block_deployments')
    expect(body.budgets[0].level).toBe('hard_capped')
  })

  it('still allows a build when only deployments are blocked', async () => {
    const { call, store, service, organization, project } = fixture()
    store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Tiny',
      period: 'monthly',
      hardLimitCents: 1,
      thresholds: [{ atPercent: 100, actions: ['block_deployments'] }],
    })
    seedUsage(store, organization.id, project.id, 500)
    await service.runCycle({
      organizationId: organization.id,
      projectId: project.id,
      now: NOW,
      handlers: { apply: () => ({}), release: () => {} },
    })
    expect((await call(`/api/v1/spend/allowance?operation=build&projectId=${project.id}`)).body.allowed).toBe(true)
  })

  it('rejects an unknown operation', async () => {
    const { call } = fixture()
    expect((await call('/api/v1/spend/allowance?operation=mine-bitcoin')).status).toBe(422)
  })
})

describe('anomalies and enforcement', () => {
  it('lists and acknowledges an anomaly', async () => {
    const { call, store, organization, project } = fixture()
    const anomaly = store.recordAnomaly({
      organizationId: organization.id,
      projectId: project.id,
      signal: 'cost',
      direction: 'spike',
      observed: 5000,
      expected: 100,
      score: 40,
      deltaPercent: 4900,
      severity: 'critical',
      bucketStart: '2026-07-16T11:00:00.000Z',
      evidence: {},
    })!
    const listed = await call(`/api/v1/spend/anomalies?projectId=${project.id}`)
    expect(listed.body.data).toHaveLength(1)
    const acknowledged = await call(`/api/v1/spend/anomalies/${anomaly.id}/acknowledge`, { method: 'POST' })
    expect(acknowledged.body.data.acknowledged).toBe(true)
    const remaining = await call(`/api/v1/spend/anomalies?projectId=${project.id}&unacknowledged=true`)
    expect(remaining.body.data).toEqual([])
  })

  it('404s an anomaly from another organization', async () => {
    const { call, controlPlane, store } = fixture()
    const other = controlPlane.createOrganization({ slug: 'other', name: 'Other' })
    const foreign = store.recordAnomaly({
      organizationId: other.id,
      signal: 'cost',
      direction: 'spike',
      observed: 1,
      expected: 0,
      score: 9,
      deltaPercent: 0,
      severity: 'info',
      bucketStart: '2026-07-16T11:00:00.000Z',
      evidence: {},
    })!
    expect((await call(`/api/v1/spend/anomalies/${foreign.id}/acknowledge`, { method: 'POST' })).status).toBe(404)
  })

  it('lists enforcement in force', async () => {
    const { call, store, organization, project } = fixture()
    const budget = store.createBudget({
      organizationId: organization.id,
      projectId: project.id,
      name: 'Cap',
      period: 'monthly',
      hardLimitCents: 1,
    })
    const record = store.openEnforcement({ budget, action: 'block_builds', reason: 'over', triggeredAtPercent: 400 })
    store.transitionEnforcement(record.id, 'active')
    const { body } = await call('/api/v1/spend/enforcement')
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ action: 'block_builds', state: 'active' })
  })
})

describe('routing', () => {
  it('still 404s an unknown API path', async () => {
    const { call } = fixture()
    const { status, body } = await call('/api/v1/nonsense')
    expect(status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })
})
