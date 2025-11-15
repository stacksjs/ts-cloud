/**
 * AWS SQS Operations
 * Uses AWS CLI (no SDK dependencies) for SQS management
 */

export interface QueueAttributes {
  QueueUrl: string
  QueueArn?: string
  ApproximateNumberOfMessages?: string
  ApproximateNumberOfMessagesNotVisible?: string
  ApproximateNumberOfMessagesDelayed?: string
  CreatedTimestamp?: string
  LastModifiedTimestamp?: string
  VisibilityTimeout?: string
  MaximumMessageSize?: string
  MessageRetentionPeriod?: string
  DelaySeconds?: string
  ReceiveMessageWaitTimeSeconds?: string
  FifoQueue?: string
  ContentBasedDeduplication?: string
}

export interface CreateQueueOptions {
  queueName: string
  fifo?: boolean
  visibilityTimeout?: number
  messageRetentionPeriod?: number
  delaySeconds?: number
  maxMessageSize?: number
  receiveMessageWaitTime?: number
  deadLetterTargetArn?: string
  maxReceiveCount?: number
  contentBasedDeduplication?: boolean
  tags?: Record<string, string>
}

export interface Message {
  MessageId: string
  ReceiptHandle: string
  Body: string
  Attributes?: Record<string, string>
  MessageAttributes?: Record<string, any>
}

/**
 * SQS queue management using AWS CLI
 */
export class SQSClient {
  private region: string
  private profile?: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.profile = profile
  }

  /**
   * Build base AWS CLI command
   */
  private buildBaseCommand(): string[] {
    const cmd = ['aws', 'sqs']

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
   * Create a new SQS queue
   */
  async createQueue(options: CreateQueueOptions): Promise<{ QueueUrl: string }> {
    const cmd = [...this.buildBaseCommand(), 'create-queue']

    const queueName = options.fifo && !options.queueName.endsWith('.fifo')
      ? `${options.queueName}.fifo`
      : options.queueName

    cmd.push('--queue-name', queueName)

    const attributes: Record<string, string> = {}

    if (options.visibilityTimeout !== undefined) {
      attributes.VisibilityTimeout = options.visibilityTimeout.toString()
    }

    if (options.messageRetentionPeriod !== undefined) {
      attributes.MessageRetentionPeriod = options.messageRetentionPeriod.toString()
    }

    if (options.delaySeconds !== undefined) {
      attributes.DelaySeconds = options.delaySeconds.toString()
    }

    if (options.maxMessageSize !== undefined) {
      attributes.MaximumMessageSize = options.maxMessageSize.toString()
    }

    if (options.receiveMessageWaitTime !== undefined) {
      attributes.ReceiveMessageWaitTimeSeconds = options.receiveMessageWaitTime.toString()
    }

    if (options.fifo) {
      attributes.FifoQueue = 'true'

      if (options.contentBasedDeduplication) {
        attributes.ContentBasedDeduplication = 'true'
      }
    }

    if (options.deadLetterTargetArn && options.maxReceiveCount) {
      attributes.RedrivePolicy = JSON.stringify({
        deadLetterTargetArn: options.deadLetterTargetArn,
        maxReceiveCount: options.maxReceiveCount,
      })
    }

    if (Object.keys(attributes).length > 0) {
      cmd.push('--attributes', JSON.stringify(attributes))
    }

    if (options.tags && Object.keys(options.tags).length > 0) {
      cmd.push('--tags', JSON.stringify(options.tags))
    }

    return await this.executeCommand(cmd)
  }

  /**
   * List all queues
   */
  async listQueues(prefix?: string): Promise<{ QueueUrls: string[] }> {
    const cmd = [...this.buildBaseCommand(), 'list-queues']

    if (prefix) {
      cmd.push('--queue-name-prefix', prefix)
    }

    const result = await this.executeCommand(cmd)

    return {
      QueueUrls: result?.QueueUrls || [],
    }
  }

  /**
   * Get queue attributes
   */
  async getQueueAttributes(queueUrl: string): Promise<{ Attributes: Record<string, string> }> {
    const cmd = [...this.buildBaseCommand(), 'get-queue-attributes']

    cmd.push('--queue-url', queueUrl)
    cmd.push('--attribute-names', 'All')

    return await this.executeCommand(cmd)
  }

  /**
   * Get queue URL by name
   */
  async getQueueUrl(queueName: string): Promise<{ QueueUrl: string }> {
    const cmd = [...this.buildBaseCommand(), 'get-queue-url']

    cmd.push('--queue-name', queueName)

    return await this.executeCommand(cmd)
  }

  /**
   * Delete a queue
   */
  async deleteQueue(queueUrl: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'delete-queue']

    cmd.push('--queue-url', queueUrl)

    await this.executeCommand(cmd)
  }

  /**
   * Purge queue (delete all messages)
   */
  async purgeQueue(queueUrl: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'purge-queue']

    cmd.push('--queue-url', queueUrl)

    await this.executeCommand(cmd)
  }

  /**
   * Send message to queue
   */
  async sendMessage(options: {
    queueUrl: string
    messageBody: string
    delaySeconds?: number
    messageGroupId?: string
    messageDeduplicationId?: string
  }): Promise<{ MessageId: string }> {
    const cmd = [...this.buildBaseCommand(), 'send-message']

    cmd.push('--queue-url', options.queueUrl)
    cmd.push('--message-body', options.messageBody)

    if (options.delaySeconds !== undefined) {
      cmd.push('--delay-seconds', options.delaySeconds.toString())
    }

    if (options.messageGroupId) {
      cmd.push('--message-group-id', options.messageGroupId)
    }

    if (options.messageDeduplicationId) {
      cmd.push('--message-deduplication-id', options.messageDeduplicationId)
    }

    return await this.executeCommand(cmd)
  }

  /**
   * Receive messages from queue
   */
  async receiveMessages(options: {
    queueUrl: string
    maxMessages?: number
    visibilityTimeout?: number
    waitTimeSeconds?: number
  }): Promise<{ Messages: Message[] }> {
    const cmd = [...this.buildBaseCommand(), 'receive-message']

    cmd.push('--queue-url', options.queueUrl)

    if (options.maxMessages !== undefined) {
      cmd.push('--max-number-of-messages', options.maxMessages.toString())
    }

    if (options.visibilityTimeout !== undefined) {
      cmd.push('--visibility-timeout', options.visibilityTimeout.toString())
    }

    if (options.waitTimeSeconds !== undefined) {
      cmd.push('--wait-time-seconds', options.waitTimeSeconds.toString())
    }

    const result = await this.executeCommand(cmd)

    return {
      Messages: result?.Messages || [],
    }
  }

  /**
   * Delete message from queue
   */
  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const cmd = [...this.buildBaseCommand(), 'delete-message']

    cmd.push('--queue-url', queueUrl)
    cmd.push('--receipt-handle', receiptHandle)

    await this.executeCommand(cmd)
  }
}
