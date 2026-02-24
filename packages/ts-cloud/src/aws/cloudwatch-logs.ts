/**
 * AWS CloudWatch Logs Operations
 * Direct API calls without AWS CLI dependency
 */

import { AWSClient } from './client'

export interface LogEvent {
  timestamp?: number
  message?: string
  ingestionTime?: number
}

export interface LogStream {
  logStreamName?: string
  creationTime?: number
  firstEventTimestamp?: number
  lastEventTimestamp?: number
  lastIngestionTime?: number
  uploadSequenceToken?: string
  arn?: string
  storedBytes?: number
}

export class CloudWatchLogsClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  async describeLogStreams(options: {
    logGroupName: string
    logStreamNamePrefix?: string
    orderBy?: 'LogStreamName' | 'LastEventTime'
    descending?: boolean
    limit?: number
  }): Promise<{ logStreams?: LogStream[], nextToken?: string }> {
    const params: Record<string, any> = {
      logGroupName: options.logGroupName,
    }

    if (options.logStreamNamePrefix) params.logStreamNamePrefix = options.logStreamNamePrefix
    if (options.orderBy) params.orderBy = options.orderBy
    if (options.descending !== undefined) params.descending = options.descending
    if (options.limit) params.limit = options.limit

    const result = await this.client.request({
      service: 'logs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'Logs_20140328.DescribeLogStreams',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  async getLogEvents(options: {
    logGroupName: string
    logStreamName: string
    startTime?: number
    endTime?: number
    limit?: number
    startFromHead?: boolean
  }): Promise<{ events?: LogEvent[], nextForwardToken?: string, nextBackwardToken?: string }> {
    const params: Record<string, any> = {
      logGroupName: options.logGroupName,
      logStreamName: options.logStreamName,
    }

    if (options.startTime) params.startTime = options.startTime
    if (options.endTime) params.endTime = options.endTime
    if (options.limit) params.limit = options.limit
    if (options.startFromHead !== undefined) params.startFromHead = options.startFromHead

    const result = await this.client.request({
      service: 'logs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'Logs_20140328.GetLogEvents',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  async describeLogGroups(options?: {
    logGroupNamePrefix?: string
    limit?: number
  }): Promise<{ logGroups?: { logGroupName?: string, arn?: string, creationTime?: number }[], nextToken?: string }> {
    const params: Record<string, any> = {}

    if (options?.logGroupNamePrefix) params.logGroupNamePrefix = options.logGroupNamePrefix
    if (options?.limit) params.limit = options.limit

    const result = await this.client.request({
      service: 'logs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'Logs_20140328.DescribeLogGroups',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  async deleteLogGroup(logGroupName: string): Promise<void> {
    await this.client.request({
      service: 'logs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'Logs_20140328.DeleteLogGroup',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({ logGroupName }),
    })
  }

  async filterLogEvents(options: {
    logGroupName: string
    logStreamNames?: string[]
    startTime?: number
    endTime?: number
    filterPattern?: string
    limit?: number
  }): Promise<{ events?: LogEvent[], searchedLogStreams?: any[], nextToken?: string }> {
    const params: Record<string, any> = {
      logGroupName: options.logGroupName,
    }

    if (options.logStreamNames) params.logStreamNames = options.logStreamNames
    if (options.startTime) params.startTime = options.startTime
    if (options.endTime) params.endTime = options.endTime
    if (options.filterPattern) params.filterPattern = options.filterPattern
    if (options.limit) params.limit = options.limit

    const result = await this.client.request({
      service: 'logs',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'Logs_20140328.FilterLogEvents',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return result
  }
}
