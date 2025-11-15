import type {
  EventBridgeRule,
  SQSQueue,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface QueueOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  delaySeconds?: number
  visibilityTimeout?: number
  messageRetentionPeriod?: number
  maxMessageSize?: number
  receiveMessageWaitTime?: number
  fifo?: boolean
  contentBasedDeduplication?: boolean
  encrypted?: boolean
  kmsKeyId?: string
}

export interface DeadLetterQueueOptions {
  slug: string
  environment: EnvironmentType
  maxReceiveCount?: number
}

export interface ScheduleOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  description?: string
  enabled?: boolean
}

export interface EcsScheduleOptions extends ScheduleOptions {
  taskDefinitionArn: string
  clusterArn: string
  subnets: string[]
  securityGroups?: string[]
  assignPublicIp?: boolean
  taskCount?: number
  containerOverrides?: Array<{
    name: string
    environment?: Array<{
      name: string
      value: string
    }>
    command?: string[]
  }>
}

export interface LambdaScheduleOptions extends ScheduleOptions {
  functionArn: string
  input?: Record<string, unknown>
}

export interface SqsTargetOptions extends ScheduleOptions {
  queueArn: string
  messageGroupId?: string
}

/**
 * Queue & Scheduling Module - EventBridge + SQS
 * Provides clean API for creating queues, cron jobs, and scheduled tasks
 */
export class Queue {
  /**
   * Create an SQS queue
   */
  static createQueue(options: QueueOptions): {
    queue: SQSQueue
    logicalId: string
  } {
    const {
      slug,
      environment,
      name,
      delaySeconds = 0,
      visibilityTimeout = 30,
      messageRetentionPeriod = 345600, // 4 days
      maxMessageSize = 262144, // 256 KB
      receiveMessageWaitTime = 0,
      fifo = false,
      contentBasedDeduplication = false,
      encrypted = true,
      kmsKeyId,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'queue',
    })

    const queueName = fifo ? `${resourceName}.fifo` : resourceName
    const logicalId = generateLogicalId(resourceName)

    const queue: SQSQueue = {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: queueName,
        DelaySeconds: delaySeconds,
        MaximumMessageSize: maxMessageSize,
        MessageRetentionPeriod: messageRetentionPeriod,
        ReceiveMessageWaitTimeSeconds: receiveMessageWaitTime,
        VisibilityTimeout: visibilityTimeout,
        Tags: [
          { Key: 'Name', Value: queueName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (fifo) {
      queue.Properties!.FifoQueue = true
      queue.Properties!.ContentBasedDeduplication = contentBasedDeduplication
    }

    if (encrypted) {
      if (kmsKeyId) {
        queue.Properties!.KmsMasterKeyId = kmsKeyId
      }
      else {
        queue.Properties!.SqsManagedSseEnabled = true
      }
    }

    return { queue, logicalId }
  }

  /**
   * Create a dead letter queue and attach it to a source queue
   */
  static createDeadLetterQueue(
    sourceQueueLogicalId: string,
    options: DeadLetterQueueOptions,
  ): {
      deadLetterQueue: SQSQueue
      updatedSourceQueue: SQSQueue
      deadLetterLogicalId: string
    } {
    const {
      slug,
      environment,
      maxReceiveCount = 3,
    } = options

    // Create DLQ
    const dlqResourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'dlq',
    })

    const deadLetterLogicalId = generateLogicalId(dlqResourceName)

    const deadLetterQueue: SQSQueue = {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: dlqResourceName,
        MessageRetentionPeriod: 1209600, // 14 days
        Tags: [
          { Key: 'Name', Value: dlqResourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Type', Value: 'DeadLetterQueue' },
        ],
      },
    }

    // Update source queue with redrive policy
    const updatedSourceQueue: SQSQueue = {
      Type: 'AWS::SQS::Queue',
      Properties: {
        RedrivePolicy: {
          deadLetterTargetArn: Fn.GetAtt(deadLetterLogicalId, 'Arn') as unknown as string,
          maxReceiveCount,
        },
      },
    }

    return {
      deadLetterQueue,
      updatedSourceQueue,
      deadLetterLogicalId,
    }
  }

  /**
   * Create an EventBridge rule with a cron schedule
   */
  static createSchedule(
    cronExpression: string,
    options: ScheduleOptions,
  ): {
      rule: EventBridgeRule
      logicalId: string
    } {
    const {
      slug,
      environment,
      name,
      description,
      enabled = true,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'schedule',
    })

    const logicalId = generateLogicalId(resourceName)

    const rule: EventBridgeRule = {
      Type: 'AWS::Events::Rule',
      Properties: {
        Name: resourceName,
        Description: description,
        ScheduleExpression: cronExpression,
        State: enabled ? 'ENABLED' : 'DISABLED',
        Targets: [],
      },
    }

