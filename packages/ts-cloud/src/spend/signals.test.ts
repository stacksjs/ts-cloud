import type { AppendTelemetryInput } from '../telemetry'
import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { TelemetryStore } from '../telemetry'
import { detectLatestAnomaly } from './anomaly'
import { SpendService } from './service'
import { DETECTABLE_SIGNALS, optionsForSignal, signalDefinition, SignalSource } from './signals'
import { SpendStore } from './store'

const stores: ControlPlaneStore[] = []
const NOW = new Date('2026-07-15T12:00:00Z')
const HOUR = 3_600_000
const WINDOW = { from: '2026-07-01T12:00:00.000Z', to: '2026-07-15T12:00:00.000Z' }

function fixture() {
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
  const spend = new SpendStore(controlPlane, { now: () => NOW })
  return {
    controlPlane,
    organization,
    project,
    environment,
    spend,
    telemetry: new TelemetryStore(controlPlane, { now: () => NOW }),
    signals: new SignalSource(controlPlane, spend),
    service: new SpendService(spend),
    scope: { organizationId: organization.id, projectId: project.id },
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** Append `count` request records into one hour, `errors` of them 5xx. */
function requests(
  telemetry: TelemetryStore,
  projectId: string,
  at: Date,
  count: number,
  options: { errors?: number; clientErrors?: number; durationMs?: number; route?: string } = {},
) {
  const batch: AppendTelemetryInput[] = []
  for (let index = 0; index < count; index++) {
    const isServerError = index < (options.errors ?? 0)
    const isClientError = !isServerError && index < (options.errors ?? 0) + (options.clientErrors ?? 0)
    batch.push({
      projectId,
      kind: 'request',
      source: 'edge',
      name: 'http.request',
      timestamp: new Date(at.getTime() + index).toISOString(),
      statusCode: isServerError ? 500 : isClientError ? 404 : 200,
      durationMs: options.durationMs ?? 40,
      method: 'GET',
      pathTemplate: options.route ?? '/',
    })
  }
  telemetry.appendMany(batch)
}

describe('signal catalog', () => {
  it('declares a gap policy for every signal', () => {
    for (const signal of DETECTABLE_SIGNALS) expect(['zero', 'gap']).toContain(signal.gapPolicy)
  })

  it('treats every ratio as a gap signal, never a zero one', () => {
    // A rate with no traffic is undefined. Filling it with 0% drags the
    // baseline down and makes the next ordinary hour look like a spike.
    for (const signal of DETECTABLE_SIGNALS.filter((item) => item.ratio))
      expect({ signal: signal.key, policy: signal.gapPolicy }).toEqual({ signal: signal.key, policy: 'gap' })
  })

  it('requires a denominator for every ratio and percentile', () => {
    for (const signal of DETECTABLE_SIGNALS.filter((item) => item.ratio || item.key.includes('p95')))
      expect(signal.minSamples).toBeGreaterThan(0)
  })

  it('requires no minimum for a plain count, because a count of three is three', () => {
    expect(signalDefinition('http.requests')!.minSamples).toBe(0)
    expect(signalDefinition('cost')!.minSamples).toBe(0)
  })
})

describe('usage-backed series', () => {
  it('sources cost from the priced rollups', () => {
    const { signals, spend, scope } = fixture()
    spend.ingestUsage([
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        provider: 'aws',
        meter: 'edge.egress_gb',
        quantity: 200,
        timestamp: '2026-07-10T10:00:00Z',
        key: 'a',
      },
    ])
    const series = signals.series('cost', scope, WINDOW)
    const point = series.points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
    expect(point?.value).toBeCloseTo(850, 4)
  })

  it('sources a meter quantity rather than its cost', () => {
    const { signals, spend, scope } = fixture()
    spend.ingestUsage([
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        provider: 'aws',
        meter: 'edge.requests',
        quantity: 5_000,
        timestamp: '2026-07-10T10:00:00Z',
        key: 'a',
      },
    ])
    const point = signals
      .series('edge.requests', scope, WINDOW)
      .points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
    expect(point?.value).toBe(5_000)
  })

  it('zero-fills a quiet hour, because serving nothing is a real zero', () => {
    const { signals, scope } = fixture()
    const series = signals.series('cost', scope, WINDOW)
    expect(series.points.every((point) => point.value === 0)).toBe(true)
  })
})

