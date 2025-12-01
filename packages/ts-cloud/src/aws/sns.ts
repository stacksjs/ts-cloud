/**
 * AWS SNS (Simple Notification Service) Operations
 * Direct API calls without AWS SDK dependency
 */

import { AWSClient } from './client'

export interface SNSTopicAttributes {
  TopicArn?: string
  DisplayName?: string
  Policy?: string
  Owner?: string
  SubscriptionsPending?: string
  SubscriptionsConfirmed?: string
  SubscriptionsDeleted?: string
  DeliveryPolicy?: string
  EffectiveDeliveryPolicy?: string
  KmsMasterKeyId?: string
}

export interface SNSSubscriptionAttributes {
  SubscriptionArn?: string
  TopicArn?: string
  Protocol?: string
  Endpoint?: string
  Owner?: string
  ConfirmationWasAuthenticated?: string
  RawMessageDelivery?: string
  FilterPolicy?: string
}

export type SNSProtocol = 'http' | 'https' | 'email' | 'email-json' | 'sms' | 'sqs' | 'application' | 'lambda'

/**
 * SNS service management using direct API calls
 */
export class SNSClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Build form-encoded body for SNS API
   */
  private buildFormBody(params: Record<string, string | undefined>): string {
    const entries = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value!)}`)
    return entries.join('&')
  }

  /**
   * Create a new SNS topic
   */
  async createTopic(params: {
    Name: string
    DisplayName?: string
    Tags?: Array<{ Key: string, Value: string }>
    Attributes?: Record<string, string>
  }): Promise<{ TopicArn?: string }> {
    const formParams: Record<string, string | undefined> = {
      Action: 'CreateTopic',
      Version: '2010-03-31',
      Name: params.Name,
    }

    if (params.DisplayName) {
      formParams['Attributes.entry.1.key'] = 'DisplayName'
      formParams['Attributes.entry.1.value'] = params.DisplayName
    }

    if (params.Tags) {
      params.Tags.forEach((tag, index) => {
        formParams[`Tags.member.${index + 1}.Key`] = tag.Key
        formParams[`Tags.member.${index + 1}.Value`] = tag.Value
      })
    }

    if (params.Attributes) {
      let attrIndex = params.DisplayName ? 2 : 1
      Object.entries(params.Attributes).forEach(([key, value]) => {
        formParams[`Attributes.entry.${attrIndex}.key`] = key
        formParams[`Attributes.entry.${attrIndex}.value`] = value
        attrIndex++
      })
    }

    const result = await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody(formParams),
    })

    return {
      TopicArn: result?.CreateTopicResponse?.CreateTopicResult?.TopicArn
        || result?.TopicArn,
    }
  }

  /**
   * Delete an SNS topic
   */
  async deleteTopic(topicArn: string): Promise<void> {
    await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody({
        Action: 'DeleteTopic',
        Version: '2010-03-31',
        TopicArn: topicArn,
      }),
    })
  }

  /**
   * List all SNS topics
   */
  async listTopics(nextToken?: string): Promise<{
    Topics?: Array<{ TopicArn?: string }>
    NextToken?: string
  }> {
    const formParams: Record<string, string | undefined> = {
      Action: 'ListTopics',
      Version: '2010-03-31',
    }

    if (nextToken) {
      formParams.NextToken = nextToken
    }

    const result = await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody(formParams),
    })

    const topics = result?.ListTopicsResponse?.ListTopicsResult?.Topics?.member
    return {
      Topics: Array.isArray(topics) ? topics : topics ? [topics] : [],
      NextToken: result?.ListTopicsResponse?.ListTopicsResult?.NextToken,
    }
  }

  /**
   * Get topic attributes
   */
  async getTopicAttributes(topicArn: string): Promise<SNSTopicAttributes> {
    const result = await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody({
        Action: 'GetTopicAttributes',
        Version: '2010-03-31',
        TopicArn: topicArn,
      }),
    })

    const attributes = result?.GetTopicAttributesResponse?.GetTopicAttributesResult?.Attributes?.entry
    const attrs: SNSTopicAttributes = { TopicArn: topicArn }

    if (Array.isArray(attributes)) {
      attributes.forEach((entry: { key: string, value: string }) => {
        (attrs as any)[entry.key] = entry.value
      })
    }

    return attrs
  }

  /**
   * Set topic attributes
   */
  async setTopicAttributes(params: {
    TopicArn: string
    AttributeName: string
    AttributeValue: string
  }): Promise<void> {
    await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody({
        Action: 'SetTopicAttributes',
        Version: '2010-03-31',
        TopicArn: params.TopicArn,
        AttributeName: params.AttributeName,
        AttributeValue: params.AttributeValue,
      }),
    })
  }

  /**
   * Subscribe to a topic
   */
  async subscribe(params: {
    TopicArn: string
    Protocol: SNSProtocol
    Endpoint: string
    Attributes?: Record<string, string>
    ReturnSubscriptionArn?: boolean
  }): Promise<{ SubscriptionArn?: string }> {
    const formParams: Record<string, string | undefined> = {
      Action: 'Subscribe',
      Version: '2010-03-31',
      TopicArn: params.TopicArn,
      Protocol: params.Protocol,
      Endpoint: params.Endpoint,
    }

    if (params.ReturnSubscriptionArn) {
      formParams.ReturnSubscriptionArn = 'true'
    }

    if (params.Attributes) {
      let attrIndex = 1
      Object.entries(params.Attributes).forEach(([key, value]) => {
        formParams[`Attributes.entry.${attrIndex}.key`] = key
        formParams[`Attributes.entry.${attrIndex}.value`] = value
        attrIndex++
      })
    }

    const result = await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody(formParams),
    })

    return {
      SubscriptionArn: result?.SubscribeResponse?.SubscribeResult?.SubscriptionArn
        || result?.SubscriptionArn,
    }
  }

  /**
   * Unsubscribe from a topic
   */
  async unsubscribe(subscriptionArn: string): Promise<void> {
    await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody({
        Action: 'Unsubscribe',
        Version: '2010-03-31',
        SubscriptionArn: subscriptionArn,
      }),
    })
  }

  /**
   * List subscriptions for a topic
   */
  async listSubscriptionsByTopic(topicArn: string, nextToken?: string): Promise<{
    Subscriptions?: SNSSubscriptionAttributes[]
    NextToken?: string
  }> {
    const formParams: Record<string, string | undefined> = {
      Action: 'ListSubscriptionsByTopic',
      Version: '2010-03-31',
      TopicArn: topicArn,
    }

    if (nextToken) {
      formParams.NextToken = nextToken
    }

    const result = await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody(formParams),
    })

    const subs = result?.ListSubscriptionsByTopicResponse?.ListSubscriptionsByTopicResult?.Subscriptions?.member
    return {
      Subscriptions: Array.isArray(subs) ? subs : subs ? [subs] : [],
      NextToken: result?.ListSubscriptionsByTopicResponse?.ListSubscriptionsByTopicResult?.NextToken,
    }
  }

  /**
   * Publish a message to a topic
   */
  async publish(params: {
    TopicArn?: string
    TargetArn?: string
    PhoneNumber?: string
    Message: string
    Subject?: string
    MessageStructure?: 'json'
    MessageAttributes?: Record<string, {
      DataType: 'String' | 'Number' | 'Binary'
      StringValue?: string
      BinaryValue?: string
    }>
  }): Promise<{ MessageId?: string }> {
    const formParams: Record<string, string | undefined> = {
      Action: 'Publish',
      Version: '2010-03-31',
      Message: params.Message,
    }

    if (params.TopicArn) formParams.TopicArn = params.TopicArn
    if (params.TargetArn) formParams.TargetArn = params.TargetArn
    if (params.PhoneNumber) formParams.PhoneNumber = params.PhoneNumber
    if (params.Subject) formParams.Subject = params.Subject
    if (params.MessageStructure) formParams.MessageStructure = params.MessageStructure

    if (params.MessageAttributes) {
      let attrIndex = 1
      Object.entries(params.MessageAttributes).forEach(([name, attr]) => {
        formParams[`MessageAttributes.entry.${attrIndex}.Name`] = name
        formParams[`MessageAttributes.entry.${attrIndex}.Value.DataType`] = attr.DataType
        if (attr.StringValue) {
          formParams[`MessageAttributes.entry.${attrIndex}.Value.StringValue`] = attr.StringValue
        }
        if (attr.BinaryValue) {
          formParams[`MessageAttributes.entry.${attrIndex}.Value.BinaryValue`] = attr.BinaryValue
        }
        attrIndex++
      })
    }

    const result = await this.client.request({
      service: 'sns',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody(formParams),
    })

    return {
      MessageId: result?.PublishResponse?.PublishResult?.MessageId
        || result?.MessageId,
    }
  }

  /**
   * Publish SMS message directly (without topic)
   */
  async publishSMS(phoneNumber: string, message: string, senderId?: string): Promise<{ MessageId?: string }> {
    const messageAttributes: Record<string, { DataType: 'String', StringValue: string }> = {}

    if (senderId) {
      messageAttributes['AWS.SNS.SMS.SenderID'] = {
        DataType: 'String',
        StringValue: senderId,
      }
    }

    return this.publish({
      PhoneNumber: phoneNumber,
      Message: message,
      MessageAttributes: Object.keys(messageAttributes).length > 0 ? messageAttributes : undefined,
    })
  }

  /**
   * Subscribe an email address to a topic
   */
  async subscribeEmail(topicArn: string, email: string): Promise<{ SubscriptionArn?: string }> {
    return this.subscribe({
      TopicArn: topicArn,
      Protocol: 'email',
      Endpoint: email,
    })
  }

  /**
   * Subscribe a Lambda function to a topic
   */
  async subscribeLambda(topicArn: string, lambdaArn: string): Promise<{ SubscriptionArn?: string }> {
    return this.subscribe({
      TopicArn: topicArn,
      Protocol: 'lambda',
      Endpoint: lambdaArn,
    })
  }

  /**
   * Subscribe an SQS queue to a topic
   */
  async subscribeSqs(topicArn: string, queueArn: string, rawMessageDelivery?: boolean): Promise<{ SubscriptionArn?: string }> {
    const attributes: Record<string, string> = {}
    if (rawMessageDelivery) {
      attributes.RawMessageDelivery = 'true'
    }

    return this.subscribe({
      TopicArn: topicArn,
      Protocol: 'sqs',
      Endpoint: queueArn,
      Attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    })
  }

  /**
   * Subscribe an HTTP/HTTPS endpoint to a topic
   */
  async subscribeHttp(topicArn: string, url: string, rawMessageDelivery?: boolean): Promise<{ SubscriptionArn?: string }> {
    const protocol: SNSProtocol = url.startsWith('https') ? 'https' : 'http'
    const attributes: Record<string, string> = {}
    if (rawMessageDelivery) {
      attributes.RawMessageDelivery = 'true'
    }

    return this.subscribe({
      TopicArn: topicArn,
      Protocol: protocol,
      Endpoint: url,
      Attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    })
  }

  /**
   * Subscribe an SMS number to a topic
   */
  async subscribeSms(topicArn: string, phoneNumber: string): Promise<{ SubscriptionArn?: string }> {
    return this.subscribe({
      TopicArn: topicArn,
      Protocol: 'sms',
      Endpoint: phoneNumber,
    })
  }

  /**
   * Check if topic exists
   */
  async topicExists(topicArn: string): Promise<boolean> {
    try {
      await this.getTopicAttributes(topicArn)
      return true
    }
    catch (error: any) {
      if (error.code === 'NotFound' || error.statusCode === 404) {
        return false
      }
      throw error
    }
  }
}
