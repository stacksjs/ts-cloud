/**
 * Sourcing the series anomaly detection runs on.
 *
 * Detection is only as good as the series underneath it, and most of the ways
 * this goes wrong are in the data rather than the statistics. Three rules are
 * encoded here because getting any of them wrong produces a detector that is
 * confidently, quietly useless:
 *
 * **1. A gap is not a zero, and which one it is depends on the signal.**
 * For a count, an hour with no data means "we served nothing" - zero is the
 * truth and zero-filling is correct. For a *ratio*, an hour with no traffic has
 * no error rate at all; filling it with 0% drags the baseline toward zero, and
 * then the first ordinary hour of real traffic reads as a spike. Ratios must
 * carry gaps through to the detector, which already skips them.
 *
 * **2. A ratio needs a denominator floor.** One failed request out of two is a
 * 50% error rate and means nothing. Below a minimum sample count the point is a
 * gap, not a number.
 *
 * **3. A percentile needs enough samples to be a percentile.** A p95 over four
 * requests is the maximum wearing a hat.
 *
 * Aggregation happens in SQL rather than by pulling records into memory: two
 * weeks of request-level telemetry is millions of rows, and the existing
 * `TelemetryStore.series` caps at 5,000 records, which would silently truncate
 * the history the baseline is built from.
 */
import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore } from '../control-plane'
import type { SeriesPoint } from './anomaly'
import type { SpendStore } from './store'

/** How an empty bucket should be treated. See rule 1 above. */
export type GapPolicy = 'zero' | 'gap'

export interface SignalDefinition {
  key: string
  label: string
  /** `cost` and meters come from usage rollups; the rest from telemetry. */
  source: 'usage' | 'telemetry'
  gapPolicy: GapPolicy
  /**
   * Minimum observations in a bucket before its value is trusted.
   * Zero for counts - a count of three is still exactly three.
   */
  minSamples: number
  /** Units for the operator-facing floor, so `minAbsoluteDelta` reads sensibly. */
  unit: string
  /** True when the signal is a ratio in 0-1. */
  ratio?: boolean
}

/**
 * The signals detection can run on.
 *
 * Deliberately short. Every signal here is one an operator can act on: a spike
 * in 5xx, a collapse in throughput, a latency regression, a cost jump. Adding
 * signals nobody would act on makes the dashboard noisier without making
 * anything safer.
 */
export const DETECTABLE_SIGNALS: readonly SignalDefinition[] = [
  { key: 'cost', label: 'Cost', source: 'usage', gapPolicy: 'zero', minSamples: 0, unit: 'cents' },
  { key: 'edge.requests', label: 'Edge requests', source: 'usage', gapPolicy: 'zero', minSamples: 0, unit: 'requests' },
  { key: 'edge.egress_gb', label: 'Edge egress', source: 'usage', gapPolicy: 'zero', minSamples: 0, unit: 'GB' },
  {
    key: 'function.invocations',
    label: 'Function invocations',
    source: 'usage',
    gapPolicy: 'zero',
    minSamples: 0,
    unit: 'invocations',
  },
  { key: 'http.requests', label: 'HTTP requests', source: 'telemetry', gapPolicy: 'zero', minSamples: 0, unit: 'requests' },
  { key: 'http.errors', label: 'HTTP 5xx', source: 'telemetry', gapPolicy: 'zero', minSamples: 0, unit: 'responses' },
  {
    key: 'http.error_rate',
    label: 'HTTP error rate',
    source: 'telemetry',
    // A rate with no traffic is undefined, not zero. See rule 1.
    gapPolicy: 'gap',
    minSamples: 20,
    unit: 'ratio',
    ratio: true,
  },
  {
    key: 'http.client_error_rate',
    label: 'HTTP 4xx rate',
    source: 'telemetry',
    gapPolicy: 'gap',
    minSamples: 20,
    unit: 'ratio',
    ratio: true,
  },
  {
    key: 'http.latency_p95',
    label: 'Latency p95',
    source: 'telemetry',
    // A percentile over four samples is the maximum wearing a hat.
    gapPolicy: 'gap',
    minSamples: 20,
    unit: 'ms',
  },
]

export function signalDefinition(key: string): SignalDefinition | undefined {
  return DETECTABLE_SIGNALS.find((signal) => signal.key === key)
}

export interface SignalScope {
  organizationId: string
  projectId?: string
  environmentId?: string
  /** Restrict to one route template, for per-route detection. */
  route?: string
}

export interface SignalWindow {
  from: string
  to: string
}

/** A series plus what it took to build it, so a caller can judge the verdict. */
export interface SignalSeries {
  signal: string
  points: SeriesPoint[]
  /** Buckets that carried enough observations to be trusted. */
  populated: number
  /** Buckets dropped for falling under `minSamples`. */
  suppressed: number
  unit: string
}

const HOUR = 3_600_000

function hourBuckets(window: SignalWindow, maxBuckets = 24 * 40): number[] {
  const start = Math.floor(new Date(window.from).getTime() / HOUR) * HOUR
  const end = new Date(window.to).getTime()
  const buckets: number[] = []
  for (let ms = start; ms < end && buckets.length < maxBuckets; ms += HOUR) buckets.push(ms)
  return buckets
}

