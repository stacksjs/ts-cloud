/**
 * The price book: usage in, cents out.
 *
 * Caps have to be enforceable on any provider, including ones with no billing
 * API at all. A Hetzner box has a fixed monthly price and an included traffic
 * allowance; a local box costs nothing until it egresses. Neither will ever
 * answer a Cost Explorer query, so the platform prices usage itself and treats
 * the provider invoice as a later correction rather than the source of truth.
 *
 * Rates are cents per unit and are stored as `microCentsPerUnit` (cents x 1e6)
 * because per-request prices are genuinely tiny - CloudFront charges about
 * 0.0000075 cents per request, which rounds to zero in any coarser unit and
 * would silently make request floods free.
 */
import type { MeterKey } from './model'

/** Cents x 1e6, so sub-cent unit prices survive integer storage. */
export const MICRO_CENTS = 1_000_000

/**
 * A graduated pricing tier.
 *
 * `upToQuantity` is the cumulative top of the tier, `null` for the final,
 * unbounded one. Graduated (not flat-rate) semantics: quantity inside each tier
 * is charged at that tier's rate, matching how every cloud actually bills.
 */
export interface PriceTier {
  upToQuantity: number | null
  microCentsPerUnit: number
}

export interface PriceEntry {
  meter: MeterKey
  provider: string
  /** Omit for a provider-wide default; a region-specific entry wins over it. */
  region?: string
  /** Quantity billed at zero before tiers apply (a free allowance). */
  includedQuantity?: number
  /** Flat rate. Ignored when `tiers` is present. */
  microCentsPerUnit?: number
  tiers?: PriceTier[]
  /**
   * Charged once per window regardless of usage (a box's monthly rental).
   * Applied by the caller for the whole window, not per usage record.
   */
  fixedCentsPerPeriod?: number
}

export interface PriceBook {
  currency: string
  entries: PriceEntry[]
}

export interface PricedUsage {
  meter: MeterKey
  provider: string
  region?: string
  quantity: number
  /** Quantity that fell inside the free allowance. */
  includedQuantity: number
  billableQuantity: number
  costCents: number
  /** No price entry matched; cost is 0 and the caller should surface this. */
  unpriced: boolean
}

export interface PricedTotal {
  currency: string
  totalCents: number
  lines: PricedUsage[]
  /** Meters that had usage but no matching price entry. */
  unpricedMeters: string[]
}

function tiersFrom(entry: PriceEntry): PriceTier[] {
  if (entry.tiers && entry.tiers.length > 0) return entry.tiers
  return [{ upToQuantity: null, microCentsPerUnit: entry.microCentsPerUnit ?? 0 }]
}

/**
 * Cost of `quantity` units under a graduated tier list, in micro-cents.
 *
 * Tiers are sorted defensively: a book assembled from several sources should
 * not price differently because someone listed the unbounded tier first.
 */
export function tieredMicroCents(quantity: number, tiers: PriceTier[]): number {
  if (!(quantity > 0)) return 0
  const ordered = [...tiers].sort((a, b) => {
    if (a.upToQuantity === null) return 1
    if (b.upToQuantity === null) return -1
    return a.upToQuantity - b.upToQuantity
  })
  let remaining = quantity
  let consumed = 0
  let total = 0
  for (const tier of ordered) {
    if (remaining <= 0) break
    const ceiling = tier.upToQuantity === null ? Infinity : tier.upToQuantity
    const width = ceiling - consumed
    if (width <= 0) continue
    const take = Math.min(remaining, width)
    total += take * tier.microCentsPerUnit
    remaining -= take
    consumed += take
  }
  // A book whose last tier is bounded leaves a remainder; charge it at the
  // highest defined rate rather than silently making the overage free.
  if (remaining > 0) {
    const highest = ordered.reduce((max, tier) => Math.max(max, tier.microCentsPerUnit), 0)
    total += remaining * highest
  }
  return total
}

