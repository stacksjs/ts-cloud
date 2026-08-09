import type { PriceBook } from './pricing'
import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_PRICE_BOOK,
  findPriceEntry,
  mergePriceBooks,
  priceUsage,
  priceUsageLines,
  tieredMicroCents,
} from './pricing'

const book: PriceBook = {
  currency: 'USD',
  entries: [
    {
      meter: 'edge.egress_gb',
      provider: 'aws',
      includedQuantity: 10,
      tiers: [
        { upToQuantity: 100, microCentsPerUnit: 10_000_000 }, // 10 cents/GB
        { upToQuantity: null, microCentsPerUnit: 5_000_000 }, // 5 cents/GB
      ],
    },
    { meter: 'edge.egress_gb', provider: 'aws', region: 'ap-south-1', microCentsPerUnit: 20_000_000 },
    { meter: 'build.minutes', provider: '*', microCentsPerUnit: 1_000_000 },
  ],
}

describe('graduated tiers', () => {
  it('charges each tier at its own rate rather than the top rate for everything', () => {
    // 150 units: 100 at 10c, 50 at 5c = 1000c + 250c.
    expect(tieredMicroCents(150, book.entries[0].tiers!) / 1_000_000).toBe(1250)
  })

  it('is insensitive to the order tiers were declared in', () => {
    const reversed = [...book.entries[0].tiers!].reverse()
    expect(tieredMicroCents(150, reversed)).toBe(tieredMicroCents(150, book.entries[0].tiers!))
  })

  it('charges an overage past a fully bounded book at the highest rate instead of free', () => {
    const bounded = [
      { upToQuantity: 10, microCentsPerUnit: 1_000_000 },
      { upToQuantity: 20, microCentsPerUnit: 3_000_000 },
    ]
    // 10 at 1c + 10 at 3c + 5 beyond the book at the highest (3c) = 55c.
    expect(tieredMicroCents(25, bounded) / 1_000_000).toBe(55)
  })

  it('treats zero and negative quantities as free', () => {
    expect(tieredMicroCents(0, book.entries[0].tiers!)).toBe(0)
    expect(tieredMicroCents(-5, book.entries[0].tiers!)).toBe(0)
  })
})

describe('price entry resolution', () => {
  it('prefers an exact region over the provider default', () => {
    expect(findPriceEntry(book, 'edge.egress_gb', 'aws', 'ap-south-1')?.microCentsPerUnit).toBe(20_000_000)
    expect(findPriceEntry(book, 'edge.egress_gb', 'aws', 'us-east-1')?.tiers).toBeDefined()
  })

  it('falls back to a wildcard provider entry', () => {
    expect(findPriceEntry(book, 'build.minutes', 'hetzner')?.provider).toBe('*')
  })

  it('returns nothing for an unknown meter', () => {
    expect(findPriceEntry(book, 'nope.meter', 'aws')).toBeUndefined()
  })
})

describe('pricing usage', () => {
  it('consumes the free allowance before charging', () => {
    const priced = priceUsage(book, { meter: 'edge.egress_gb', provider: 'aws', quantity: 30 })
    expect(priced.includedQuantity).toBe(10)
    expect(priced.billableQuantity).toBe(20)
    expect(priced.costCents).toBe(200)
  })

  it('consumes the allowance once across incremental calls', () => {
    const first = priceUsage(book, { meter: 'edge.egress_gb', provider: 'aws', quantity: 6 })
    const second = priceUsage(book, { meter: 'edge.egress_gb', provider: 'aws', quantity: 6 }, 6)
    expect(first.costCents).toBe(0)
    expect(second.includedQuantity).toBe(4)
    expect(second.costCents).toBe(20)
  })

  it('places tier boundaries at the period total, not at the batch boundary', () => {
    // One call for 150 billable must cost the same as two calls of 75.
    const whole = priceUsage(book, { meter: 'edge.egress_gb', provider: 'aws', quantity: 160 })
    const a = priceUsage(book, { meter: 'edge.egress_gb', provider: 'aws', quantity: 80 })
    const b = priceUsage(book, { meter: 'edge.egress_gb', provider: 'aws', quantity: 80 }, 80)
    expect(a.costCents + b.costCents).toBeCloseTo(whole.costCents, 6)
  })

  it('flags an unpriced meter instead of silently charging zero', () => {
    const priced = priceUsage(book, { meter: 'mystery.meter', provider: 'aws', quantity: 100 })
    expect(priced.unpriced).toBe(true)
    expect(priced.costCents).toBe(0)
  })

  it('sums lines and reports unpriced meters', () => {
    const total = priceUsageLines(book, [
      { meter: 'edge.egress_gb', provider: 'aws', quantity: 30 },
      { meter: 'build.minutes', provider: 'hetzner', quantity: 10 },
      { meter: 'mystery.meter', provider: 'aws', quantity: 1 },
    ])
    expect(total.totalCents).toBe(210)
    expect(total.unpricedMeters).toEqual(['mystery.meter'])
  })

  it('applies the allowance once per meter+provider+region across a batch', () => {
    const total = priceUsageLines(book, [
      { meter: 'edge.egress_gb', provider: 'aws', quantity: 5 },
      { meter: 'edge.egress_gb', provider: 'aws', quantity: 15 },
    ])
    // 20 total, 10 free, 10 at 10c.
    expect(total.totalCents).toBe(100)
  })
})

describe('price book merging', () => {
  it('lets an override replace an exact meter+provider+region entry', () => {
    const merged = mergePriceBooks(book, {
      currency: 'USD',
      entries: [{ meter: 'edge.egress_gb', provider: 'aws', microCentsPerUnit: 1_000_000 }],
    })
    const priced = priceUsage(merged, { meter: 'edge.egress_gb', provider: 'aws', quantity: 10 })
    expect(priced.costCents).toBe(10)
    // The region-specific entry is untouched by a provider-default override.
    expect(findPriceEntry(merged, 'edge.egress_gb', 'aws', 'ap-south-1')?.microCentsPerUnit).toBe(20_000_000)
  })
})

describe('shipped defaults', () => {
  it('prices a sub-cent request meter without rounding it to free', () => {
    const priced = priceUsage(DEFAULT_PRICE_BOOK, { meter: 'edge.requests', provider: 'aws', quantity: 10_000_000 })
    expect(priced.costCents).toBeGreaterThan(0)
  })

  it('meters a local box at zero cost so a loop is still visible in development', () => {
    const priced = priceUsage(DEFAULT_PRICE_BOOK, { meter: 'function.invocations', provider: 'local', quantity: 5_000_000 })
    expect(priced.unpriced).toBe(false)
    expect(priced.costCents).toBe(0)
    expect(priced.quantity).toBe(5_000_000)
  })

  it('gives Hetzner egress a large included allowance and AWS egress a small one', () => {
    const hetzner = priceUsage(DEFAULT_PRICE_BOOK, { meter: 'edge.egress_gb', provider: 'hetzner', quantity: 5_000 })
    const aws = priceUsage(DEFAULT_PRICE_BOOK, { meter: 'edge.egress_gb', provider: 'aws', quantity: 5_000 })
    expect(hetzner.costCents).toBe(0)
    expect(aws.costCents).toBeGreaterThan(aws.quantity)
  })
})