/**
 * Assemble a series from bucketed values.
 *
 * The gap policy decides what an absent bucket becomes. A gap is expressed as
 * `Number.NaN` rather than omitted, because omitting it would shift every later
 * point into the wrong seasonal phase - the same reason zero-filling exists for
 * counts. The detector skips non-finite values.
 */
function assemble(
  definition: SignalDefinition,
  window: SignalWindow,
  values: Map<number, { value: number; samples: number }>,
): SignalSeries {
  const points: SeriesPoint[] = []
  let populated = 0
  let suppressed = 0
  for (const bucket of hourBuckets(window)) {
    const entry = values.get(bucket)
    const bucketStart = new Date(bucket).toISOString()
    if (!entry) {
      points.push({ bucketStart, value: definition.gapPolicy === 'zero' ? 0 : Number.NaN })
      continue
    }
    if (entry.samples < definition.minSamples) {
      // Not enough denominator to mean anything. A gap, never a zero.
      points.push({ bucketStart, value: Number.NaN })
      suppressed++
      continue
    }
    points.push({ bucketStart, value: entry.value })
    populated++
  }
  return { signal: definition.key, points, populated, suppressed, unit: definition.unit }
}

export class SignalSource {
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    private readonly spend: SpendStore,
  ) {}

  private query(sql: string, bindings: SQLQueryBindings[]): Array<Record<string, unknown>> {
    return this.controlPlane.database.query(sql).all(...bindings) as Array<Record<string, unknown>>
  }

  /** Usage-backed series: cost, or one meter's quantity. */
  private usageSeries(definition: SignalDefinition, scope: SignalScope, window: SignalWindow): SignalSeries {
    const summary = this.spend.summarizeUsage({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      meters: definition.key === 'cost' ? undefined : [definition.key],
      from: window.from,
      to: window.to,
    })
    const values = new Map<number, { value: number; samples: number }>()
    for (const point of summary.series)
      values.set(new Date(point.bucketStart).getTime(), {
        value: definition.key === 'cost' ? point.costCents : point.quantity,
        samples: 1,
      })
    return assemble(definition, window, values)
  }

  /**
   * Telemetry-backed series, aggregated in SQL.
   *
   * Request records are the source rather than pre-aggregated metrics, because
   * a ratio has to be computed from the same rows on both sides. Dividing a
   * request-count metric by an error-count metric collected separately gives a
   * rate that is wrong whenever the two were sampled differently.
   */
  private telemetrySeries(definition: SignalDefinition, scope: SignalScope, window: SignalWindow): SignalSeries {
    // Telemetry is per-project. Without one there is no series to build, and a
    // zero-filled one would assert "no traffic" where the truth is "unknown".
    if (!scope.projectId) return { signal: definition.key, points: [], populated: 0, suppressed: 0, unit: definition.unit }
    const clauses = ["kind = 'request'", 'project_id = ?', 'timestamp >= ?', 'timestamp < ?']
    const bindings: SQLQueryBindings[] = [scope.projectId, window.from, window.to]
    if (scope.environmentId) {
      clauses.push('environment_id = ?')
      bindings.push(scope.environmentId)
    }
    if (scope.route) {
      clauses.push('path_template = ?')
      bindings.push(scope.route)
    }

    // One pass over the rows produces every counter the signals need, so a
    // rate is always numerator and denominator from the same scan.
    const rows = this.query(
      `SELECT
        CAST(strftime('%s', timestamp) AS INTEGER) / 3600 AS bucket,
        COUNT(*) AS total,
        SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
        SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS client_errors,
        SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed
      FROM telemetry_records
      WHERE ${clauses.join(' AND ')}
      GROUP BY bucket
      ORDER BY bucket`,
      bindings,
    )

    const values = new Map<number, { value: number; samples: number }>()
    for (const row of rows) {
      const bucket = Number(row.bucket) * HOUR
      const total = Number(row.total)
      if (definition.key === 'http.requests') values.set(bucket, { value: total, samples: total })
      else if (definition.key === 'http.errors')
        values.set(bucket, { value: Number(row.server_errors), samples: total })
      else if (definition.key === 'http.error_rate')
        values.set(bucket, { value: total > 0 ? Number(row.server_errors) / total : 0, samples: total })
      else if (definition.key === 'http.client_error_rate')
        values.set(bucket, { value: total > 0 ? Number(row.client_errors) / total : 0, samples: total })
    }

    if (definition.key === 'http.latency_p95') return this.latencySeries(definition, clauses, bindings, window)
    return assemble(definition, window, values)
  }

  /**
   * p95 latency per hour.
   *
   * Computed with a window function rather than by pulling durations into
   * memory: a busy hour is hundreds of thousands of rows, and the point of
   * doing this in SQL is not having to hold them.
   */
  private latencySeries(
    definition: SignalDefinition,
    clauses: string[],
    bindings: SQLQueryBindings[],
    window: SignalWindow,
  ): SignalSeries {
    const rows = this.query(
      `WITH ranked AS (
        SELECT
          CAST(strftime('%s', timestamp) AS INTEGER) / 3600 AS bucket,
          duration_ms,
          ROW_NUMBER() OVER (PARTITION BY CAST(strftime('%s', timestamp) AS INTEGER) / 3600 ORDER BY duration_ms) AS position,
          COUNT(*) OVER (PARTITION BY CAST(strftime('%s', timestamp) AS INTEGER) / 3600) AS samples
        FROM telemetry_records
        WHERE ${clauses.join(' AND ')} AND duration_ms IS NOT NULL
      )
      SELECT bucket, MIN(duration_ms) AS value, MAX(samples) AS samples
      FROM ranked
      WHERE position >= CAST(samples * 0.95 AS INTEGER)
      GROUP BY bucket
      ORDER BY bucket`,
      bindings,
    )
    const values = new Map<number, { value: number; samples: number }>()
    for (const row of rows)
      values.set(Number(row.bucket) * HOUR, { value: Number(row.value), samples: Number(row.samples) })
    return assemble(definition, window, values)
  }

  /** The series for one signal. Returns an all-gap series for an unknown one. */
  series(signal: string, scope: SignalScope, window: SignalWindow): SignalSeries {
    const definition = signalDefinition(signal)
    if (!definition) return { signal, points: [], populated: 0, suppressed: 0, unit: '' }
    return definition.source === 'usage'
      ? this.usageSeries(definition, scope, window)
      : this.telemetrySeries(definition, scope, window)
  }

  /**
   * Route templates worth evaluating individually.
   *
   * Bounded and ordered by traffic: per-route detection on a long tail of
   * one-hit routes produces noise, not insight, and the routes that matter are
   * the ones carrying enough traffic for a baseline to exist.
   */
  busiestRoutes(scope: SignalScope, window: SignalWindow, limit = 10, minRequests = 500): string[] {
    if (!scope.projectId) return []
    const clauses = ["kind = 'request'", 'project_id = ?', 'timestamp >= ?', 'timestamp < ?', 'path_template IS NOT NULL']
    const bindings: SQLQueryBindings[] = [scope.projectId, window.from, window.to]
    if (scope.environmentId) {
      clauses.push('environment_id = ?')
      bindings.push(scope.environmentId)
    }
    return this.query(
      `SELECT path_template, COUNT(*) AS total FROM telemetry_records
      WHERE ${clauses.join(' AND ')}
      GROUP BY path_template HAVING total >= ? ORDER BY total DESC LIMIT ?`,
      [...bindings, minRequests, Math.max(1, Math.min(50, limit))],
    ).map((row) => String(row.path_template))
  }
}

