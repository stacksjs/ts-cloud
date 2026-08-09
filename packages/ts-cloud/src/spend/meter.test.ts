import type { TelemetryRecord } from '../telemetry'
import { describe, expect, it } from 'bun:test'
import { aggregateDeltas, CounterTracker, findMapping, meterTelemetry, usageDeltaKey } from './meter'

const BYTES_PER_GB = 1024 ** 3

function record(overrides: Partial<TelemetryRecord> & Pick<TelemetryRecord, 'name'>): TelemetryRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: 'proj-1',
    kind: 'metric',
    source: 'edge-collector',
    timestamp: '2026-07-15T12:30:00.000Z',
    observedAt: '2026-07-15T12:30:01.000Z',
    sampled: false,
    attributes: {},
    ingestedBytes: 0,
    ...overrides,
  } as TelemetryRecord
}

describe('mapping resolution', () => {
  it('prefers an exact match over a prefix rule', () => {
    const mappings = [
      { match: 'function.*', meter: 'function.invocations' as const },
      { match: 'function.duration_ms', meter: 'function.gb_seconds' as const },
    ]
    expect(findMapping('function.duration_ms', mappings)?.meter).toBe('function.gb_seconds')
    expect(findMapping('function.cold_start', mappings)?.meter).toBe('function.invocations')
  })

  it('returns nothing for an unmapped signal', () => {
    expect(findMapping('cpu.load')).toBeUndefined()
  })
})

describe('counter differencing', () => {
  it('bills the first reading in full, then only increments', () => {
    const tracker = new CounterTracker()
    expect(tracker.delta('a', 100, '2026-07-15T12:00:00Z')).toBe(100)
    expect(tracker.delta('a', 150, '2026-07-15T13:00:00Z')).toBe(50)
    expect(tracker.delta('a', 150, '2026-07-15T14:00:00Z')).toBeUndefined()
  })

  it('treats a counter restart as a fresh total rather than a negative delta', () => {
    const tracker = new CounterTracker()
    tracker.delta('a', 900, '2026-07-15T12:00:00Z')
    expect(tracker.delta('a', 40, '2026-07-15T13:00:00Z')).toBe(40)
    expect(tracker.delta('a', 60, '2026-07-15T14:00:00Z')).toBe(20)
  })

  it('holds the high-water mark through float noise instead of double-billing', () => {
    const tracker = new CounterTracker()
    tracker.delta('a', 1000, '2026-07-15T12:00:00Z')
    expect(tracker.delta('a', 999.9, '2026-07-15T13:00:00Z')).toBeUndefined()
    // Climbing back past the dip bills only the genuinely new units.
    expect(tracker.delta('a', 1010, '2026-07-15T14:00:00Z')).toBe(10)
  })

  it('ignores an out-of-order sample and keeps the later reading authoritative', () => {
    const tracker = new CounterTracker()
    tracker.delta('a', 100, '2026-07-15T13:00:00Z')
    expect(tracker.delta('a', 80, '2026-07-15T12:00:00Z')).toBeUndefined()
    expect(tracker.delta('a', 120, '2026-07-15T14:00:00Z')).toBe(20)
  })

  it('rejects a non-finite or negative reading', () => {
    const tracker = new CounterTracker()
    expect(tracker.delta('a', Number.NaN)).toBeUndefined()
    expect(tracker.delta('a', -1)).toBeUndefined()
  })

  it('keeps counters per key', () => {
    const tracker = new CounterTracker()
    tracker.delta('a', 100)
    tracker.delta('b', 500)
    expect(tracker.delta('a', 110)).toBe(10)
    expect(tracker.size).toBe(2)
  })

  it('prunes counters for hosts that stopped reporting', () => {
    const tracker = new CounterTracker()
    tracker.delta('a', 100, '2026-07-01T00:00:00Z')
    tracker.delta('b', 100, '2026-07-15T00:00:00Z')
    expect(tracker.prune(new Date('2026-07-10T00:00:00Z'))).toBe(1)
    expect(tracker.size).toBe(1)
  })
})

