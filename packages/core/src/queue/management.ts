/**
 * SQS Queue Management
 * Retention policies, delay queues, and queue operations
 */

export interface QueueManagement {
  id: string
  queueUrl: string
  queueName: string
  messageRetentionPeriod: number // seconds (60 - 1209600)
  delaySeconds: number // 0-900
  maximumMessageSize: number // bytes
  receiveMessageWaitTime: number // seconds (long polling)
  purgeInProgress: boolean
}

export interface RetentionPolicy {
  id: string
  queueId: string
  retentionPeriod: number // seconds
  autoCleanup: boolean
  cleanupSchedule?: string
  archiveExpiredMessages: boolean
  archiveS3Bucket?: string
}

export interface DelayQueue {
  id: string
  queueUrl: string
  defaultDelay: number // seconds
  perMessageDelay: boolean
  maxDelay: number
}

export interface PurgeOperation {
  id: string
  queueUrl: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  messagesPurged?: number
  startedAt?: Date
  completedAt?: Date
}

export interface QueueMetrics {
  id: string
  queueUrl: string
  timestamp: Date
  approximateNumberOfMessages: number
  approximateNumberOfMessagesNotVisible: number
  approximateNumberOfMessagesDelayed: number
  oldestMessageAge?: number
}

/**
 * Queue management manager
 */
export class QueueManagementManager {
  private queues: Map<string, QueueManagement> = new Map()
  private retentionPolicies: Map<string, RetentionPolicy> = new Map()
  private delayQueues: Map<string, DelayQueue> = new Map()
  private purgeOperations: Map<string, PurgeOperation> = new Map()
  private metrics: Map<string, QueueMetrics[]> = new Map()
  private queueCounter = 0
  private retentionCounter = 0
  private delayCounter = 0
  private purgeCounter = 0
  private metricsCounter = 0

  /**
   * Create queue
   */
  createQueue(queue: Omit<QueueManagement, 'id' | 'purgeInProgress'>): QueueManagement {
    const id = `queue-${Date.now()}-${this.queueCounter++}`

    const queueManagement: QueueManagement = {
      id,
      purgeInProgress: false,
      ...queue,
    }

    this.queues.set(id, queueManagement)

    return queueManagement
  }

  /**
   * Create standard queue
   */
  createStandardQueue(options: {
    queueName: string
    messageRetentionDays?: number
  }): QueueManagement {
    return this.createQueue({
      queueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${options.queueName}`,
      queueName: options.queueName,
      messageRetentionPeriod: (options.messageRetentionDays || 4) * 24 * 60 * 60,
      delaySeconds: 0,
      maximumMessageSize: 256 * 1024, // 256 KB
      receiveMessageWaitTime: 0,
    })
  }

  /**
   * Create long polling queue
   */
  createLongPollingQueue(options: {
    queueName: string
    waitTimeSeconds?: number
  }): QueueManagement {
    return this.createQueue({
      queueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${options.queueName}`,
      queueName: options.queueName,
      messageRetentionPeriod: 345600, // 4 days
      delaySeconds: 0,
      maximumMessageSize: 256 * 1024,
      receiveMessageWaitTime: options.waitTimeSeconds || 20,
    })
  }

  /**
   * Create retention policy
   */
  createRetentionPolicy(policy: Omit<RetentionPolicy, 'id'>): RetentionPolicy {
    const id = `retention-${Date.now()}-${this.retentionCounter++}`

    const retentionPolicy: RetentionPolicy = {
      id,
      ...policy,
    }

    this.retentionPolicies.set(id, retentionPolicy)

    // Update queue retention
    const queue = this.queues.get(policy.queueId)
    if (queue) {
      queue.messageRetentionPeriod = policy.retentionPeriod
    }

    return retentionPolicy
  }

  /**
   * Create short retention policy
   */
  createShortRetentionPolicy(options: {
    queueId: string
    retentionHours: number
  }): RetentionPolicy {
    return this.createRetentionPolicy({
      queueId: options.queueId,
      retentionPeriod: options.retentionHours * 60 * 60,
      autoCleanup: true,
      archiveExpiredMessages: false,
    })
  }

  /**
   * Create archival retention policy
   */
  createArchivalRetentionPolicy(options: {
    queueId: string
    retentionDays: number
    s3Bucket: string
  }): RetentionPolicy {
    return this.createRetentionPolicy({
      queueId: options.queueId,
      retentionPeriod: options.retentionDays * 24 * 60 * 60,
      autoCleanup: true,
      cleanupSchedule: 'cron(0 0 * * ? *)', // Daily at midnight
      archiveExpiredMessages: true,
      archiveS3Bucket: options.s3Bucket,
    })
  }

  /**
   * Create delay queue
   */
  createDelayQueue(delay: Omit<DelayQueue, 'id'>): DelayQueue {
    const id = `delay-${Date.now()}-${this.delayCounter++}`

    const delayQueue: DelayQueue = {
      id,
      ...delay,
    }

    this.delayQueues.set(id, delayQueue)

    // Update queue delay
    const queue = Array.from(this.queues.values()).find(q => q.queueUrl === delay.queueUrl)
    if (queue) {
      queue.delaySeconds = delay.defaultDelay
    }

    return delayQueue
  }

  /**
   * Create scheduled delay queue
   */
  createScheduledDelayQueue(options: {
    queueUrl: string
    delayMinutes: number
  }): DelayQueue {
    return this.createDelayQueue({
      queueUrl: options.queueUrl,
      defaultDelay: options.delayMinutes * 60,
      perMessageDelay: false,
      maxDelay: 900, // 15 minutes max
    })
  }