/** Most specific match wins: exact region, then provider default, then wildcard provider. */
export function findPriceEntry(book: PriceBook, meter: MeterKey, provider?: string, region?: string): PriceEntry | undefined {
  const candidates = book.entries.filter((entry) => entry.meter === meter)
  if (candidates.length === 0) return undefined
  const byProvider = candidates.filter((entry) => entry.provider === provider)
  const pool = byProvider.length > 0 ? byProvider : candidates.filter((entry) => entry.provider === '*')
  return pool.find((entry) => entry.region === region) ?? pool.find((entry) => entry.region == null)
}

export interface UsageLine {
  meter: MeterKey
  quantity: number
  provider?: string
  region?: string
}

/**
 * Price one usage line.
 *
 * `alreadyUsedQuantity` lets a caller price incrementally across a window while
 * still honouring a free allowance: pass the quantity already billed this
 * period and the allowance is consumed once, not once per call.
 */
export function priceUsage(book: PriceBook, line: UsageLine, alreadyUsedQuantity: number = 0): PricedUsage {
  const entry = findPriceEntry(book, line.meter, line.provider, line.region)
  const quantity = Math.max(0, line.quantity)
  if (!entry) {
    return {
      meter: line.meter,
      provider: line.provider ?? 'unknown',
      region: line.region,
      quantity,
      includedQuantity: 0,
      billableQuantity: quantity,
      costCents: 0,
      unpriced: true,
    }
  }
  const allowance = Math.max(0, entry.includedQuantity ?? 0)
  const priorBillable = Math.max(0, alreadyUsedQuantity - allowance)
  const remainingAllowance = Math.max(0, allowance - Math.max(0, alreadyUsedQuantity))
  const included = Math.min(quantity, remainingAllowance)
  const billable = quantity - included
  const tiers = tiersFrom(entry)
  // Price cumulatively and subtract what was already charged, so tier
  // boundaries land where the period total crosses them - not where an
  // arbitrary batch of records happens to start.
  const micro = tieredMicroCents(priorBillable + billable, tiers) - tieredMicroCents(priorBillable, tiers)
  return {
    meter: line.meter,
    provider: entry.provider,
    region: entry.region ?? line.region,
    quantity,
    includedQuantity: included,
    billableQuantity: billable,
    costCents: micro / MICRO_CENTS,
    unpriced: false,
  }
}

/** Price a set of lines, one allowance per (meter, provider, region). */
export function priceUsageLines(book: PriceBook, lines: UsageLine[]): PricedTotal {
  const consumed = new Map<string, number>()
  const priced: PricedUsage[] = []
  for (const line of lines) {
    const key = `${line.meter}\0${line.provider ?? ''}\0${line.region ?? ''}`
    const already = consumed.get(key) ?? 0
    const result = priceUsage(book, line, already)
    consumed.set(key, already + result.quantity)
    priced.push(result)
  }
  return {
    currency: book.currency,
    totalCents: priced.reduce((sum, item) => sum + item.costCents, 0),
    lines: priced,
    unpricedMeters: [...new Set(priced.filter((item) => item.unpriced).map((item) => String(item.meter)))],
  }
}

/** Round a cent amount to whole cents for storage or display. */
export function roundCents(cents: number): number {
  return Math.round(cents * 100) / 100
}

/**
 * Merge price books, later entries winning on an exact (meter, provider,
 * region) match. This is how an operator overrides a shipped default without
 * forking the whole book.
 */
export function mergePriceBooks(base: PriceBook, ...overrides: PriceBook[]): PriceBook {
  const merged = new Map<string, PriceEntry>()
  const keyOf = (entry: PriceEntry): string => `${entry.meter}\0${entry.provider}\0${entry.region ?? ''}`
  for (const entry of base.entries) merged.set(keyOf(entry), entry)
  let currency = base.currency
  for (const book of overrides) {
    currency = book.currency || currency
    for (const entry of book.entries) merged.set(keyOf(entry), entry)
  }
  return { currency, entries: [...merged.values()] }
}

