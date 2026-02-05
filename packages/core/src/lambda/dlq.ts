/**
 * Lambda Dead Letter Queue (DLQ)
 * Error handling and failed event management
 */

export interface DLQConfig {
  id: string
  functionName: string
  targetArn: string
  targetType: 'sqs' | 'sns'
  maxReceiveCount?: number
  retentionPeriod?: number // seconds
}

export interface DLQMessage {
  id: string
  functionName: string
  requestId: string
  timestamp: Date
  errorMessage: string
  errorType: string
  stackTrace?: string
  payload: any
  attemptCount: number
}

export interface DLQAlarm {
  id: string
  dlqConfigId: string
  alarmName: string
  threshold: number
  evaluationPeriods: number
  notificationTopicArn?: string
  enabled: boolean
}

export interface DLQReprocessing {
  id: string
  dlqConfigId: string
  messageId: string
  status: 'pending' | 'processing' | 'success' | 'failed'
  startedAt?: Date
  completedAt?: Date
  error?: string
}

/**
 * Lambda DLQ manager
 */
export class LambdaDLQManager {
  private dlqConfigs: Map<string, DLQConfig> = new Map()
  private messages: Map<string, DLQMessage> = new Map()
  private alarms: Map<string, DLQAlarm> = new Map()
  private reprocessing: Map<string, DLQReprocessing> = new Map()
  private configCounter = 0
  private messageCounter = 0
  private alarmCounter = 0
  private reprocessCounter = 0

  /**
   * Configure DLQ
   */
  configureDLQ(config: Omit<DLQConfig, 'id'>): DLQConfig {
    const id = `dlq-${Date.now()}-${this.configCounter++}`

    const dlqConfig: DLQConfig = {
      id,
      ...config,
    }

    this.dlqConfigs.set(id, dlqConfig)

    return dlqConfig
  }

  /**
   * Configure SQS DLQ
   */
  configureSQSDLQ(options: {
    functionName: string
    queueArn: string
    maxReceiveCount?: number
    retentionPeriod?: number
  }): DLQConfig {
    return this.configureDLQ({
      functionName: options.functionName,
      targetArn: options.queueArn,
      targetType: 'sqs',
      maxReceiveCount: options.maxReceiveCount || 3,
      retentionPeriod: options.retentionPeriod || 1209600, // 14 days
    })
  }

  /**
   * Configure SNS DLQ
   */
  configureSNSDLQ(options: {
    functionName: string
    topicArn: string
  }): DLQConfig {
    return this.configureDLQ({
      functionName: options.functionName,
      targetArn: options.topicArn,
      targetType: 'sns',
    })
  }

  /**
   * Configure DLQ with alarm
   */
  configureDLQWithAlarm(options: {
    functionName: string
    queueArn: string
    alarmThreshold: number
    notificationTopicArn: string
  }): DLQConfig {
    const dlq = this.configureSQSDLQ({
      functionName: options.functionName,
      queueArn: options.queueArn,
    })

    this.createDLQAlarm({
      dlqConfigId: dlq.id,
      alarmName: `${options.functionName}-dlq-alarm`,
      threshold: options.alarmThreshold,
      evaluationPeriods: 1,
      notificationTopicArn: options.notificationTopicArn,
      enabled: true,
    })

    return dlq
  }

  /**
   * Send message to DLQ
   */
  sendToDLQ(options: {
    functionName: string
    requestId: string
    errorMessage: string
    errorType: string
    stackTrace?: string
    payload: any
    attemptCount: number
  }): DLQMessage {
    const id = `message-${Date.now()}-${this.messageCounter++}`

    const message: DLQMessage = {
      id,
      timestamp: new Date(),
      ...options,
    }

    this.messages.set(id, message)

    return message
  }

  /**
   * Create DLQ alarm
   */
  createDLQAlarm(alarm: Omit<DLQAlarm, 'id'>): DLQAlarm {
    const id = `alarm-${Date.now()}-${this.alarmCounter++}`

    const dlqAlarm: DLQAlarm = {
      id,
      ...alarm,
    }

    this.alarms.set(id, dlqAlarm)

    return dlqAlarm
  }

  /**
   * Create age alarm
   */
  createAgeAlarm(options: {
    dlqConfigId: string
    maxAgeSeconds: number
    notificationTopicArn: string
  }): DLQAlarm {
    const config = this.dlqConfigs.get(options.dlqConfigId)

    if (!config) {
      throw new Error(`DLQ config not found: ${options.dlqConfigId}`)
    }

    return this.createDLQAlarm({
      dlqConfigId: options.dlqConfigId,
      alarmName: `${config.functionName}-dlq-age-alarm`,
      threshold: options.maxAgeSeconds,
      evaluationPeriods: 1,
      notificationTopicArn: options.notificationTopicArn,
      enabled: true,
    })
  }