describe('telemetry-backed series', () => {
  it('counts requests per hour', () => {
    const { signals, telemetry, scope } = fixture()
    requests(telemetry, scope.projectId!, new Date('2026-07-10T10:00:00Z'), 30)
    const point = signals
      .series('http.requests', scope, WINDOW)
      .points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
    expect(point?.value).toBe(30)
  })

  it('computes an error rate from the same rows as its denominator', () => {
    const { signals, telemetry, scope } = fixture()
    requests(telemetry, scope.projectId!, new Date('2026-07-10T10:00:00Z'), 100, { errors: 5 })
    const point = signals
      .series('http.error_rate', scope, WINDOW)
      .points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
    expect(point?.value).toBeCloseTo(0.05, 5)
  })

  it('separates 4xx from 5xx', () => {
    const { signals, telemetry, scope } = fixture()
    requests(telemetry, scope.projectId!, new Date('2026-07-10T10:00:00Z'), 100, { errors: 5, clientErrors: 20 })
    const at = (signal: string) =>
      signals.series(signal, scope, WINDOW).points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
        ?.value
    expect(at('http.error_rate')).toBeCloseTo(0.05, 5)
    expect(at('http.client_error_rate')).toBeCloseTo(0.2, 5)
    expect(at('http.errors')).toBe(5)
  })

  it('suppresses a rate computed from too few requests', () => {
    const { signals, telemetry, scope } = fixture()
    // 1 error out of 2 requests is a 50% error rate and means nothing.
    requests(telemetry, scope.projectId!, new Date('2026-07-10T10:00:00Z'), 2, { errors: 1 })
    const series = signals.series('http.error_rate', scope, WINDOW)
    const point = series.points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
    expect(Number.isFinite(point!.value)).toBe(false)
    expect(series.suppressed).toBe(1)
  })

  it('leaves an untrafficked hour as a gap for a rate, not a zero', () => {
    const { signals, telemetry, scope } = fixture()
    requests(telemetry, scope.projectId!, new Date('2026-07-10T10:00:00Z'), 100, { errors: 5 })
    const series = signals.series('http.error_rate', scope, WINDOW)
    const quiet = series.points.find((item) => item.bucketStart === '2026-07-09T10:00:00.000Z')
    expect(Number.isFinite(quiet!.value)).toBe(false)
  })

  it('still zero-fills a count for the same hour', () => {
    const { signals, telemetry, scope } = fixture()
    requests(telemetry, scope.projectId!, new Date('2026-07-10T10:00:00Z'), 100)
    const series = signals.series('http.requests', scope, WINDOW)
    expect(series.points.find((item) => item.bucketStart === '2026-07-09T10:00:00.000Z')?.value).toBe(0)
  })

  it('computes a p95 that is not the maximum', () => {
    const { signals, telemetry, scope } = fixture()
    const at = new Date('2026-07-10T10:00:00Z')
    // 99 fast requests and one very slow one: p95 must not be the outlier.
    requests(telemetry, scope.projectId!, at, 99, { durationMs: 10 })
    requests(telemetry, scope.projectId!, new Date(at.getTime() + 200), 1, { durationMs: 9_000 })
    const value = signals
      .series('http.latency_p95', scope, WINDOW)
      .points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')?.value
    expect(value).toBeLessThan(9_000)
  })

  it('narrows to one route when asked', () => {
    const { signals, telemetry, scope } = fixture()
    const at = new Date('2026-07-10T10:00:00Z')
    requests(telemetry, scope.projectId!, at, 50, { route: '/checkout' })
    requests(telemetry, scope.projectId!, new Date(at.getTime() + 100), 200, { route: '/' })
    const scoped = signals
      .series('http.requests', { ...scope, route: '/checkout' }, WINDOW)
      .points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
    expect(scoped?.value).toBe(50)
  })

  it('returns an empty series without a project, rather than a zero-filled lie', () => {
    // Telemetry is per-project. A zero-filled series would assert "no traffic"
    // where the truth is "we cannot know".
    const { signals, organization } = fixture()
    expect(signals.series('http.requests', { organizationId: organization.id }, WINDOW).points).toEqual([])
  })
})

