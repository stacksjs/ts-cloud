/**
 * FOCUS export: cost data in the shape FinOps tools already read.
 *
 * FOCUS (FinOps Open Cost and Usage Specification) is the interchange format
 * Vantage, CloudZero, and the rest ingest. Emitting it matters more than it
 * looks: without it, every team wanting cost observability writes a bespoke
 * transformer against our column names, and that transformer breaks the first
 * time we add a meter.
 *
 * Two deliberate choices:
 *
 *   - **Newline-delimited JSON**, not an array. A year of hourly rollups is
 *     large, and a consumer should be able to stream it without holding the
 *     whole export in memory - which also means we can generate it without
 *     doing so either.
 *   - **Daily granularity by default.** FOCUS consumers expect a billing
 *     period grain, and an hourly export is ~24x the rows for detail nobody
 *     reconciles against an invoice. Hourly stays available for our own API.
 */
import type { UsageRollup } from './model'
import { METERS } from './model'

/** The specification version these rows conform to. */
export const FOCUS_VERSION = '1.3'

/**
 * A FOCUS billing record.
 *
 * Column names are the specification's, not ours - that is the whole point.
 * Only the columns we can populate honestly are emitted; inventing a
 * `ContractedCost` we do not know would be worse than omitting it.
 */
export interface FocusRecord {
  /** Specification version, so a consumer can branch on it. */
  FocusVersion: string
  /** Inclusive start of the charge period, ISO-8601. */
  ChargePeriodStart: string
  /** Exclusive end. */
  ChargePeriodEnd: string
  BillingPeriodStart: string
  BillingPeriodEnd: string
  BillingCurrency: string
  /** What the customer is billed. We report our estimate. */
  BilledCost: number
  /** Amortized cost. Identical to billed here: we model no commitments. */
  EffectiveCost: number
  ListCost: number
  ChargeCategory: 'Usage'
  ChargeDescription: string
  /** `AWS`, `Hetzner`, or whatever the meter was attributed to. */
  ProviderName: string
  PublisherName: string
  InvoiceIssuerName: string
  ServiceName: string
  ServiceCategory: string
  /** Our meter key, so a consumer can map back to what we measured. */
  SkuId: string
  PricingUnit: string
  PricingQuantity: number
  ConsumedQuantity: number
  ConsumedUnit: string
  RegionId?: string
  ResourceId?: string
  /** The project and environment, so cost splits the way teams are organized. */
  SubAccountId?: string
  SubAccountName?: string
  Tags: Record<string, string>
}

/**
 * Map a meter to a FOCUS service category.
 *
 * The specification's categories are coarse on purpose; picking the nearest
 * honest one beats inventing a category no consumer knows how to group.
 */
function serviceCategory(meter: string): string {
  if (meter.startsWith('edge.') || meter.startsWith('object.egress')) return 'Networking'
  if (meter.startsWith('function.') || meter.startsWith('compute.') || meter.startsWith('build.')) return 'Compute'
  if (meter.startsWith('storage.') || meter.startsWith('object.')) return 'Storage'
  if (meter.startsWith('database.')) return 'Databases'
  if (meter.startsWith('telemetry.')) return 'Management and Governance'
  return 'Other'
}

function serviceName(meter: string): string {
  return METERS[meter]?.label ?? meter
}

function pricingUnit(meter: string): string {
  const unit = METERS[meter]?.unit
  if (unit === 'gb') return 'GB'
  if (unit === 'gb_hours') return 'GB-Hours'
  if (unit === 'gb_seconds') return 'GB-Seconds'
  if (unit === 'hours') return 'Hours'
  if (unit === 'minutes') return 'Minutes'
  if (unit === 'requests') return 'Requests'
  if (unit === 'invocations') return 'Invocations'
  return 'Count'
}

export interface FocusExportOptions {
  /** Billing period the rows belong to. */
  billingPeriodStart: string
  billingPeriodEnd: string
  currency?: string
  /** `daily` (the FOCUS norm) or `hourly` (our native grain). */
  granularity?: 'hourly' | 'daily'
  /** Names for the sub-account column, keyed by project id. */
  projectNames?: Record<string, string>
}

