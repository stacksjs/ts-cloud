import { describe, expect, it } from 'bun:test'
import {
  compareServiceCosts,
  egressUsageCosts,
  monthToDateRange,
  percentChange,
  projectedMonthlyCost,
  rollingComparisonRange,
} from './reporting'

describe('cost reporting periods and comparisons', () => {
  it('builds an inclusive MTD window and naive month projection', () => {
    const range = monthToDateRange(new Date('2026-04-10T18:00:00Z'))
    expect(range).toMatchObject({
      start: '2026-04-01',
      end: '2026-04-11',
      daysElapsed: 10,
      daysInMonth: 30,
      previous: { start: '2026-03-01', end: '2026-04-01' },
    })
    expect(projectedMonthlyCost(100, range.daysElapsed, range.daysInMonth)).toBe(300)
  })

  it('builds adjacent rolling windows without overlap', () => {
    expect(rollingComparisonRange(7, new Date('2026-04-10T18:00:00Z'))).toEqual({
      current: { start: '2026-04-04', end: '2026-04-11', label: 'last 7 days' },
      previous: { start: '2026-03-28', end: '2026-04-04', label: 'previous 7 days' },
    })
    expect(() => rollingComparisonRange(0)).toThrow('1 to 366')
  })

  it('compares service rows and represents new spend explicitly', () => {
    const compared = compareServiceCosts(
      [
        { service: 'EC2', amount: 120, unit: 'USD' },
        { service: 'Lambda', amount: 5, unit: 'USD' },
      ],
      [{ service: 'EC2', amount: 100, unit: 'USD' }],
    )
    expect(compared[0]).toMatchObject({ previousAmount: 100, changePercent: 20 })
    expect(compared[1]).toMatchObject({ previousAmount: 0, changePercent: null })
    expect(percentChange(0, 0)).toBe(0)
  })

  it('keeps only billed egress-shaped usage types', () => {
    expect(
      egressUsageCosts([
        { key: 'USE1-NatGateway-Bytes', amount: 30, unit: 'USD' },
        { key: 'DataTransfer-Out-Bytes', amount: 50, unit: 'USD' },
        { key: 'BoxUsage:m7g.large', amount: 100, unit: 'USD' },
      ]).map((cost) => cost.key),
    ).toEqual(['DataTransfer-Out-Bytes', 'USE1-NatGateway-Bytes'])
  })
})
