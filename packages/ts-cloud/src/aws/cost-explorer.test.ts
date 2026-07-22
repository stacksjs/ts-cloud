import { describe, expect, it } from 'bun:test'
import { CostExplorerClient } from './cost-explorer'

describe('CostExplorerClient dimension queries', () => {
  it('aggregates every time bucket and response page', async () => {
    const client = new CostExplorerClient(undefined, { useCache: false })
    const bodies: any[] = []
    let page = 0
    // @ts-expect-error test seam for the direct AWS transport
    client.client.request = async (request: { body: string }) => {
      bodies.push(JSON.parse(request.body))
      page++
      if (page === 1) {
        return {
          ResultsByTime: [
            { Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '2.5', Unit: 'USD' } } }] },
            { Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '3.5', Unit: 'USD' } } }] },
          ],
          NextPageToken: 'next',
        }
      }
      return {
        ResultsByTime: [{ Groups: [{ Keys: ['S3'], Metrics: { UnblendedCost: { Amount: '4', Unit: 'USD' } } }] }],
      }
    }

    expect(
      await client.getCostByDimension({
        start: '2026-04-01',
        end: '2026-04-11',
        granularity: 'DAILY',
        dimension: 'SERVICE',
      }),
    ).toEqual([
      { key: 'EC2', amount: 6, unit: 'USD' },
      { key: 'S3', amount: 4, unit: 'USD' },
    ])
    expect(bodies[0].GroupBy[0].Key).toBe('SERVICE')
    expect(bodies[1].NextPageToken).toBe('next')
  })

  it('maps dimension results onto the existing service contract', async () => {
    const client = new CostExplorerClient(undefined, { useCache: false })
    // @ts-expect-error test seam for the direct AWS transport
    client.client.request = async () => ({
      ResultsByTime: [
        { Groups: [{ Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '1.25', Unit: 'USD' } } }] },
      ],
    })
    expect(await client.getCostByService({ start: '2026-04-01', end: '2026-04-02' })).toEqual([
      { service: 'AWS Lambda', amount: 1.25, unit: 'USD' },
    ])
  })
})
