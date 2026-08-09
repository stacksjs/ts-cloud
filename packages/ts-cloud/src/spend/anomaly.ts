/**
 * Anomaly detection for spend and traffic.
 *
 * The naive version of this - mean plus three standard deviations - does not
 * survive contact with real infrastructure data, for two reasons:
 *
 *   1. **The mean is not robust.** One genuine incident poisons the baseline
 *      for as long as it stays in the window, so the detector goes quiet
 *      exactly when it matters. Median and MAD (median absolute deviation) are
 *      unmoved by up to half the sample being garbage.
 *   2. **Infrastructure data is seasonal.** Traffic at 3am Sunday is not
 *      traffic at 3pm Tuesday. A flat baseline fires every weekday morning and
 *      teaches everyone to ignore it. The baseline here is per-phase: an hour
 *      is compared against the same hour on previous days.
 *
 * Two guards keep the noise down further: a warmup (no history, no verdict)
 * and an absolute floor (a jump from $0.01 to $0.09 is 800% and worth nobody's
 * pager).
 */
import type { AnomalyDirection } from './model'

export interface SeriesPoint {
  bucketStart: string
  value: number
}

export interface AnomalyOptions {
  /**
   * Points per season. 24 for hourly data with a daily cycle (the default),
   * 168 for hourly data with a weekly cycle.
   */
  seasonLength?: number
  /** Robust z-score above which a point is anomalous. Lower is more sensitive. */
  threshold?: number
  /** Minimum same-phase observations before any verdict. Below this: warmup. */
  minHistory?: number
  /**
   * Absolute change below which nothing is reported, in the series' own units.
   * This is what stops a rounding-error spike from paging anyone.
   */
  minAbsoluteDelta?: number
  /** Report drops as well as spikes. Off by default; a spend drop is good news. */
  detectDrops?: boolean
  /** Score at which an anomaly is `critical` rather than `warning`. */
  criticalThreshold?: number
}

export interface AnomalyPoint {
  bucketStart: string
  observed: number
  expected: number
  score: number
  direction: AnomalyDirection
  deltaPercent: number
  severity: 'info' | 'warning' | 'critical'
  /** Same-phase observations the baseline was drawn from. */
  historySize: number
  /** The robust spread of the baseline, in the series' units. */
  deviation: number
}

