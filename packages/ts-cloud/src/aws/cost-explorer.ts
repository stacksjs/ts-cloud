/**
 * AWS Cost Explorer Client
 * Direct JSON-RPC calls (no AWS SDK / CLI dependency).
 *
 * Endpoint is global but lives in us-east-1.
 */

import { AWSClient } from './client'

export interface ServiceCost {
  service: string
  amount: number
  unit: string
}

export class CostExplorerClient {
  private client: AWSClient

  constructor() {
    this.client = new AWSClient()
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
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    })

    const groups = result?.ResultsByTime?.[0]?.Groups ?? []
    return groups
      .map((g: any): ServiceCost => ({
        service: g.Keys?.[0] ?? 'Unknown',
        amount: Number.parseFloat(g.Metrics?.UnblendedCost?.Amount ?? '0'),
        unit: g.Metrics?.UnblendedCost?.Unit ?? 'USD',
      }))
      .filter((g: ServiceCost) => g.amount > 0)
      .sort((a: ServiceCost, b: ServiceCost) => b.amount - a.amount)
  }
}
