/**
 * Regression tests for the SES v1 (query API) XML response parsing.
 *
 * AWSClient.parseXmlResponse strips the single root element, so
 * `<GetSendQuotaResponse><GetSendQuotaResult>..` arrives as
 * `{ GetSendQuotaResult: .. }`. getSendQuota and getSendStatistics read
 * `result.GetSendQuotaResponse?.GetSendQuotaResult`, which is never there, and
 * so reported no quota and no statistics for every account.
 *
 * The bodies below are SES's documented responses, run through the real
 * parser so the shape under test is the one it actually emits.
 */

import { describe, expect, it } from 'bun:test'
import { SESClient } from '../src/aws/ses'

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
const NS = 'xmlns="http://ses.amazonaws.com/doc/2010-12-01/"'
const METADATA = '<ResponseMetadata><RequestId>273021c6-c866-11e0-b926-699e21c3af9e</RequestId></ResponseMetadata>'

function withXmlResponse(client: SESClient, xml: string): void {
  // @ts-expect-error — reach into the private AWSClient to stub one call
  const aws: any = client.client
  aws.request = async () => aws.parseXmlResponse(XML + xml)
}

function withMockedRequest(client: SESClient, response: any): void {
  // @ts-expect-error — reach into the private AWSClient to stub one call
  client.client.request = async () => response
}

function dataPoint(timestamp: string, attempts: number): string {
  return `<member><DeliveryAttempts>${attempts}</DeliveryAttempts><Timestamp>${timestamp}</Timestamp><Rejects>0</Rejects><Bounces>1</Bounces><Complaints>0</Complaints></member>`
}

describe('SESClient.getSendQuota reads through the stripped XML root', () => {
  it('returns the quota from a real SES body (it returned all undefined)', async () => {
    const client = new SESClient('us-east-1')
    withXmlResponse(client, `<GetSendQuotaResponse ${NS}><GetSendQuotaResult><SentLast24Hours>127.0</SentLast24Hours><Max24HourSend>50000.0</Max24HourSend><MaxSendRate>14.0</MaxSendRate></GetSendQuotaResult>${METADATA}</GetSendQuotaResponse>`)
    expect(await client.getSendQuota()).toEqual({ Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 127 })
  })

  it('reports zero sent as 0, not undefined', async () => {
    const client = new SESClient('us-east-1')
    withXmlResponse(client, `<GetSendQuotaResponse ${NS}><GetSendQuotaResult><SentLast24Hours>0.0</SentLast24Hours><Max24HourSend>200.0</Max24HourSend><MaxSendRate>1.0</MaxSendRate></GetSendQuotaResult>${METADATA}</GetSendQuotaResponse>`)
    expect(await client.getSendQuota()).toEqual({ Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 })
  })

  it('still reads a body that keeps the <GetSendQuotaResponse> wrapper', async () => {
    const client = new SESClient('us-east-1')
    withMockedRequest(client, { GetSendQuotaResponse: { GetSendQuotaResult: { SentLast24Hours: 3, Max24HourSend: 200, MaxSendRate: 1 } } })
    expect(await client.getSendQuota()).toEqual({ Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 3 })
  })
})

describe('SESClient.getSendStatistics reads through the stripped XML root', () => {
  it('returns every data point from a real SES body (it returned undefined)', async () => {
    const client = new SESClient('us-east-1')
    withXmlResponse(client, `<GetSendStatisticsResponse ${NS}><GetSendStatisticsResult><SendDataPoints>${dataPoint('2011-08-03T19:23:00Z', 8)}${dataPoint('2011-08-03T06:53:00Z', 7)}</SendDataPoints></GetSendStatisticsResult>${METADATA}</GetSendStatisticsResponse>`)
    const { SendDataPoints } = await client.getSendStatistics()
    expect(SendDataPoints).toHaveLength(2)
    expect(SendDataPoints?.[0]).toEqual({ DeliveryAttempts: 8, Timestamp: '2011-08-03T19:23:00Z', Rejects: 0, Bounces: 1, Complaints: 0 })
    expect(SendDataPoints?.[1]?.DeliveryAttempts).toBe(7)
  })

  it('returns a single data point as a one-element array, not a bare object', async () => {
    const client = new SESClient('us-east-1')
    withXmlResponse(client, `<GetSendStatisticsResponse ${NS}><GetSendStatisticsResult><SendDataPoints>${dataPoint('2011-08-03T19:23:00Z', 8)}</SendDataPoints></GetSendStatisticsResult>${METADATA}</GetSendStatisticsResponse>`)
    const { SendDataPoints } = await client.getSendStatistics()
    expect(Array.isArray(SendDataPoints)).toBe(true)
    expect(SendDataPoints).toHaveLength(1)
  })

  it('returns an empty array for an account with no sends', async () => {
    const client = new SESClient('us-east-1')
    withXmlResponse(client, `<GetSendStatisticsResponse ${NS}><GetSendStatisticsResult><SendDataPoints/></GetSendStatisticsResult>${METADATA}</GetSendStatisticsResponse>`)
    expect(await client.getSendStatistics()).toEqual({ SendDataPoints: [] })
  })

  it('still reads a body that keeps the <GetSendStatisticsResponse> wrapper', async () => {
    const client = new SESClient('us-east-1')
    withMockedRequest(client, { GetSendStatisticsResponse: { GetSendStatisticsResult: { SendDataPoints: { member: [{ DeliveryAttempts: 2 }] } } } })
    expect(await client.getSendStatistics()).toEqual({ SendDataPoints: [{ DeliveryAttempts: 2 }] })
  })
})
