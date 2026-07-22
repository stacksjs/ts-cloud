import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { TelemetryStore, pathTemplate, redactTelemetryText, telemetryBucketLabel, telemetryPercentile } from '.'

const stores: ControlPlaneStore[] = []
function fixture(now = new Date('2026-07-21T12:00:00.000Z')) {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' }); stores.push(controlPlane)
  const project = controlPlane.createProject({ slug: 'acme', name: 'Acme' })
  const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const resource = controlPlane.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'api', name: 'API' })
  return { controlPlane, project, environment, resource, telemetry: new TelemetryStore(controlPlane, { now: () => now }) }
}
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('telemetry safety and persistence', () => {
  it('redacts query values, credentials, email, and sensitive attributes before persistence', () => {
    const { project, environment, telemetry } = fixture()
    const record = telemetry.append({ projectId: project.id, environmentId: environment.id, kind: 'log', source: 'journald', name: 'api.log', timestamp: '2026-07-21T11:59:00Z', message: 'GET /users?email=person@example.com authorization=Bearer-secret', attributes: { cookie: 'session=secret', nested: { email: 'person@example.com' } } })
    expect(record.message).toBe('GET /users?email=[REDACTED] [REDACTED]')
    expect(record.attributes).toEqual({ cookie: '[REDACTED]', nested: { email: '[EMAIL]' } })
    expect(redactTelemetryText('https://x.test/a?token=one&safe=two')).toBe('https://x.test/a?token=[REDACTED]&safe=[REDACTED]')
    expect(pathTemplate('/users/123456/orders?secret=x')).toBe('/users/:id/orders')
  })

  it('enforces project/resource scope and resumes cursor pagination without overlap', () => {
    const { project, environment, resource, telemetry } = fixture()
    for (let minute = 0; minute < 3; minute++) telemetry.append({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, kind: 'log', source: 'journald', name: 'api.log', timestamp: `2026-07-21T11:0${minute}:00Z`, message: `line ${minute}` })
    const first = telemetry.query({ projectId: project.id, environmentId: environment.id, resourceIds: [resource.id], from: '2026-07-21T11:00:00Z', to: '2026-07-21T12:00:00Z', limit: 2 })
    const second = telemetry.query({ projectId: project.id, environmentId: environment.id, resourceIds: [resource.id], from: '2026-07-21T11:00:00Z', to: '2026-07-21T12:00:00Z', limit: 2, cursor: first.nextCursor })
    expect(first.records.map(item => item.message)).toEqual(['line 2', 'line 1'])
    expect(second.records.map(item => item.message)).toEqual(['line 0'])
    expect(new Set([...first.records, ...second.records].map(item => item.id)).size).toBe(3)
  })

  it('saves bounded actor-scoped queries without allowing project changes', () => {
    const { controlPlane, project, environment, telemetry } = fixture()
    const actor = controlPlane.createActor({ kind: 'user', externalId: 'user:chris', displayName: 'Chris' })
    const query = { projectId: project.id, environmentId: environment.id, from: '2026-07-21T11:00:00Z', to: '2026-07-21T12:00:00Z', kinds: ['log' as const], text: 'error' }
    const saved = telemetry.saveQuery(project.id, actor.id, 'Errors', query)
    expect(telemetry.listSavedQueries(project.id, actor.id)).toEqual([saved])
    expect(() => telemetry.saveQuery('another-project', actor.id, 'Invalid', query)).toThrow('cross project')
    expect(telemetry.deleteSavedQuery(project.id, actor.id, saved.id)).toBeTrue()
  })
})

describe('telemetry aggregation and time semantics', () => {
  it('uses nearest-rank percentiles and emits explicit empty buckets', () => {
    const { project, environment, telemetry } = fixture()
    for (const [second, value] of [[10, 10], [20, 20], [30, 30], [40, 40], [50, 100]] as Array<[number, number]>) telemetry.append({ projectId: project.id, environmentId: environment.id, kind: 'metric', source: 'host', name: 'request.duration', unit: 'ms', timestamp: `2026-07-21T11:00:${second.toString().padStart(2, '0')}Z`, value })
    const [series] = telemetry.series({ projectId: project.id, environmentId: environment.id, kinds: ['metric'], names: ['request.duration'], from: '2026-07-21T11:00:00Z', to: '2026-07-21T11:03:00Z', bucketMs: 60_000, aggregation: 'p95', timezone: 'UTC' })
    expect(telemetryPercentile([10, 20, 30, 40, 100], 95)).toBe(100)
    expect(series.points.map(point => ({ value: point.value, gap: point.gap }))).toEqual([{ value: 100, gap: false }, { value: undefined, gap: true }, { value: undefined, gap: true }])
  })

  it('labels DST fallback buckets with distinct timezone offsets', () => {
    const before = telemetryBucketLabel(new Date('2026-11-01T08:30:00Z'), 'America/Los_Angeles')
    const after = telemetryBucketLabel(new Date('2026-11-01T09:30:00Z'), 'America/Los_Angeles')
    expect(before).not.toBe(after)
    expect(before).toContain('PDT')
    expect(after).toContain('PST')
  })

  it('bounds ranges and enforces age/count retention', () => {
    const { project, environment, telemetry } = fixture()
    telemetry.append({ projectId: project.id, environmentId: environment.id, kind: 'metric', source: 'host', name: 'cpu', timestamp: '2026-06-01T00:00:00Z', value: 1 })
    telemetry.append({ projectId: project.id, environmentId: environment.id, kind: 'metric', source: 'host', name: 'cpu', timestamp: '2026-07-21T11:00:00Z', value: 2 })
    expect(() => telemetry.query({ projectId: project.id, from: '2026-01-01T00:00:00Z', to: '2026-07-21T00:00:00Z' })).toThrow('31 days')
    expect(telemetry.enforceRetention({ rawDays: 30, downsampleAfterDays: 7, downsampleBucketMs: 3_600_000, maxRecords: 1 }, project.id).deleted).toBe(1)
  })

  it('downsamples older raw metrics with count/min/max/p95 provenance', () => {
    const { project, environment, telemetry } = fixture()
    telemetry.append({ projectId: project.id, environmentId: environment.id, kind: 'metric', source: 'host', name: 'cpu', unit: 'percent', timestamp: '2026-07-11T10:01:00Z', value: 10 })
    telemetry.append({ projectId: project.id, environmentId: environment.id, kind: 'metric', source: 'host', name: 'cpu', unit: 'percent', timestamp: '2026-07-11T10:30:00Z', value: 30 })
    expect(telemetry.downsample({ rawDays: 30, downsampleAfterDays: 7, downsampleBucketMs: 3_600_000, maxRecords: 100 }, project.id)).toEqual({ compacted: 2, rollups: 1 })
    const result = telemetry.query({ projectId: project.id, from: '2026-07-11T10:00:00Z', to: '2026-07-11T11:00:00Z' })
    expect(result.records[0]).toMatchObject({ source: 'host:rollup', value: 20, attributes: { count: 2, min: 10, max: 30, p95: 30 } })
  })
})