    return { rule, logicalId }
  }

  /**
   * Schedule an ECS Fargate task with cron
   */
  static scheduleEcsTask(
    cronExpression: string,
    roleArn: string,
    options: EcsScheduleOptions,
  ): {
      rule: EventBridgeRule
      logicalId: string
    } {
    const {
      slug,
      environment,
      name,
      description,
      enabled = true,
      taskDefinitionArn,
      clusterArn,
      subnets,
      securityGroups = [],
      assignPublicIp = false,
      taskCount = 1,
      containerOverrides,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'ecs-schedule',
    })

    const logicalId = generateLogicalId(resourceName)

    const ecsParameters: EventBridgeRule['Properties']['Targets'][0]['EcsParameters'] = {
      TaskDefinitionArn: taskDefinitionArn,
      TaskCount: taskCount,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        awsvpcConfiguration: {
          Subnets: subnets,
          SecurityGroups: securityGroups,
          AssignPublicIp: assignPublicIp ? 'ENABLED' : 'DISABLED',
        },
      },
      PlatformVersion: 'LATEST',
    }

    const target: EventBridgeRule['Properties']['Targets'][0] = {
      Id: '1',
      Arn: clusterArn,
      RoleArn: roleArn,
      EcsParameters: ecsParameters,
    }

    // Add container overrides if specified
    if (containerOverrides && containerOverrides.length > 0) {
      target.Input = JSON.stringify({
        containerOverrides,
      })
    }

    const rule: EventBridgeRule = {
      Type: 'AWS::Events::Rule',
      Properties: {
        Name: resourceName,
        Description: description || `Scheduled ECS task: ${taskDefinitionArn}`,
        ScheduleExpression: cronExpression,
        State: enabled ? 'ENABLED' : 'DISABLED',
        Targets: [target],
      },
    }

    return { rule, logicalId }
  }

  /**
   * Schedule a Lambda function with cron
   */
  static scheduleLambda(
    cronExpression: string,
    options: LambdaScheduleOptions,
  ): {
      rule: EventBridgeRule
      logicalId: string
    } {
    const {
      slug,
      environment,
      name,
      description,
      enabled = true,
      functionArn,
      input,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'lambda-schedule',
    })

    const logicalId = generateLogicalId(resourceName)

    const target: EventBridgeRule['Properties']['Targets'][0] = {
      Id: '1',
      Arn: functionArn,
    }

    if (input) {
      target.Input = JSON.stringify(input)
    }

    const rule: EventBridgeRule = {
      Type: 'AWS::Events::Rule',
      Properties: {
        Name: resourceName,
        Description: description || `Scheduled Lambda: ${functionArn}`,
        ScheduleExpression: cronExpression,
        State: enabled ? 'ENABLED' : 'DISABLED',
        Targets: [target],
      },
    }

    return { rule, logicalId }
  }

  /**
   * Schedule an SQS message with cron
   */
  static scheduleSqsMessage(
    cronExpression: string,
    options: SqsTargetOptions,
  ): {
      rule: EventBridgeRule
      logicalId: string
    } {
    const {
      slug,
      environment,
      name,
      description,
      enabled = true,
      queueArn,
      messageGroupId,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'sqs-schedule',
    })

    const logicalId = generateLogicalId(resourceName)

    const target: EventBridgeRule['Properties']['Targets'][0] = {
      Id: '1',
      Arn: queueArn,
    }

    if (messageGroupId) {
      target.SqsParameters = {
        MessageGroupId: messageGroupId,
      }
    }

    const rule: EventBridgeRule = {
      Type: 'AWS::Events::Rule',
      Properties: {
        Name: resourceName,
        Description: description || `Scheduled SQS message: ${queueArn}`,
        ScheduleExpression: cronExpression,
        State: enabled ? 'ENABLED' : 'DISABLED',
        Targets: [target],
      },
    }

    return { rule, logicalId }
  }

  /**
   * Add a target to an existing EventBridge rule
   */
  static addTarget(
    rule: EventBridgeRule,
    target: {
      id: string
      arn: string
      roleArn?: string
      input?: Record<string, unknown>
    },
  ): EventBridgeRule {
    if (!rule.Properties.Targets) {
      rule.Properties.Targets = []
    }

    const eventTarget: EventBridgeRule['Properties']['Targets'][0] = {
      Id: target.id,
      Arn: target.arn,
    }

    if (target.roleArn) {
      eventTarget.RoleArn = target.roleArn
    }

    if (target.input) {
      eventTarget.Input = JSON.stringify(target.input)
    }

    rule.Properties.Targets.push(eventTarget)

    return rule
  }

  /**
   * Helper: Convert cron expression to rate expression
   * EventBridge supports both cron() and rate() expressions
   */
  static toCronExpression(expression: string): string {
    // If already in cron() or rate() format, return as-is
    if (expression.startsWith('cron(') || expression.startsWith('rate(')) {
      return expression
    }

    // Otherwise, wrap in cron()
    return `cron(${expression})`
  }

  /**
   * Helper: Create rate expression
   */
  static rateExpression(value: number, unit: 'minute' | 'minutes' | 'hour' | 'hours' | 'day' | 'days'): string {
    return `rate(${value} ${unit})`
  }

  /**
   * Common cron expressions
   */
  static readonly CronExpressions = {
    EveryMinute: 'cron(* * * * ? *)',
    Every5Minutes: 'cron(*/5 * * * ? *)',
    Every15Minutes: 'cron(*/15 * * * ? *)',
    Every30Minutes: 'cron(*/30 * * * ? *)',
    Hourly: 'cron(0 * * * ? *)',
    Daily: 'cron(0 0 * * ? *)',
    DailyAt9AM: 'cron(0 9 * * ? *)',
    DailyAtMidnight: 'cron(0 0 * * ? *)',
    Weekly: 'cron(0 0 ? * SUN *)',
    Monthly: 'cron(0 0 1 * ? *)',
  } as const

  /**
   * Common rate expressions
   */
  static readonly RateExpressions = {
    Every1Minute: 'rate(1 minute)',
    Every5Minutes: 'rate(5 minutes)',
    Every10Minutes: 'rate(10 minutes)',
    Every15Minutes: 'rate(15 minutes)',
    Every30Minutes: 'rate(30 minutes)',
    Every1Hour: 'rate(1 hour)',
    Every6Hours: 'rate(6 hours)',
    Every12Hours: 'rate(12 hours)',
    Every1Day: 'rate(1 day)',
  } as const
}