export interface AnomalyResult {
  anomalies: AnomalyPoint[]
  /** True when there was not enough history to judge anything. */
  warmingUp: boolean
  /** Points evaluated (excludes those skipped for lack of history). */
  evaluated: number
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * Median absolute deviation, scaled to be comparable to a standard deviation.
 *
 * The 1.4826 factor makes MAD a consistent estimator of sigma for normal data,
 * so a threshold of 3 means roughly what it means for a classic z-score.
 */
export function medianAbsoluteDeviation(values: readonly number[], center?: number): number {
  if (values.length === 0) return 0
  const mid = center ?? median(values)
  return 1.4826 * median(values.map((value) => Math.abs(value - mid)))
}

/**
 * Robust z-score.
 *
 * A MAD of zero means the history is perfectly flat - common for a meter that
 * is usually idle. Falling back to a small fraction of the center keeps a real
 * jump detectable without dividing by zero and calling everything infinite.
 */
export function robustZScore(value: number, history: readonly number[]): { score: number; center: number; deviation: number } {
  const center = median(history)
  let deviation = medianAbsoluteDeviation(history, center)
  if (deviation === 0) deviation = Math.max(Math.abs(center) * 0.1, Number.EPSILON)
  return { score: (value - center) / deviation, center, deviation }
}

/**
 * Exponentially weighted moving average.
 *
 * Exposed because it is the right baseline for a series with a trend but no
 * seasonality - a slowly growing storage meter, for instance.
 */
export function ewma(values: readonly number[], alpha: number = 0.3): number[] {
  const output: number[] = []
  let current = values[0] ?? 0
  for (const value of values) {
    current = alpha * value + (1 - alpha) * current
    output.push(current)
  }
  return output
}

/**
 * Same-phase history for index `i`: the value at this position in each earlier
 * season. Hour 14 today is compared against hour 14 yesterday, the day before,
 * and so on - never against hour 3.
 */
function samePhaseHistory(values: readonly number[], index: number, seasonLength: number): number[] {
  const history: number[] = []
  // Non-finite entries are gaps, not values. One NaN in the list would make the
  // median NaN and silently disable detection for that phase forever, which is
  // the worst possible failure: a detector that reports nothing and looks fine.
  for (let cursor = index - seasonLength; cursor >= 0; cursor -= seasonLength)
    if (Number.isFinite(values[cursor])) history.push(values[cursor])
  return history
}

/**
 * Find points that do not fit their own history.
 *
 * Returns anomalies in bucket order. Callers usually only act on the most
 * recent one; the full list is what makes a backfill or a chart useful.
 */
export function detectAnomalies(series: readonly SeriesPoint[], options: AnomalyOptions = {}): AnomalyResult {
  const seasonLength = Math.max(1, Math.floor(options.seasonLength ?? 24))
  const threshold = options.threshold ?? 3.5
  const criticalThreshold = options.criticalThreshold ?? threshold * 2
  const minHistory = Math.max(2, Math.floor(options.minHistory ?? 3))
  const minAbsoluteDelta = Math.max(0, options.minAbsoluteDelta ?? 0)
  const values = series.map((point) => point.value)
  const anomalies: AnomalyPoint[] = []
  let evaluated = 0

  for (let index = 0; index < series.length; index++) {
    const history = samePhaseHistory(values, index, seasonLength)
    if (history.length < minHistory) continue
    const observed = values[index]
    // A gap has nothing to judge. It is not a zero and not an anomaly.
    if (!Number.isFinite(observed)) continue
    evaluated++
    const { score, center, deviation } = robustZScore(observed, history)
    const direction: AnomalyDirection = score >= 0 ? 'spike' : 'drop'
    if (direction === 'drop' && options.detectDrops !== true) continue
    if (Math.abs(score) < threshold) continue
    if (Math.abs(observed - center) < minAbsoluteDelta) continue
    anomalies.push({
      bucketStart: series[index].bucketStart,
      observed,
      expected: center,
      score,
      direction,
      deltaPercent: center === 0 ? (observed === 0 ? 0 : Infinity) : ((observed - center) / center) * 100,
      severity: Math.abs(score) >= criticalThreshold ? 'critical' : 'warning',
      historySize: history.length,
      deviation,
    })
  }

  return { anomalies, warmingUp: evaluated === 0, evaluated }
}

/**
 * Judge only the most recent point.
 *
 * This is the shape an evaluation loop wants: it runs every hour and only
 * cares whether the hour that just closed was strange.
 */
export function detectLatestAnomaly(series: readonly SeriesPoint[], options: AnomalyOptions = {}): AnomalyPoint | undefined {
  if (series.length === 0) return undefined
  const result = detectAnomalies(series, options)
  const last = series[series.length - 1].bucketStart
  return result.anomalies.find((anomaly) => anomaly.bucketStart === last)
}

/**
 * Sensible option presets per signal class.
 *
 * Cost gets a floor of 25 cents because nobody wants to hear that a $0.02 hour
 * became $0.30. Request counts get a much higher absolute floor for the same
 * reason at a different scale, and a weekly season because request traffic has
 * a strong weekday/weekend shape that a daily season would keep re-discovering.
 */
export function anomalyOptionsForSignal(signal: string): AnomalyOptions {
  if (signal === 'cost') return { seasonLength: 24, threshold: 3.5, minHistory: 3, minAbsoluteDelta: 25 }
  if (signal.startsWith('edge.') || signal.startsWith('function.'))
    return { seasonLength: 168, threshold: 4, minHistory: 3, minAbsoluteDelta: 1000 }
  return { seasonLength: 24, threshold: 3.5, minHistory: 3 }
}
