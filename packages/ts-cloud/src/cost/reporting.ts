import type { DimensionCost, ServiceCost } from '../aws/cost-explorer'

const DAY_MS = 24 * 60 * 60 * 1000

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()))
}

export interface CostRange {
  start: string
  end: string
  label: string
}

export interface MonthToDateRange extends CostRange {
  previous: CostRange
  daysElapsed: number
  daysInMonth: number
}

export function monthToDateRange(now: Date = new Date()): MonthToDateRange {
  const today = utcDay(now)
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  const end = new Date(today.getTime() + DAY_MS)
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))
  const previousEnd = start
  const previousStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
  return {
    start: iso(start),
    end: iso(end),
    label: start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    daysElapsed: today.getUTCDate(),
    daysInMonth: Math.round((nextMonth.getTime() - start.getTime()) / DAY_MS),
    previous: {
      start: iso(previousStart),
      end: iso(previousEnd),
      label: previousStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    },
  }
}

export function rollingComparisonRange(days: number, now: Date = new Date()): { current: CostRange; previous: CostRange } {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('days must be an integer from 1 to 366')
  const end = new Date(utcDay(now).getTime() + DAY_MS)
  const currentStart = new Date(end.getTime() - days * DAY_MS)
  const previousStart = new Date(currentStart.getTime() - days * DAY_MS)
  return {
    current: { start: iso(currentStart), end: iso(end), label: `last ${days} days` },
    previous: { start: iso(previousStart), end: iso(currentStart), label: `previous ${days} days` },
  }
}

export function projectedMonthlyCost(total: number, daysElapsed: number, daysInMonth: number): number {
  return daysElapsed > 0 ? (total / daysElapsed) * daysInMonth : 0
}

export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null
  return ((current - previous) / previous) * 100
}

export interface ComparedServiceCost extends ServiceCost {
  previousAmount: number
  changePercent: number | null
}

export function compareServiceCosts(current: ServiceCost[], previous: ServiceCost[]): ComparedServiceCost[] {
  const prior = new Map(previous.map((cost) => [cost.service, cost.amount]))
  return current.map((cost) => {
    const previousAmount = prior.get(cost.service) ?? 0
    return { ...cost, previousAmount, changePercent: percentChange(cost.amount, previousAmount) }
  })
}

const EGRESS_USAGE_TYPE = /(?:data.?transfer|natgateway.*bytes|aws-(?:in|out)-bytes|regional-bytes|inter.?az|internet)/i

export function egressUsageCosts(costs: DimensionCost[]): DimensionCost[] {
  return costs.filter((cost) => EGRESS_USAGE_TYPE.test(cost.key)).sort((a, b) => b.amount - a.amount)
}
