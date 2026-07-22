/**
 * AWS Cost Explorer Client
 * Direct JSON-RPC calls (no AWS SDK / CLI dependency).
 *
 * Endpoint is global but lives in us-east-1.
 *
 * Cost Explorer requests are billed at $0.01 each, so getCostByService is
 * served from a filesystem cache by default. Pass `useCache: false` to bypass.
 */
import type { CacheHit, CostCacheKey } from './cost-explorer-cache'
import { AWSClient } from './client'
import { loadCache, saveCache } from './cost-explorer-cache'
import { resolveCredentials } from './credentials'

export interface ServiceCost {
  service: string
  amount: number
  unit: string
}

export interface DimensionCost {
  key: string
  amount: number
  unit: string
}

export type CostDimension = 'SERVICE' | 'USAGE_TYPE' | 'OPERATION' | 'REGION' | 'LINKED_ACCOUNT' | 'RESOURCE_ID'

export interface CostExplorerOptions {
  useCache?: boolean
}

export class CostExplorerClient {
  private client: AWSClient
  private profile: string | undefined
  private useCache: boolean

  /** Set after each call so callers can render a "(cached, NNN seconds old)" hint. */
  public lastCacheAgeSeconds: number | null = null

  constructor(profile?: string, options?: CostExplorerOptions) {
    this.profile = profile
    this.useCache = options?.useCache ?? true
    this.client = new AWSClient(resolveCredentials(profile))
  }

  /**
   * Group total cost by SERVICE for a single time period, sorted descending.
   */
  async getCostByService(params: {
    start: string
    end: string
    granularity?: 'DAILY' | 'MONTHLY'
  }): Promise<ServiceCost[]> {
    const costs = await this.getCostByDimension({ ...params, dimension: 'SERVICE' })
    return costs.map((cost) => ({ service: cost.key, amount: cost.amount, unit: cost.unit }))
  }

  /**
   * Group and aggregate cost across every returned time bucket for one Cost
   * Explorer dimension. Handles response pagination and caches the normalized
   * result rather than provider response envelopes.
   */
  async getCostByDimension(params: {
    start: string
    end: string
    dimension: CostDimension
    granularity?: 'DAILY' | 'MONTHLY'
    filter?: unknown
  }): Promise<DimensionCost[]> {
    const { start, end, dimension, granularity = 'MONTHLY', filter } = params
    const metrics = ['UnblendedCost']
    const groupBy = [{ Type: 'DIMENSION', Key: dimension }]

    const cacheKey: CostCacheKey = { start, end, granularity, metrics, groupBy, filter }

    if (this.useCache) {
      const hit: CacheHit<DimensionCost[]> | null = loadCache<DimensionCost[]>(this.profile, cacheKey)
      if (hit) {
        this.lastCacheAgeSeconds = hit.ageSeconds
        return hit.response
      }
    }
    this.lastCacheAgeSeconds = null

    const totals = new Map<string, DimensionCost>()
    let nextPageToken: string | undefined
    do {
      const body: Record<string, unknown> = {
        TimePeriod: { Start: start, End: end },
        Granularity: granularity,
        Metrics: metrics,
        GroupBy: groupBy,
      }
      if (filter) body.Filter = filter
      if (nextPageToken) body.NextPageToken = nextPageToken

      const result = await this.client.request({
        service: 'ce',
        region: 'us-east-1',
        method: 'POST',
        path: '/',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage',
        },
        body: JSON.stringify(body),
      })

      for (const period of result?.ResultsByTime ?? []) {
        for (const group of period?.Groups ?? []) {
          const key = group.Keys?.[0] ?? 'Unknown'
          const amount = Number.parseFloat(group.Metrics?.UnblendedCost?.Amount ?? '0')
          const unit = group.Metrics?.UnblendedCost?.Unit ?? 'USD'
          const current = totals.get(key)
          totals.set(key, { key, amount: (current?.amount ?? 0) + amount, unit })
        }
      }
      nextPageToken = result?.NextPageToken || undefined
    } while (nextPageToken)

    const costs = [...totals.values()].filter((cost) => cost.amount > 0).sort((a, b) => b.amount - a.amount)

    if (this.useCache) {
      saveCache(this.profile, cacheKey, costs)
    }

    return costs
  }

  /** Total unblended cost per day over a window (for the spend trend chart). */
  async getDailyTotals(params: { start: string; end: string }): Promise<number[]> {
    const result = await this.client.request({
      service: 'ce',
      region: 'us-east-1',
      method: 'POST',
      path: '/',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage',
      },
      body: JSON.stringify({
        TimePeriod: { Start: params.start, End: params.end },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
      }),
    })
    const byTime = result?.ResultsByTime ?? []
    return byTime.map((t: any) => Number.parseFloat(t.Total?.UnblendedCost?.Amount ?? '0'))
  }
}
