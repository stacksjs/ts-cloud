import type { UsageRollup } from './model'
import { describe, expect, it } from 'bun:test'
import { FOCUS_VERSION, streamFocusJsonl, toFocusJsonl, toFocusRecords } from './focus'

function rollup(overrides: Partial<UsageRollup> = {}): UsageRollup {
  return {
    organizationId: 'org-1',
    projectId: 'proj-1',
    environmentId: 'env-1',
    resourceId: '',
    provider: 'aws',
    region: 'us-east-1',
    meter: 'edge.egress_gb',
    bucketStart: '2026-07-15T10:00:00.000Z',
    quantity: 12,
    costCents: 102,
    sampleCount: 1,
    updatedAt: '2026-07-15T11:00:00.000Z',
    ...overrides,
  }
}

const PERIOD = { billingPeriodStart: '2026-07-01T00:00:00.000Z', billingPeriodEnd: '2026-08-01T00:00:00.000Z' }

describe('FOCUS records', () => {
  it('emits the specification column names, not ours', () => {
    const [record] = toFocusRecords([rollup()], PERIOD)
    for (const column of [
      'FocusVersion',
      'ChargePeriodStart',
      'BillingCurrency',
      'BilledCost',
      'ServiceCategory',
      'SkuId',
      'PricingQuantity',
    ])
      expect(record).toHaveProperty(column)
    expect(record.FocusVersion).toBe(FOCUS_VERSION)
  })

  it('reports money in the major unit, not cents', () => {
    // A consumer summing cents as dollars would be off by 100x.
    expect(toFocusRecords([rollup({ costCents: 102 })], PERIOD)[0].BilledCost).toBe(1.02)
  })

  it('reports billed, effective, and list cost as the same number', () => {
    const [record] = toFocusRecords([rollup()], PERIOD)
    // No commitments are modelled; a different effective cost would be a
    // fabricated discount.
    expect(record.EffectiveCost).toBe(record.BilledCost)
    expect(record.ListCost).toBe(record.BilledCost)
  })

  it('aggregates to a daily grain by default', () => {
    const rollups = [
      rollup({ bucketStart: '2026-07-15T10:00:00.000Z', quantity: 10, costCents: 100 }),
      rollup({ bucketStart: '2026-07-15T14:00:00.000Z', quantity: 5, costCents: 50 }),
      rollup({ bucketStart: '2026-07-16T02:00:00.000Z', quantity: 2, costCents: 20 }),
    ]
    const records = toFocusRecords(rollups, PERIOD)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      ChargePeriodStart: '2026-07-15T00:00:00.000Z',
      ChargePeriodEnd: '2026-07-16T00:00:00.000Z',
      PricingQuantity: 15,
      BilledCost: 1.5,
    })
  })

  it('keeps the hourly grain when asked', () => {
    const rollups = [
      rollup({ bucketStart: '2026-07-15T10:00:00.000Z' }),
      rollup({ bucketStart: '2026-07-15T14:00:00.000Z' }),
    ]
    const records = toFocusRecords(rollups, { ...PERIOD, granularity: 'hourly' })
    expect(records).toHaveLength(2)
    expect(records[0].ChargePeriodEnd).toBe('2026-07-15T11:00:00.000Z')
  })

  it('never merges different meters, providers, or projects', () => {
    const records = toFocusRecords(
      [
        rollup({ meter: 'edge.egress_gb' }),
        rollup({ meter: 'edge.requests' }),
        rollup({ provider: 'hetzner' }),
        rollup({ projectId: 'proj-2' }),
      ],
      PERIOD,
    )
    expect(records).toHaveLength(4)
  })

  it('maps meters onto the specification service categories', () => {
    const categories = Object.fromEntries(
      toFocusRecords(
        [
          rollup({ meter: 'edge.egress_gb' }),
          rollup({ meter: 'function.gb_seconds' }),
          rollup({ meter: 'storage.gb_hours' }),
          rollup({ meter: 'database.gb_hours' }),
          rollup({ meter: 'unknown.thing' }),
        ],
        PERIOD,
      ).map((record) => [record.SkuId, record.ServiceCategory]),
    )
    expect(categories).toMatchObject({
      'edge.egress_gb': 'Networking',
      'function.gb_seconds': 'Compute',
      'storage.gb_hours': 'Storage',
      'database.gb_hours': 'Databases',
      'unknown.thing': 'Other',
    })
  })

  it('carries the project and environment so cost splits by team', () => {
    const [record] = toFocusRecords([rollup()], { ...PERIOD, projectNames: { 'proj-1': 'Web' } })
    expect(record.SubAccountId).toBe('proj-1')
    expect(record.SubAccountName).toBe('Web')
    expect(record.Tags).toMatchObject({ environment: 'env-1', project: 'proj-1' })
  })

  it('falls back to the project id when no name is supplied', () => {
    expect(toFocusRecords([rollup()], PERIOD)[0].SubAccountName).toBe('proj-1')
  })

  it('omits empty optional columns rather than emitting blanks', () => {
    const [record] = toFocusRecords([rollup({ region: '', resourceId: '' })], PERIOD)
    expect(record.RegionId).toBeUndefined()
    expect(record.ResourceId).toBeUndefined()
  })

  it('sorts by period then meter, so a diff between exports is readable', () => {
    const records = toFocusRecords(
      [
        rollup({ bucketStart: '2026-07-16T02:00:00.000Z', meter: 'edge.requests' }),
        rollup({ bucketStart: '2026-07-15T02:00:00.000Z', meter: 'storage.gb_hours' }),
        rollup({ bucketStart: '2026-07-15T02:00:00.000Z', meter: 'edge.egress_gb' }),
      ],
      PERIOD,
    )
    expect(records.map((record) => `${record.ChargePeriodStart.slice(8, 10)}:${record.SkuId}`)).toEqual([
      '15:edge.egress_gb',
      '15:storage.gb_hours',
      '16:edge.requests',
    ])
  })
})

describe('JSONL serialization', () => {
  it('writes one JSON object per line, each independently parseable', () => {
    const records = toFocusRecords([rollup(), rollup({ meter: 'edge.requests' })], PERIOD)
    const lines = toFocusJsonl(records).trim().split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('is not a JSON array, so a consumer can stream it', () => {
    const output = toFocusJsonl(toFocusRecords([rollup()], PERIOD))
    expect(output.startsWith('[')).toBe(false)
    expect(output.endsWith('\n')).toBe(true)
  })

  it('emits nothing at all for no records', () => {
    expect(toFocusJsonl([])).toBe('')
  })

  it('streams in chunks without dropping or duplicating a record', () => {
    const rollups = Array.from({ length: 1_200 }, (_, index) =>
      rollup({ bucketStart: new Date(Date.UTC(2026, 6, 1) + index * 86_400_000).toISOString() }),
    )
    const records = toFocusRecords(rollups, PERIOD)
    const streamed = [...streamFocusJsonl(records, 500)].join('')
    expect(streamed).toBe(toFocusJsonl(records))
    expect(streamed.trim().split('\n')).toHaveLength(records.length)
  })
})