describe('busiest routes', () => {
  it('ranks by traffic and ignores the long tail', () => {
    const { signals, telemetry, scope } = fixture()
    const at = new Date('2026-07-10T10:00:00Z')
    requests(telemetry, scope.projectId!, at, 600, { route: '/' })
    requests(telemetry, scope.projectId!, new Date(at.getTime() + 1_000), 550, { route: '/api/items' })
    requests(telemetry, scope.projectId!, new Date(at.getTime() + 2_000), 5, { route: '/rare' })
    const routes = signals.busiestRoutes(scope, WINDOW)
    expect(routes).toEqual(['/', '/api/items'])
  })

  it('is bounded, so a thousand routes cannot become a thousand queries', () => {
    const { signals, telemetry, scope } = fixture()
    for (let index = 0; index < 12; index++)
      requests(telemetry, scope.projectId!, new Date(`2026-07-10T${String(index).padStart(2, '0')}:00:00Z`), 600, {
        route: `/r${index}`,
      })
    expect(signals.busiestRoutes(scope, WINDOW, 5).length).toBe(5)
  })
})

describe('per-signal detector options', () => {
  it('uses a weekly season for traffic and a daily one for cost', () => {
    expect(optionsForSignal('cost').seasonLength).toBe(24)
    expect(optionsForSignal('http.requests').seasonLength).toBe(168)
  })

  it('watches for traffic collapse but not for cost collapse', () => {
    // A drop in traffic is an outage. A drop in cost is good news.
    expect(optionsForSignal('http.requests').detectDrops).toBe(true)
    expect(optionsForSignal('cost').detectDrops).toBe(false)
  })

  it('expresses each floor in that signal units', () => {
    expect(optionsForSignal('cost').minAbsoluteDelta).toBe(25)
    expect(optionsForSignal('http.error_rate').minAbsoluteDelta).toBe(0.02)
    expect(optionsForSignal('http.requests').minAbsoluteDelta).toBe(1_000)
  })
})

describe('gaps do not poison the baseline', () => {
  it('ignores gap points when building the seasonal history', () => {
    const points = Array.from({ length: 24 * 8 }, (_, index) => ({
      bucketStart: new Date(Date.UTC(2026, 6, 1) + index * HOUR).toISOString(),
      value: index % 24 === 5 && index < 24 * 4 ? Number.NaN : 0.01,
    }))
    // The final same-phase point spikes; earlier ones at that phase are gaps.
    points[points.length - 1] = { ...points[points.length - 1], value: 0.4 }
    const anomaly = detectLatestAnomaly(points, { seasonLength: 24, minHistory: 3, minAbsoluteDelta: 0.02 })
    // A single NaN in the history would make the median NaN and silently
    // disable detection for that phase forever.
    expect(anomaly).toBeDefined()
    expect(anomaly!.expected).toBeCloseTo(0.01, 5)
  })

  it('never reports a gap as an anomaly', () => {
    const points = Array.from({ length: 24 * 8 }, (_, index) => ({
      bucketStart: new Date(Date.UTC(2026, 6, 1) + index * HOUR).toISOString(),
      value: 0.01,
    }))
    points[points.length - 1] = { ...points[points.length - 1], value: Number.NaN }
    expect(detectLatestAnomaly(points, { seasonLength: 24, minHistory: 3 })).toBeUndefined()
  })
})