  /**
   * Purge queue
   */
  async purgeQueue(queueId: string): Promise<PurgeOperation> {
    const queue = this.queues.get(queueId)

    if (!queue) {
      throw new Error(`Queue not found: ${queueId}`)
    }

    if (queue.purgeInProgress) {
      throw new Error('Purge already in progress for this queue')
    }

    const id = `purge-${Date.now()}-${this.purgeCounter++}`

    const purgeOp: PurgeOperation = {
      id,
      queueUrl: queue.queueUrl,
      status: 'in_progress',
      startedAt: new Date(),
    }

    this.purgeOperations.set(id, purgeOp)
    queue.purgeInProgress = true

    // Simulate purge operation
    setTimeout(() => {
      purgeOp.status = 'completed'
      purgeOp.completedAt = new Date()
      purgeOp.messagesPurged = Math.floor(Math.random() * 1000)
      queue.purgeInProgress = false
    }, 100)

    return purgeOp
  }

  /**
   * Collect queue metrics
   */
  collectQueueMetrics(queueUrl: string): QueueMetrics {
    const id = `metrics-${Date.now()}-${this.metricsCounter++}`

    const metrics: QueueMetrics = {
      id,
      queueUrl,
      timestamp: new Date(),
      approximateNumberOfMessages: Math.floor(Math.random() * 1000),
      approximateNumberOfMessagesNotVisible: Math.floor(Math.random() * 100),
      approximateNumberOfMessagesDelayed: Math.floor(Math.random() * 50),
      oldestMessageAge: Math.floor(Math.random() * 86400),
    }

    const queueMetrics = this.metrics.get(queueUrl) || []
    queueMetrics.push(metrics)
    this.metrics.set(queueUrl, queueMetrics)

    return metrics
  }

  /**
   * Get queue health
   */
  getQueueHealth(queueUrl: string): {
    status: 'healthy' | 'warning' | 'critical'
    issues: string[]
    recommendations: string[]
  } {
    const metricsHistory = this.metrics.get(queueUrl) || []

    if (metricsHistory.length === 0) {
      return {
        status: 'healthy',
        issues: [],
        recommendations: [],
      }
    }

    const latest = metricsHistory[metricsHistory.length - 1]
    const issues: string[] = []
    const recommendations: string[] = []
    let status: 'healthy' | 'warning' | 'critical' = 'healthy'

    // Check message backlog
    if (latest.approximateNumberOfMessages > 10000) {
      status = 'critical'
      issues.push('Large message backlog detected')
      recommendations.push('Increase consumer capacity')
    } else if (latest.approximateNumberOfMessages > 1000) {
      status = 'warning'
      issues.push('Growing message backlog')
      recommendations.push('Monitor consumer performance')
    }

    // Check message age
    if (latest.oldestMessageAge && latest.oldestMessageAge > 3600) {
      if (status !== 'critical') status = 'warning'
      issues.push('Old messages in queue')
      recommendations.push('Review message processing')
    }

    // Check delayed messages
    if (latest.approximateNumberOfMessagesDelayed > 100) {
      if (status !== 'critical') status = 'warning'
      issues.push('High number of delayed messages')
    }

    return {
      status,
      issues,
      recommendations,
    }
  }

  /**
   * Get queue
   */
  getQueue(id: string): QueueManagement | undefined {
    return this.queues.get(id)
  }

  /**
   * List queues
   */
  listQueues(): QueueManagement[] {
    return Array.from(this.queues.values())
  }

  /**
   * Get retention policy
   */
  getRetentionPolicy(id: string): RetentionPolicy | undefined {
    return this.retentionPolicies.get(id)
  }

  /**
   * List retention policies
   */
  listRetentionPolicies(): RetentionPolicy[] {
    return Array.from(this.retentionPolicies.values())
  }

  /**
   * Get purge operations
   */
  getPurgeOperations(queueUrl?: string): PurgeOperation[] {
    let operations = Array.from(this.purgeOperations.values())

    if (queueUrl) {
      operations = operations.filter(op => op.queueUrl === queueUrl)
    }

    return operations
  }

  /**
   * Generate CloudFormation for queue
   */
  generateQueueCF(queue: QueueManagement): any {
    return {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: queue.queueName,
        MessageRetentionPeriod: queue.messageRetentionPeriod,
        DelaySeconds: queue.delaySeconds,
        MaximumMessageSize: queue.maximumMessageSize,
        ReceiveMessageWaitTimeSeconds: queue.receiveMessageWaitTime,
      },
    }
  }

  /**
   * Generate CloudFormation for EventBridge rule for cleanup
   */
  generateCleanupRuleCF(policy: RetentionPolicy): any {
    return {
      Type: 'AWS::Events::Rule',
      Properties: {
        Name: `${policy.id}-cleanup`,
        Description: 'Automated queue cleanup',
        ScheduleExpression: policy.cleanupSchedule || 'cron(0 0 * * ? *)',
        State: 'ENABLED',
        Targets: [
          {
            Arn: 'arn:aws:lambda:us-east-1:123456789012:function:queue-cleanup',
            Id: policy.id,
            Input: JSON.stringify({
              queueId: policy.queueId,
              archiveBucket: policy.archiveS3Bucket,
            }),
          },
        ],
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.queues.clear()
    this.retentionPolicies.clear()
    this.delayQueues.clear()
    this.purgeOperations.clear()
    this.metrics.clear()
    this.queueCounter = 0
    this.retentionCounter = 0
    this.delayCounter = 0
    this.purgeCounter = 0
    this.metricsCounter = 0
  }
}

/**
 * Global queue management manager instance
 */
export const queueManagementManager = new QueueManagementManager()
