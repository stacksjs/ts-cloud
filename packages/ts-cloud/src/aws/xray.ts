/**
 * Minimal AWS X-Ray client for the dashboard's distributed-tracing view. Direct
 * SigV4 JSON calls (no SDK): GetTraceSummaries lists recent traces in a window,
 * BatchGetTraces fetches full segment documents for a set of trace ids.
 */
import { AWSClient } from './client'

export interface TraceSummary {
  Id?: string
  StartTime?: number
  Duration?: number
  ResponseTime?: number
  HasError?: boolean
  HasFault?: boolean
  HasThrottle?: boolean
  Http?: {
    HttpURL?: string
    HttpStatus?: number
    HttpMethod?: string
    ClientIp?: string
    UserAgent?: string
  }
  ErrorRootCauses?: any[]
  FaultRootCauses?: any[]
}

export interface XRayTrace {
  Id?: string
  Duration?: number
  Segments?: Array<{ Id?: string, Document?: string }>
}

export class XRayClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * List trace summaries between two times. `filterExpression` is an X-Ray
   * filter (e.g. `service("acme-production-http")` or `error = true`).
   */
  async getTraceSummaries(options: { startTime: Date, endTime: Date, filterExpression?: string, nextToken?: string }): Promise<{ summaries: TraceSummary[], nextToken?: string }> {
    const body: Record<string, any> = {
      StartTime: Math.floor(options.startTime.getTime() / 1000),
      EndTime: Math.floor(options.endTime.getTime() / 1000),
      TimeRangeType: 'Event',
      Sampling: false,
    }
    if (options.filterExpression)
      body.FilterExpression = options.filterExpression
    if (options.nextToken)
      body.NextToken = options.nextToken

    const res = await this.client.request({
      service: 'xray',
      region: this.region,
      method: 'POST',
      path: '/TraceSummaries',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { summaries: res?.TraceSummaries ?? [], nextToken: res?.NextToken }
  }

  /** Fetch full traces (segment documents) for up to 5 trace ids. */
  async batchGetTraces(traceIds: string[]): Promise<XRayTrace[]> {
    if (!traceIds.length)
      return []
    const res = await this.client.request({
      service: 'xray',
      region: this.region,
      method: 'POST',
      path: '/Traces',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ TraceIds: traceIds.slice(0, 5) }),
    })
    return res?.Traces ?? []
  }
}
