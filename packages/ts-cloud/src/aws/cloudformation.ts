/**
 * AWS CloudFormation Operations
 * Direct API calls without AWS CLI dependency
 */

import { AWSClient, buildQueryParams } from './client'

export interface StackParameter {
  ParameterKey: string
  ParameterValue: string
  UsePreviousValue?: boolean
}

export interface StackTag {
  Key: string
  Value: string
}

export interface CreateStackOptions {
  stackName: string
  templateBody?: string
  templateUrl?: string
  parameters?: StackParameter[]
  capabilities?: string[]
  roleArn?: string
  tags?: StackTag[]
  timeoutInMinutes?: number
  onFailure?: 'DO_NOTHING' | 'ROLLBACK' | 'DELETE'
}

export interface UpdateStackOptions {
  stackName: string
  templateBody?: string
  templateUrl?: string
  parameters?: StackParameter[]
  capabilities?: string[]
  roleArn?: string
  tags?: StackTag[]
}

export interface DescribeStacksOptions {
  stackName?: string
}

export interface StackEvent {
  Timestamp: string
  ResourceType: string
  LogicalResourceId: string
  ResourceStatus: string
  ResourceStatusReason?: string
}

export interface Stack {
  StackId: string
  StackName: string
  StackStatus: string
  CreationTime: string
  LastUpdatedTime?: string
  Parameters?: StackParameter[]
  Outputs?: Array<{
    OutputKey: string
    OutputValue: string
    Description?: string
    ExportName?: string
  }>
  Tags?: StackTag[]
}

/**
 * CloudFormation stack management using direct API calls
 */