function dayStart(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`
}

function addDay(iso: string): string {
  return new Date(new Date(iso).getTime() + 86_400_000).toISOString()
}

function addHour(iso: string): string {
  return new Date(new Date(iso).getTime() + 3_600_000).toISOString()
}

/**
 * Convert rollups into FOCUS records.
 *
 * Rows are aggregated to the requested grain first. Emitting one record per
 * rollup at daily granularity would produce 24 rows per day per meter that a
 * consumer then has to sum, which defeats the point of choosing a grain.
 */
export function toFocusRecords(rollups: readonly UsageRollup[], options: FocusExportOptions): FocusRecord[] {
  const currency = options.currency ?? 'USD'
  const daily = (options.granularity ?? 'daily') === 'daily'
  const grouped = new Map<string, { rollup: UsageRollup; quantity: number; costCents: number; start: string }>()

  for (const rollup of rollups) {
    const start = daily ? dayStart(rollup.bucketStart) : rollup.bucketStart
    const key = [start, rollup.meter, rollup.provider, rollup.region, rollup.projectId, rollup.resourceId].join('\0')
    const existing = grouped.get(key)
    if (existing) {
      existing.quantity += rollup.quantity
      existing.costCents += rollup.costCents
    } else {
      grouped.set(key, { rollup, quantity: rollup.quantity, costCents: rollup.costCents, start })
    }
  }

  return [...grouped.values()]
    .sort((a, b) => a.start.localeCompare(b.start) || String(a.rollup.meter).localeCompare(String(b.rollup.meter)))
    .map(({ rollup, quantity, costCents, start }) => {
      // FOCUS costs are in the billing currency's major unit, not cents.
      const cost = Math.round(costCents) / 100
      const provider = rollup.provider || 'ts-cloud'
      return {
        FocusVersion: FOCUS_VERSION,
        ChargePeriodStart: start,
        ChargePeriodEnd: daily ? addDay(start) : addHour(start),
        BillingPeriodStart: options.billingPeriodStart,
        BillingPeriodEnd: options.billingPeriodEnd,
        BillingCurrency: currency,
        BilledCost: cost,
        // No commitments are modelled, so amortized and list cost are the same
        // number. Reporting a different one would be a fabricated discount.
        EffectiveCost: cost,
        ListCost: cost,
        ChargeCategory: 'Usage' as const,
        ChargeDescription: `${serviceName(rollup.meter)} on ${provider}`,
        ProviderName: provider,
        PublisherName: provider,
        InvoiceIssuerName: provider,
        ServiceName: serviceName(rollup.meter),
        ServiceCategory: serviceCategory(String(rollup.meter)),
        SkuId: String(rollup.meter),
        PricingUnit: pricingUnit(String(rollup.meter)),
        PricingQuantity: quantity,
        ConsumedQuantity: quantity,
        ConsumedUnit: pricingUnit(String(rollup.meter)),
        RegionId: rollup.region || undefined,
        ResourceId: rollup.resourceId || undefined,
        SubAccountId: rollup.projectId || undefined,
        SubAccountName: rollup.projectId ? (options.projectNames?.[rollup.projectId] ?? rollup.projectId) : undefined,
        Tags: {
          ...(rollup.environmentId ? { environment: rollup.environmentId } : {}),
          ...(rollup.projectId ? { project: rollup.projectId } : {}),
        },
      }
    })
}

/** Serialize to newline-delimited JSON, one record per line. */
export function toFocusJsonl(records: readonly FocusRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
}

/**
 * Stream the export.
 *
 * A year at hourly grain is hundreds of thousands of rows; building one string
 * would hold the whole export in memory on both ends. The chunking is by
 * record count rather than bytes because a consumer reads lines, not bytes.
 */
export function* streamFocusJsonl(records: readonly FocusRecord[], chunkSize = 500): Generator<string> {
  for (let index = 0; index < records.length; index += chunkSize)
    yield toFocusJsonl(records.slice(index, index + chunkSize))
}
