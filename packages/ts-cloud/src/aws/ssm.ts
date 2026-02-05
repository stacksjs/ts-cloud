/**
 * AWS SSM (Systems Manager) Parameter Store Client
 * Manages parameters and secrets using direct API calls
*/

import { AWSClient } from './client'

export interface Parameter {
  Name?: string
  Type?: 'String' | 'StringList' | 'SecureString'
  Value?: string
  Version?: number
  LastModifiedDate?: string
  ARN?: string
  DataType?: string
  Description?: string
  AllowedPattern?: string
  KeyId?: string
  Tier?: 'Standard' | 'Advanced' | 'Intelligent-Tiering'
}

export interface ParameterHistory {
  Name?: string
  Type?: 'String' | 'StringList' | 'SecureString'
  KeyId?: string
  LastModifiedDate?: string
  LastModifiedUser?: string
  Description?: string
  Value?: string
  Version?: number
  Labels?: string[]
  Tier?: string
}

export interface PutParameterOptions {
  Name: string
  Value: string
  Type?: 'String' | 'StringList' | 'SecureString'
  Description?: string
  KeyId?: string
  Overwrite?: boolean
  AllowedPattern?: string
  Tags?: { Key: string, Value: string }[]
  Tier?: 'Standard' | 'Advanced' | 'Intelligent-Tiering'
  DataType?: string
}

export interface GetParameterOptions {
  Name: string
  WithDecryption?: boolean
}

export interface GetParametersOptions {
  Names: string[]
  WithDecryption?: boolean
}

export interface GetParametersByPathOptions {
  Path: string
  Recursive?: boolean
  WithDecryption?: boolean
  MaxResults?: number
  NextToken?: string
  ParameterFilters?: {
    Key: string
    Option?: string
    Values?: string[]
  }[]
}

export interface DeleteParameterOptions {
  Name: string
}