export class CloudFormationClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a new CloudFormation stack
   */
  async createStack(options: CreateStackOptions): Promise<{ StackId: string }> {
    const params: Record<string, any> = {
      Action: 'CreateStack',
      StackName: options.stackName,
      Version: '2010-05-15',
    }

    if (options.templateBody) {
      params.TemplateBody = options.templateBody
    }
    else if (options.templateUrl) {
      params.TemplateURL = options.templateUrl
    }
    else {
      throw new Error('Either templateBody or templateUrl must be provided')
    }

    if (options.parameters) {
      options.parameters.forEach((param, index) => {
        params[`Parameters.member.${index + 1}.ParameterKey`] = param.ParameterKey
        params[`Parameters.member.${index + 1}.ParameterValue`] = param.ParameterValue
      })
    }

    if (options.capabilities) {
      options.capabilities.forEach((cap, index) => {
        params[`Capabilities.member.${index + 1}`] = cap
      })
    }

    if (options.roleArn) {
      params.RoleARN = options.roleArn
    }

    if (options.tags) {
      options.tags.forEach((tag, index) => {
        params[`Tags.member.${index + 1}.Key`] = tag.Key
        params[`Tags.member.${index + 1}.Value`] = tag.Value
      })
    }

    if (options.timeoutInMinutes) {
      params.TimeoutInMinutes = options.timeoutInMinutes
    }

    if (options.onFailure) {
      params.OnFailure = options.onFailure
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { StackId: result.StackId || result.CreateStackResult?.StackId }
  }

  /**
   * Update an existing CloudFormation stack
   */
  async updateStack(options: UpdateStackOptions): Promise<{ StackId: string }> {
    const params: Record<string, any> = {
      Action: 'UpdateStack',
      StackName: options.stackName,
      Version: '2010-05-15',
    }

    if (options.templateBody) {
      params.TemplateBody = options.templateBody
    }
    else if (options.templateUrl) {
      params.TemplateURL = options.templateUrl
    }

    if (options.parameters) {
      options.parameters.forEach((param, index) => {
        params[`Parameters.member.${index + 1}.ParameterKey`] = param.ParameterKey
        if (param.UsePreviousValue) {
          params[`Parameters.member.${index + 1}.UsePreviousValue`] = 'true'
        }
        else {
          params[`Parameters.member.${index + 1}.ParameterValue`] = param.ParameterValue
        }
      })
    }

    if (options.capabilities) {
      options.capabilities.forEach((cap, index) => {
        params[`Capabilities.member.${index + 1}`] = cap
      })
    }

    if (options.roleArn) {
      params.RoleARN = options.roleArn
    }

    if (options.tags) {
      options.tags.forEach((tag, index) => {
        params[`Tags.member.${index + 1}.Key`] = tag.Key
        params[`Tags.member.${index + 1}.Value`] = tag.Value
      })
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { StackId: result.StackId || result.UpdateStackResult?.StackId }
  }

  /**
   * Delete a CloudFormation stack
   */
  async deleteStack(stackName: string, roleArn?: string): Promise<void> {
    const params: Record<string, any> = {
      Action: 'DeleteStack',
      StackName: stackName,
      Version: '2010-05-15',
    }

    if (roleArn) {
      params.RoleARN = roleArn
    }

    await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * Describe CloudFormation stacks
   */
  async describeStacks(options: DescribeStacksOptions = {}): Promise<{ Stacks: Stack[] }> {
    const params: Record<string, any> = {
      Action: 'DescribeStacks',
      Version: '2010-05-15',
    }

    if (options.stackName) {
      params.StackName = options.stackName
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    // Parse the response
    const stacks = this.parseStacksResponse(result)
    return { Stacks: stacks }
  }

  /**
   * Get stack events
   */
  async describeStackEvents(stackName: string): Promise<{ StackEvents: StackEvent[] }> {
    const params: Record<string, any> = {
      Action: 'DescribeStackEvents',
      StackName: stackName,
      Version: '2010-05-15',
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { StackEvents: this.parseStackEvents(result) }
  }

  /**
   * Wait for stack to reach a specific status
   */
  async waitForStack(stackName: string, waitType: 'stack-create-complete' | 'stack-update-complete' | 'stack-delete-complete'): Promise<void> {
    const targetStatuses = {
      'stack-create-complete': ['CREATE_COMPLETE'],
      'stack-update-complete': ['UPDATE_COMPLETE'],
      'stack-delete-complete': ['DELETE_COMPLETE'],
    }

    const failureStatuses = [
      'CREATE_FAILED',
      'ROLLBACK_FAILED',
      'ROLLBACK_COMPLETE',
      'DELETE_FAILED',
      'UPDATE_ROLLBACK_FAILED',
      'UPDATE_ROLLBACK_COMPLETE',
    ]

    const targets = targetStatuses[waitType]
    const maxAttempts = 120 // 10 minutes
    let attempts = 0

    while (attempts < maxAttempts) {
      try {
        const result = await this.describeStacks({ stackName })

        if (result.Stacks.length === 0) {
          if (waitType === 'stack-delete-complete') {
            return // Stack deleted successfully
          }
          throw new Error(`Stack ${stackName} not found`)
        }

        const stack = result.Stacks[0]

        if (targets.includes(stack.StackStatus)) {
          return // Target status reached
        }

        if (failureStatuses.includes(stack.StackStatus)) {
          throw new Error(`Stack reached failure status: ${stack.StackStatus}`)
        }

        // Wait 5 seconds before next attempt
        await new Promise(resolve => setTimeout(resolve, 5000))
        attempts++
      }
      catch (error: any) {
        if (waitType === 'stack-delete-complete' && error.message?.includes('does not exist')) {
          return // Stack deleted
        }
        throw error
      }
    }

    throw new Error(`Timeout waiting for stack to reach ${waitType}`)
  }

  /**
   * Validate CloudFormation template
   */
  async validateTemplate(templateBody: string): Promise<any> {
    const params: Record<string, any> = {
      Action: 'ValidateTemplate',
      TemplateBody: templateBody,
      Version: '2010-05-15',
    }

    return await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * List all stacks
   */
  async listStacks(statusFilter?: string[]): Promise<{ StackSummaries: Array<{
    StackId: string
    StackName: string
    TemplateDescription?: string
    CreationTime: string
    LastUpdatedTime?: string
    DeletionTime?: string
    StackStatus: string
  }> }> {
    const params: Record<string, any> = {
      Action: 'ListStacks',
      Version: '2010-05-15',
    }

    if (statusFilter) {
      statusFilter.forEach((status, index) => {
        params[`StackStatusFilter.member.${index + 1}`] = status
      })
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { StackSummaries: [] } // TODO: Parse response
  }

  /**
   * Get stack resources
   */
  async listStackResources(stackName: string): Promise<{ StackResourceSummaries: Array<{
    LogicalResourceId: string
    PhysicalResourceId: string
    ResourceType: string
    ResourceStatus: string
    LastUpdatedTimestamp: string
  }> }> {
    const params: Record<string, any> = {
      Action: 'ListStackResources',
      StackName: stackName,
      Version: '2010-05-15',
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { StackResourceSummaries: [] } // TODO: Parse response
  }

  /**
   * Create change set (for preview before updating)
   */
  async createChangeSet(options: {
    stackName: string
    changeSetName: string
    templateBody?: string
    templateUrl?: string
    parameters?: StackParameter[]
    capabilities?: string[]
    changeSetType?: 'CREATE' | 'UPDATE'
  }): Promise<{ Id: string, StackId: string }> {
    const params: Record<string, any> = {
      Action: 'CreateChangeSet',
      StackName: options.stackName,
      ChangeSetName: options.changeSetName,
      Version: '2010-05-15',
    }

    if (options.templateBody) {
      params.TemplateBody = options.templateBody
    }
    else if (options.templateUrl) {
      params.TemplateURL = options.templateUrl
    }

    if (options.parameters) {
      options.parameters.forEach((param, index) => {
        params[`Parameters.member.${index + 1}.ParameterKey`] = param.ParameterKey
        params[`Parameters.member.${index + 1}.ParameterValue`] = param.ParameterValue
      })
    }

    if (options.capabilities) {
      options.capabilities.forEach((cap, index) => {
        params[`Capabilities.member.${index + 1}`] = cap
      })
    }

    if (options.changeSetType) {
      params.ChangeSetType = options.changeSetType
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { Id: result.Id, StackId: result.StackId }
  }

  /**
   * Describe change set
   */
  async describeChangeSet(stackName: string, changeSetName: string): Promise<any> {
    const params: Record<string, any> = {
      Action: 'DescribeChangeSet',
      StackName: stackName,
      ChangeSetName: changeSetName,
      Version: '2010-05-15',
    }

    return await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * Execute change set
   */
  async executeChangeSet(stackName: string, changeSetName: string): Promise<void> {
    const params: Record<string, any> = {
      Action: 'ExecuteChangeSet',
      StackName: stackName,
      ChangeSetName: changeSetName,
      Version: '2010-05-15',
    }

    await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * Delete change set
   */
  async deleteChangeSet(stackName: string, changeSetName: string): Promise<void> {
    const params: Record<string, any> = {
      Action: 'DeleteChangeSet',
      StackName: stackName,
      ChangeSetName: changeSetName,
      Version: '2010-05-15',
    }

    await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * Get stack outputs as key-value pairs
   */
  async getStackOutputs(stackName: string): Promise<Record<string, string>> {
    const result = await this.describeStacks({ stackName })

    if (!result.Stacks || result.Stacks.length === 0) {
      throw new Error(`Stack ${stackName} not found`)
    }

    const stack = result.Stacks[0]
    const outputs: Record<string, string> = {}

    if (stack.Outputs) {
      for (const output of stack.Outputs) {
        outputs[output.OutputKey] = output.OutputValue
      }
    }

    return outputs
  }

  /**
   * Get stack template
   */
  async getTemplate(stackName: string): Promise<{ TemplateBody: string }> {
    const params: Record<string, any> = {
      Action: 'GetTemplate',
      StackName: stackName,
      Version: '2010-05-15',
    }

    const result = await this.client.request({
      service: 'cloudformation',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { TemplateBody: result.TemplateBody }
  }

  /**
   * Parse stacks response
   */
  private parseStacksResponse(result: any): Stack[] {
    // Simple parser for now - in production, would use a proper XML parser
    const stacks: Stack[] = []

    // This is a simplified version - the actual XML parsing would be more robust
    if (result.StackId) {
      stacks.push({
        StackId: result.StackId,
        StackName: result.StackName,
        StackStatus: result.StackStatus,
        CreationTime: result.CreationTime,
        LastUpdatedTime: result.LastUpdatedTime,
      })
    }

    return stacks
  }

  /**
   * Parse stack events response
   */
  private parseStackEvents(result: any): StackEvent[] {
    // Simplified parser
    return []
  }
}
