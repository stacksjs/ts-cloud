/**
 * AWS SQS Operations
 * Direct API calls without AWS CLI dependency
*/

import { AWSClient } from './client'

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
 * SQS queue management using direct API calls
*/
export class SQSClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1', profile?: string) {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a new SQS queue
  */
  async createQueue(options: CreateQueueOptions): Promise<{ QueueUrl: string }> {
    const queueName = options.fifo && !options.queueName.endsWith('.fifo')
      ? `${options.queueName}.fifo`
      : options.queueName

    const params: Record<string, any> = {
      Action: 'CreateQueue',
      QueueName: queueName,
      Version: '2012-11-05',
    }

    let attrIndex = 1

    if (options.visibilityTimeout !== undefined) {
      params[`Attribute.${attrIndex}.Name`] = 'VisibilityTimeout'
      params[`Attribute.${attrIndex}.Value`] = options.visibilityTimeout.toString()
      attrIndex++
    }

    if (options.messageRetentionPeriod !== undefined) {
      params[`Attribute.${attrIndex}.Name`] = 'MessageRetentionPeriod'
      params[`Attribute.${attrIndex}.Value`] = options.messageRetentionPeriod.toString()
      attrIndex++
    }

    if (options.delaySeconds !== undefined) {
      params[`Attribute.${attrIndex}.Name`] = 'DelaySeconds'
      params[`Attribute.${attrIndex}.Value`] = options.delaySeconds.toString()
      attrIndex++
    }

    if (options.maxMessageSize !== undefined) {
      params[`Attribute.${attrIndex}.Name`] = 'MaximumMessageSize'
      params[`Attribute.${attrIndex}.Value`] = options.maxMessageSize.toString()
      attrIndex++
    }

    if (options.receiveMessageWaitTime !== undefined) {
      params[`Attribute.${attrIndex}.Name`] = 'ReceiveMessageWaitTimeSeconds'
      params[`Attribute.${attrIndex}.Value`] = options.receiveMessageWaitTime.toString()
      attrIndex++
    }

    if (options.fifo) {
      params[`Attribute.${attrIndex}.Name`] = 'FifoQueue'
      params[`Attribute.${attrIndex}.Value`] = 'true'
      attrIndex++

      if (options.contentBasedDeduplication) {
        params[`Attribute.${attrIndex}.Name`] = 'ContentBasedDeduplication'
        params[`Attribute.${attrIndex}.Value`] = 'true'
        attrIndex++
      }
    }

    if (options.deadLetterTargetArn && options.maxReceiveCount) {
      params[`Attribute.${attrIndex}.Name`] = 'RedrivePolicy'
      params[`Attribute.${attrIndex}.Value`] = JSON.stringify({
        deadLetterTargetArn: options.deadLetterTargetArn,
        maxReceiveCount: options.maxReceiveCount,
      })
      attrIndex++
    }

    if (options.tags && Object.keys(options.tags).length > 0) {
      let tagIndex = 1
      for (const [key, value] of Object.entries(options.tags)) {
        params[`Tag.${tagIndex}.Key`] = key
        params[`Tag.${tagIndex}.Value`] = value
        tagIndex++
      }
    }

    const result = await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { QueueUrl: result.QueueUrl || result.CreateQueueResult?.QueueUrl }
  }

  /**
   * List all queues
  */
  async listQueues(prefix?: string): Promise<{ QueueUrls: string[] }> {
    const params: Record<string, any> = {
      Action: 'ListQueues',
      Version: '2012-11-05',
    }

    if (prefix) {
      params.QueueNamePrefix = prefix
    }

    const result = await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    // Parse queue URLs from response
    const queueUrls: string[] = []
    if (result.QueueUrl) {
      queueUrls.push(result.QueueUrl)
    }
    else if (result.ListQueuesResult?.QueueUrl) {
      if (Array.isArray(result.ListQueuesResult.QueueUrl)) {
        queueUrls.push(...result.ListQueuesResult.QueueUrl)
      }
      else {
        queueUrls.push(result.ListQueuesResult.QueueUrl)
      }
    }

    return { QueueUrls: queueUrls }
  }

  /**
   * Get queue attributes
  */
  async getQueueAttributes(queueUrl: string): Promise<{ Attributes: Record<string, string> }> {
    const params: Record<string, any> = {
      Action: 'GetQueueAttributes',
      QueueUrl: queueUrl,
      Version: '2012-11-05',
      'AttributeName.1': 'All',
    }

    const result = await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { Attributes: result.Attributes || result.GetQueueAttributesResult?.Attributes || {} }
  }

  /**
   * Get queue URL by name
  */
  async getQueueUrl(queueName: string): Promise<{ QueueUrl: string }> {
    const params: Record<string, any> = {
      Action: 'GetQueueUrl',
      QueueName: queueName,
      Version: '2012-11-05',
    }

    const result = await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { QueueUrl: result.QueueUrl || result.GetQueueUrlResult?.QueueUrl }
  }

  /**
   * Delete a queue
  */
  async deleteQueue(queueUrl: string): Promise<void> {
    const params: Record<string, any> = {
      Action: 'DeleteQueue',
      QueueUrl: queueUrl,
      Version: '2012-11-05',
    }

    await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * Purge queue (delete all messages)
  */
  async purgeQueue(queueUrl: string): Promise<void> {
    const params: Record<string, any> = {
      Action: 'PurgeQueue',
      QueueUrl: queueUrl,
      Version: '2012-11-05',
    }

    await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
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
    const params: Record<string, any> = {
      Action: 'SendMessage',
      QueueUrl: options.queueUrl,
      MessageBody: options.messageBody,
      Version: '2012-11-05',
    }

    if (options.delaySeconds !== undefined) {
      params.DelaySeconds = options.delaySeconds
    }

    if (options.messageGroupId) {
      params.MessageGroupId = options.messageGroupId
    }

    if (options.messageDeduplicationId) {
      params.MessageDeduplicationId = options.messageDeduplicationId
    }

    const result = await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    return { MessageId: result.MessageId || result.SendMessageResult?.MessageId }
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
    const params: Record<string, any> = {
      Action: 'ReceiveMessage',
      QueueUrl: options.queueUrl,
      Version: '2012-11-05',
    }

    if (options.maxMessages !== undefined) {
      params.MaxNumberOfMessages = options.maxMessages
    }

    if (options.visibilityTimeout !== undefined) {
      params.VisibilityTimeout = options.visibilityTimeout
    }

    if (options.waitTimeSeconds !== undefined) {
      params.WaitTimeSeconds = options.waitTimeSeconds
    }

    const result = await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })

    const messages: Message[] = []
    const msgData = result.Message || result.ReceiveMessageResult?.Message

    if (msgData) {
      if (Array.isArray(msgData)) {
        messages.push(...msgData.map((m: any) => ({
          MessageId: m.MessageId,
          ReceiptHandle: m.ReceiptHandle,
          Body: m.Body,
        })))
      }
      else {
        messages.push({
          MessageId: msgData.MessageId,
          ReceiptHandle: msgData.ReceiptHandle,
          Body: msgData.Body,
        })
      }
    }

    return { Messages: messages }
  }

  /**
   * Delete message from queue
  */
  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const params: Record<string, any> = {
      Action: 'DeleteMessage',
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
      Version: '2012-11-05',
    }

    await this.client.request({
      service: 'sqs',
      region: this.region,
      method: 'POST',
      path: '/',
      body: new URLSearchParams(params).toString(),
    })
  }
}
