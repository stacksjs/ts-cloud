import type { UsageDelta } from './model'
import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { AnomalyConfigStore, routeMatches, SENSITIVITY_THRESHOLDS } from './anomaly-config'
import { SpendService } from './service'
import { SpendStore } from './store'

const stores: ControlPlaneStore[] = []
const NOW = new Date('2026-07-15T12:00:00Z')
const HOUR = 3_600_000

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
  return {
    controlPlane,
    organization,
    project,
    environment,
    store,
    service: new SpendService(store),
    configs: new AnomalyConfigStore(controlPlane, { now: () => now }),
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('route matching', () => {
  it('matches within and across segments', () => {
    expect(routeMatches('/api/*', '/api/users')).toBe(true)
    expect(routeMatches('/api/*', '/api/users/1')).toBe(false)
    expect(routeMatches('/api/**', '/api/users/1')).toBe(true)
  })

  it('escapes metacharacters', () => {
    expect(routeMatches('/a.b', '/axb')).toBe(false)
  })
})

describe('anomaly configs', () => {
  it('falls back to the shipped preset when nothing is configured', () => {
    const { configs, organization, project } = fixture()
    const resolved = configs.optionsFor({ organizationId: organization.id, projectId: project.id }, 'cost')
    // Detection works out of the box; configuration is a refinement.
    expect(resolved.enabled).toBe(true)
    expect(resolved.config).toBeUndefined()
    expect(resolved.options.minAbsoluteDelta).toBe(25)
  })

  it('maps sensitivity onto a threshold rather than exposing a z-score', () => {
    const { configs, organization } = fixture()
    configs.upsert({ organizationId: organization.id, signal: 'cost', sensitivity: 'high' })
    expect(configs.optionsFor({ organizationId: organization.id }, 'cost').options.threshold).toBe(
      SENSITIVITY_THRESHOLDS.high,
    )
  })

  it('prefers the most specific scope', () => {
    const { configs, organization, project, environment } = fixture()
    configs.upsert({ organizationId: organization.id, signal: 'cost', sensitivity: 'low' })
    configs.upsert({
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      signal: 'cost',
      sensitivity: 'high',
    })
    const resolved = configs.optionsFor(
      { organizationId: organization.id, projectId: project.id, environmentId: environment.id },
      'cost',
    )
    expect(resolved.options.threshold).toBe(SENSITIVITY_THRESHOLDS.high)
  })

  it('updates in place rather than creating a duplicate', () => {
    const { configs, organization } = fixture()
    const first = configs.upsert({ organizationId: organization.id, signal: 'cost', sensitivity: 'low' })
    const second = configs.upsert({ organizationId: organization.id, signal: 'cost', sensitivity: 'high' })
    expect(second.id).toBe(first.id)
    expect(second.version).toBe(2)
    expect(configs.list({ organizationId: organization.id })).toHaveLength(1)
  })

  it('rejects a nonsensical season length', () => {
    const { configs, organization } = fixture()
    expect(() => configs.upsert({ organizationId: organization.id, signal: 'cost', seasonLength: 0 })).toThrow(
      'positive integer',
    )
  })

  it('can disable a signal entirely', () => {
    const { configs, organization } = fixture()
    configs.upsert({ organizationId: organization.id, signal: 'cost', enabled: false })
    expect(configs.optionsFor({ organizationId: organization.id }, 'cost').enabled).toBe(false)
  })

  it('lists org-wide configs alongside a project, so nothing looks unwatched', () => {
    const { configs, organization, project } = fixture()
    configs.upsert({ organizationId: organization.id, signal: 'cost' })
    configs.upsert({ organizationId: organization.id, projectId: project.id, signal: 'edge.requests' })
    expect(configs.list({ organizationId: organization.id, projectId: project.id })).toHaveLength(2)
  })

  it('deletes', () => {
    const { configs, organization } = fixture()
    const config = configs.upsert({ organizationId: organization.id, signal: 'cost' })
    expect(configs.delete(config.id)).toBe(true)
    expect(configs.list({ organizationId: organization.id })).toEqual([])
  })
})

describe('silences', () => {
  it('requires a reason', () => {
    const { configs, organization } = fixture()
    expect(() => configs.silence({ organizationId: organization.id, signal: 'cost', reason: '  ' })).toThrow(
      'needs a reason',
    )
  })

  it('refuses a matcher that would silence everything', () => {
    const { configs, organization } = fixture()
    // Indistinguishable from a broken detector when someone asks why nothing fires.
    expect(() => configs.silence({ organizationId: organization.id, reason: 'noisy' })).toThrow('at least one of')
  })

  it('matches on signal, route, or status code', () => {
    const { configs, organization } = fixture()
    configs.silence({ organizationId: organization.id, signal: 'cost', reason: 'known' })
    configs.silence({ organizationId: organization.id, routePattern: '/webhooks/**', reason: 'crawler' })
    configs.silence({ organizationId: organization.id, statusCode: 404, reason: 'scanner noise' })
    const scope = { organizationId: organization.id }
    expect(configs.isSilenced(scope, { signal: 'cost' })).toBeDefined()
    expect(configs.isSilenced(scope, { signal: 'edge.requests', route: '/webhooks/stripe' })).toBeDefined()
    expect(configs.isSilenced(scope, { signal: 'edge.requests', statusCode: 404 })).toBeDefined()
    expect(configs.isSilenced(scope, { signal: 'edge.requests', route: '/checkout' })).toBeUndefined()
  })

  it('requires every named field to match, not just one', () => {
    const { configs, organization } = fixture()
    configs.silence({ organizationId: organization.id, signal: 'cost', statusCode: 500, reason: 'known' })
    const scope = { organizationId: organization.id }
    expect(configs.isSilenced(scope, { signal: 'cost', statusCode: 500 })).toBeDefined()
    expect(configs.isSilenced(scope, { signal: 'cost', statusCode: 200 })).toBeUndefined()
  })

  it('expires on its own when given an end', () => {
    let now = NOW
    const controlPlane = new ControlPlaneStore({ path: ':memory:' })
    stores.push(controlPlane)
    const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
    const configs = new AnomalyConfigStore(controlPlane, { now: () => now })
    configs.silence({
      organizationId: organization.id,
      signal: 'cost',
      reason: 'migration window',
      expiresAt: new Date(NOW.getTime() + HOUR).toISOString(),
    })
    expect(configs.isSilenced({ organizationId: organization.id }, { signal: 'cost' })).toBeDefined()
    now = new Date(NOW.getTime() + 2 * HOUR)
    expect(configs.isSilenced({ organizationId: organization.id }, { signal: 'cost' })).toBeUndefined()
    expect(configs.listSilences({ organizationId: organization.id })).toEqual([])
    expect(configs.listSilences({ organizationId: organization.id, includeExpired: true })).toHaveLength(1)
  })

  it('removes a silence', () => {
    const { configs, organization } = fixture()
    const silence = configs.silence({ organizationId: organization.id, signal: 'cost', reason: 'known' })
    expect(configs.removeSilence(silence.id)).toBe(true)
    expect(configs.isSilenced({ organizationId: organization.id }, { signal: 'cost' })).toBeUndefined()
  })
})

describe('detection honours configuration', () => {
  function seedSpike(context: ReturnType<typeof fixture>) {
    const deltas: Array<UsageDelta & { key: string }> = []
    const start = new Date('2026-07-05T12:00:00Z').getTime()
    const hours = Math.floor((NOW.getTime() - start) / HOUR)
    for (let hour = 0; hour < hours - 1; hour++)
      deltas.push({
        organizationId: context.organization.id,
        projectId: context.project.id,
        provider: 'aws',
        meter: 'edge.egress_gb',
        quantity: 20,
        timestamp: new Date(start + hour * HOUR).toISOString(),
        key: `flat-${hour}`,
      })
    deltas.push({
      organizationId: context.organization.id,
      projectId: context.project.id,
      provider: 'aws',
      meter: 'edge.egress_gb',
      quantity: 20_000,
      timestamp: new Date(start + (hours - 1) * HOUR).toISOString(),
      key: 'spike',
    })
    context.store.ingestUsage(deltas)
  }

  it('detects a spike with no configuration at all', () => {
    const context = fixture()
    seedSpike(context)
    expect(
      context.service.detectAnomalies({ organizationId: context.organization.id, projectId: context.project.id, signals: ['cost'] }, NOW),
    ).toHaveLength(1)
  })

  it('reports nothing when the signal is disabled', () => {
    const context = fixture()
    seedSpike(context)
    context.service.anomalyConfigs.upsert({
      organizationId: context.organization.id,
      projectId: context.project.id,
      signal: 'cost',
      enabled: false,
    })
    expect(
      context.service.detectAnomalies({ organizationId: context.organization.id, projectId: context.project.id, signals: ['cost'] }, NOW),
    ).toEqual([])
  })

  it('reports nothing when the signal is silenced', () => {
    const context = fixture()
    seedSpike(context)
    context.service.anomalyConfigs.silence({
      organizationId: context.organization.id,
      projectId: context.project.id,
      signal: 'cost',
      reason: 'Planned backfill.',
    })
    expect(
      context.service.detectAnomalies({ organizationId: context.organization.id, projectId: context.project.id, signals: ['cost'] }, NOW),
    ).toEqual([])
  })

  it('uses the configured severity rather than the detector default', () => {
    const context = fixture()
    seedSpike(context)
    context.service.anomalyConfigs.upsert({
      organizationId: context.organization.id,
      projectId: context.project.id,
      signal: 'cost',
      severity: 'info',
    })
    const [anomaly] = context.service.detectAnomalies(
      { organizationId: context.organization.id, projectId: context.project.id },
      NOW,
    )
    expect(anomaly.severity).toBe('info')
  })

  it('suppresses a spike when the floor is raised above it', () => {
    const context = fixture()
    seedSpike(context)
    context.service.anomalyConfigs.upsert({
      organizationId: context.organization.id,
      projectId: context.project.id,
      signal: 'cost',
      minAbsoluteDelta: 100_000_000,
    })
    expect(
      context.service.detectAnomalies({ organizationId: context.organization.id, projectId: context.project.id, signals: ['cost'] }, NOW),
    ).toEqual([])
  })
})