describe('the cycle covers every signal', () => {
  function seedTraffic(context: ReturnType<typeof fixture>, spikeErrors: number) {
    const start = new Date('2026-07-05T12:00:00Z').getTime()
    const hours = Math.floor((NOW.getTime() - start) / HOUR)
    for (let hour = 0; hour < hours - 1; hour++)
      requests(context.telemetry, context.scope.projectId!, new Date(start + hour * HOUR), 200, { errors: 1 })
    requests(context.telemetry, context.scope.projectId!, new Date(start + (hours - 1) * HOUR), 200, {
      errors: spikeErrors,
    })
  }

  it('detects an error-rate spike, not only a cost one', () => {
    const context = fixture()
    seedTraffic(context, 120)
    const found = context.service.detectAnomalies({ ...context.scope, signals: ['http.error_rate'] }, NOW, {
      seasonLength: 24,
    })
    expect(found).toHaveLength(1)
    expect(found[0].signal).toBe('http.error_rate')
    expect(found[0].observed).toBeGreaterThan(found[0].expected)
  })

  it('stays quiet when the error rate is merely ordinary', () => {
    const context = fixture()
    seedTraffic(context, 2)
    expect(
      context.service.detectAnomalies({ ...context.scope, signals: ['http.error_rate'] }, NOW, { seasonLength: 24 }),
    ).toEqual([])
  })

  it('records the unit and the suppressed-bucket count as evidence', () => {
    const context = fixture()
    seedTraffic(context, 120)
    const [anomaly] = context.service.detectAnomalies({ ...context.scope, signals: ['http.error_rate'] }, NOW, {
      seasonLength: 24,
    })
    expect(anomaly.evidence).toMatchObject({ unit: 'ratio' })
    expect(anomaly.evidence).toHaveProperty('suppressedBuckets')
  })

  it('runs every signal by default', () => {
    const context = fixture()
    seedTraffic(context, 120)
    const found = context.service.detectAnomalies(context.scope, NOW, { seasonLength: 24 })
    expect(found.some((anomaly) => anomaly.signal === 'http.error_rate')).toBe(true)
  })

  /** Seed one route across the 14-day floor at 25 req/hour: enough to clear the
   * denominator floor and to rank as busy, without six figures of inserts. */
  function seedRoute(context: ReturnType<typeof fixture>, route: string, spikeErrors: number) {
    const start = NOW.getTime() - 14 * 24 * HOUR
    const hours = 14 * 24
    for (let hour = 0; hour < hours - 1; hour++)
      requests(context.telemetry, context.scope.projectId!, new Date(start + hour * HOUR), 25, { errors: 0, route })
    requests(context.telemetry, context.scope.projectId!, new Date(start + (hours - 1) * HOUR), 25, {
      errors: spikeErrors,
      route,
    })
  }

  it('tags a route-scoped anomaly so two routes cannot dedupe against each other', () => {
    const context = fixture()
    seedRoute(context, '/checkout', 20)
    const found = context.service.detectAnomalies(
      { ...context.scope, signals: ['http.error_rate'], routes: true },
      NOW,
      { seasonLength: 24 },
    )
    expect(found.some((anomaly) => anomaly.signal === 'http.error_rate@/checkout')).toBe(true)
  })

  it('honours a route silence before doing any work', () => {
    const context = fixture()
    seedRoute(context, '/webhooks/stripe', 20)
    context.service.anomalyConfigs.silence({
      organizationId: context.scope.organizationId,
      projectId: context.scope.projectId,
      routePattern: '/webhooks/**',
      reason: 'Provider retries in bursts.',
    })
    const found = context.service.detectAnomalies(
      { ...context.scope, signals: ['http.error_rate'], routes: true },
      NOW,
      { seasonLength: 24 },
    )
    expect(found.some((anomaly) => anomaly.signal.includes('/webhooks/'))).toBe(false)
  })
})