/**
 * Detector options per signal.
 *
 * The floors are in each signal's own units, which is the only way they mean
 * anything: 25 cents, 1,000 requests, and 2 percentage points are all "small
 * enough to ignore" for their signal and nonsense for the others.
 */
export function optionsForSignal(signal: string): {
  seasonLength: number
  threshold: number
  minHistory: number
  minAbsoluteDelta: number
  detectDrops: boolean
} {
  const base = { seasonLength: 24, threshold: 3.5, minHistory: 3, minAbsoluteDelta: 0, detectDrops: false }
  if (signal === 'cost') return { ...base, minAbsoluteDelta: 25 }
  if (signal === 'edge.requests' || signal === 'http.requests')
    // Weekly: request traffic has a strong weekday shape a daily season would
    // keep re-discovering. Drops matter here - a collapse in traffic is an
    // outage, and it is the one signal where zero is alarming rather than free.
    return { ...base, seasonLength: 168, threshold: 4, minAbsoluteDelta: 1_000, detectDrops: true }
  if (signal === 'edge.egress_gb') return { ...base, seasonLength: 168, threshold: 4, minAbsoluteDelta: 5 }
  if (signal === 'function.invocations') return { ...base, seasonLength: 168, threshold: 4, minAbsoluteDelta: 1_000 }
  if (signal === 'http.errors') return { ...base, seasonLength: 168, threshold: 4, minAbsoluteDelta: 25 }
  if (signal === 'http.error_rate' || signal === 'http.client_error_rate')
    // Two percentage points. A rate moving from 0.1% to 0.3% is a tripling and
    // still nothing; from 1% to 8% is worth waking someone.
    return { ...base, seasonLength: 168, threshold: 3.5, minAbsoluteDelta: 0.02 }
  if (signal === 'http.latency_p95') return { ...base, seasonLength: 168, threshold: 4, minAbsoluteDelta: 100 }
  return base
}

/**
 * How far back a signal needs to look.
 *
 * A weekly season with three same-phase observations needs three weeks of
 * history, not two. A fixed 14-day lookback silently starves every weekly
 * signal: the detector finds two prior points, falls under `minHistory`, and
 * reports nothing forever while looking perfectly healthy.
 */
export function lookbackHoursForSignal(signal: string): number {
  const options = optionsForSignal(signal)
  const needed = options.seasonLength * (options.minHistory + 1)
  // Floor at two weeks so short-season signals still get a real baseline, and
  // cap at the bucket limit the series builder enforces.
  return Math.min(24 * 40, Math.max(24 * 14, needed))
}
