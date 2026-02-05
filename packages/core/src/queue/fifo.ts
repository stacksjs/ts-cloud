/**
 * SQS FIFO Queue Management
 * First-In-First-Out queues with message ordering and deduplication
 */

export interface FIFOQueue {
  id: string
  name: string
  queueUrl: string
  contentBasedDeduplication: boolean
  deduplicationScope: 'queue' | 'messageGroup'
  fifoThroughputLimit: 'perQueue' | 'perMessageGroupId'
  messageRetentionPeriod: number // seconds
  visibilityTimeout: number
  receiveMessageWaitTime: number
  deadLetterTargetArn?: string
  maxReceiveCount?: number
}

export interface MessageGroup {
  id: string
  messageGroupId: string
  queueId: string
  messagesInFlight: number
  lastMessageTimestamp?: Date
}

export interface DeduplicationConfig {
  id: string
  queueId: string
  deduplicationInterval: number // seconds (up to 5 minutes)
  contentBasedDeduplication: boolean
  deduplicationHashes: Map<string, Date>
}

export interface FIFOMessage {
  id: string
  messageId: string
  messageGroupId: string
  messageDeduplicationId?: string
  body: string
  attributes: Record<string, any>
  sentTimestamp: Date
  sequenceNumber: string
}

/**
 * FIFO queue manager
 */
export class FIFOQueueManager {
  private queues: Map<string, FIFOQueue> = new Map()
  private messageGroups: Map<string, MessageGroup> = new Map()
  private deduplicationConfigs: Map<string, DeduplicationConfig> = new Map()
  private messages: Map<string, FIFOMessage> = new Map()
  private queueCounter = 0
  private groupCounter = 0
  private deduplicationCounter = 0
  private messageCounter = 0
  private sequenceCounter = 0

