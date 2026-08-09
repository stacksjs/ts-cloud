/**
 * Metering: turn telemetry into billable quantities.
 *
 * The telemetry pipeline already carries every signal a cap needs - request
 * records with `bytesOut`, function durations, build operations, egress
 * counters from the on-box collector. Metering is the translation layer that
 * normalizes those into the provider-neutral meters in `model.ts`, so a budget
 * does not have to know whether a byte left via CloudFront or via nginx.
 *
 * Two properties matter here and are enforced by tests:
 *
 *   1. **Deltas, not totals.** A collector that reports a monotonic counter
 *      ("egress this month: 812 GB") must be differenced before it is added to
 *      a rollup, or the month gets re-billed on every scrape. {@link CounterTracker}
 *      handles that, including the counter resets that a reboot causes.
 *   2. **Idempotency.** The same telemetry record processed twice must not
 *      count twice. Every delta carries a deterministic key derived from the
 *      record, and the store upserts on it.
 */
import type { JsonValue } from '../control-plane'
import type { TelemetryRecord } from '../telemetry'
import type { MeterKey, UsageDelta } from './model'
import { createHash } from 'node:crypto'

const BYTES_PER_GB = 1024 ** 3

/** A rule mapping a telemetry signal onto a meter. */
export interface MeterMapping {
  /** Telemetry `name` to match, or a prefix when it ends with `*`. */
  match: string
  meter: MeterKey
  /** Which field carries the quantity. `value` is the default. */
  field?: 'value' | 'bytesOut' | 'bytesIn' | 'durationMs' | 'count'
  /** Multiply the raw field by this to reach the meter's unit. */
  scale?: number
  /**
   * The signal is a monotonically increasing counter and must be differenced.
   * Anything an agent reports as a running period total needs this.
   */
  cumulative?: boolean
}

/**
 * Default mappings against the signal names the platform already emits.
 *
 * `request.count` and `traffic.requests` both exist because the edge collector
 * and the dashboard's own instrumentation grew up separately; mapping both is
 * cheaper and less brittle than renaming a signal that operators' dashboards
 * already query.
 */
export const DEFAULT_METER_MAPPINGS: readonly MeterMapping[] = [
  { match: 'request.count', meter: 'edge.requests' },
  { match: 'traffic.requests', meter: 'edge.requests' },
  { match: 'http.request', meter: 'edge.requests', field: 'count' },
  { match: 'traffic.bytes_out', meter: 'edge.egress_gb', scale: 1 / BYTES_PER_GB },
  { match: 'storage.egress.day', meter: 'object.egress_gb', scale: 1 / BYTES_PER_GB },
  { match: 'storage.egress.month', meter: 'object.egress_gb', scale: 1 / BYTES_PER_GB, cumulative: true },
  { match: 'storage.egress.day_downloads', meter: 'object.requests' },
  { match: 'function.invocation', meter: 'function.invocations', field: 'count' },
  { match: 'function.duration_ms', meter: 'function.gb_seconds', scale: 1 / 1000 },
  { match: 'build.duration_ms', meter: 'build.minutes', scale: 1 / 60_000 },
  { match: 'telemetry.ingest_bytes', meter: 'telemetry.ingest_gb', scale: 1 / BYTES_PER_GB },
  { match: 'image.transform', meter: 'image.transformations', field: 'count' },
]

function matches(mapping: MeterMapping, name: string): boolean {
  return mapping.match.endsWith('*') ? name.startsWith(mapping.match.slice(0, -1)) : mapping.match === name
}

export function findMapping(name: string, mappings: readonly MeterMapping[] = DEFAULT_METER_MAPPINGS): MeterMapping | undefined {
  // Exact matches beat prefix matches so a specific rule is never shadowed.
  return (
    mappings.find((mapping) => !mapping.match.endsWith('*') && mapping.match === name) ??
    mappings.find((mapping) => matches(mapping, name))
  )
}

function quantityFrom(record: TelemetryRecord, mapping: MeterMapping): number | undefined {
  const field = mapping.field ?? 'value'
  const raw =
    field === 'count'
      ? 1
      : field === 'bytesOut'
        ? record.bytesOut
        : field === 'bytesIn'
          ? record.bytesIn
          : field === 'durationMs'
            ? record.durationMs
            : record.value
  if (raw == null || !Number.isFinite(raw)) return undefined
  return raw * (mapping.scale ?? 1)
}

