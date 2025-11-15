/**
 * AWS CloudFormation Operations
 * Uses AWS CLI (no SDK dependencies) for CloudFormation stack management
 */

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
  }>
  Tags?: StackTag[]
}

/**
 * CloudFormation stack management using AWS CLI
 */
export class CloudFormationClient {
  private region: string
  private profile?: string

  constructor(region: string, profile?: string) {
    this.region = region
    this.profile = profile
  }

  /**
   * Build base AWS CLI command
   */
  private buildBaseCommand(): string[] {
    const cmd = ['aws', 'cloudformation']

    if (this.region) {
      cmd.push('--region', this.region)
    }

    if (this.profile) {
      cmd.push('--profile', this.profile)
    }

    cmd.push('--output', 'json')

    return cmd
  }

  /**
   * Execute AWS CLI command
   */
  private async executeCommand(args: string[]): Promise<any> {
    const proc = Bun.spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    await proc.exited

    if (proc.exitCode !== 0) {
      throw new Error(`AWS CLI Error: ${stderr || stdout}`)
    }

    return stdout ? JSON.parse(stdout) : null
  }

  /**
   * Create a new CloudFormation stack
   */
  async createStack(options: CreateStackOptions): Promise<{ StackId: string }> {
    const cmd = [...this.buildBaseCommand(), 'create-stack']

    cmd.push('--stack-name', options.stackName)

    if (options.templateBody) {
      cmd.push('--template-body', options.templateBody)
    }
    else if (options.templateUrl) {
      cmd.push('--template-url', options.templateUrl)
    }
    else {
      throw new Error('Either templateBody or templateUrl must be provided')
    }

    if (options.parameters && options.parameters.length > 0) {
      cmd.push('--parameters', JSON.stringify(options.parameters))
    }

    if (options.capabilities && options.capabilities.length > 0) {
      cmd.push('--capabilities', ...options.capabilities)
    }

    if (options.roleArn) {
      cmd.push('--role-arn', options.roleArn)
    }

    if (options.tags && options.tags.length > 0) {
      cmd.push('--tags', JSON.stringify(options.tags))
    }

    if (options.timeoutInMinutes) {
      cmd.push('--timeout-in-minutes', options.timeoutInMinutes.toString())
    }

    if (options.onFailure) {
      cmd.push('--on-failure', options.onFailure)
    }

    return await this.executeCommand(cmd)
  }

  /**
   * Update an existing CloudFormation stack
   */
  async updateStack(options: UpdateStackOptions): Promise<{ StackId: string }> {
    const cmd = [...this.buildBaseCommand(), 'update-stack']

    cmd.push('--stack-name', options.stackName)

    if (options.templateBody) {
      cmd.push('--template-body', options.templateBody)
    }
    else if (options.templateUrl) {
      cmd.push('--template-url', options.templateUrl)
    }

    if (options.parameters && options.parameters.length > 0) {
      cmd.push('--parameters', JSON.stringify(options.parameters))
    }

    if (options.capabilities && options.capabilities.length > 0) {
      cmd.push('--capabilities', ...options.capabilities)
    }

    if (options.roleArn) {
      cmd.push('--role-arn', options.roleArn)
    }

    if (options.tags && options.tags.length > 0) {
      cmd.push('--tags', JSON.stringify(options.tags))
    }

    return await this.executeCommand(cmd)
  }

  /**
   * Delete a CloudFormation stack
   */
  async deleteStack(stackName: string, roleArn?: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'delete-stack']

    cmd.push('--stack-name', stackName)

    if (roleArn) {
      cmd.push('--role-arn', roleArn)
    }

    await this.executeCommand(cmd)
  }

  /**
   * Describe CloudFormation stacks
   */
  async describeStacks(options: DescribeStacksOptions = {}): Promise<{ Stacks: Stack[] }> {
    const cmd = [...this.buildBaseCommand(), 'describe-stacks']

    if (options.stackName) {
      cmd.push('--stack-name', options.stackName)
    }

    return await this.executeCommand(cmd)
  }

  /**
   * Get stack events
   */
  async describeStackEvents(stackName: string): Promise<{ StackEvents: StackEvent[] }> {
    const cmd = [...this.buildBaseCommand(), 'describe-stack-events']

    cmd.push('--stack-name', stackName)

    return await this.executeCommand(cmd)
  }

  /**
   * Wait for stack to reach a specific status
   */
  async waitForStack(stackName: string, waitType: 'stack-create-complete' | 'stack-update-complete' | 'stack-delete-complete'): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'wait', waitType]

    cmd.push('--stack-name', stackName)

    await this.executeCommand(cmd)
  }

  /**
   * Validate CloudFormation template
   */
  async validateTemplate(templateBody: string): Promise<any> {
    const cmd = [...this.buildBaseCommand(), 'validate-template']

    cmd.push('--template-body', templateBody)

    return await this.executeCommand(cmd)
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
    const cmd = [...this.buildBaseCommand(), 'list-stacks']

    if (statusFilter && statusFilter.length > 0) {
      cmd.push('--stack-status-filter', ...statusFilter)
    }

    return await this.executeCommand(cmd)
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
    const cmd = [...this.buildBaseCommand(), 'list-stack-resources']

    cmd.push('--stack-name', stackName)

    return await this.executeCommand(cmd)
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
    const cmd = [...this.buildBaseCommand(), 'create-change-set']

    cmd.push('--stack-name', options.stackName)
    cmd.push('--change-set-name', options.changeSetName)

    if (options.templateBody) {
      cmd.push('--template-body', options.templateBody)
    }
    else if (options.templateUrl) {
      cmd.push('--template-url', options.templateUrl)
    }

    if (options.parameters && options.parameters.length > 0) {
      cmd.push('--parameters', JSON.stringify(options.parameters))
    }

    if (options.capabilities && options.capabilities.length > 0) {
      cmd.push('--capabilities', ...options.capabilities)
    }

    if (options.changeSetType) {
      cmd.push('--change-set-type', options.changeSetType)
    }

    return await this.executeCommand(cmd)
  }

  /**
   * Describe change set
   */
  async describeChangeSet(stackName: string, changeSetName: string): Promise<any> {
    const cmd = [...this.buildBaseCommand(), 'describe-change-set']

    cmd.push('--stack-name', stackName)
    cmd.push('--change-set-name', changeSetName)

    return await this.executeCommand(cmd)
  }

  /**
   * Execute change set
   */
  async executeChangeSet(stackName: string, changeSetName: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'execute-change-set']

    cmd.push('--stack-name', stackName)
    cmd.push('--change-set-name', changeSetName)

    await this.executeCommand(cmd)
  }

  /**
   * Delete change set
   */
  async deleteChangeSet(stackName: string, changeSetName: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'delete-change-set']

    cmd.push('--stack-name', stackName)
    cmd.push('--change-set-name', changeSetName)

    await this.executeCommand(cmd)
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
}