  /**
   * Create FIFO queue
   */
  createFIFOQueue(queue: Omit<FIFOQueue, 'id' | 'queueUrl'>): FIFOQueue {
    const id = `fifo-queue-${Date.now()}-${this.queueCounter++}`

    // Ensure name ends with .fifo
    const queueName = queue.name.endsWith('.fifo') ? queue.name : `${queue.name}.fifo`

    const { name, ...restQueue } = queue

    const fifoQueue: FIFOQueue = {
      id,
      name: queueName,
      queueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${queueName}`,
      ...restQueue,
    }

    this.queues.set(id, fifoQueue)

    // Create deduplication config
    this.createDeduplicationConfig({
      queueId: id,
      contentBasedDeduplication: queue.contentBasedDeduplication,
      deduplicationInterval: 300, // 5 minutes
    })

    return fifoQueue
  }

  /**
   * Create high-throughput FIFO queue
   */
  createHighThroughputFIFO(options: {
    name: string
    contentBasedDeduplication?: boolean
  }): FIFOQueue {
    return this.createFIFOQueue({
      name: options.name,
      contentBasedDeduplication: options.contentBasedDeduplication ?? true,
      deduplicationScope: 'messageGroup',
      fifoThroughputLimit: 'perMessageGroupId',
      messageRetentionPeriod: 345600, // 4 days
      visibilityTimeout: 30,
      receiveMessageWaitTime: 0,
    })
  }

  /**
   * Create standard FIFO queue
   */
  createStandardFIFO(options: {
    name: string
    contentBasedDeduplication?: boolean
  }): FIFOQueue {
    return this.createFIFOQueue({
      name: options.name,
      contentBasedDeduplication: options.contentBasedDeduplication ?? false,
      deduplicationScope: 'queue',
      fifoThroughputLimit: 'perQueue',
      messageRetentionPeriod: 345600,
      visibilityTimeout: 30,
      receiveMessageWaitTime: 0,
    })
  }

  /**
   * Create deduplication config
   */
  private createDeduplicationConfig(config: {
    queueId: string
    contentBasedDeduplication: boolean
    deduplicationInterval: number
  }): DeduplicationConfig {
    const id = `dedup-${Date.now()}-${this.deduplicationCounter++}`

    const deduplicationConfig: DeduplicationConfig = {
      id,
      deduplicationHashes: new Map(),
      ...config,
    }

    this.deduplicationConfigs.set(config.queueId, deduplicationConfig)

    return deduplicationConfig
  }

  /**
   * Send message to FIFO queue
   */
  sendMessage(options: {
    queueId: string
    messageGroupId: string
    messageBody: string
    messageDeduplicationId?: string
    messageAttributes?: Record<string, any>
  }): FIFOMessage | null {
    const queue = this.queues.get(options.queueId)

    if (!queue) {
      throw new Error(`Queue not found: ${options.queueId}`)
    }

    // Check deduplication
    const deduplicationConfig = this.deduplicationConfigs.get(options.queueId)
    if (deduplicationConfig) {
      const deduplicationId = options.messageDeduplicationId ||
        (queue.contentBasedDeduplication ? this.generateHash(options.messageBody) : undefined)

      if (deduplicationId && this.isDuplicate(deduplicationConfig, deduplicationId)) {
        return null // Message deduplicated
      }

      if (deduplicationId) {
        deduplicationConfig.deduplicationHashes.set(deduplicationId, new Date())
      }
    }

    const messageId = `msg-${Date.now()}-${this.messageCounter++}`
    const sequenceNumber = this.generateSequenceNumber()

    const message: FIFOMessage = {
      id: messageId,
      messageId,
      messageGroupId: options.messageGroupId,
      messageDeduplicationId: options.messageDeduplicationId,
      body: options.messageBody,
      attributes: options.messageAttributes || {},
      sentTimestamp: new Date(),
      sequenceNumber,
    }

    this.messages.set(messageId, message)

    // Update message group
    this.updateMessageGroup(options.queueId, options.messageGroupId)

    return message
  }

  /**
   * Check if message is duplicate
   */
  private isDuplicate(config: DeduplicationConfig, deduplicationId: string): boolean {
    const existing = config.deduplicationHashes.get(deduplicationId)

    if (!existing) {
      return false
    }

    const age = (Date.now() - existing.getTime()) / 1000

    if (age > config.deduplicationInterval) {
      config.deduplicationHashes.delete(deduplicationId)
      return false
    }

    return true
  }

  /**
   * Generate message hash
   */
  private generateHash(content: string): string {
    // Simplified hash generation
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(36)
  }

  /**
   * Generate sequence number
   */
  private generateSequenceNumber(): string {
    return `${Date.now()}${this.sequenceCounter++}`.padStart(20, '0')
  }

  /**
   * Update message group
   */
  private updateMessageGroup(queueId: string, messageGroupId: string): void {
    const groupKey = `${queueId}-${messageGroupId}`
    let group = this.messageGroups.get(groupKey)

    if (!group) {
      const id = `group-${Date.now()}-${this.groupCounter++}`
      group = {
        id,
        messageGroupId,
        queueId,
        messagesInFlight: 0,
      }
      this.messageGroups.set(groupKey, group)
    }

    group.messagesInFlight++
    group.lastMessageTimestamp = new Date()
  }

  /**
   * Get message groups for queue
   */
  getMessageGroups(queueId: string): MessageGroup[] {
    return Array.from(this.messageGroups.values()).filter(g => g.queueId === queueId)
  }

  /**
   * Get queue
   */
  getQueue(id: string): FIFOQueue | undefined {
    return this.queues.get(id)
  }

  /**
   * List queues
   */
  listQueues(): FIFOQueue[] {
    return Array.from(this.queues.values())
  }

  /**
   * Get messages
   */
  getMessages(queueId: string, messageGroupId?: string): FIFOMessage[] {
    let messages = Array.from(this.messages.values())

    if (messageGroupId) {
      messages = messages.filter(m => m.messageGroupId === messageGroupId)
    }

    return messages.sort((a, b) => a.sequenceNumber.localeCompare(b.sequenceNumber))
  }

  /**
   * Generate CloudFormation for FIFO queue
   */
  generateFIFOQueueCF(queue: FIFOQueue): any {
    return {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: queue.name,
        FifoQueue: true,
        ContentBasedDeduplication: queue.contentBasedDeduplication,
        DeduplicationScope: queue.deduplicationScope,
        FifoThroughputLimit: queue.fifoThroughputLimit,
        MessageRetentionPeriod: queue.messageRetentionPeriod,
        VisibilityTimeout: queue.visibilityTimeout,
        ReceiveMessageWaitTimeSeconds: queue.receiveMessageWaitTime,
        ...(queue.deadLetterTargetArn && {
          RedrivePolicy: {
            deadLetterTargetArn: queue.deadLetterTargetArn,
            maxReceiveCount: queue.maxReceiveCount || 3,
          },
        }),
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.queues.clear()
    this.messageGroups.clear()
    this.deduplicationConfigs.clear()
    this.messages.clear()
    this.queueCounter = 0
    this.groupCounter = 0
    this.deduplicationCounter = 0
    this.messageCounter = 0
    this.sequenceCounter = 0
  }
}

/**
 * Global FIFO queue manager instance
 */
export const fifoQueueManager: FIFOQueueManager = new FIFOQueueManager()