/**
 * SSM Parameter Store client using direct API calls
*/
export class SSMClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Put a parameter to Parameter Store
  */
  async putParameter(options: PutParameterOptions): Promise<{
    Version?: number
    Tier?: string
  }> {
    const params: Record<string, any> = {
      Name: options.Name,
      Value: options.Value,
    }

    if (options.Type) {
      params.Type = options.Type
    }

    if (options.Description) {
      params.Description = options.Description
    }

    if (options.KeyId) {
      params.KeyId = options.KeyId
    }

    if (options.Overwrite !== undefined) {
      params.Overwrite = options.Overwrite
    }

    if (options.AllowedPattern) {
      params.AllowedPattern = options.AllowedPattern
    }

    if (options.Tags && options.Tags.length > 0) {
      params.Tags = options.Tags
    }

    if (options.Tier) {
      params.Tier = options.Tier
    }

    if (options.DataType) {
      params.DataType = options.DataType
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.PutParameter',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      Version: result.Version,
      Tier: result.Tier,
    }
  }

  /**
   * Get a parameter from Parameter Store
  */
  async getParameter(options: GetParameterOptions): Promise<{
    Parameter?: Parameter
  }> {
    const params: Record<string, any> = {
      Name: options.Name,
    }

    if (options.WithDecryption !== undefined) {
      params.WithDecryption = options.WithDecryption
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.GetParameter',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      Parameter: result.Parameter ? this.parseParameter(result.Parameter) : undefined,
    }
  }

  /**
   * Get multiple parameters from Parameter Store
  */
  async getParameters(options: GetParametersOptions): Promise<{
    Parameters?: Parameter[]
    InvalidParameters?: string[]
  }> {
    const params: Record<string, any> = {
      Names: options.Names,
    }

    if (options.WithDecryption !== undefined) {
      params.WithDecryption = options.WithDecryption
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.GetParameters',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      Parameters: result.Parameters?.map((p: any) => this.parseParameter(p)),
      InvalidParameters: result.InvalidParameters,
    }
  }

  /**
   * Get parameters by path (hierarchical)
  */
  async getParametersByPath(options: GetParametersByPathOptions): Promise<{
    Parameters?: Parameter[]
    NextToken?: string
  }> {
    const params: Record<string, any> = {
      Path: options.Path,
    }

    if (options.Recursive !== undefined) {
      params.Recursive = options.Recursive
    }

    if (options.WithDecryption !== undefined) {
      params.WithDecryption = options.WithDecryption
    }

    if (options.MaxResults) {
      params.MaxResults = options.MaxResults
    }

    if (options.NextToken) {
      params.NextToken = options.NextToken
    }

    if (options.ParameterFilters && options.ParameterFilters.length > 0) {
      params.ParameterFilters = options.ParameterFilters
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.GetParametersByPath',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      Parameters: result.Parameters?.map((p: any) => this.parseParameter(p)),
      NextToken: result.NextToken,
    }
  }

  /**
   * Delete a parameter from Parameter Store
  */
  async deleteParameter(options: DeleteParameterOptions): Promise<void> {
    const params: Record<string, any> = {
      Name: options.Name,
    }

    await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.DeleteParameter',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Delete multiple parameters from Parameter Store
  */
  async deleteParameters(names: string[]): Promise<{
    DeletedParameters?: string[]
    InvalidParameters?: string[]
  }> {
    const params: Record<string, any> = {
      Names: names,
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.DeleteParameters',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      DeletedParameters: result.DeletedParameters,
      InvalidParameters: result.InvalidParameters,
    }
  }

  /**
   * Describe parameters (metadata only, no values)
  */
  async describeParameters(options?: {
    Filters?: { Key: string, Values: string[] }[]
    ParameterFilters?: { Key: string, Option?: string, Values?: string[] }[]
    MaxResults?: number
    NextToken?: string
  }): Promise<{
    Parameters?: Parameter[]
    NextToken?: string
  }> {
    const params: Record<string, any> = {}

    if (options?.Filters && options.Filters.length > 0) {
      params.Filters = options.Filters
    }

    if (options?.ParameterFilters && options.ParameterFilters.length > 0) {
      params.ParameterFilters = options.ParameterFilters
    }

    if (options?.MaxResults) {
      params.MaxResults = options.MaxResults
    }

    if (options?.NextToken) {
      params.NextToken = options.NextToken
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.DescribeParameters',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      Parameters: result.Parameters?.map((p: any) => this.parseParameter(p)),
      NextToken: result.NextToken,
    }
  }

  /**
   * Get parameter history
  */
  async getParameterHistory(options: {
    Name: string
    WithDecryption?: boolean
    MaxResults?: number
    NextToken?: string
  }): Promise<{
    Parameters?: ParameterHistory[]
    NextToken?: string
  }> {
    const params: Record<string, any> = {
      Name: options.Name,
    }

    if (options.WithDecryption !== undefined) {
      params.WithDecryption = options.WithDecryption
    }

    if (options.MaxResults) {
      params.MaxResults = options.MaxResults
    }

    if (options.NextToken) {
      params.NextToken = options.NextToken
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.GetParameterHistory',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      Parameters: result.Parameters?.map((p: any) => ({
        Name: p.Name,
        Type: p.Type,
        KeyId: p.KeyId,
        LastModifiedDate: p.LastModifiedDate,
        LastModifiedUser: p.LastModifiedUser,
        Description: p.Description,
        Value: p.Value,
        Version: p.Version,
        Labels: p.Labels,
        Tier: p.Tier,
      })),
      NextToken: result.NextToken,
    }
  }

  /**
   * Label a parameter version
  */
  async labelParameterVersion(options: {
    Name: string
    ParameterVersion?: number
    Labels: string[]
  }): Promise<{
    InvalidLabels?: string[]
    ParameterVersion?: number
  }> {
    const params: Record<string, any> = {
      Name: options.Name,
      Labels: options.Labels,
    }

    if (options.ParameterVersion !== undefined) {
      params.ParameterVersion = options.ParameterVersion
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.LabelParameterVersion',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      InvalidLabels: result.InvalidLabels,
      ParameterVersion: result.ParameterVersion,
    }
  }

  /**
   * Add tags to a parameter
  */
  async addTagsToResource(options: {
    ResourceType: 'Parameter'
    ResourceId: string
    Tags: { Key: string, Value: string }[]
  }): Promise<void> {
    const params: Record<string, any> = {
      ResourceType: options.ResourceType,
      ResourceId: options.ResourceId,
      Tags: options.Tags,
    }

    await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.AddTagsToResource',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Remove tags from a parameter
  */
  async removeTagsFromResource(options: {
    ResourceType: 'Parameter'
    ResourceId: string
    TagKeys: string[]
  }): Promise<void> {
    const params: Record<string, any> = {
      ResourceType: options.ResourceType,
      ResourceId: options.ResourceId,
      TagKeys: options.TagKeys,
    }

    await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.RemoveTagsFromResource',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * List tags for a parameter
  */
  async listTagsForResource(options: {
    ResourceType: 'Parameter'
    ResourceId: string
  }): Promise<{
    TagList?: { Key: string, Value: string }[]
  }> {
    const params: Record<string, any> = {
      ResourceType: options.ResourceType,
      ResourceId: options.ResourceId,
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.ListTagsForResource',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      TagList: result.TagList,
    }
  }

  /**
   * Helper: Set a string parameter
  */
  async setString(name: string, value: string, options?: {
    description?: string
    overwrite?: boolean
    tags?: { Key: string, Value: string }[]
  }): Promise<{ Version?: number }> {
    return this.putParameter({
      Name: name,
      Value: value,
      Type: 'String',
      Description: options?.description,
      Overwrite: options?.overwrite ?? true,
      Tags: options?.tags,
    })
  }

  /**
   * Helper: Set a secure string parameter (encrypted)
  */
  async setSecureString(name: string, value: string, options?: {
    description?: string
    overwrite?: boolean
    kmsKeyId?: string
    tags?: { Key: string, Value: string }[]
  }): Promise<{ Version?: number }> {
    return this.putParameter({
      Name: name,
      Value: value,
      Type: 'SecureString',
      Description: options?.description,
      Overwrite: options?.overwrite ?? true,
      KeyId: options?.kmsKeyId,
      Tags: options?.tags,
    })
  }

  /**
   * Helper: Get a parameter value (decrypted)
  */
  async getValue(name: string): Promise<string | undefined> {
    const result = await this.getParameter({
      Name: name,
      WithDecryption: true,
    })
    return result.Parameter?.Value
  }

  /**
   * Helper: Get all parameters under a path
  */
  async getAllByPath(path: string, recursive: boolean = true): Promise<Parameter[]> {
    const allParams: Parameter[] = []
    let nextToken: string | undefined

    do {
      const result = await this.getParametersByPath({
        Path: path,
        Recursive: recursive,
        WithDecryption: true,
        NextToken: nextToken,
      })

      if (result.Parameters) {
        allParams.push(...result.Parameters)
      }

      nextToken = result.NextToken
    } while (nextToken)

    return allParams
  }

  /**
   * Parse parameter response
  */
  private parseParameter(p: any): Parameter {
    return {
      Name: p.Name,
      Type: p.Type,
      Value: p.Value,
      Version: p.Version,
      LastModifiedDate: p.LastModifiedDate,
      ARN: p.ARN,
      DataType: p.DataType,
      Description: p.Description,
      AllowedPattern: p.AllowedPattern,
      KeyId: p.KeyId,
      Tier: p.Tier,
    }
  }

  /**
   * Send a command to EC2 instances via SSM
  */
  async sendCommand(options: {
    InstanceIds: string[]
    DocumentName: string
    Parameters?: Record<string, string[]>
    TimeoutSeconds?: number
    Comment?: string
    OutputS3BucketName?: string
    OutputS3KeyPrefix?: string
  }): Promise<{
    CommandId?: string
    Status?: string
    StatusDetails?: string
  }> {
    const params: Record<string, any> = {
      InstanceIds: options.InstanceIds,
      DocumentName: options.DocumentName,
    }

    if (options.Parameters) {
      params.Parameters = options.Parameters
    }

    if (options.TimeoutSeconds) {
      params.TimeoutSeconds = options.TimeoutSeconds
    }

    if (options.Comment) {
      params.Comment = options.Comment
    }

    if (options.OutputS3BucketName) {
      params.OutputS3BucketName = options.OutputS3BucketName
    }

    if (options.OutputS3KeyPrefix) {
      params.OutputS3KeyPrefix = options.OutputS3KeyPrefix
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.SendCommand',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      CommandId: result.Command?.CommandId,
      Status: result.Command?.Status,
      StatusDetails: result.Command?.StatusDetails,
    }
  }

  /**
   * Get command invocation result
  */
  async getCommandInvocation(options: {
    CommandId: string
    InstanceId: string
  }): Promise<{
    Status?: string
    StatusDetails?: string
    StandardOutputContent?: string
    StandardErrorContent?: string
    ResponseCode?: number
  }> {
    const params = {
      CommandId: options.CommandId,
      InstanceId: options.InstanceId,
    }

    const result = await this.client.request({
      service: 'ssm',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AmazonSSM.GetCommandInvocation',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(params),
    })

    return {
      Status: result.Status,
      StatusDetails: result.StatusDetails,
      StandardOutputContent: result.StandardOutputContent,
      StandardErrorContent: result.StandardErrorContent,
      ResponseCode: result.ResponseCode,
    }
  }

  /**
   * Run a shell command on an EC2 instance and wait for result
  */
  async runShellCommand(instanceId: string, commands: string[], options?: {
    timeoutSeconds?: number
    waitForCompletion?: boolean
    pollIntervalMs?: number
    maxWaitMs?: number
  }): Promise<{
    success: boolean
    output?: string
    error?: string
    status?: string
  }> {
    const sendResult = await this.sendCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: {
        commands,
      },
      TimeoutSeconds: options?.timeoutSeconds || 600,
    })

    if (!sendResult.CommandId) {
      return { success: false, error: 'Failed to send command' }
    }

    if (options?.waitForCompletion === false) {
      return { success: true, status: 'Pending' }
    }

    // Poll for completion
    const pollInterval = options?.pollIntervalMs || 2000
    const maxWait = options?.maxWaitMs || 300000 // 5 minutes default
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval))

      try {
        const invocation = await this.getCommandInvocation({
          CommandId: sendResult.CommandId,
          InstanceId: instanceId,
        })

        if (invocation.Status === 'Success') {
          return {
            success: true,
            output: invocation.StandardOutputContent,
            error: invocation.StandardErrorContent,
            status: invocation.Status,
          }
        }

        if (invocation.Status === 'Failed' || invocation.Status === 'Cancelled' || invocation.Status === 'TimedOut') {
          return {
            success: false,
            output: invocation.StandardOutputContent,
            error: invocation.StandardErrorContent || invocation.StatusDetails,
            status: invocation.Status,
          }
        }

        // Still pending/in progress, continue polling
      }
      catch (e: any) {
        // InvocationDoesNotExist means command is still being sent
        if (!e.message?.includes('InvocationDoesNotExist')) {
          return { success: false, error: e.message }
        }
      }
    }

    return { success: false, error: 'Command timed out waiting for completion' }
  }
}
