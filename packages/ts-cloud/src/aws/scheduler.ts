/**
 * AWS EventBridge Scheduler Operations
 * Direct API calls without AWS CLI dependency
 */

import { AWSClient } from './client'

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
 * EventBridge Scheduler management using direct API calls
 */
export class SchedulerClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
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
    const params: Record<string, any> = {
      Action: 'PutRule',
      Name: options.name,
      ScheduleExpression: options.scheduleExpression,
      Version: '2015-10-07',
    }

    if (options.description) {
      params.Description = options.description
    }

    if (options.state) {
      params.State = options.state
    }
    else {
      params.State = 'ENABLED'
    }

    const result = await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.PutRule',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Name: options.name,
        ScheduleExpression: options.scheduleExpression,
        State: options.state || 'ENABLED',
        Description: options.description,
      }),
    })

    return { RuleArn: result.RuleArn }
  }

  /**
   * Add target to a rule
   */
  async putTargets(ruleName: string, targets: Target[]): Promise<void> {
    await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.PutTargets',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Rule: ruleName,
        Targets: targets,
      }),
    })
  }

  /**
   * List all rules
   */
  async listRules(namePrefix?: string): Promise<{ Rules: Rule[] }> {
    const payload: any = {}

    if (namePrefix) {
      payload.NamePrefix = namePrefix
    }

    const result = await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.ListRules',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify(payload),
    })

    return { Rules: result.Rules || [] }
  }

  /**
   * Describe a rule
   */
  async describeRule(name: string): Promise<Rule> {
    const result = await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.DescribeRule',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Name: name,
      }),
    })

    return {
      Name: result.Name,
      Arn: result.Arn,
      ScheduleExpression: result.ScheduleExpression,
      State: result.State,
      Description: result.Description,
    }
  }

  /**
   * List targets for a rule
   */
  async listTargetsByRule(ruleName: string): Promise<{ Targets: Target[] }> {
    const result = await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.ListTargetsByRule',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Rule: ruleName,
      }),
    })

    return { Targets: result.Targets || [] }
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

    await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.DeleteRule',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Name: name,
        Force: force || false,
      }),
    })
  }

  /**
   * Remove targets from a rule
   */
  async removeTargets(ruleName: string, targetIds: string[]): Promise<void> {
    await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.RemoveTargets',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Rule: ruleName,
        Ids: targetIds,
      }),
    })
  }

  /**
   * Enable a rule
   */
  async enableRule(name: string): Promise<void> {
    await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.EnableRule',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Name: name,
      }),
    })
  }

  /**
   * Disable a rule
   */
  async disableRule(name: string): Promise<void> {
    await this.client.request({
      service: 'events',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'X-Amz-Target': 'AWSEvents.DisableRule',
        'Content-Type': 'application/x-amz-json-1.1',
      },
      body: JSON.stringify({
        Name: name,
      }),
    })
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
