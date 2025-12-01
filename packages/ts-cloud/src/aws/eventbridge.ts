/**
 * AWS EventBridge Client
 * Direct API calls for EventBridge operations
 */

import { AWSClient } from './client'

export interface EventBridgeRule {
  Name: string
  Arn?: string
  EventPattern?: string
  ScheduleExpression?: string
  State?: 'ENABLED' | 'DISABLED'
  Description?: string
  RoleArn?: string
  EventBusName?: string
}

export interface EventBridgeTarget {
  Id: string
  Arn: string
  RoleArn?: string
  Input?: string
  InputPath?: string
  InputTransformer?: {
    InputPathsMap?: Record<string, string>
    InputTemplate: string
  }
  RetryPolicy?: {
    MaximumRetryAttempts?: number
    MaximumEventAgeInSeconds?: number
  }
}

/**
 * EventBridge client for direct API calls
 */
export class EventBridgeClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, any>): Promise<T> {
    return this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSEvents.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Create or update a rule
   */
  async putRule(params: {
    Name: string
    ScheduleExpression?: string
    EventPattern?: string
    State?: 'ENABLED' | 'DISABLED'
    Description?: string
    RoleArn?: string
    Tags?: Array<{ Key: string; Value: string }>
    EventBusName?: string
  }): Promise<{ RuleArn: string }> {
    return this.request('PutRule', params)
  }

  /**
   * Delete a rule
   */
  async deleteRule(params: {
    Name: string
    EventBusName?: string
    Force?: boolean
  }): Promise<void> {
    return this.request('DeleteRule', params)
  }

  /**
   * Describe a rule
   */
  async describeRule(params: {
    Name: string
    EventBusName?: string
  }): Promise<EventBridgeRule> {
    return this.request('DescribeRule', params)
  }

  /**
   * List rules
   */
  async listRules(params?: {
    NamePrefix?: string
    EventBusName?: string
    NextToken?: string
    Limit?: number
  }): Promise<{ Rules: EventBridgeRule[]; NextToken?: string }> {
    return this.request('ListRules', params || {})
  }

  /**
   * Enable a rule
   */
  async enableRule(params: {
    Name: string
    EventBusName?: string
  }): Promise<void> {
    return this.request('EnableRule', params)
  }

  /**
   * Disable a rule
   */
  async disableRule(params: {
    Name: string
    EventBusName?: string
  }): Promise<void> {
    return this.request('DisableRule', params)
  }

  /**
   * Add targets to a rule
   */
  async putTargets(params: {
    Rule: string
    EventBusName?: string
    Targets: EventBridgeTarget[]
  }): Promise<{
    FailedEntryCount: number
    FailedEntries: Array<{
      TargetId: string
      ErrorCode: string
      ErrorMessage: string
    }>
  }> {
    return this.request('PutTargets', params)
  }

  /**
   * Remove targets from a rule
   */
  async removeTargets(params: {
    Rule: string
    EventBusName?: string
    Ids: string[]
    Force?: boolean
  }): Promise<{
    FailedEntryCount: number
    FailedEntries: Array<{
      TargetId: string
      ErrorCode: string
      ErrorMessage: string
    }>
  }> {
    return this.request('RemoveTargets', params)
  }

  /**
   * List targets for a rule
   */
  async listTargetsByRule(params: {
    Rule: string
    EventBusName?: string
    NextToken?: string
    Limit?: number
  }): Promise<{ Targets: EventBridgeTarget[]; NextToken?: string }> {
    return this.request('ListTargetsByRule', params)
  }

  /**
   * Put events to EventBridge
   */
  async putEvents(params: {
    Entries: Array<{
      Time?: string
      Source: string
      Resources?: string[]
      DetailType: string
      Detail: string
      EventBusName?: string
    }>
  }): Promise<{
    FailedEntryCount: number
    Entries: Array<{
      EventId?: string
      ErrorCode?: string
      ErrorMessage?: string
    }>
  }> {
    return this.request('PutEvents', params)
  }

  /**
   * Create a scheduler schedule (EventBridge Scheduler)
   */
  async createSchedule(params: {
    Name: string
    ScheduleExpression: string
    FlexibleTimeWindow: {
      Mode: 'OFF' | 'FLEXIBLE'
      MaximumWindowInMinutes?: number
    }
    Target: {
      Arn: string
      RoleArn: string
      Input?: string
    }
    Description?: string
    State?: 'ENABLED' | 'DISABLED'
    GroupName?: string
  }): Promise<{ ScheduleArn: string }> {
    // Note: EventBridge Scheduler uses a different API
    return this.client.request({
      service: 'scheduler',
      region: this.region,
      method: 'POST',
      path: `/schedules/${params.Name}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
  }
}
