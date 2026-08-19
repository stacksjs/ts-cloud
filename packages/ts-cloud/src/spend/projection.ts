/**
 * Forecasting: where does this window land if nothing changes?
 *
 * A cap that only reacts to actual spend is always late - by the time a
 * monthly budget reads 100%, the money is gone. The useful signal is the
 * forecast, and the hard part about a forecast is knowing when to distrust it.
 * Ten minutes into a month, a burn rate extrapolates to a number that is
 * arithmetically correct and completely meaningless.
 *
 * So every projection carries a confidence, and the evaluator refuses to
 * enforce on a low-confidence one. Two things build confidence: elapsed time
 * (a longer sample is a better sample) and the number of buckets that actually
 * carried spend (one huge hour is a spike, not a trend).
 */
import type { BudgetWindow, SpendProjection } from './model'

export interface ProjectionInput {
  window: BudgetWindow
  actualCents: number
  /** Hourly cost buckets in the window, ascending. Optional but sharpens the estimate. */
  series?: ReadonlyArray<{ bucketStart: string; costCents: number }>
  /** The limit to project exhaustion against, in cents. */
  limitCents?: number
  /**
   * How much weight recent buckets get, 0-1. Higher reacts faster to a spike;
   * 0 falls back to the flat window average.
   */
  recencyWeight?: number
}

/** Fraction of the window elapsed, clamped to [0, 1]. */
function elapsedFraction(window: BudgetWindow): number {
  if (!(window.totalMs > 0)) return 1
  return Math.min(1, Math.max(0, window.elapsedMs / window.totalMs))
}

/**
 * Exponentially weighted burn, in cents per millisecond.
 *
 * The flat average over the window is the honest baseline, but it badly
 * under-reacts to the case this whole subsystem exists for: a loop that starts
 * on day 20 of a month. Blending in a recency-weighted rate lets the forecast
 * move within an hour of the spike while still being anchored by history.
 */
function weightedBurnCentsPerMs(input: ProjectionInput): number {
  const window = input.window
  const elapsed = Math.max(1, window.elapsedMs)
  const flat = input.actualCents / elapsed
  const series = input.series ?? []
  const weight = Math.min(1, Math.max(0, input.recencyWeight ?? 0.6))
  if (series.length < 2 || weight === 0) return flat
  // EWMA over hourly buckets: alpha chosen so ~the last 6 hours dominate.
  const alpha = 0.3
  let ewma = series[0].costCents
  for (let index = 1; index < series.length; index++) ewma = alpha * series[index].costCents + (1 - alpha) * ewma
  const recent = ewma / 3_600_000
  return flat * (1 - weight) + recent * weight
}

/**
 * Confidence in the forecast, 0-1.
 *
 * Deliberately conservative early: at 5% elapsed the forecast is worth almost
 * nothing no matter how many buckets it saw, which is why the two factors
 * multiply rather than average.
 */
function projectionConfidence(window: BudgetWindow, buckets: number): number {
  const elapsed = elapsedFraction(window)
  // Saturating curve: 0 at the start, ~0.63 at a third elapsed, ~0.95 at full.
  const timeFactor = 1 - Math.exp(-3 * elapsed)
  // Six populated buckets is enough to distinguish a rate from an accident.
  const sampleFactor = Math.min(1, buckets / 6)
  return Math.round(timeFactor * sampleFactor * 100) / 100
}

export function projectSpend(input: ProjectionInput): SpendProjection {
  const window = input.window
  const elapsed = elapsedFraction(window)
  const actualCents = Math.max(0, input.actualCents)
  const burn = weightedBurnCentsPerMs(input)
  const remainingMs = Math.max(0, window.totalMs - window.elapsedMs)
  const projectedCents = actualCents + burn * remainingMs
  const populated = (input.series ?? []).filter((point) => point.costCents > 0).length
  const projection: SpendProjection = {
    actualCents,
    burnRateCentsPerMs: burn,
    projectedCents,
    elapsedFraction: elapsed,
    confidence: projectionConfidence(window, populated),
  }
  if (input.limitCents != null && input.limitCents > 0 && burn > 0) {
    const remainingBudget = input.limitCents - actualCents
    if (remainingBudget <= 0) {
      projection.timeToExhaustionMs = 0
      projection.exhaustionAt = new Date(new Date(window.start).getTime() + window.elapsedMs).toISOString()
    } else {
      const msToExhaustion = remainingBudget / burn
      if (msToExhaustion <= remainingMs) {
        projection.timeToExhaustionMs = msToExhaustion
        projection.exhaustionAt = new Date(
          new Date(window.start).getTime() + window.elapsedMs + msToExhaustion,
        ).toISOString()
      }
    }
  }
  return projection
}

/** Percent of `limitCents` that `cents` represents. A zero limit is treated as fully used. */
export function percentOfLimit(cents: number, limitCents?: number): number {
  if (limitCents == null) return 0
  if (limitCents <= 0) return cents > 0 ? Infinity : 0
  return (cents / limitCents) * 100
}

/** Human-readable time-to-cap, e.g. `2d 4h`. Empty when the cap is not projected to be hit. */
export function formatTimeToExhaustion(ms?: number): string {
  if (ms == null) return ''
  if (ms <= 0) return 'now'
  const hours = Math.floor(ms / 3_600_000)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
  return `${Math.max(1, Math.floor(ms / 60_000))}m`
}
