/**
 * AWS EventBridge Scheduler Operations
 * Uses AWS CLI (no SDK dependencies) for EventBridge Scheduler management
 */

export interface Schedule {
  Name: string
  Arn?: string
  State?: 'ENABLED' | 'DISABLED'
  ScheduleExpression?: string
  Target?: {
    Arn: string
    RoleArn: string
    Input?: string
  }
  FlexibleTimeWindow?: {
    Mode: 'OFF' | 'FLEXIBLE'
    MaximumWindowInMinutes?: number
  }
  GroupName?: string
}

export interface CreateScheduleOptions {
  name: string
  scheduleExpression: string
  targetArn: string
  roleArn: string
  input?: string
  groupName?: string
  state?: 'ENABLED' | 'DISABLED'
  description?: string
  flexibleTimeWindow?: {
    mode: 'OFF' | 'FLEXIBLE'
    maxWindowMinutes?: number
  }
}

export interface Rule {
  Name: string
  Arn: string
  EventPattern?: string
  ScheduleExpression?: string
  State: 'ENABLED' | 'DISABLED'
  Description?: string
}

export interface Target {
  Id: string
  Arn: string
  RoleArn?: string
  Input?: string
  InputPath?: string
}

/**
 * EventBridge Scheduler management using AWS CLI
 */
export class SchedulerClient {
  private region: string
  private profile?: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.profile = profile
  }

  /**
   * Build base AWS CLI command
   */
  private buildBaseCommand(service: 'events' | 'scheduler' = 'events'): string[] {
    const cmd = ['aws', service]

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
   * Create a new schedule (EventBridge rule)
   */
  async createRule(options: {
    name: string
    scheduleExpression: string
    description?: string
    state?: 'ENABLED' | 'DISABLED'
  }): Promise<{ RuleArn: string }> {
    const cmd = [...this.buildBaseCommand('events'), 'put-rule']

    cmd.push('--name', options.name)
    cmd.push('--schedule-expression', options.scheduleExpression)

    if (options.description) {
      cmd.push('--description', options.description)
    }

    if (options.state) {
      cmd.push('--state', options.state)
    }

    return await this.executeCommand(cmd)
  }

  /**
   * Add target to a rule
   */
  async putTargets(ruleName: string, targets: Target[]): Promise<void> {
    const cmd = [...this.buildBaseCommand('events'), 'put-targets']

    cmd.push('--rule', ruleName)
    cmd.push('--targets', JSON.stringify(targets))

    await this.executeCommand(cmd)
  }

  /**
   * List all rules
   */
  async listRules(namePrefix?: string): Promise<{ Rules: Rule[] }> {
    const cmd = [...this.buildBaseCommand('events'), 'list-rules']

    if (namePrefix) {
      cmd.push('--name-prefix', namePrefix)
    }

    return await this.executeCommand(cmd)
  }

  /**
   * Describe a rule
   */
  async describeRule(name: string): Promise<Rule> {
    const cmd = [...this.buildBaseCommand('events'), 'describe-rule']

    cmd.push('--name', name)

    return await this.executeCommand(cmd)
  }

  /**
   * List targets for a rule
   */
  async listTargetsByRule(ruleName: string): Promise<{ Targets: Target[] }> {
    const cmd = [...this.buildBaseCommand('events'), 'list-targets-by-rule']

    cmd.push('--rule', ruleName)

    return await this.executeCommand(cmd)
  }

  /**
   * Delete a rule
   */
  async deleteRule(name: string, force?: boolean): Promise<void> {
    // First, remove all targets
    if (force) {
      try {
        const targets = await this.listTargetsByRule(name)
        if (targets.Targets && targets.Targets.length > 0) {
          await this.removeTargets(name, targets.Targets.map(t => t.Id))
        }
      }
      catch {
        // Ignore errors when removing targets
      }
    }

    const cmd = [...this.buildBaseCommand('events'), 'delete-rule']

    cmd.push('--name', name)

    if (force) {
      cmd.push('--force')
    }

    await this.executeCommand(cmd)
  }

  /**
   * Remove targets from a rule
   */
  async removeTargets(ruleName: string, targetIds: string[]): Promise<void> {
    const cmd = [...this.buildBaseCommand('events'), 'remove-targets']

    cmd.push('--rule', ruleName)
    cmd.push('--ids', ...targetIds)

    await this.executeCommand(cmd)
  }

  /**
   * Enable a rule
   */
  async enableRule(name: string): Promise<void> {
    const cmd = [...this.buildBaseCommand('events'), 'enable-rule']

    cmd.push('--name', name)

    await this.executeCommand(cmd)
  }

  /**
   * Disable a rule
   */
  async disableRule(name: string): Promise<void> {
    const cmd = [...this.buildBaseCommand('events'), 'disable-rule']

    cmd.push('--name', name)

    await this.executeCommand(cmd)
  }

  /**
   * Create a Lambda-triggered schedule
   */
  async createLambdaSchedule(options: {
    name: string
    scheduleExpression: string
    functionArn: string
    description?: string
    input?: string
  }): Promise<{ RuleArn: string }> {
    // Create the rule
    const rule = await this.createRule({
      name: options.name,
      scheduleExpression: options.scheduleExpression,
      description: options.description,
      state: 'ENABLED',
    })

    // Add Lambda as target
    await this.putTargets(options.name, [
      {
        Id: '1',
        Arn: options.functionArn,
        Input: options.input,
      },
    ])

    return rule
  }

  /**
   * Create an ECS task schedule
   */
  async createEcsSchedule(options: {
    name: string
    scheduleExpression: string
    clusterArn: string
    taskDefinitionArn: string
    roleArn: string
    subnets: string[]
    securityGroups?: string[]
    description?: string
  }): Promise<{ RuleArn: string }> {
    // Create the rule
    const rule = await this.createRule({
      name: options.name,
      scheduleExpression: options.scheduleExpression,
      description: options.description,
      state: 'ENABLED',
    })

    // Add ECS task as target
    const ecsParameters = {
      TaskDefinitionArn: options.taskDefinitionArn,
      TaskCount: 1,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        awsvpcConfiguration: {
          Subnets: options.subnets,
          SecurityGroups: options.securityGroups || [],
          AssignPublicIp: 'ENABLED',
        },
      },
    }

    await this.putTargets(options.name, [
      {
        Id: '1',
        Arn: options.clusterArn,
        RoleArn: options.roleArn,
        Input: JSON.stringify({
          containerOverrides: [],
        }),
      },
    ])

    return rule
  }
}
