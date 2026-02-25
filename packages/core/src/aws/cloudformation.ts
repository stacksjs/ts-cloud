/**
 * AWS CloudFormation API Client
 * Direct API calls without AWS SDK dependency
 */

import type { AWSCredentials } from './credentials'
import { resolveCredentials } from './credentials'
import { makeAWSRequest } from './signature'

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

    const text = await response.text()
    return parseCloudFormationXML(text)
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
      for (const [index, [key, value]] of Object.entries(options.parameters).entries()) {
        params[`Parameters.member.${index + 1}.ParameterKey`] = key
        params[`Parameters.member.${index + 1}.ParameterValue`] = value
      }
    }

    if (options.capabilities) {
      for (const [index, cap] of options.capabilities.entries()) {
        params[`Capabilities.member.${index + 1}`] = cap
      }
    }

    if (options.tags) {
      for (const [index, [key, value]] of Object.entries(options.tags).entries()) {
        params[`Tags.member.${index + 1}.Key`] = key
        params[`Tags.member.${index + 1}.Value`] = value
      }
    }

    if (options.timeoutInMinutes) {
      params.TimeoutInMinutes = options.timeoutInMinutes
    }

    if (options.onFailure) {
      params.OnFailure = options.onFailure
    }

    const result = await this.request('CreateStack', params)
    const createResult = result?.CreateStackResult || result?.CreateStackResponse?.CreateStackResult || result
    return createResult?.StackId
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
      for (const [index, [key, value]] of Object.entries(options.parameters).entries()) {
        params[`Parameters.member.${index + 1}.ParameterKey`] = key
        params[`Parameters.member.${index + 1}.ParameterValue`] = value
      }
    }

    if (options.capabilities) {
      for (const [index, cap] of options.capabilities.entries()) {
        params[`Capabilities.member.${index + 1}`] = cap
      }
    }

    if (options.tags) {
      for (const [index, [key, value]] of Object.entries(options.tags).entries()) {
        params[`Tags.member.${index + 1}.Key`] = key
        params[`Tags.member.${index + 1}.Value`] = value
      }
    }

    const result = await this.request('UpdateStack', params)
    const updateResult = result?.UpdateStackResult || result?.UpdateStackResponse?.UpdateStackResult || result
    return updateResult?.StackId
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

    // Navigate the parsed XML structure
    const describeResult = result?.DescribeStacksResult || result?.DescribeStacksResponse?.DescribeStacksResult || result
    const stacks = describeResult?.Stacks?.member
    const stack = Array.isArray(stacks) ? stacks[0] : stacks
    if (!stack) {
      throw new Error(`Stack ${stackName} not found`)
    }
    return parseStack(stack)
  }

  /**
   * List all CloudFormation stacks
   */
  async listStacks(statusFilter?: string[]): Promise<CloudFormationStack[]> {
    const params: Record<string, any> = {}

    if (statusFilter) {
      for (const [index, status] of statusFilter.entries()) {
        params[`StackStatusFilter.member.${index + 1}`] = status
      }
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
        try {
          const events = await this.describeStackEvents(stackName)
          let newEvents: StackEvent[] = []

          if (lastEventId) {
            // Events come newest-first; collect until we hit the last-seen event
            for (const event of events) {
              if (event.EventId === lastEventId) break
              newEvents.push(event)
            }
            // Reverse to show in chronological order
            newEvents.reverse()
          }
          else if (events.length > 0) {
            newEvents = [events[0]]
          }

          for (const event of newEvents) {
            onProgress(event)
          }

          if (events.length > 0) {
            lastEventId = events[0].EventId
          }
        }
        catch {
          // Ignore event fetch errors - don't break the wait loop
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
   * Wait for stack using waiter-style name (e.g., 'stack-create-complete')
   * Convenience method that maps waiter names to CloudFormation states
   */
  async waitForStackWithProgress(
    stackName: string,
    waiterName: string,
    onProgress?: (event: StackEvent) => void,
  ): Promise<CloudFormationStack> {
    const waiterMap: Record<string, string[]> = {
      'stack-create-complete': ['CREATE_COMPLETE'],
      'stack-update-complete': ['UPDATE_COMPLETE'],
      'stack-delete-complete': ['DELETE_COMPLETE'],
    }

    const desiredStates = waiterMap[waiterName]
    if (!desiredStates) {
      throw new Error(`Unknown waiter: ${waiterName}`)
    }

    return this.waitForStack(stackName, desiredStates, onProgress)
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
      for (const [index, [key, value]] of Object.entries(options.parameters).entries()) {
        params[`Parameters.member.${index + 1}.ParameterKey`] = key
        params[`Parameters.member.${index + 1}.ParameterValue`] = value
      }
    }

    if (options.capabilities) {
      for (const [index, cap] of options.capabilities.entries()) {
        params[`Capabilities.member.${index + 1}`] = cap
      }
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

  /**
   * Describe stacks (SDK-compatible interface returning { Stacks: [...] })
   * Accepts either a string stackName or an object { stackName: string }
   */
  async describeStacks(input: string | { stackName: string }): Promise<{ Stacks: CloudFormationStack[] }> {
    const stackName = typeof input === 'string' ? input : input.stackName
    try {
      const stack = await this.describeStack(stackName)
      return { Stacks: [stack] }
    }
    catch {
      return { Stacks: [] }
    }
  }

  /**
   * Get stack outputs as a key-value map
   */
  async getStackOutputs(stackName: string): Promise<Record<string, string>> {
    const result = await this.request('DescribeStacks', {
      StackName: stackName,
    })

    const describeResult = result?.DescribeStacksResult || result?.DescribeStacksResponse?.DescribeStacksResult || result
    const stacks = describeResult?.Stacks?.member
    const stack = Array.isArray(stacks) ? stacks[0] : stacks
    if (!stack) return {}

    const outputs: Record<string, string> = {}
    const outputList = stack.Outputs?.member
    if (outputList) {
      const items = Array.isArray(outputList) ? outputList : [outputList]
      for (const output of items) {
        if (output.OutputKey && output.OutputValue) {
          outputs[output.OutputKey] = output.OutputValue
        }
      }
    }
    return outputs
  }

  /**
   * Empty and delete an S3 bucket (convenience for cleanup)
   * Note: This is a pass-through for S3 operations during stack cleanup
   */
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
 * XML parser for CloudFormation responses.
 * Properly handles nested elements with the same tag name (e.g., nested <member> elements).
 */
function parseCloudFormationXML(xml: string): any {
  // Remove XML declaration and namespace attributes
  xml = xml.replace(/<\?xml[^?]*\?>\s*/, '').trim()

  function findMatchingClose(str: string, tagName: string, startPos: number): number {
    // Find the matching closing tag, accounting for nested elements with the same name
    let depth = 1
    let pos = startPos
    const openPattern = `<${tagName}`
    const closeTag = `</${tagName}>`

    while (pos < str.length && depth > 0) {
      const nextOpen = str.indexOf(openPattern, pos)
      const nextClose = str.indexOf(closeTag, pos)

      if (nextClose === -1) return -1 // No closing tag found

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // Check if it's actually an opening tag (not just a prefix match)
        const charAfterTag = str[nextOpen + openPattern.length]
        if (charAfterTag === '>' || charAfterTag === ' ' || charAfterTag === '/') {
          // Check for self-closing tag
          const tagEnd = str.indexOf('>', nextOpen)
          if (tagEnd !== -1 && str[tagEnd - 1] === '/') {
            // Self-closing, don't increase depth
            pos = tagEnd + 1
          } else {
            depth++
            pos = tagEnd + 1
          }
        } else {
          pos = nextOpen + openPattern.length
        }
      } else {
        depth--
        if (depth === 0) return nextClose
        pos = nextClose + closeTag.length
      }
    }
    return -1
  }

  function parseElement(str: string, pos: number): { value: any, end: number } {
    // Skip whitespace
    while (pos < str.length && /\s/.test(str[pos])) pos++

    if (pos >= str.length || str[pos] !== '<') {
      const textEnd = str.indexOf('<', pos)
      if (textEnd === -1) return { value: str.slice(pos).trim(), end: str.length }
      return { value: str.slice(pos, textEnd).trim(), end: textEnd }
    }

    // Check for closing tag
    if (str[pos + 1] === '/') {
      return { value: undefined, end: pos }
    }

    // Parse opening tag
    const tagMatch = str.slice(pos).match(/^<(\w+)([^>]*?)\/?>/)
    if (!tagMatch) return { value: undefined, end: pos + 1 }

    const tagName = tagMatch[1]
    const isSelfClosing = tagMatch[0].endsWith('/>')

    if (isSelfClosing) {
      // Self-closing tag like <NotificationARNs/> or <Tags/>
      return { value: '', end: pos + tagMatch[0].length }
    }

    const innerPos = pos + tagMatch[0].length
    const closingTag = `</${tagName}>`
    const closingIdx = findMatchingClose(str, tagName, innerPos)
    if (closingIdx === -1) return { value: undefined, end: pos + tagMatch[0].length }

    const innerContent = str.slice(innerPos, closingIdx).trim()

    // Check if inner content has child elements
    if (!innerContent.includes('<')) {
      return { value: innerContent, end: closingIdx + closingTag.length }
    }

    // Parse children
    const children: Record<string, any> = {}
    let childPos = innerPos

    while (childPos < closingIdx) {
      while (childPos < closingIdx && /\s/.test(str[childPos])) childPos++
      if (childPos >= closingIdx) break
      if (str[childPos] !== '<' || str[childPos + 1] === '/') break

      const childTagMatch = str.slice(childPos).match(/^<(\w+)/)
      if (!childTagMatch) break

      const childName = childTagMatch[1]
      const result = parseElement(str, childPos)
      if (result.value === undefined) { childPos++; continue }

      // Handle list items (member pattern)
      if (childName === 'member' || children[childName] !== undefined) {
        if (!Array.isArray(children[childName])) {
          children[childName] = children[childName] !== undefined ? [children[childName]] : []
        }
        children[childName].push(result.value)
      } else {
        children[childName] = result.value
      }

      childPos = result.end
    }

    return { value: children, end: closingIdx + closingTag.length }
  }

  const result = parseElement(xml, 0)
  return result.value || {}
}

/**
 * Parse stack from XML response or parsed object
 */
function parseStack(data: any): CloudFormationStack {
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
 * Parse stack list from parsed XML object
 */
function parseStackList(data: any): CloudFormationStack[] {
  const result = data?.ListStacksResult || data?.ListStacksResponse?.ListStacksResult || data
  const summaries = result?.StackSummaries?.member
  if (!summaries) return []
  const items = Array.isArray(summaries) ? summaries : [summaries]
  return items.map((s: any) => ({
    StackName: s.StackName || '',
    StackId: s.StackId,
    StackStatus: s.StackStatus,
    CreationTime: s.CreationTime,
    LastUpdatedTime: s.LastUpdatedTime,
    StackStatusReason: s.StackStatusReason,
    Description: s.Description,
  }))
}

/**
 * Parse stack events from parsed XML object
 */
function parseStackEvents(data: any): StackEvent[] {
  const result = data?.DescribeStackEventsResult || data?.DescribeStackEventsResponse?.DescribeStackEventsResult || data
  const events = result?.StackEvents?.member
  if (!events) return []
  const items = Array.isArray(events) ? events : [events]
  return items.map((e: any) => ({
    StackId: e.StackId || '',
    EventId: e.EventId || '',
    StackName: e.StackName || '',
    LogicalResourceId: e.LogicalResourceId || '',
    PhysicalResourceId: e.PhysicalResourceId,
    ResourceType: e.ResourceType || '',
    Timestamp: e.Timestamp || '',
    ResourceStatus: e.ResourceStatus || '',
    ResourceStatusReason: e.ResourceStatusReason,
  }))
}
