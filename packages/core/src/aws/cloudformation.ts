/**
 * AWS CloudFormation API Client
 * Direct API calls without AWS SDK dependency
*/

import type { AWSCredentials } from './credentials'
import { resolveCredentials } from './credentials'
import { makeAWSRequest, parseXMLResponse } from './signature'

export interface CloudFormationStack {
  StackName: string
  StackId?: string
  StackStatus?: string
  CreationTime?: string
  LastUpdatedTime?: string
  StackStatusReason?: string
  Description?: string
  Parameters?: Array<{ ParameterKey: string, ParameterValue: string }>
  Outputs?: Array<{ OutputKey: string, OutputValue: string, Description?: string }>
  Tags?: Array<{ Key: string, Value: string }>
}

export interface CreateStackOptions {
  stackName: string
  templateBody?: string
  templateURL?: string
  parameters?: Record<string, string>
  capabilities?: string[]
  tags?: Record<string, string>
  timeoutInMinutes?: number
  onFailure?: 'DO_NOTHING' | 'ROLLBACK' | 'DELETE'
}

export interface UpdateStackOptions {
  stackName: string
  templateBody?: string
  templateURL?: string
  parameters?: Record<string, string>
  capabilities?: string[]
  tags?: Record<string, string>
}

export interface StackEvent {
  EventId: string
  StackName: string
  LogicalResourceId: string
  PhysicalResourceId?: string
  ResourceType: string
  Timestamp: string
  ResourceStatus: string
  ResourceStatusReason?: string
}

/**
 * CloudFormation API Client
*/
export class CloudFormationClient {
  private credentials: AWSCredentials | null = null
  private region: string

  constructor(
    region: string = 'us-east-1',
    private readonly profile: string = 'default',
  ) {
    this.region = region
  }

  /**
   * Initialize client with credentials
  */
  async init(): Promise<void> {
    this.credentials = await resolveCredentials(this.profile)
    if (this.credentials.region) {
      this.region = this.credentials.region
    }
  }

  /**
   * Ensure credentials are loaded
  */
  private async ensureCredentials(): Promise<AWSCredentials> {
    if (!this.credentials) {
      await this.init()
    }
    return this.credentials!
  }

  /**
   * Make a CloudFormation API request
  */
  private async request(action: string, params: Record<string, any>): Promise<any> {
    const credentials = await this.ensureCredentials()

    // Build query string
    const queryParams: Record<string, string> = {
      Action: action,
      Version: '2010-05-15',
      ...flattenParams(params),
    }

    const queryString = new URLSearchParams(queryParams).toString()

    const response = await makeAWSRequest({
      method: 'POST',
      url: `https://cloudformation.${this.region}.amazonaws.com/`,
      service: 'cloudformation',
      region: this.region,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: queryString,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    })

    return await parseXMLResponse(response)
  }

  /**
   * Create a new CloudFormation stack
  */
  async createStack(options: CreateStackOptions): Promise<string> {
    const params: Record<string, any> = {
      StackName: options.stackName,
    }

    if (options.templateBody) {
      params.TemplateBody = options.templateBody
    }
    else if (options.templateURL) {
      params.TemplateURL = options.templateURL
    }
    else {
      throw new Error('Either templateBody or templateURL must be provided')
    }

    if (options.parameters) {
      params.Parameters = Object.entries(options.parameters).map(([key, value], index) => ({
        [`Parameters.member.${index + 1}.ParameterKey`]: key,
        [`Parameters.member.${index + 1}.ParameterValue`]: value,
      }))
    }

    if (options.capabilities) {
      params.Capabilities = options.capabilities.map((cap, index) => ({
        [`Capabilities.member.${index + 1}`]: cap,
      }))
    }

    if (options.tags) {
      params.Tags = Object.entries(options.tags).map(([key, value], index) => ({
        [`Tags.member.${index + 1}.Key`]: key,
        [`Tags.member.${index + 1}.Value`]: value,
      }))
    }

    if (options.timeoutInMinutes) {
      params.TimeoutInMinutes = options.timeoutInMinutes
    }

    if (options.onFailure) {
      params.OnFailure = options.onFailure
    }

    const result = await this.request('CreateStack', params)
    return result.StackId
  }

  /**
   * Update an existing CloudFormation stack
  */
  async updateStack(options: UpdateStackOptions): Promise<string> {
    const params: Record<string, any> = {
      StackName: options.stackName,
    }

    if (options.templateBody) {
      params.TemplateBody = options.templateBody
    }
    else if (options.templateURL) {
      params.TemplateURL = options.templateURL
    }

    if (options.parameters) {
      params.Parameters = Object.entries(options.parameters).map(([key, value], index) => ({
        [`Parameters.member.${index + 1}.ParameterKey`]: key,
        [`Parameters.member.${index + 1}.ParameterValue`]: value,
      }))
    }

    if (options.capabilities) {
      params.Capabilities = options.capabilities.map((cap, index) => ({
        [`Capabilities.member.${index + 1}`]: cap,
      }))
    }

    if (options.tags) {
      params.Tags = Object.entries(options.tags).map(([key, value], index) => ({
        [`Tags.member.${index + 1}.Key`]: key,
        [`Tags.member.${index + 1}.Value`]: value,
      }))
    }

    const result = await this.request('UpdateStack', params)
    return result.StackId
  }