/** Stable id for a delta, so replaying the same record is a no-op in the store. */
export function usageDeltaKey(delta: UsageDelta, sourceId: string): string {
  return createHash('sha256')
    .update(
      [
        sourceId,
        delta.meter,
        delta.organizationId,
        delta.projectId ?? '',
        delta.environmentId ?? '',
        delta.resourceId ?? '',
        delta.timestamp,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 32)
}

/**
 * Difference monotonic counters into deltas.
 *
 * `/proc/net/dev` style counters reset on reboot and wrap on 32-bit interfaces.
 * A naive subtraction turns either into a hugely negative delta - or, worse,
 * a caller who clamps at zero silently loses the usage. The rule used here: a
 * value lower than the last one means the counter restarted, so the new value
 * *is* the delta. That over-counts by at most one scrape interval and never
 * under-counts, which is the right direction for something guarding a budget.
 */
export class CounterTracker {
  private readonly last = new Map<string, { value: number; at: number }>()

  constructor(private readonly resetToleranceRatio: number = 0.999) {}

  /** Returns the increment to bill, or undefined when there is nothing new. */
  delta(key: string, value: number, at: Date | string = new Date()): number | undefined {
    if (!Number.isFinite(value) || value < 0) return undefined
    const timestamp = new Date(at).getTime()
    const previous = this.last.get(key)
    if (!previous) {
      this.last.set(key, { value, at: timestamp })
      return value > 0 ? value : undefined
    }
    // Out-of-order sample: ignore rather than reorder history we cannot see,
    // and leave the high-water mark alone so the next in-order sample is right.
    if (timestamp < previous.at) return undefined
    // A dip too small to be a restart is float noise in the agent's own
    // arithmetic. Hold the previous reading; adopting the dip would bill the
    // difference twice once the counter climbs back past it.
    if (value < previous.value && value >= previous.value * this.resetToleranceRatio) return undefined
    this.last.set(key, { value, at: timestamp })
    if (value >= previous.value) {
      const increment = value - previous.value
      return increment > 0 ? increment : undefined
    }
    return value > 0 ? value : undefined
  }

  /** Drop tracked counters not seen since `before`, so a retired host stops holding memory. */
  prune(before: Date): number {
    const cutoff = before.getTime()
    let removed = 0
    for (const [key, entry] of this.last) {
      if (entry.at < cutoff) {
        this.last.delete(key)
        removed++
      }
    }
    return removed
  }

  get size(): number {
    return this.last.size
  }
}

export interface MeteredDelta extends UsageDelta {
  /** Deterministic idempotency key. */
  key: string
}

export interface MeterOptions {
  mappings?: readonly MeterMapping[]
  /** Shared across calls so cumulative counters difference correctly over time. */
  counters?: CounterTracker
  /** Fallback when a record carries no provider attribute. */
  defaultProvider?: string
}

function attributeString(attributes: Record<string, JsonValue>, key: string): string | undefined {
  const value = attributes[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Convert telemetry records into usage deltas.
 *
 * Records that map to no meter are skipped silently - the telemetry stream
 * carries far more than billing cares about, and warning on each would drown
 * the log.
 */
export function meterTelemetry(
  organizationId: string,
  records: readonly TelemetryRecord[],
  options: MeterOptions = {},
): MeteredDelta[] {
  const mappings = options.mappings ?? DEFAULT_METER_MAPPINGS
  const counters = options.counters
  const deltas: MeteredDelta[] = []
  for (const record of records) {
    const mapping = findMapping(record.name, mappings)
    if (!mapping) continue
    let quantity = quantityFrom(record, mapping)
    if (quantity == null) continue
    if (mapping.cumulative) {
      if (!counters) continue
      const counterKey = [record.projectId, record.environmentId ?? '', record.resourceId ?? '', record.name, record.source].join('\0')
      const differenced = counters.delta(counterKey, quantity, record.timestamp)
      if (differenced == null) continue
      quantity = differenced
    }
    if (!(quantity > 0)) continue
    const delta: UsageDelta = {
      organizationId,
      projectId: record.projectId,
      environmentId: record.environmentId,
      resourceId: record.resourceId,
      provider: attributeString(record.attributes, 'provider') ?? options.defaultProvider,
      region: record.region ?? attributeString(record.attributes, 'region'),
      meter: mapping.meter,
      quantity,
      timestamp: record.timestamp,
      attributes: { source: record.source, signal: record.name },
    }
    deltas.push({ ...delta, key: usageDeltaKey(delta, record.id) })
  }
  return deltas
}

/** Collapse deltas that share a scope, meter, and hour. Fewer rows, same total. */
export function aggregateDeltas(deltas: readonly UsageDelta[]): UsageDelta[] {
  const grouped = new Map<string, UsageDelta>()
  for (const delta of deltas) {
    const bucket = new Date(Math.floor(new Date(delta.timestamp).getTime() / 3_600_000) * 3_600_000).toISOString()
    const key = [
      delta.organizationId,
      delta.projectId ?? '',
      delta.environmentId ?? '',
      delta.resourceId ?? '',
      delta.provider ?? '',
      delta.region ?? '',
      delta.meter,
      bucket,
    ].join('\0')
    const existing = grouped.get(key)
    if (existing) existing.quantity += delta.quantity
    else grouped.set(key, { ...delta, timestamp: bucket })
  }
  return [...grouped.values()]
}