describe('metering telemetry', () => {
  it('maps request counts and scales byte counters into gigabytes', () => {
    const deltas = meterTelemetry('org-1', [
      record({ name: 'request.count', value: 1200 }),
      record({ name: 'traffic.bytes_out', value: 2 * BYTES_PER_GB }),
    ])
    expect(deltas.map((delta) => [delta.meter, delta.quantity])).toEqual([
      ['edge.requests', 1200],
      ['edge.egress_gb', 2],
    ])
  })

  it('counts one unit per record for count-field mappings', () => {
    const deltas = meterTelemetry('org-1', [
      record({ name: 'function.invocation' }),
      record({ name: 'function.invocation' }),
    ])
    expect(deltas).toHaveLength(2)
    expect(deltas.every((delta) => delta.quantity === 1)).toBe(true)
  })

  it('converts function duration into gb-seconds', () => {
    const deltas = meterTelemetry('org-1', [record({ name: 'function.duration_ms', value: 4500 })])
    expect(deltas[0]).toMatchObject({ meter: 'function.gb_seconds', quantity: 4.5 })
  })

  it('skips unmapped signals without complaint', () => {
    expect(meterTelemetry('org-1', [record({ name: 'cpu.load', value: 3 })])).toEqual([])
  })

  it('skips a cumulative signal when no counter tracker is supplied', () => {
    const deltas = meterTelemetry('org-1', [record({ name: 'storage.egress.month', value: BYTES_PER_GB })])
    expect(deltas).toEqual([])
  })

  it('differences a cumulative signal across scrapes', () => {
    const counters = new CounterTracker()
    const first = meterTelemetry(
      'org-1',
      [record({ name: 'storage.egress.month', value: 10 * BYTES_PER_GB, timestamp: '2026-07-15T12:00:00.000Z' })],
      { counters },
    )
    const second = meterTelemetry(
      'org-1',
      [record({ name: 'storage.egress.month', value: 14 * BYTES_PER_GB, timestamp: '2026-07-15T13:00:00.000Z' })],
      { counters },
    )
    expect(first[0].quantity).toBe(10)
    expect(second[0].quantity).toBe(4)
  })

  it('reads provider and region from the record and falls back to the default', () => {
    const deltas = meterTelemetry(
      'org-1',
      [
        record({ name: 'request.count', value: 1, attributes: { provider: 'hetzner' }, region: 'nbg1' }),
        record({ name: 'request.count', value: 1 }),
      ],
      { defaultProvider: 'aws' },
    )
    expect(deltas[0]).toMatchObject({ provider: 'hetzner', region: 'nbg1' })
    expect(deltas[1]).toMatchObject({ provider: 'aws' })
  })

  it('drops zero and negative quantities', () => {
    const deltas = meterTelemetry('org-1', [
      record({ name: 'request.count', value: 0 }),
      record({ name: 'request.count', value: -5 }),
    ])
    expect(deltas).toEqual([])
  })

  it('produces a stable key so replaying a record cannot double-count', () => {
    const one = record({ id: 'tel-1', name: 'request.count', value: 10 })
    const first = meterTelemetry('org-1', [one])
    const second = meterTelemetry('org-1', [one])
    expect(first[0].key).toBe(second[0].key)
    expect(usageDeltaKey(first[0], 'tel-2')).not.toBe(first[0].key)
  })
})

describe('delta aggregation', () => {
  it('collapses same-scope deltas into one hour bucket without losing quantity', () => {
    const deltas = meterTelemetry('org-1', [
      record({ name: 'request.count', value: 10, timestamp: '2026-07-15T12:05:00.000Z' }),
      record({ name: 'request.count', value: 15, timestamp: '2026-07-15T12:55:00.000Z' }),
      record({ name: 'request.count', value: 5, timestamp: '2026-07-15T13:05:00.000Z' }),
    ])
    const aggregated = aggregateDeltas(deltas)
    expect(aggregated).toHaveLength(2)
    expect(aggregated[0]).toMatchObject({ quantity: 25, timestamp: '2026-07-15T12:00:00.000Z' })
    expect(aggregated[1]).toMatchObject({ quantity: 5, timestamp: '2026-07-15T13:00:00.000Z' })
  })

  it('keeps different meters and providers apart', () => {
    const aggregated = aggregateDeltas([
      { organizationId: 'o', meter: 'edge.requests', quantity: 1, timestamp: '2026-07-15T12:00:00.000Z', provider: 'aws' },
      { organizationId: 'o', meter: 'edge.requests', quantity: 1, timestamp: '2026-07-15T12:00:00.000Z', provider: 'hetzner' },
      { organizationId: 'o', meter: 'edge.egress_gb', quantity: 1, timestamp: '2026-07-15T12:00:00.000Z', provider: 'aws' },
    ])
    expect(aggregated).toHaveLength(3)
  })
})
