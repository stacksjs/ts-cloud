import { describe, expect, it } from 'bun:test'
import { parseSadfHostHistory, providerMetricSeries } from '../../src/drivers/hetzner/monitoring'

describe('Hetzner monitoring history', () => {
  it('parses and bounds sysstat CPU, RAM, and swap samples', () => {
    const raw = JSON.stringify({
      sysstat: {
        hosts: [
          {
            statistics: [
              {
                timestamp: { date: '2026-07-27', time: '18:20:00', utc: 1 },
                'cpu-load': [{ cpu: 'all', user: 20, system: 10, iowait: 5, idle: 65 }],
                memory: {
                  memused: 2_000_000,
                  'memused-percent': 50,
                  avail: 1_500_000,
                  swpused: 500_000,
                  'swpused-percent': 25,
                },
              },
              {
                timestamp: { date: '2026-07-27', time: '19:20:00', utc: 1 },
                'cpu-load': [{ cpu: 'all', user: 40, system: 15, iowait: 0, idle: 45 }],
                memory: {
                  memused: 2_400_000,
                  'memused-percent': 60,
                  avail: 1_100_000,
                  swpused: 700_000,
                  'swpused-percent': 35,
                },
              },
            ],
          },
        ],
      },
    })
    const points = parseSadfHostHistory(
      raw,
      new Date('2026-07-27T19:00:00Z'),
      new Date('2026-07-27T20:00:00Z'),
    )
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      timestamp: '2026-07-27T19:20:00.000Z',
      cpuUsedPercent: 55,
      memoryUsedPercent: 60,
      swapUsedPercent: 35,
    })
    expect(points[0].memoryAvailableBytes).toBe(1_100_000 * 1024)
  })

  it('normalizes provider time series values and skips malformed samples', () => {
    const series = providerMetricSeries({
      start: '2026-07-27T18:00:00Z',
      end: '2026-07-27T19:00:00Z',
      step: 60,
      time_series: {
        cpu: { values: [[1785175200, '75.5'], [1785175260, 'not-a-number']] },
      },
    })
    expect(series.cpu).toEqual([{ timestamp: '2026-07-27T18:00:00.000Z', value: 75.5 }])
  })
})
