/**
 * AWS Cost Explorer Client
 * Direct JSON-RPC calls (no AWS SDK / CLI dependency).
 *
 * Endpoint is global but lives in us-east-1.
 *
 * Cost Explorer requests are billed at $0.01 each, so getCostByService is
 * served from a filesystem cache by default. Pass `useCache: false` to bypass.
 */

import { AWSClient } from './client'
import type { CacheHit, CostCacheKey } from './cost-explorer-cache'
import { loadCache, saveCache } from './cost-explorer-cache'
import { resolveCredentials } from './credentials'

export interface ServiceCost {
  service: string
  amount: number
  unit: string
}

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
    const { start, end, granularity = 'MONTHLY' } = params
    const metrics = ['UnblendedCost']
    const groupBy = [{ Type: 'DIMENSION', Key: 'SERVICE' }]

    const cacheKey: CostCacheKey = { start, end, granularity, metrics, groupBy }

    if (this.useCache) {
      const hit: CacheHit<ServiceCost[]> | null = loadCache<ServiceCost[]>(this.profile, cacheKey)
      if (hit) {
        this.lastCacheAgeSeconds = hit.ageSeconds
        return hit.response
      }
    }
    this.lastCacheAgeSeconds = null

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
        TimePeriod: { Start: start, End: end },
        Granularity: granularity,
        Metrics: metrics,
        GroupBy: groupBy,
      }),
    })

    const groups = result?.ResultsByTime?.[0]?.Groups ?? []
    const services: ServiceCost[] = groups
      .map((g: any): ServiceCost => ({
        service: g.Keys?.[0] ?? 'Unknown',
        amount: Number.parseFloat(g.Metrics?.UnblendedCost?.Amount ?? '0'),
        unit: g.Metrics?.UnblendedCost?.Unit ?? 'USD',
      }))
      .filter((g: ServiceCost) => g.amount > 0)
      .sort((a: ServiceCost, b: ServiceCost) => b.amount - a.amount)

    if (this.useCache) {
      saveCache(this.profile, cacheKey, services)
    }

    return services
  }

  /** Total unblended cost per day over a window (for the spend trend chart). */
  async getDailyTotals(params: { start: string, end: string }): Promise<number[]> {
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