const perGb = (cents: number): number => Math.round(cents * MICRO_CENTS)
const perUnit = (cents: number): number => Math.round(cents * MICRO_CENTS)

/**
 * Shipped defaults, in US cents, list price, us-east-1 / eu-central.
 *
 * These are estimates for *forecasting and capping*, not an invoice. They are
 * intentionally slightly conservative (rounded up) so a cap trips a little
 * early rather than a little late - the failure mode of a cap that fires at
 * 101% is a surprised user, and the whole point is not to surprise them.
 */
export const DEFAULT_PRICE_BOOK: PriceBook = {
  currency: 'USD',
  entries: [
    // AWS
    { meter: 'edge.requests', provider: 'aws', microCentsPerUnit: perUnit(0.0000075 * 100) },
    {
      meter: 'edge.egress_gb',
      provider: 'aws',
      includedQuantity: 100,
      tiers: [
        { upToQuantity: 10_240, microCentsPerUnit: perGb(8.5) },
        { upToQuantity: 51_200, microCentsPerUnit: perGb(8.0) },
        { upToQuantity: null, microCentsPerUnit: perGb(6.0) },
      ],
    },
    { meter: 'function.invocations', provider: 'aws', includedQuantity: 1_000_000, microCentsPerUnit: perUnit(0.00002 * 100) },
    { meter: 'function.gb_seconds', provider: 'aws', includedQuantity: 400_000, microCentsPerUnit: perUnit(0.0000166667 * 100) },
    { meter: 'storage.gb_hours', provider: 'aws', microCentsPerUnit: perUnit((0.08 / 730) * 100) },
    { meter: 'object.egress_gb', provider: 'aws', includedQuantity: 100, microCentsPerUnit: perGb(9.0) },
    { meter: 'object.requests', provider: 'aws', microCentsPerUnit: perUnit(0.0000004 * 100) },
    { meter: 'database.gb_hours', provider: 'aws', microCentsPerUnit: perUnit((0.115 / 730) * 100) },
    { meter: 'compute.instance_hours', provider: 'aws', microCentsPerUnit: perUnit(0.0416 * 100) },

    // Hetzner: cheap egress with a large included allowance, then a flat overage.
    { meter: 'edge.egress_gb', provider: 'hetzner', includedQuantity: 20_480, microCentsPerUnit: perGb(0.108) },
    { meter: 'object.egress_gb', provider: 'hetzner', includedQuantity: 1_024, microCentsPerUnit: perGb(0.108) },
    { meter: 'compute.instance_hours', provider: 'hetzner', microCentsPerUnit: perUnit(0.0095 * 100) },
    { meter: 'storage.gb_hours', provider: 'hetzner', microCentsPerUnit: perUnit((0.044 / 730) * 100) },
    { meter: 'edge.requests', provider: 'hetzner', microCentsPerUnit: 0 },

    // A local box bills nothing, but still meters - so a runaway loop is
    // visible in development, where it is cheapest to find.
    { meter: 'edge.requests', provider: 'local', microCentsPerUnit: 0 },
    { meter: 'edge.egress_gb', provider: 'local', microCentsPerUnit: 0 },
    { meter: 'function.invocations', provider: 'local', microCentsPerUnit: 0 },
    { meter: 'function.gb_seconds', provider: 'local', microCentsPerUnit: 0 },

    // Platform-level meters that are provider-independent.
    { meter: 'build.minutes', provider: '*', includedQuantity: 6_000, microCentsPerUnit: perUnit(0.008 * 100) },
    { meter: 'telemetry.ingest_gb', provider: '*', includedQuantity: 5, microCentsPerUnit: perGb(50) },
    { meter: 'image.transformations', provider: '*', includedQuantity: 5_000, microCentsPerUnit: perUnit(0.0005 * 100) },
  ],
}