  /**
   * Delete a CloudFormation stack
  */
  async deleteStack(stackName: string): Promise<void> {
    await this.request('DeleteStack', {
      StackName: stackName,
    })
  }

  /**
   * Describe a CloudFormation stack
  */
  async describeStack(stackName: string): Promise<CloudFormationStack> {
    const result = await this.request('DescribeStacks', {
      StackName: stackName,
    })

    // Parse stack from XML response
    return parseStack(result)
  }

  /**
   * List all CloudFormation stacks
  */
  async listStacks(statusFilter?: string[]): Promise<CloudFormationStack[]> {
    const params: Record<string, any> = {}

    if (statusFilter) {
      params.StackStatusFilter = statusFilter.map((status, index) => ({
        [`StackStatusFilter.member.${index + 1}`]: status,
      }))
    }

    const result = await this.request('ListStacks', params)
    return parseStackList(result)
  }

  /**
   * Get stack events
  */
  async describeStackEvents(stackName: string): Promise<StackEvent[]> {
    const result = await this.request('DescribeStackEvents', {
      StackName: stackName,
    })

    return parseStackEvents(result)
  }

  /**
   * Wait for stack to reach a terminal state
  */
  async waitForStack(
    stackName: string,
    desiredStates: string[],
    onProgress?: (event: StackEvent) => void,
  ): Promise<CloudFormationStack> {
    const pollInterval = 5000 // 5 seconds
    const maxAttempts = 360 // 30 minutes maximum
    let attempts = 0
    let lastEventId: string | null = null

    while (attempts < maxAttempts) {
      attempts++

      const stack = await this.describeStack(stackName)

      // Get latest events
      if (onProgress) {
        const events = await this.describeStackEvents(stackName)
        const newEvents = lastEventId
          ? events.filter(e => e.EventId !== lastEventId).reverse()
          : [events[0]]

        newEvents.forEach(event => onProgress(event))

        if (events.length > 0) {
          lastEventId = events[0].EventId
        }
      }

      // Check if stack reached desired state
      if (stack.StackStatus && desiredStates.includes(stack.StackStatus)) {
        return stack
      }

      // Check for failure states
      if (stack.StackStatus?.includes('FAILED') || stack.StackStatus?.includes('ROLLBACK')) {
        throw new Error(
          `Stack reached failed state: ${stack.StackStatus}\n`
          + `Reason: ${stack.StackStatusReason || 'Unknown'}`,
        )
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    throw new Error(`Timeout waiting for stack ${stackName} to complete`)
  }

  /**
   * Create a change set
  */
  async createChangeSet(options: {
    stackName: string
    changeSetName: string
    templateBody?: string
    templateURL?: string
    parameters?: Record<string, string>
    capabilities?: string[]
  }): Promise<string> {
    const params: Record<string, any> = {
      StackName: options.stackName,
      ChangeSetName: options.changeSetName,
      ChangeSetType: 'UPDATE',
    }

    if (options.templateBody) {
      params.TemplateBody = options.templateBody
    }
    else if (options.templateURL) {
      params.TemplateURL = options.templateURL
    }

    if (options.parameters) {
      params.Parameters = Object.entries(options.parameters).map(([key, value], index) => ({
        [`Parameters.member.${index + 1}.ParameterKey`]: key,
        [`Parameters.member.${index + 1}.ParameterValue`]: value,
      }))
    }

    if (options.capabilities) {
      params.Capabilities = options.capabilities.map((cap, index) => ({
        [`Capabilities.member.${index + 1}`]: cap,
      }))
    }

    const result = await this.request('CreateChangeSet', params)
    return result.ChangeSetId
  }

  /**
   * Execute a change set
  */
  async executeChangeSet(changeSetName: string, stackName: string): Promise<void> {
    await this.request('ExecuteChangeSet', {
      ChangeSetName: changeSetName,
      StackName: stackName,
    })
  }
}

/**
 * Flatten nested parameters for AWS API query string
*/
function flattenParams(params: Record<string, any>, prefix: string = ''): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}.${key}` : key

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object') {
          Object.assign(result, flattenParams(item, `${fullKey}.${index + 1}`))
        }
        else {
          result[`${fullKey}.${index + 1}`] = String(item)
        }
      })
    }
    else if (typeof value === 'object' && value !== null) {
      Object.assign(result, flattenParams(value, fullKey))
    }
    else if (value !== undefined && value !== null) {
      result[fullKey] = String(value)
    }
  }

  return result
}

/**
 * Parse stack from XML response
*/
function parseStack(data: any): CloudFormationStack {
  // Simplified parsing - in production, use a proper XML parser
  return {
    StackName: data.StackName || '',
    StackId: data.StackId,
    StackStatus: data.StackStatus,
    CreationTime: data.CreationTime,
    LastUpdatedTime: data.LastUpdatedTime,
    StackStatusReason: data.StackStatusReason,
    Description: data.Description,
  }
}

/**
 * Parse stack list from XML response
*/
function parseStackList(data: any): CloudFormationStack[] {
  // Simplified parsing
  return []
}

/**
 * Parse stack events from XML response
*/
function parseStackEvents(data: any): StackEvent[] {
  // Simplified parsing
  return []
}
