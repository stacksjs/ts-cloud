import type {
  EventBridgeEcsParameters,
  EventBridgeRule,
  EventBridgeTarget,
  SQSQueue,
} from '@stacksjs/ts-cloud-aws-types'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'
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

    const ecsParameters: EventBridgeEcsParameters = {
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

    const target: EventBridgeTarget = {
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

    const target: EventBridgeTarget = {
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

    const target: EventBridgeTarget = {
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

    const eventTarget: EventBridgeTarget = {
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

  /**
   * Convert a human-readable rate string to a cron/rate expression
   * Supports formats like: "every 5 minutes", "every hour", "daily at 9am", etc.
   */
  static rateStringToExpression(rateString: string): string {
    const normalized = rateString.toLowerCase().trim()

    // Every X minutes/hours/days patterns
    const everyMatch = normalized.match(/^every\s+(\d+)\s+(minute|minutes|hour|hours|day|days)$/i)
    if (everyMatch) {
      const value = parseInt(everyMatch[1], 10)
      const unit = everyMatch[2].toLowerCase()
      const singularUnit = unit.endsWith('s') && value === 1 ? unit.slice(0, -1) : unit
      const pluralUnit = !unit.endsWith('s') && value > 1 ? `${unit}s` : unit
      return `rate(${value} ${value === 1 ? singularUnit : pluralUnit})`
    }

    // "every minute", "every hour", "every day"
    const singleMatch = normalized.match(/^every\s+(minute|hour|day)$/i)
    if (singleMatch) {
      return `rate(1 ${singleMatch[1]})`
    }

    // Time-based patterns
    const timePatterns: Record<string, string> = {
      'every minute': 'rate(1 minute)',
      'every hour': 'rate(1 hour)',
      'every day': 'rate(1 day)',
      'hourly': 'cron(0 * * * ? *)',
      'daily': 'cron(0 0 * * ? *)',
      'daily at midnight': 'cron(0 0 * * ? *)',
      'weekly': 'cron(0 0 ? * SUN *)',
      'monthly': 'cron(0 0 1 * ? *)',
      'yearly': 'cron(0 0 1 1 ? *)',
    }

    if (timePatterns[normalized]) {
      return timePatterns[normalized]
    }

    // "daily at Xam/pm" pattern
    const dailyAtMatch = normalized.match(/^daily\s+at\s+(\d{1,2})\s*(am|pm)?$/i)
    if (dailyAtMatch) {
      let hour = parseInt(dailyAtMatch[1], 10)
      const meridiem = dailyAtMatch[2]?.toLowerCase()

      if (meridiem === 'pm' && hour !== 12) {
        hour += 12
      }
      else if (meridiem === 'am' && hour === 12) {
        hour = 0
      }

      return `cron(0 ${hour} * * ? *)`
    }

    // "at HH:MM" pattern
    const atTimeMatch = normalized.match(/^at\s+(\d{1,2}):(\d{2})$/i)
    if (atTimeMatch) {
      const hour = parseInt(atTimeMatch[1], 10)
      const minute = parseInt(atTimeMatch[2], 10)
      return `cron(${minute} ${hour} * * ? *)`
    }

    // Weekday patterns
    const weekdayMap: Record<string, string> = {
      monday: 'MON',
      tuesday: 'TUE',
      wednesday: 'WED',
      thursday: 'THU',
      friday: 'FRI',
      saturday: 'SAT',
      sunday: 'SUN',
    }

    const weekdayMatch = normalized.match(/^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i)
    if (weekdayMatch) {
      const day = weekdayMap[weekdayMatch[1].toLowerCase()]
      return `cron(0 0 ? * ${day} *)`
    }

    // If nothing matched, assume it's already a cron expression
    return Queue.toCronExpression(rateString)
  }

  /**
   * Job configuration interface
   */
  static readonly JobConfig = {
    /**
     * Create job configuration with retry settings
     */
    create: (options: {
      name: string
      handler: string
      retries?: number
      backoff?: 'linear' | 'exponential' | 'fixed'
      backoffDelay?: number
      maxDelay?: number
      timeout?: number
      jitter?: boolean
    }): JobConfiguration => {
      const {
        name,
        handler,
        retries = 3,
        backoff = 'exponential',
        backoffDelay = 1000, // 1 second
        maxDelay = 30000, // 30 seconds
        timeout = 60000, // 1 minute
        jitter = true,
      } = options

      return {
        name,
        handler,
        retries,
        backoff,
        backoffDelay,
        maxDelay,
        timeout,
        jitter,
      }
    },

    /**
     * Calculate delay for a given retry attempt
     */
    calculateDelay: (
      attempt: number,
      config: Pick<JobConfiguration, 'backoff' | 'backoffDelay' | 'maxDelay' | 'jitter'>,
    ): number => {
      const { backoff, backoffDelay, maxDelay, jitter } = config
      let delay: number

      switch (backoff) {
        case 'linear':
          delay = backoffDelay * attempt
          break
        case 'exponential':
          delay = backoffDelay * 2 ** (attempt - 1)
          break
        case 'fixed':
        default:
          delay = backoffDelay
      }

      // Cap at maxDelay
      delay = Math.min(delay, maxDelay || Number.MAX_SAFE_INTEGER)

      // Add jitter if enabled (0-25% random variation)
      if (jitter) {
        const jitterAmount = delay * 0.25 * Math.random()
        delay += jitterAmount
      }

      return Math.floor(delay)
    },

    /**
     * Common job configurations
     */
    presets: {
      /**
       * Fast retry for transient failures
       */
      fastRetry: {
        retries: 5,
        backoff: 'exponential' as const,
        backoffDelay: 100,
        maxDelay: 5000,
        jitter: true,
      },

      /**
       * Standard job with moderate retries
       */
      standard: {
        retries: 3,
        backoff: 'exponential' as const,
        backoffDelay: 1000,
        maxDelay: 30000,
        jitter: true,
      },

      /**
       * Long-running job with extended timeouts
       */
      longRunning: {
        retries: 2,
        backoff: 'exponential' as const,
        backoffDelay: 5000,
        maxDelay: 60000,
        timeout: 300000, // 5 minutes
        jitter: true,
      },

      /**
       * Critical job with many retries
       */
      critical: {
        retries: 10,
        backoff: 'exponential' as const,
        backoffDelay: 500,
        maxDelay: 60000,
        jitter: true,
      },

      /**
       * No retry (fire and forget)
       */
      noRetry: {
        retries: 0,
        backoff: 'fixed' as const,
        backoffDelay: 0,
        maxDelay: 0,
        jitter: false,
      },
    },
  }

  /**
   * Create ECS container override for job execution
   */
  static createJobContainerOverride(options: {
    containerName: string
    jobClass: string
    jobData?: Record<string, unknown>
    environment?: Record<string, string>
  }): {
    name: string
    command: string[]
    environment: Array<{ name: string, value: string }>
  } {
    const { containerName, jobClass, jobData, environment = {} } = options

    const envVars: Array<{ name: string, value: string }> = [
      { name: 'JOB_CLASS', value: jobClass },
    ]

    if (jobData) {
      envVars.push({ name: 'JOB_DATA', value: JSON.stringify(jobData) })
    }

    for (const [key, value] of Object.entries(environment)) {
      envVars.push({ name: key, value })
    }

    return {
      name: containerName,
      command: ['bun', 'run', 'app/Jobs/runner.ts'],
      environment: envVars,
    }
  }

  /**
   * Generate scheduled job resources
   */
  static createScheduledJob(options: {
    slug: string
    environment: EnvironmentType
    schedule: string
    jobClass: string
    jobData?: Record<string, unknown>
    taskDefinitionArn: string
    clusterArn: string
    subnets: string[]
    securityGroups?: string[]
    roleArn: string
    containerName?: string
  }): {
    rule: EventBridgeRule
    logicalId: string
  } {
    const {
      slug,
      environment,
      schedule,
      jobClass,
      jobData,
      taskDefinitionArn,
      clusterArn,
      subnets,
      securityGroups = [],
      roleArn,
      containerName = 'app',
    } = options

    // Convert schedule string to expression
    const scheduleExpression = Queue.rateStringToExpression(schedule)

    // Create container override
    const containerOverride = Queue.createJobContainerOverride({
      containerName,
      jobClass,
      jobData,
    })

    return Queue.scheduleEcsTask(scheduleExpression, roleArn, {
      slug,
      environment,
      name: `${slug}-${jobClass.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      description: `Scheduled job: ${jobClass}`,
      taskDefinitionArn,
      clusterArn,
      subnets,
      securityGroups,
      containerOverrides: [containerOverride],
    })
  }

  /**
   * Queue presets for common use cases
   */
  static readonly QueuePresets = {
    /**
     * High-throughput queue with short visibility
     */
    highThroughput: (slug: string, environment: EnvironmentType): {
      queue: SQSQueue
      logicalId: string
    } =>
      Queue.createQueue({
        slug,
        environment,
        visibilityTimeout: 30,
        receiveMessageWaitTime: 0,
        delaySeconds: 0,
      }),

    /**
     * Long-running job queue
     */
    longRunning: (slug: string, environment: EnvironmentType): {
      queue: SQSQueue
      logicalId: string
    } =>
      Queue.createQueue({
        slug,
        environment,
        visibilityTimeout: 300, // 5 minutes
        messageRetentionPeriod: 1209600, // 14 days
      }),

    /**
     * FIFO queue for ordered processing
     */
    fifo: (slug: string, environment: EnvironmentType): {
      queue: SQSQueue
      logicalId: string
    } =>
      Queue.createQueue({
        slug,
        environment,
        fifo: true,
        contentBasedDeduplication: true,
      }),

    /**
     * Delayed queue for scheduled messages
     */
    delayed: (slug: string, environment: EnvironmentType, delaySeconds: number = 60): {
      queue: SQSQueue
      logicalId: string
    } =>
      Queue.createQueue({
        slug,
        environment,
        delaySeconds,
      }),
  }
}

/**
 * Job configuration type
 */
export interface JobConfiguration {
  name: string
  handler: string
  retries: number
  backoff: 'linear' | 'exponential' | 'fixed'
  backoffDelay: number
  maxDelay: number
  timeout: number
  jitter: boolean
}

/**
 * Discovered job definition from file scanning
 */
export interface DiscoveredJob {
  name: string
  path: string
  schedule?: string
  handler: string
  enabled: boolean
  retries?: number
  backoff?: 'linear' | 'exponential' | 'fixed'
  timeout?: number
  description?: string
}

/**
 * Discovered action definition from file scanning
 */
export interface DiscoveredAction {
  name: string
  path: string
  handler: string
  description?: string
}

/**
 * Dynamic job and action loader for Stacks framework integration
 */
export class JobLoader {
  /**
   * Discover jobs from app/Jobs directory
   * Scans *.ts files and extracts job metadata from exports
   */
  static async discoverJobs(options: {
    projectRoot: string
    jobsPath?: string
  }): Promise<DiscoveredJob[]> {
    const { projectRoot, jobsPath = 'app/Jobs' } = options
    const fullPath = `${projectRoot}/${jobsPath}`
    const jobs: DiscoveredJob[] = []

    try {
      // Use dynamic import to check if path functions exist (Node/Bun compatibility)
      const fs = await import('node:fs')
      const path = await import('node:path')

      if (!fs.existsSync(fullPath)) {
        return []
      }

      const files = fs.readdirSync(fullPath)
        .filter((f: string) => f.endsWith('.ts') && !f.startsWith('_') && f !== 'runner.ts')

      for (const file of files) {
        const filePath = path.join(fullPath, file)
        const jobName = file.replace('.ts', '')

        // Read file content to extract metadata
        const content = fs.readFileSync(filePath, 'utf-8')
        const metadata = JobLoader.parseJobMetadata(content, jobName, filePath)

        if (metadata) {
          jobs.push(metadata)
        }
      }
    }
    catch {
      // File system not available (browser context), return empty
      return []
    }

    return jobs
  }

  /**
   * Parse job metadata from file content
   * Looks for exported schedule, handle function, and config
   */
  static parseJobMetadata(
    content: string,
    name: string,
    path: string,
  ): DiscoveredJob | null {
    // Look for schedule export
    const scheduleMatch = content.match(/export\s+const\s+schedule\s*=\s*['"`]([^'"`]+)['"`]/)
      || content.match(/schedule:\s*['"`]([^'"`]+)['"`]/)

    // Look for enabled flag
    const enabledMatch = content.match(/export\s+const\s+enabled\s*=\s*(true|false)/)
      || content.match(/enabled:\s*(true|false)/)

    // Look for retries
    const retriesMatch = content.match(/export\s+const\s+retries\s*=\s*(\d+)/)
      || content.match(/retries:\s*(\d+)/)

    // Look for timeout
    const timeoutMatch = content.match(/export\s+const\s+timeout\s*=\s*(\d+)/)
      || content.match(/timeout:\s*(\d+)/)

    // Look for backoff strategy
    const backoffMatch = content.match(/export\s+const\s+backoff\s*=\s*['"`](linear|exponential|fixed)['"`]/)
      || content.match(/backoff:\s*['"`](linear|exponential|fixed)['"`]/)

    // Look for description
    const descriptionMatch = content.match(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/)
      || content.match(/description:\s*['"`]([^'"`]+)['"`]/)

    // Check if there's a handle function or default export
    const hasHandle = content.includes('export async function handle')
      || content.includes('export function handle')
      || content.includes('export default')

    if (!hasHandle) {
      return null
    }

    return {
      name,
      path,
      schedule: scheduleMatch?.[1],
      handler: `${name}.handle`,
      enabled: enabledMatch?.[1] !== 'false',
      retries: retriesMatch ? parseInt(retriesMatch[1], 10) : undefined,
      backoff: backoffMatch?.[1] as 'linear' | 'exponential' | 'fixed' | undefined,
      timeout: timeoutMatch ? parseInt(timeoutMatch[1], 10) : undefined,
      description: descriptionMatch?.[1],
    }
  }

  /**
   * Discover actions from app/Actions directory
   * Scans *.ts files and extracts action metadata
   */
  static async discoverActions(options: {
    projectRoot: string
    actionsPath?: string
  }): Promise<DiscoveredAction[]> {
    const { projectRoot, actionsPath = 'app/Actions' } = options
    const fullPath = `${projectRoot}/${actionsPath}`
    const actions: DiscoveredAction[] = []

    try {
      const fs = await import('node:fs')
      const path = await import('node:path')

      if (!fs.existsSync(fullPath)) {
        return []
      }

      const files = fs.readdirSync(fullPath)
        .filter((f: string) => f.endsWith('.ts') && !f.startsWith('_'))

      for (const file of files) {
        const filePath = path.join(fullPath, file)
        const actionName = file.replace('.ts', '')

        const content = fs.readFileSync(filePath, 'utf-8')
        const metadata = JobLoader.parseActionMetadata(content, actionName, filePath)

        if (metadata) {
          actions.push(metadata)
        }
      }
    }
    catch {
      return []
    }

    return actions
  }

  /**
   * Parse action metadata from file content
   */
  static parseActionMetadata(
    content: string,
    name: string,
    path: string,
  ): DiscoveredAction | null {
    // Check if there's a handle function or default export
    const hasHandle = content.includes('export async function handle')
      || content.includes('export function handle')
      || content.includes('export default')

    if (!hasHandle) {
      return null
    }

    // Look for description
    const descriptionMatch = content.match(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/)
      || content.match(/description:\s*['"`]([^'"`]+)['"`]/)

    return {
      name,
      path,
      handler: `${name}.handle`,
      description: descriptionMatch?.[1],
    }
  }

  /**
   * Generate scheduled job resources from discovered jobs
   */
  static generateScheduledJobResources(options: {
    slug: string
    environment: EnvironmentType
    jobs: DiscoveredJob[]
    taskDefinitionArn: string
    clusterArn: string
    subnets: string[]
    securityGroups?: string[]
    roleArn: string
    containerName?: string
  }): {
    rules: Record<string, EventBridgeRule>
    count: number
  } {
    const {
      slug,
      environment,
      jobs,
      taskDefinitionArn,
      clusterArn,
      subnets,
      securityGroups = [],
      roleArn,
      containerName = 'app',
    } = options

    const rules: Record<string, EventBridgeRule> = {}
    let count = 0

    for (const job of jobs) {
      // Skip jobs without schedules or disabled jobs
      if (!job.schedule || !job.enabled) {
        continue
      }

      const { rule, logicalId } = Queue.createScheduledJob({
        slug,
        environment,
        schedule: job.schedule,
        jobClass: job.name,
        taskDefinitionArn,
        clusterArn,
        subnets,
        securityGroups,
        roleArn,
        containerName,
      })

      rules[logicalId] = rule
      count++
    }

    return { rules, count }
  }

  /**
   * Generate a job runner script for ECS tasks
   */
  static generateJobRunnerScript(): string {
    return `#!/usr/bin/env bun
/**
 * Job Runner Script
 * This script is invoked by ECS scheduled tasks to run jobs
 * Auto-generated by ts-cloud
 */
const jobClass = process.env.JOB_CLASS
const jobDataRaw = process.env.JOB_DATA

if (!jobClass) {
  console.error('JOB_CLASS environment variable is required')
  process.exit(1)
}

async function run() {
  try {
    const jobData = jobDataRaw ? JSON.parse(jobDataRaw) : {}

    // Dynamic import of the job module
    const jobModule = await import(\`./$\{jobClass}.ts\`)

    // Check for handle function
    const handler = jobModule.handle || jobModule.default

    if (typeof handler !== 'function') {
      throw new Error(\`Job $\{jobClass\} does not export a handle function\`)
    }

    console.log(\`[Job Runner] Starting job: $\{jobClass\}\`)
    const startTime = Date.now()

    await handler(jobData)

    const duration = Date.now() - startTime
    console.log(\`[Job Runner] Job $\{jobClass\} completed in $\{duration\}ms\`)

    process.exit(0)
  } catch (error) {
    console.error(\`[Job Runner] Job $\{jobClass\} failed:\`, error)
    process.exit(1)
  }
}

run()
`
  }

  /**
   * Generate job manifest file for CI/CD deployments
   */
  static async generateJobManifest(options: {
    projectRoot: string
    jobsPath?: string
  }): Promise<{
    jobs: DiscoveredJob[]
    scheduledCount: number
    totalCount: number
  }> {
    const jobs = await JobLoader.discoverJobs(options)

    const scheduledJobs = jobs.filter(j => j.schedule && j.enabled)

    return {
      jobs,
      scheduledCount: scheduledJobs.length,
      totalCount: jobs.length,
    }
  }
}

/**
 * Stacks framework job/action integration helpers
 */
export const StacksIntegration: {
  loadJobs: typeof JobLoader.discoverJobs
  loadActions: typeof JobLoader.discoverActions
  generateScheduledJobs: typeof JobLoader.generateScheduledJobResources
  generateRunner: typeof JobLoader.generateJobRunnerScript
  paths: {
    jobs: string
    actions: string
    runner: string
  }
} = {
  /**
   * Load jobs from Stacks app/Jobs directory
   */
  loadJobs: JobLoader.discoverJobs,

  /**
   * Load actions from Stacks app/Actions directory
   */
  loadActions: JobLoader.discoverActions,

  /**
   * Generate all scheduled job resources
   */
  generateScheduledJobs: JobLoader.generateScheduledJobResources,

  /**
   * Generate job runner script
   */
  generateRunner: JobLoader.generateJobRunnerScript,

  /**
   * Default paths for Stacks framework
   */
  paths: {
    jobs: 'app/Jobs',
    actions: 'app/Actions',
    runner: 'app/Jobs/runner.ts',
  },
}