  /**
   * Reprocess DLQ message
   */
  async reprocessMessage(messageId: string): Promise<DLQReprocessing> {
    const message = this.messages.get(messageId)

    if (!message) {
      throw new Error(`Message not found: ${messageId}`)
    }

    const config = Array.from(this.dlqConfigs.values()).find(
      c => c.functionName === message.functionName
    )

    if (!config) {
      throw new Error(`DLQ config not found for function: ${message.functionName}`)
    }

    const id = `reprocess-${Date.now()}-${this.reprocessCounter++}`

    const reprocessing: DLQReprocessing = {
      id,
      dlqConfigId: config.id,
      messageId,
      status: 'pending',
      startedAt: new Date(),
    }

    this.reprocessing.set(id, reprocessing)

    // Simulate reprocessing
    setTimeout(() => {
      reprocessing.status = 'processing'

      setTimeout(() => {
        // Randomly succeed or fail
        const success = Math.random() > 0.3

        reprocessing.status = success ? 'success' : 'failed'
        reprocessing.completedAt = new Date()

        if (!success) {
          reprocessing.error = 'Reprocessing failed - same error occurred'
        } else {
          // Remove message from DLQ if successful
          this.messages.delete(messageId)
        }
      }, 100)
    }, 50)

    return reprocessing
  }

  /**
   * Batch reprocess messages
   */
  async batchReprocess(options: {
    dlqConfigId: string
    maxMessages?: number
  }): Promise<DLQReprocessing[]> {
    const config = this.dlqConfigs.get(options.dlqConfigId)

    if (!config) {
      throw new Error(`DLQ config not found: ${options.dlqConfigId}`)
    }

    const messages = Array.from(this.messages.values())
      .filter(m => m.functionName === config.functionName)
      .slice(0, options.maxMessages || 10)

    const reprocessingPromises = messages.map(m => this.reprocessMessage(m.id))

    return Promise.all(reprocessingPromises)
  }

  /**
   * Get DLQ statistics
   */
  getDLQStats(dlqConfigId: string): {
    totalMessages: number
    oldestMessage?: Date
    newestMessage?: Date
    averageAttempts: number
    errorTypes: Record<string, number>
  } {
    const config = this.dlqConfigs.get(dlqConfigId)

    if (!config) {
      throw new Error(`DLQ config not found: ${dlqConfigId}`)
    }

    const messages = Array.from(this.messages.values()).filter(
      m => m.functionName === config.functionName
    )

    const errorTypes: Record<string, number> = {}
    let totalAttempts = 0

    for (const message of messages) {
      errorTypes[message.errorType] = (errorTypes[message.errorType] || 0) + 1
      totalAttempts += message.attemptCount
    }

    const timestamps = messages.map(m => m.timestamp)

    return {
      totalMessages: messages.length,
      oldestMessage: timestamps.length > 0 ? new Date(Math.min(...timestamps.map(t => t.getTime()))) : undefined,
      newestMessage: timestamps.length > 0 ? new Date(Math.max(...timestamps.map(t => t.getTime()))) : undefined,
      averageAttempts: messages.length > 0 ? totalAttempts / messages.length : 0,
      errorTypes,
    }
  }

  /**
   * Get DLQ config
   */
  getDLQConfig(id: string): DLQConfig | undefined {
    return this.dlqConfigs.get(id)
  }

  /**
   * List DLQ configs
   */
  listDLQConfigs(): DLQConfig[] {
    return Array.from(this.dlqConfigs.values())
  }

  /**
   * Get DLQ messages
   */
  getDLQMessages(dlqConfigId: string): DLQMessage[] {
    const config = this.dlqConfigs.get(dlqConfigId)

    if (!config) {
      return []
    }

    return Array.from(this.messages.values()).filter(
      m => m.functionName === config.functionName
    )
  }

  /**
   * Generate CloudFormation for DLQ
   */
  generateDLQCF(config: DLQConfig): any {
    return {
      DeadLetterConfig: {
        TargetArn: config.targetArn,
      },
    }
  }

  /**
   * Generate CloudFormation for SQS DLQ
   */
  generateSQSDLQCF(config: DLQConfig): any {
    return {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: `${config.functionName}-dlq`,
        MessageRetentionPeriod: config.retentionPeriod || 1209600,
        ...(config.maxReceiveCount && {
          RedrivePolicy: {
            deadLetterTargetArn: config.targetArn,
            maxReceiveCount: config.maxReceiveCount,
          },
        }),
      },
    }
  }

  /**
   * Generate CloudFormation for DLQ alarm
   */
  generateDLQAlarmCF(alarm: DLQAlarm): any {
    const config = this.dlqConfigs.get(alarm.dlqConfigId)

    if (!config) {
      throw new Error(`DLQ config not found: ${alarm.dlqConfigId}`)
    }

    return {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        AlarmName: alarm.alarmName,
        AlarmDescription: `DLQ alarm for ${config.functionName}`,
        MetricName: 'ApproximateNumberOfMessagesVisible',
        Namespace: 'AWS/SQS',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: alarm.evaluationPeriods,
        Threshold: alarm.threshold,
        ComparisonOperator: 'GreaterThanThreshold',
        Dimensions: [
          {
            Name: 'QueueName',
            Value: config.targetArn.split(':').pop(),
          },
        ],
        ...(alarm.notificationTopicArn && {
          AlarmActions: [alarm.notificationTopicArn],
        }),
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.dlqConfigs.clear()
    this.messages.clear()
    this.alarms.clear()
    this.reprocessing.clear()
    this.configCounter = 0
    this.messageCounter = 0
    this.alarmCounter = 0
    this.reprocessCounter = 0
  }
}

/**
 * Global Lambda DLQ manager instance
 */
export const lambdaDLQManager: LambdaDLQManager = new LambdaDLQManager()
