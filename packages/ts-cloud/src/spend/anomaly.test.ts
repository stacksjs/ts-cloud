import type { SeriesPoint } from './anomaly'
import { describe, expect, it } from 'bun:test'
import {
  anomalyOptionsForSignal,
  detectAnomalies,
  detectLatestAnomaly,
  ewma,
  median,
  medianAbsoluteDeviation,
  robustZScore,
} from './anomaly'

/** Hourly series with a daily shape: quiet at night, busy in the afternoon. */
function dailySeries(days: number, shape: (hour: number) => number, start = Date.UTC(2026, 6, 1)): SeriesPoint[] {
  const points: SeriesPoint[] = []
  for (let index = 0; index < days * 24; index++) {
    points.push({ bucketStart: new Date(start + index * 3_600_000).toISOString(), value: shape(index % 24) })
  }
  return points
}

describe('robust statistics', () => {
  it('takes the median of even and odd samples', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it('scales MAD to be comparable with a standard deviation', () => {
    expect(medianAbsoluteDeviation([10, 10, 10, 10])).toBe(0)
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBeCloseTo(1.4826, 4)
  })

  it('is unmoved by an outlier that would wreck a mean-based baseline', () => {
    const clean = [10, 10, 11, 9, 10]
    const poisoned = [10, 10, 11, 9, 10, 100_000]
    expect(median(poisoned)).toBeCloseTo(median(clean), 0)
    // A z-score against the poisoned history still flags a genuine spike.
    expect(robustZScore(500, poisoned).score).toBeGreaterThan(3.5)
  })

  it('does not divide by zero on a perfectly flat history', () => {
    const { score, deviation } = robustZScore(50, [10, 10, 10, 10])
    expect(Number.isFinite(score)).toBe(true)
    expect(deviation).toBeGreaterThan(0)
    expect(score).toBeGreaterThan(3.5)
  })

  it('computes an EWMA that tracks a level shift', () => {
    const smoothed = ewma([10, 10, 10, 100, 100, 100], 0.5)
    expect(smoothed[2]).toBeCloseTo(10, 5)
    expect(smoothed[5]).toBeGreaterThan(80)
  })
})

describe('seasonal anomaly detection', () => {
  it('does not flag the daily cycle itself', () => {
    const series = dailySeries(7, (hour) => (hour >= 9 && hour < 18 ? 1000 : 50))
    expect(detectAnomalies(series, { minAbsoluteDelta: 0 }).anomalies).toEqual([])
  })

  it('flags a spike in a quiet hour that a flat baseline would miss', () => {
    const series = dailySeries(7, (hour) => (hour >= 9 && hour < 18 ? 1000 : 50))
    // 3am on the last day jumps to 800: far below the daily peak, but wildly
    // out of line for 3am.
    const target = series.length - 24 + 3
    series[target] = { ...series[target], value: 800 }
    const anomalies = detectAnomalies(series, { minAbsoluteDelta: 0 }).anomalies
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]).toMatchObject({ bucketStart: series[target].bucketStart, direction: 'spike' })
    expect(anomalies[0].expected).toBe(50)
  })

  it('stays quiet during warmup instead of guessing', () => {
    const series = dailySeries(2, () => 100)
    series[series.length - 1] = { ...series[series.length - 1], value: 100_000 }
    const result = detectAnomalies(series, { minHistory: 3, minAbsoluteDelta: 0 })
    expect(result.warmingUp).toBe(true)
    expect(result.anomalies).toEqual([])
  })

  it('ignores a large percentage jump that is a trivial absolute change', () => {
    const series = dailySeries(7, () => 2)
    series[series.length - 1] = { ...series[series.length - 1], value: 30 }
    // 1400% up, but only 28 cents. The floor suppresses it.
    expect(detectAnomalies(series, { minAbsoluteDelta: 100 }).anomalies).toEqual([])
    expect(detectAnomalies(series, { minAbsoluteDelta: 0 }).anomalies).toHaveLength(1)
  })

  it('ignores drops unless asked for them', () => {
    const series = dailySeries(7, () => 1000)
    series[series.length - 1] = { ...series[series.length - 1], value: 1 }
    expect(detectAnomalies(series, { minAbsoluteDelta: 0 }).anomalies).toEqual([])
    const drops = detectAnomalies(series, { minAbsoluteDelta: 0, detectDrops: true }).anomalies
    expect(drops).toHaveLength(1)
    expect(drops[0].direction).toBe('drop')
  })

  it('escalates severity with the score', () => {
    const series = dailySeries(7, () => 100)
    series[series.length - 1] = { ...series[series.length - 1], value: 100_000 }
    const [anomaly] = detectAnomalies(series, { minAbsoluteDelta: 0, threshold: 3.5, criticalThreshold: 7 }).anomalies
    expect(anomaly.severity).toBe('critical')
  })

  it('honours a weekly season for weekend-shaped traffic', () => {
    // A consumer site that is busy at the weekend: a daily season sees every
    // Saturday as a spike, because five quiet weekdays outvote the baseline.
    const series: SeriesPoint[] = []
    const start = Date.UTC(2026, 6, 6) // a Monday
    for (let index = 0; index < 24 * 28; index++) {
      const weekday = Math.floor(index / 24) % 7
      series.push({
        bucketStart: new Date(start + index * 3_600_000).toISOString(),
        value: weekday >= 5 ? 1000 : 100,
      })
    }
    expect(detectAnomalies(series, { seasonLength: 24, minAbsoluteDelta: 0 }).anomalies.length).toBeGreaterThan(0)
    expect(detectAnomalies(series, { seasonLength: 168, minAbsoluteDelta: 0 }).anomalies).toEqual([])
  })
})

describe('latest-point detection', () => {
  it('reports only the most recent bucket', () => {
    const series = dailySeries(7, () => 100)
    const earlier = series.length - 30
    series[earlier] = { ...series[earlier], value: 50_000 }
    expect(detectLatestAnomaly(series, { minAbsoluteDelta: 0 })).toBeUndefined()
    series[series.length - 1] = { ...series[series.length - 1], value: 50_000 }
    expect(detectLatestAnomaly(series, { minAbsoluteDelta: 0 })?.bucketStart).toBe(series[series.length - 1].bucketStart)
  })

  it('handles an empty series', () => {
    expect(detectLatestAnomaly([])).toBeUndefined()
  })
})

describe('signal presets', () => {
  it('gives cost a cent floor and traffic a weekly season', () => {
    expect(anomalyOptionsForSignal('cost')).toMatchObject({ seasonLength: 24, minAbsoluteDelta: 25 })
    expect(anomalyOptionsForSignal('edge.requests')).toMatchObject({ seasonLength: 168 })
  })
})