describe('route detection only runs signals that have a route', () => {
  it('marks usage signals as not route-aware', () => {
    // Usage rollups are priced per meter, not per path. A "cost on /checkout"
    // series is really the project-wide one wearing a route's name.
    for (const key of ['cost', 'edge.requests', 'edge.egress_gb', 'function.invocations'])
      expect({ key, routeAware: signalDefinition(key)!.routeAware }).toEqual({ key, routeAware: false })
    for (const key of ['http.requests', 'http.error_rate', 'http.latency_p95'])
      expect({ key, routeAware: signalDefinition(key)!.routeAware }).toEqual({ key, routeAware: true })
  })

  it('never records a route-tagged cost anomaly', () => {
    const context = fixture()
    // Cost spikes, and there is plenty of route traffic to tempt the loop.
    const start = NOW.getTime() - 14 * 24 * HOUR
    for (let hour = 0; hour < 14 * 24 - 1; hour++) {
      context.spend.ingestUsage([
        {
          organizationId: context.scope.organizationId,
          projectId: context.scope.projectId,
          provider: 'aws',
          meter: 'edge.egress_gb',
          quantity: 150,
          timestamp: new Date(start + hour * HOUR).toISOString(),
          key: `flat-${hour}`,
        },
      ])
      requests(context.telemetry, context.scope.projectId!, new Date(start + hour * HOUR), 25, { route: '/checkout' })
    }
    context.spend.ingestUsage([
      {
        organizationId: context.scope.organizationId,
        projectId: context.scope.projectId,
        provider: 'aws',
        meter: 'edge.egress_gb',
        quantity: 90_000,
        timestamp: new Date(start + (14 * 24 - 1) * HOUR).toISOString(),
        key: 'spike',
      },
    ])
    requests(context.telemetry, context.scope.projectId!, new Date(start + (14 * 24 - 1) * HOUR), 25, {
      route: '/checkout',
    })
    const found = context.service.detectAnomalies({ ...context.scope, routes: true }, NOW, { seasonLength: 24 })
    expect(found.some((anomaly) => anomaly.signal === 'cost')).toBe(true)
    // The bug this guards: `cost@/checkout` carrying project-wide numbers.
    expect(found.some((anomaly) => anomaly.signal.startsWith('cost@'))).toBe(false)
    expect(found.some((anomaly) => anomaly.signal.startsWith('edge.egress_gb@'))).toBe(false)
  })
})

describe('counter memoization', () => {
  it('serves every counter signal from one scan', () => {
    const { signals, telemetry, controlPlane, scope } = fixture()
    requests(telemetry, scope.projectId!, new Date('2026-07-10T10:00:00Z'), 100, { errors: 5 })
    const at = (signal: string) =>
      signals.series(signal, scope, WINDOW).points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')
        ?.value

    expect(at('http.requests')).toBe(100)
    // Delete the rows out from under the source. A memoized result is
    // unchanged; a second scan would now see nothing.
    controlPlane.database.run("DELETE FROM telemetry_records WHERE kind = 'request'")
    expect(at('http.errors')).toBe(5)
    expect(at('http.error_rate')).toBeCloseTo(0.05, 5)

    signals.resetCache()
    expect(at('http.requests')).toBe(0)
  })

  it('keeps separate scopes apart in the memo', () => {
    const { signals, telemetry, scope } = fixture()
    const at = new Date('2026-07-10T10:00:00Z')
    requests(telemetry, scope.projectId!, at, 40, { route: '/a' })
    requests(telemetry, scope.projectId!, new Date(at.getTime() + 500), 90, { route: '/b' })
    const value = (route?: string) =>
      signals
        .series('http.requests', { ...scope, route }, WINDOW)
        .points.find((item) => item.bucketStart === '2026-07-10T10:00:00.000Z')?.value
    expect(value('/a')).toBe(40)
    expect(value('/b')).toBe(90)
    expect(value()).toBe(130)
  })
})
