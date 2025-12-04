/**
 * Unified SMS Module
 * Provides SMS sending and receiving with S3 storage for incoming messages
 *
 * Similar to the Email module, this provides:
 * - Sending SMS via SNS or Pinpoint
 * - Receiving SMS stored in S3
 * - Inbox management (list, read, delete)
 * - Two-way messaging support
 */

import { SNSClient } from './sns'
import { PinpointSmsVoiceClient } from './pinpoint-sms-voice'
import { S3Client } from './s3'
import { SchedulerClient } from './scheduler'
import { LambdaClient } from './lambda'

export interface SmsClientConfig {
  region?: string
  // S3 bucket for storing incoming SMS
  inboxBucket?: string
  inboxPrefix?: string
  // Default sender (phone number or sender ID)
  defaultSender?: string
  // Use Pinpoint (modern) or SNS (legacy) for sending
  provider?: 'pinpoint' | 'sns'
  // Lambda function ARN for scheduled SMS
  schedulerLambdaArn?: string
  // Role ARN for scheduler to invoke Lambda
  schedulerRoleArn?: string
  // S3 bucket for storing scheduled messages
  scheduledBucket?: string
  scheduledPrefix?: string
  // Delivery receipts configuration
  receiptBucket?: string
  receiptPrefix?: string
  // Track delivery status (requires receipts bucket)
  trackDelivery?: boolean
}

export interface SmsMessage {
  key: string
  from: string
  to: string
  body: string
  timestamp: Date
  messageId?: string
  originationNumber?: string
  destinationNumber?: string
  // Read/unread status
  read?: boolean
  readAt?: Date
  // Conversation threading
  conversationId?: string
  // Delivery status
  status?: 'pending' | 'sent' | 'delivered' | 'failed'
  deliveredAt?: Date
  // Raw message data
  raw?: any
}

export interface SendSmsOptions {
  to: string
  body: string
  from?: string
  // SMS type for SNS
  type?: 'Promotional' | 'Transactional'
  // Media attachments (MMS) - Pinpoint only
  mediaUrls?: string[]
  // Scheduled sending
  scheduledAt?: Date
  // Template ID (if using templates)
  templateId?: string
  // Template variables
  templateVariables?: Record<string, string>
}

export interface ScheduledSms {
  id: string
  to: string
  body: string
  from?: string
  scheduledAt: Date
  status: 'pending' | 'sent' | 'failed' | 'cancelled'
  createdAt: Date
  sentAt?: Date
  messageId?: string
  error?: string
  templateId?: string
  templateVariables?: Record<string, string>
}

export interface SmsTemplate {
  id: string
  name: string
  body: string
  description?: string
  variables?: string[]
  createdAt: Date
  updatedAt?: Date
}

export interface InboxOptions {
  prefix?: string
  maxResults?: number
  startAfter?: string
}

export interface DeliveryReceipt {
  messageId: string
  status: 'pending' | 'sent' | 'delivered' | 'failed' | 'unknown'
  timestamp: Date
  to: string
  from?: string
  errorCode?: string
  errorMessage?: string
  carrierName?: string
  // Pricing info (if available from Pinpoint)
  priceInUsd?: number
  // Message parts (for long SMS)
  messagePartCount?: number
  // Raw receipt data
  raw?: any
}

export interface DeliveryReceiptWebhookConfig {
  // SNS topic ARN to receive delivery receipts
  snsTopicArn?: string
  // S3 bucket for storing delivery receipts
  receiptBucket?: string
  receiptPrefix?: string
  // Callback URL for HTTP webhooks
  webhookUrl?: string
  // Secret for webhook signature verification
  webhookSecret?: string
}

/**
 * SMS Client with S3 inbox storage
 */
export class SmsClient {
  private config: SmsClientConfig
  private sns: SNSClient
  private pinpoint?: PinpointSmsVoiceClient
  private s3?: S3Client
  private scheduler?: SchedulerClient

  constructor(config: SmsClientConfig = {}) {
    this.config = {
      region: 'us-east-1',
      inboxPrefix: 'sms/inbox/',
      scheduledPrefix: 'sms/scheduled/',
      receiptPrefix: 'sms/receipts/',
      provider: 'sns',
      ...config,
    }

    this.sns = new SNSClient(this.config.region!)

    if (this.config.provider === 'pinpoint') {
      this.pinpoint = new PinpointSmsVoiceClient(this.config.region!)
    }

    if (this.config.inboxBucket || this.config.scheduledBucket) {
      this.s3 = new S3Client(this.config.region!)
    }

    if (this.config.schedulerLambdaArn) {
      this.scheduler = new SchedulerClient(this.config.region!)
    }
  }

  // ============================================
  // Sending SMS
  // ============================================

  /**
   * Send an SMS message (optionally scheduled)
   */
  async send(options: SendSmsOptions): Promise<{ messageId: string; scheduledId?: string }> {
    const { to, from, type, mediaUrls, scheduledAt, templateId, templateVariables } = options
    const sender = from || this.config.defaultSender

    // Resolve message body (handle templates)
    let body = options.body
    if (templateId) {
      const template = await this.getTemplate(templateId)
      if (template) {
        body = this.applyTemplate(template.body, templateVariables || {})
      }
    }

    // If scheduled, store for later sending
    if (scheduledAt && scheduledAt > new Date()) {
      const scheduledSms = await this.scheduleMessage({
        to,
        body,
        from: sender,
        scheduledAt,
        templateId,
        templateVariables,
      })
      return { messageId: '', scheduledId: scheduledSms.id }
    }

    // If MMS (has media), must use Pinpoint
    if (mediaUrls && mediaUrls.length > 0) {
      if (!this.pinpoint) {
        throw new Error('MMS requires Pinpoint provider. Set provider: "pinpoint" in config')
      }
      const result = await this.pinpoint.sendMediaMessage({
        destinationPhoneNumber: to,
        originationIdentity: sender!,
        messageBody: body,
        mediaUrls,
      })
      return { messageId: result.MessageId || '' }
    }

    // Use configured provider for SMS
    if (this.config.provider === 'pinpoint' && this.pinpoint) {
      const result = await this.pinpoint.sendSms({
        to,
        message: body,
        from: sender,
      })
      return { messageId: result.MessageId || '' }
    }

    // Default to SNS
    const result = await this.sns.publish({
      PhoneNumber: to,
      Message: body,
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: type || 'Transactional',
        },
        ...(sender && {
          'AWS.SNS.SMS.SenderID': {
            DataType: 'String',
            StringValue: sender,
          },
        }),
      },
    })

    return { messageId: result.MessageId || '' }
  }

  /**
   * Send a text message (alias for send)
   */
  async sendText(to: string, message: string, from?: string): Promise<{ messageId: string }> {
    return this.send({ to, body: message, from })
  }

  /**
   * Send an MMS with media attachments
   */
  async sendMms(
    to: string,
    message: string,
    mediaUrls: string[],
    from?: string,
  ): Promise<{ messageId: string }> {
    return this.send({ to, body: message, mediaUrls, from })
  }

  // ============================================
  // Inbox Management (S3 Storage)
  // ============================================

  /**
   * Get incoming SMS messages from S3 inbox
   */
  async getInbox(options: InboxOptions = {}): Promise<SmsMessage[]> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    const prefix = options.prefix || this.config.inboxPrefix || 'sms/inbox/'
    const objects = await this.s3.list({
      bucket: this.config.inboxBucket,
      prefix,
      maxKeys: options.maxResults || 100,
    })

    const messages: SmsMessage[] = []

    for (const obj of objects || []) {
      if (!obj.Key) continue

      try {
        const content = await this.s3.getObject(this.config.inboxBucket, obj.Key)
        const parsed = this.parseIncomingSms(content, obj.Key)
        if (parsed) {
          messages.push(parsed)
        }
      } catch (err) {
        console.error(`Failed to read SMS ${obj.Key}:`, err)
      }
    }

    // Sort by timestamp descending (newest first)
    return messages.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Get a specific SMS message by key
   */
  async getMessage(key: string): Promise<SmsMessage | null> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    try {
      const content = await this.s3.getObject(this.config.inboxBucket, key)
      return this.parseIncomingSms(content, key)
    } catch (err) {
      return null
    }
  }

  /**
   * Delete an SMS message from inbox
   */
  async deleteMessage(key: string): Promise<void> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    await this.s3.deleteObject({
      bucket: this.config.inboxBucket,
      key,
    })
  }

  /**
   * Move an SMS to a different folder (e.g., archive)
   */
  async moveMessage(key: string, destinationPrefix: string): Promise<string> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    const content = await this.s3.getObject(this.config.inboxBucket, key)
    const filename = key.split('/').pop() || `${Date.now()}.json`
    const newKey = `${destinationPrefix}${filename}`

    await this.s3.putObject({
      bucket: this.config.inboxBucket,
      key: newKey,
      body: content,
      contentType: 'application/json',
    })

    await this.s3.deleteObject({
      bucket: this.config.inboxBucket,
      key,
    })

    return newKey
  }

  /**
   * Archive an SMS message
   */
  async archiveMessage(key: string): Promise<string> {
    return this.moveMessage(key, 'sms/archive/')
  }

  /**
   * Mark a message as read
   */
  async markAsRead(key: string): Promise<void> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    const content = await this.s3.getObject(this.config.inboxBucket, key)
    const data = JSON.parse(content)
    data.read = true
    data.readAt = new Date().toISOString()

    await this.s3.putObject({
      bucket: this.config.inboxBucket,
      key,
      body: JSON.stringify(data, null, 2),
      contentType: 'application/json',
    })
  }

  /**
   * Mark a message as unread
   */
  async markAsUnread(key: string): Promise<void> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    const content = await this.s3.getObject(this.config.inboxBucket, key)
    const data = JSON.parse(content)
    data.read = false
    delete data.readAt

    await this.s3.putObject({
      bucket: this.config.inboxBucket,
      key,
      body: JSON.stringify(data, null, 2),
      contentType: 'application/json',
    })
  }

  /**
   * Get unread message count
   */
  async getUnreadCount(): Promise<number> {
    const messages = await this.getInbox({ maxResults: 1000 })
    return messages.filter(m => !m.read).length
  }

  /**
   * Batch mark messages as read
   */
  async markManyAsRead(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.markAsRead(key)))
  }

  /**
   * Batch delete messages
   */
  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.deleteMessage(key)))
  }

  /**
   * Get inbox count
   */
  async getInboxCount(): Promise<number> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    const objects = await this.s3.list({
      bucket: this.config.inboxBucket,
      prefix: this.config.inboxPrefix || 'sms/inbox/',
      maxKeys: 1000,
    })

    return objects?.length || 0
  }

  // ============================================
  // Conversation Threading
  // ============================================

  /**
   * Get conversation ID for a phone number pair
   * Normalizes phone numbers and creates a consistent ID
   */
  getConversationId(phone1: string, phone2: string): string {
    const normalized = [normalizePhoneNumber(phone1), normalizePhoneNumber(phone2)].sort()
    return `${normalized[0]}_${normalized[1]}`
  }

  /**
   * Get all messages in a conversation with a specific phone number
   */
  async getConversation(phoneNumber: string, myNumber?: string): Promise<SmsMessage[]> {
    const messages = await this.getInbox({ maxResults: 1000 })
    const normalizedTarget = normalizePhoneNumber(phoneNumber)

    return messages.filter(m => {
      const from = normalizePhoneNumber(m.from)
      const to = normalizePhoneNumber(m.to)
      return from === normalizedTarget || to === normalizedTarget
    }).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  }

  /**
   * Get unique conversations (grouped by contact)
   */
  async getConversations(): Promise<Array<{
    phoneNumber: string
    lastMessage: SmsMessage
    messageCount: number
    unreadCount: number
  }>> {
    const messages = await this.getInbox({ maxResults: 1000 })
    const conversations = new Map<string, {
      phoneNumber: string
      messages: SmsMessage[]
    }>()

    for (const msg of messages) {
      // Use the "other" phone number as the conversation key
      const otherNumber = normalizePhoneNumber(msg.from) // Incoming messages
      if (!conversations.has(otherNumber)) {
        conversations.set(otherNumber, { phoneNumber: otherNumber, messages: [] })
      }
      conversations.get(otherNumber)!.messages.push(msg)
    }

    return Array.from(conversations.values()).map(conv => ({
      phoneNumber: conv.phoneNumber,
      lastMessage: conv.messages[0], // Already sorted newest first
      messageCount: conv.messages.length,
      unreadCount: conv.messages.filter(m => !m.read).length,
    })).sort((a, b) => b.lastMessage.timestamp.getTime() - a.lastMessage.timestamp.getTime())
  }

  // ============================================
  // Two-Way Messaging Support
  // ============================================

  /**
   * Store an incoming SMS to S3
   * This is typically called from a Lambda handler that receives SNS/Pinpoint webhooks
   */
  async storeIncomingSms(message: {
    from: string
    to: string
    body: string
    messageId?: string
    timestamp?: Date
    raw?: any
  }): Promise<string> {
    if (!this.s3 || !this.config.inboxBucket) {
      throw new Error('Inbox bucket not configured')
    }

    const timestamp = message.timestamp || new Date()
    const messageId = message.messageId || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const key = `${this.config.inboxPrefix}${timestamp.toISOString().split('T')[0]}/${messageId}.json`

    const smsData = {
      from: message.from,
      to: message.to,
      body: message.body,
      messageId,
      timestamp: timestamp.toISOString(),
      raw: message.raw,
    }

    await this.s3.putObject({
      bucket: this.config.inboxBucket,
      key,
      body: JSON.stringify(smsData, null, 2),
      contentType: 'application/json',
    })

    return key
  }

  // ============================================
  // Phone Number Management
  // ============================================

  /**
   * Get phone numbers (Pinpoint only)
   */
  async getPhoneNumbers(): Promise<any[]> {
    if (!this.pinpoint) {
      throw new Error('Phone number management requires Pinpoint provider')
    }

    const result = await this.pinpoint.describePhoneNumbers({})
    return result.PhoneNumbers || []
  }

  /**
   * Enable two-way SMS on a phone number
   */
  async enableTwoWay(
    phoneNumberId: string,
    destinationArn: string,
  ): Promise<void> {
    if (!this.pinpoint) {
      throw new Error('Two-way SMS requires Pinpoint provider')
    }

    await this.pinpoint.enableTwoWaySms(phoneNumberId, destinationArn)
  }

  // ============================================
  // Opt-Out Management
  // ============================================

  /**
   * Check if a phone number is opted out
   */
  async isOptedOut(phoneNumber: string): Promise<boolean> {
    return this.sns.checkIfPhoneNumberIsOptedOut(phoneNumber)
  }

  /**
   * Get list of opted-out phone numbers
   */
  async getOptedOutNumbers(): Promise<string[]> {
    const result = await this.sns.listPhoneNumbersOptedOut()
    return result.phoneNumbers || []
  }

  /**
   * Opt a phone number back in (requires user consent)
   */
  async optIn(phoneNumber: string): Promise<void> {
    await this.sns.optInPhoneNumber(phoneNumber)
  }

  // ============================================
  // Sandbox Management (SNS)
  // ============================================

  /**
   * Check if account is in SMS sandbox
   */
  async isInSandbox(): Promise<boolean> {
    const status = await this.sns.getSMSSandboxAccountStatus()
    return status.IsInSandbox
  }

  /**
   * Add a phone number to SMS sandbox for testing
   */
  async addSandboxNumber(phoneNumber: string): Promise<void> {
    await this.sns.createSMSSandboxPhoneNumber(phoneNumber)
  }

  /**
   * Verify a sandbox phone number with OTP
   */
  async verifySandboxNumber(phoneNumber: string, otp: string): Promise<void> {
    await this.sns.verifySMSSandboxPhoneNumber(phoneNumber, otp)
  }

  /**
   * List sandbox phone numbers
   */
  async listSandboxNumbers(): Promise<Array<{ PhoneNumber: string; Status: string }>> {
    const result = await this.sns.listSMSSandboxPhoneNumbers()
    return result.phoneNumbers || []
  }

  // ============================================
  // Scheduled SMS
  // ============================================

  /**
   * Schedule an SMS message for later delivery
   */
  async scheduleMessage(options: {
    to: string
    body: string
    from?: string
    scheduledAt: Date
    templateId?: string
    templateVariables?: Record<string, string>
  }): Promise<ScheduledSms> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Scheduled bucket not configured')
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const key = `${this.config.scheduledPrefix}${id}.json`

    const scheduledSms: ScheduledSms = {
      id,
      to: options.to,
      body: options.body,
      from: options.from,
      scheduledAt: options.scheduledAt,
      status: 'pending',
      createdAt: new Date(),
      templateId: options.templateId,
      templateVariables: options.templateVariables,
    }

    await this.s3.putObject({
      bucket,
      key,
      body: JSON.stringify(scheduledSms, null, 2),
      contentType: 'application/json',
    })

    // Create EventBridge schedule if scheduler is configured
    if (this.scheduler && this.config.schedulerLambdaArn && this.config.schedulerRoleArn) {
      const scheduleExpression = `at(${options.scheduledAt.toISOString().replace(/\.\d{3}Z$/, '')})`
      await this.scheduler.createLambdaSchedule({
        name: `sms-${id}`,
        scheduleExpression,
        functionArn: this.config.schedulerLambdaArn,
        input: JSON.stringify({ scheduledSmsId: id, bucket, key }),
      })
    }

    return scheduledSms
  }

  /**
   * Get all scheduled SMS messages
   */
  async getScheduledMessages(): Promise<ScheduledSms[]> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Scheduled bucket not configured')
    }

    const objects = await this.s3.list({
      bucket,
      prefix: this.config.scheduledPrefix || 'sms/scheduled/',
      maxKeys: 1000,
    })

    const messages: ScheduledSms[] = []
    for (const obj of objects || []) {
      if (!obj.Key) continue
      try {
        const content = await this.s3.getObject(bucket, obj.Key)
        const sms = JSON.parse(content) as ScheduledSms
        sms.scheduledAt = new Date(sms.scheduledAt)
        sms.createdAt = new Date(sms.createdAt)
        if (sms.sentAt) sms.sentAt = new Date(sms.sentAt)
        messages.push(sms)
      } catch {
        // Skip invalid entries
      }
    }

    return messages.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
  }

  /**
   * Get a scheduled SMS by ID
   */
  async getScheduledMessage(id: string): Promise<ScheduledSms | null> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Scheduled bucket not configured')
    }

    const key = `${this.config.scheduledPrefix}${id}.json`
    try {
      const content = await this.s3.getObject(bucket, key)
      const sms = JSON.parse(content) as ScheduledSms
      sms.scheduledAt = new Date(sms.scheduledAt)
      sms.createdAt = new Date(sms.createdAt)
      if (sms.sentAt) sms.sentAt = new Date(sms.sentAt)
      return sms
    } catch {
      return null
    }
  }

  /**
   * Cancel a scheduled SMS
   */
  async cancelScheduledMessage(id: string): Promise<void> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Scheduled bucket not configured')
    }

    const key = `${this.config.scheduledPrefix}${id}.json`
    const sms = await this.getScheduledMessage(id)
    if (!sms) throw new Error(`Scheduled SMS ${id} not found`)

    sms.status = 'cancelled'
    await this.s3.putObject({
      bucket,
      key,
      body: JSON.stringify(sms, null, 2),
      contentType: 'application/json',
    })

    // Delete EventBridge schedule if scheduler is configured
    if (this.scheduler) {
      try {
        await this.scheduler.deleteRule(`sms-${id}`, true)
      } catch {
        // Rule may not exist
      }
    }
  }

  /**
   * Send a scheduled SMS immediately (called by Lambda handler)
   */
  async sendScheduledMessage(id: string): Promise<{ messageId: string }> {
    const sms = await this.getScheduledMessage(id)
    if (!sms) throw new Error(`Scheduled SMS ${id} not found`)
    if (sms.status !== 'pending') {
      throw new Error(`Scheduled SMS ${id} is not pending (status: ${sms.status})`)
    }

    try {
      const result = await this.send({
        to: sms.to,
        body: sms.body,
        from: sms.from,
      })

      // Update status
      const bucket = this.config.scheduledBucket || this.config.inboxBucket!
      const key = `${this.config.scheduledPrefix}${id}.json`
      sms.status = 'sent'
      sms.sentAt = new Date()
      sms.messageId = result.messageId

      await this.s3!.putObject({
        bucket,
        key,
        body: JSON.stringify(sms, null, 2),
        contentType: 'application/json',
      })

      return result
    } catch (err: any) {
      // Update with error
      const bucket = this.config.scheduledBucket || this.config.inboxBucket!
      const key = `${this.config.scheduledPrefix}${id}.json`
      sms.status = 'failed'
      sms.error = err.message

      await this.s3!.putObject({
        bucket,
        key,
        body: JSON.stringify(sms, null, 2),
        contentType: 'application/json',
      })

      throw err
    }
  }

  /**
   * Schedule SMS to send at a specific time (convenience method)
   */
  async sendAt(to: string, body: string, scheduledAt: Date, from?: string): Promise<ScheduledSms> {
    return this.scheduleMessage({ to, body, scheduledAt, from })
  }

  /**
   * Schedule SMS to send after a delay (convenience method)
   */
  async sendAfter(
    to: string,
    body: string,
    delayMinutes: number,
    from?: string,
  ): Promise<ScheduledSms> {
    const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000)
    return this.scheduleMessage({ to, body, scheduledAt, from })
  }

  // ============================================
  // SMS Templates
  // ============================================

  /**
   * Create an SMS template
   */
  async createTemplate(template: {
    name: string
    body: string
    description?: string
  }): Promise<SmsTemplate> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Templates bucket not configured')
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const key = `sms/templates/${id}.json`

    // Extract variables from template (e.g., {{name}}, {{code}})
    const variableMatches = template.body.match(/\{\{(\w+)\}\}/g) || []
    const variables = variableMatches.map(m => m.replace(/\{\{|\}\}/g, ''))

    const smsTemplate: SmsTemplate = {
      id,
      name: template.name,
      body: template.body,
      description: template.description,
      variables: [...new Set(variables)],
      createdAt: new Date(),
    }

    await this.s3.putObject({
      bucket,
      key,
      body: JSON.stringify(smsTemplate, null, 2),
      contentType: 'application/json',
    })

    return smsTemplate
  }

  /**
   * Get all SMS templates
   */
  async getTemplates(): Promise<SmsTemplate[]> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Templates bucket not configured')
    }

    const objects = await this.s3.list({
      bucket,
      prefix: 'sms/templates/',
      maxKeys: 1000,
    })

    const templates: SmsTemplate[] = []
    for (const obj of objects || []) {
      if (!obj.Key) continue
      try {
        const content = await this.s3.getObject(bucket, obj.Key)
        const template = JSON.parse(content) as SmsTemplate
        template.createdAt = new Date(template.createdAt)
        if (template.updatedAt) template.updatedAt = new Date(template.updatedAt)
        templates.push(template)
      } catch {
        // Skip invalid entries
      }
    }

    return templates.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Get a template by ID
   */
  async getTemplate(id: string): Promise<SmsTemplate | null> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      return null
    }

    const key = `sms/templates/${id}.json`
    try {
      const content = await this.s3.getObject(bucket, key)
      const template = JSON.parse(content) as SmsTemplate
      template.createdAt = new Date(template.createdAt)
      if (template.updatedAt) template.updatedAt = new Date(template.updatedAt)
      return template
    } catch {
      return null
    }
  }

  /**
   * Get a template by name
   */
  async getTemplateByName(name: string): Promise<SmsTemplate | null> {
    const templates = await this.getTemplates()
    return templates.find(t => t.name === name) || null
  }

  /**
   * Update a template
   */
  async updateTemplate(
    id: string,
    updates: { name?: string; body?: string; description?: string },
  ): Promise<SmsTemplate> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Templates bucket not configured')
    }

    const template = await this.getTemplate(id)
    if (!template) throw new Error(`Template ${id} not found`)

    if (updates.name) template.name = updates.name
    if (updates.body) {
      template.body = updates.body
      // Re-extract variables
      const variableMatches = updates.body.match(/\{\{(\w+)\}\}/g) || []
      template.variables = [...new Set(variableMatches.map(m => m.replace(/\{\{|\}\}/g, '')))]
    }
    if (updates.description !== undefined) template.description = updates.description
    template.updatedAt = new Date()

    const key = `sms/templates/${id}.json`
    await this.s3.putObject({
      bucket,
      key,
      body: JSON.stringify(template, null, 2),
      contentType: 'application/json',
    })

    return template
  }

  /**
   * Delete a template
   */
  async deleteTemplate(id: string): Promise<void> {
    const bucket = this.config.scheduledBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Templates bucket not configured')
    }

    await this.s3.deleteObject({
      bucket,
      key: `sms/templates/${id}.json`,
    })
  }

  /**
   * Send using a template
   */
  async sendTemplate(
    to: string,
    templateId: string,
    variables: Record<string, string>,
    from?: string,
  ): Promise<{ messageId: string }> {
    const template = await this.getTemplate(templateId)
    if (!template) throw new Error(`Template ${templateId} not found`)

    const body = this.applyTemplate(template.body, variables)
    return this.send({ to, body, from })
  }

  /**
   * Apply variables to a template string
   */
  private applyTemplate(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return variables[key] !== undefined ? variables[key] : match
    })
  }

  // ============================================
  // Delivery Receipts / Webhooks
  // ============================================

  /**
   * Store a delivery receipt
   * Called by the Lambda handler when a delivery status notification is received
   */
  async storeDeliveryReceipt(receipt: {
    messageId: string
    status: DeliveryReceipt['status']
    to: string
    from?: string
    errorCode?: string
    errorMessage?: string
    carrierName?: string
    priceInUsd?: number
    messagePartCount?: number
    timestamp?: Date
    raw?: any
  }): Promise<string> {
    const bucket = this.config.receiptBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Receipt bucket not configured')
    }

    const timestamp = receipt.timestamp || new Date()
    const key = `${this.config.receiptPrefix}${timestamp.toISOString().split('T')[0]}/${receipt.messageId}.json`

    const deliveryReceipt: DeliveryReceipt = {
      messageId: receipt.messageId,
      status: receipt.status,
      timestamp,
      to: receipt.to,
      from: receipt.from,
      errorCode: receipt.errorCode,
      errorMessage: receipt.errorMessage,
      carrierName: receipt.carrierName,
      priceInUsd: receipt.priceInUsd,
      messagePartCount: receipt.messagePartCount,
      raw: receipt.raw,
    }

    await this.s3.putObject({
      bucket,
      key,
      body: JSON.stringify(deliveryReceipt, null, 2),
      contentType: 'application/json',
    })

    return key
  }

  /**
   * Get delivery receipt for a message
   */
  async getDeliveryReceipt(messageId: string): Promise<DeliveryReceipt | null> {
    const bucket = this.config.receiptBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      return null
    }

    // Search for the receipt in recent days
    const today = new Date()
    for (let i = 0; i < 7; i++) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().split('T')[0]
      const key = `${this.config.receiptPrefix}${dateStr}/${messageId}.json`

      try {
        const content = await this.s3.getObject(bucket, key)
        const receipt = JSON.parse(content) as DeliveryReceipt
        receipt.timestamp = new Date(receipt.timestamp)
        return receipt
      } catch {
        // Try next day
      }
    }

    return null
  }

  /**
   * Get all delivery receipts (recent)
   */
  async getDeliveryReceipts(options: {
    maxResults?: number
    status?: DeliveryReceipt['status']
  } = {}): Promise<DeliveryReceipt[]> {
    const bucket = this.config.receiptBucket || this.config.inboxBucket
    if (!this.s3 || !bucket) {
      throw new Error('Receipt bucket not configured')
    }

    const objects = await this.s3.list({
      bucket,
      prefix: this.config.receiptPrefix,
      maxKeys: options.maxResults || 100,
    })

    const receipts: DeliveryReceipt[] = []
    for (const obj of objects || []) {
      if (!obj.Key || !obj.Key.endsWith('.json')) continue
      try {
        const content = await this.s3.getObject(bucket, obj.Key)
        const receipt = JSON.parse(content) as DeliveryReceipt
        receipt.timestamp = new Date(receipt.timestamp)

        // Filter by status if specified
        if (options.status && receipt.status !== options.status) continue

        receipts.push(receipt)
      } catch {
        // Skip invalid entries
      }
    }

    return receipts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
  }

  /**
   * Get delivery status for a message
   */
  async getDeliveryStatus(messageId: string): Promise<DeliveryReceipt['status']> {
    const receipt = await this.getDeliveryReceipt(messageId)
    return receipt?.status || 'unknown'
  }

  /**
   * Wait for delivery confirmation (polling)
   */
  async waitForDelivery(
    messageId: string,
    options: {
      timeoutMs?: number
      pollIntervalMs?: number
    } = {},
  ): Promise<DeliveryReceipt | null> {
    const timeout = options.timeoutMs || 30000 // 30 seconds default
    const pollInterval = options.pollIntervalMs || 1000 // 1 second default
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const receipt = await this.getDeliveryReceipt(messageId)
      if (receipt && (receipt.status === 'delivered' || receipt.status === 'failed')) {
        return receipt
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    return await this.getDeliveryReceipt(messageId)
  }

  /**
   * Get failed message receipts
   */
  async getFailedMessages(maxResults: number = 100): Promise<DeliveryReceipt[]> {
    return this.getDeliveryReceipts({ maxResults, status: 'failed' })
  }

  /**
   * Get delivery statistics
   */
  async getDeliveryStats(options: {
    since?: Date
    maxMessages?: number
  } = {}): Promise<{
    total: number
    delivered: number
    failed: number
    pending: number
    deliveryRate: number
    averagePriceUsd: number
  }> {
    const receipts = await this.getDeliveryReceipts({ maxResults: options.maxMessages || 1000 })

    const since = options.since || new Date(0)
    const filtered = receipts.filter(r => r.timestamp >= since)

    const delivered = filtered.filter(r => r.status === 'delivered').length
    const failed = filtered.filter(r => r.status === 'failed').length
    const pending = filtered.filter(r => r.status === 'pending' || r.status === 'sent').length

    const pricesWithValue = filtered.filter(r => r.priceInUsd !== undefined).map(r => r.priceInUsd!)
    const averagePriceUsd = pricesWithValue.length > 0
      ? pricesWithValue.reduce((a, b) => a + b, 0) / pricesWithValue.length
      : 0

    return {
      total: filtered.length,
      delivered,
      failed,
      pending,
      deliveryRate: filtered.length > 0 ? delivered / filtered.length : 0,
      averagePriceUsd,
    }
  }

  /**
   * Send SMS and track delivery
   * Combines send() with delivery tracking
   */
  async sendAndTrack(options: SendSmsOptions): Promise<{
    messageId: string
    trackDelivery: () => Promise<DeliveryReceipt | null>
    waitForDelivery: (timeoutMs?: number) => Promise<DeliveryReceipt | null>
  }> {
    const result = await this.send(options)

    return {
      messageId: result.messageId,
      trackDelivery: () => this.getDeliveryReceipt(result.messageId),
      waitForDelivery: (timeoutMs?: number) =>
        this.waitForDelivery(result.messageId, { timeoutMs }),
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Parse incoming SMS from various formats (SNS notification, Pinpoint, raw JSON)
   */
  private parseIncomingSms(content: string, key: string): SmsMessage | null {
    try {
      const data = JSON.parse(content)

      // If it's an SNS notification wrapper
      if (data.Type === 'Notification' && data.Message) {
        const innerMessage = JSON.parse(data.Message)
        return this.extractSmsFields(innerMessage, key, data.Timestamp)
      }

      // Direct SMS data format
      return this.extractSmsFields(data, key)
    } catch {
      // Not JSON, might be raw text
      return {
        key,
        from: 'unknown',
        to: 'unknown',
        body: content,
        timestamp: new Date(),
      }
    }
  }

  /**
   * Extract SMS fields from various data formats
   */
  private extractSmsFields(data: any, key: string, timestamp?: string): SmsMessage {
    return {
      key,
      from: data.from || data.originationNumber || data.OriginationNumber || data.sourceNumber || 'unknown',
      to: data.to || data.destinationNumber || data.DestinationNumber || data.destinationAddress || 'unknown',
      body: data.body || data.message || data.messageBody || data.Message || data.text || '',
      timestamp: new Date(timestamp || data.timestamp || data.Timestamp || Date.now()),
      messageId: data.messageId || data.MessageId || data.inboundMessageId,
      originationNumber: data.originationNumber || data.OriginationNumber,
      destinationNumber: data.destinationNumber || data.DestinationNumber,
      raw: data,
    }
  }
}

// ============================================
// Lambda Handler for Incoming SMS
// ============================================

/**
 * Create a Lambda handler for processing incoming SMS from SNS
 * Use this with an SNS topic that receives two-way SMS messages
 *
 * @example
 * ```typescript
 * // lambda.ts
 * import { createSmsInboxHandler } from 'ts-cloud/aws/sms'
 *
 * export const handler = createSmsInboxHandler({
 *   bucket: 'my-sms-bucket',
 *   prefix: 'sms/inbox/',
 *   region: 'us-east-1',
 * })
 * ```
 */
export function createSmsInboxHandler(config: {
  bucket: string
  prefix?: string
  region?: string
  onMessage?: (message: SmsMessage) => Promise<void>
}) {
  const smsClient = new SmsClient({
    region: config.region || 'us-east-1',
    inboxBucket: config.bucket,
    inboxPrefix: config.prefix || 'sms/inbox/',
  })

  return async (event: any): Promise<any> => {
    console.log('Incoming SMS event:', JSON.stringify(event))

    // Handle SNS event (from two-way SMS)
    if (event.Records) {
      for (const record of event.Records) {
        if (record.Sns) {
          const snsMessage = record.Sns
          let messageData: any

          try {
            messageData = JSON.parse(snsMessage.Message)
          } catch {
            messageData = { body: snsMessage.Message }
          }

          const message = {
            from: messageData.originationNumber || messageData.from || 'unknown',
            to: messageData.destinationNumber || messageData.to || 'unknown',
            body: messageData.messageBody || messageData.body || messageData.message || '',
            messageId: messageData.inboundMessageId || snsMessage.MessageId,
            timestamp: new Date(snsMessage.Timestamp),
            raw: messageData,
          }

          // Store in S3
          const key = await smsClient.storeIncomingSms(message)
          console.log(`Stored incoming SMS: ${key}`)

          // Call optional callback
          if (config.onMessage) {
            const storedMessage = await smsClient.getMessage(key)
            if (storedMessage) {
              await config.onMessage(storedMessage)
            }
          }
        }
      }
    }

    // Handle direct Pinpoint event
    if (event.originationNumber && event.messageBody) {
      const message = {
        from: event.originationNumber,
        to: event.destinationNumber,
        body: event.messageBody,
        messageId: event.inboundMessageId,
        timestamp: new Date(),
        raw: event,
      }

      const key = await smsClient.storeIncomingSms(message)
      console.log(`Stored incoming SMS: ${key}`)

      if (config.onMessage) {
        const storedMessage = await smsClient.getMessage(key)
        if (storedMessage) {
          await config.onMessage(storedMessage)
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'SMS processed' }),
    }
  }
}

/**
 * Create a Lambda handler for sending scheduled SMS messages
 * This is invoked by EventBridge Scheduler at the scheduled time
 *
 * @example
 * ```typescript
 * // lambda.ts
 * import { createScheduledSmsHandler } from 'ts-cloud/aws/sms'
 *
 * export const handler = createScheduledSmsHandler({
 *   bucket: 'my-sms-bucket',
 *   region: 'us-east-1',
 * })
 * ```
 */
export function createScheduledSmsHandler(config: {
  bucket: string
  scheduledPrefix?: string
  region?: string
  onSent?: (sms: ScheduledSms) => Promise<void>
  onError?: (sms: ScheduledSms, error: Error) => Promise<void>
}) {
  const smsClient = new SmsClient({
    region: config.region || 'us-east-1',
    scheduledBucket: config.bucket,
    scheduledPrefix: config.scheduledPrefix || 'sms/scheduled/',
  })

  return async (event: any): Promise<any> => {
    console.log('Scheduled SMS event:', JSON.stringify(event))

    const { scheduledSmsId } = event

    if (!scheduledSmsId) {
      console.error('Missing scheduledSmsId in event')
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing scheduledSmsId' }),
      }
    }

    try {
      const result = await smsClient.sendScheduledMessage(scheduledSmsId)
      console.log(`Sent scheduled SMS ${scheduledSmsId}: ${result.messageId}`)

      if (config.onSent) {
        const sms = await smsClient.getScheduledMessage(scheduledSmsId)
        if (sms) await config.onSent(sms)
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ messageId: result.messageId }),
      }
    } catch (err: any) {
      console.error(`Failed to send scheduled SMS ${scheduledSmsId}:`, err.message)

      if (config.onError) {
        const sms = await smsClient.getScheduledMessage(scheduledSmsId)
        if (sms) await config.onError(sms, err)
      }

      return {
        statusCode: 500,
        body: JSON.stringify({ error: err.message }),
      }
    }
  }
}

/**
 * Convenience function to create an SMS client
 */
export function createSmsClient(config?: SmsClientConfig): SmsClient {
  return new SmsClient(config)
}

/**
 * Create a Lambda handler for processing SMS delivery receipts
 * This handles SNS notifications from Pinpoint/SNS delivery status events
 *
 * @example
 * ```typescript
 * // lambda.ts
 * import { createDeliveryReceiptHandler } from 'ts-cloud/aws/sms'
 *
 * export const handler = createDeliveryReceiptHandler({
 *   bucket: 'my-sms-bucket',
 *   region: 'us-east-1',
 *   onDelivered: async (receipt) => {
 *     console.log(`SMS ${receipt.messageId} delivered to ${receipt.to}`)
 *   },
 *   onFailed: async (receipt) => {
 *     console.error(`SMS ${receipt.messageId} failed: ${receipt.errorMessage}`)
 *   },
 * })
 * ```
 */
export function createDeliveryReceiptHandler(config: {
  bucket: string
  receiptPrefix?: string
  region?: string
  onDelivered?: (receipt: DeliveryReceipt) => Promise<void>
  onFailed?: (receipt: DeliveryReceipt) => Promise<void>
  onReceipt?: (receipt: DeliveryReceipt) => Promise<void>
  // Optional: webhook URL to forward receipts to
  webhookUrl?: string
  webhookSecret?: string
}) {
  const smsClient = new SmsClient({
    region: config.region || 'us-east-1',
    receiptBucket: config.bucket,
    receiptPrefix: config.receiptPrefix || 'sms/receipts/',
  })

  return async (event: any): Promise<any> => {
    console.log('Delivery receipt event:', JSON.stringify(event))

    const receipts: DeliveryReceipt[] = []

    // Handle SNS events (delivery status from Pinpoint/SNS)
    if (event.Records) {
      for (const record of event.Records) {
        if (record.Sns) {
          const snsMessage = record.Sns
          let data: any

          try {
            data = JSON.parse(snsMessage.Message)
          } catch {
            data = snsMessage.Message
          }

          // Parse different delivery status formats
          const receipt = parseDeliveryStatus(data, snsMessage)
          if (receipt) {
            receipts.push(receipt)
          }
        }
      }
    }

    // Handle direct CloudWatch Events from Pinpoint
    if (event.detail?.eventType) {
      const receipt = parsePinpointEvent(event)
      if (receipt) {
        receipts.push(receipt)
      }
    }

    // Handle direct SNS SMS delivery status
    if (event.notification?.messageId) {
      const receipt = parseSnsDeliveryStatus(event)
      if (receipt) {
        receipts.push(receipt)
      }
    }

    // Process all receipts
    for (const receipt of receipts) {
      // Store in S3
      await smsClient.storeDeliveryReceipt(receipt)
      console.log(`Stored delivery receipt: ${receipt.messageId} - ${receipt.status}`)

      // Call callbacks
      if (config.onReceipt) {
        await config.onReceipt(receipt)
      }

      if (receipt.status === 'delivered' && config.onDelivered) {
        await config.onDelivered(receipt)
      }

      if (receipt.status === 'failed' && config.onFailed) {
        await config.onFailed(receipt)
      }

      // Forward to webhook if configured
      if (config.webhookUrl) {
        await forwardToWebhook(config.webhookUrl, receipt, config.webhookSecret)
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ processed: receipts.length }),
    }
  }
}

/**
 * Parse delivery status from various event formats
 */
function parseDeliveryStatus(data: any, snsMessage: any): DeliveryReceipt | null {
  // Pinpoint SMS event format
  if (data.eventType === 'TEXT_DELIVERED' || data.eventType === 'TEXT_SENT' || data.eventType === '_SMS.SUCCESS' || data.eventType === '_SMS.FAILURE') {
    return {
      messageId: data.attributes?.message_id || data.client_context?.custom?.message_id || snsMessage.MessageId,
      status: data.eventType.includes('DELIVERED') || data.eventType.includes('SUCCESS') ? 'delivered' : 'failed',
      timestamp: new Date(data.event_timestamp || snsMessage.Timestamp),
      to: data.attributes?.destination_phone_number || data.endpoint?.address || '',
      from: data.attributes?.origination_phone_number || '',
      errorCode: data.attributes?.record_status,
      errorMessage: data.attributes?.status_message,
      carrierName: data.attributes?.carrier_name,
      priceInUsd: data.metrics?.price_in_millicents_usd ? data.metrics.price_in_millicents_usd / 100000 : undefined,
      messagePartCount: data.attributes?.number_of_message_parts,
      raw: data,
    }
  }

  // SNS SMS delivery status format
  if (data.status !== undefined && data.PhoneNumber) {
    const status = data.status === 'SUCCESS' ? 'delivered'
      : data.status === 'FAILURE' ? 'failed'
        : data.status === 'PENDING' ? 'pending'
          : 'unknown'

    return {
      messageId: data.messageId || snsMessage.MessageId,
      status,
      timestamp: new Date(data.timestamp || snsMessage.Timestamp),
      to: data.PhoneNumber || data.destination || '',
      from: data.SenderId,
      errorCode: data.providerResponse?.statusCode,
      errorMessage: data.providerResponse?.statusMessage || data.providerResponse?.errorMessage,
      carrierName: data.providerResponse?.carrierName,
      priceInUsd: data.priceInUSD,
      messagePartCount: data.numberOfMessageParts,
      raw: data,
    }
  }

  // Generic delivery notification
  if (data.messageId) {
    return {
      messageId: data.messageId,
      status: normalizeStatus(data.status || data.deliveryStatus || 'unknown'),
      timestamp: new Date(data.timestamp || snsMessage?.Timestamp || Date.now()),
      to: data.to || data.destination || data.phoneNumber || '',
      from: data.from || data.source,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage || data.error,
      raw: data,
    }
  }

  return null
}

/**
 * Parse Pinpoint CloudWatch event
 */
function parsePinpointEvent(event: any): DeliveryReceipt | null {
  const detail = event.detail

  if (!detail) return null

  const eventType = detail.eventType || detail.event_type
  let status: DeliveryReceipt['status'] = 'unknown'

  if (eventType?.includes('DELIVERED') || eventType?.includes('SUCCESS')) {
    status = 'delivered'
  } else if (eventType?.includes('FAILURE') || eventType?.includes('FAILED')) {
    status = 'failed'
  } else if (eventType?.includes('SENT')) {
    status = 'sent'
  }

  return {
    messageId: detail.attributes?.message_id || detail.messageId || event.id,
    status,
    timestamp: new Date(detail.event_timestamp || event.time || Date.now()),
    to: detail.attributes?.destination_phone_number || detail.endpoint?.address || '',
    from: detail.attributes?.origination_phone_number,
    errorCode: detail.attributes?.record_status,
    errorMessage: detail.attributes?.status_message,
    carrierName: detail.attributes?.carrier_name,
    priceInUsd: detail.metrics?.price_in_millicents_usd ? detail.metrics.price_in_millicents_usd / 100000 : undefined,
    messagePartCount: detail.attributes?.number_of_message_parts,
    raw: event,
  }
}

/**
 * Parse SNS SMS delivery status notification
 */
function parseSnsDeliveryStatus(event: any): DeliveryReceipt | null {
  const notification = event.notification

  return {
    messageId: notification.messageId,
    status: normalizeStatus(notification.status),
    timestamp: new Date(notification.timestamp || Date.now()),
    to: event.destination || notification.destination,
    from: notification.senderId,
    errorCode: notification.providerResponse?.statusCode,
    errorMessage: notification.providerResponse?.statusMessage,
    carrierName: notification.providerResponse?.carrierName,
    priceInUsd: notification.priceInUSD,
    messagePartCount: notification.numberOfMessageParts,
    raw: event,
  }
}

/**
 * Normalize status strings to DeliveryReceipt status
 */
function normalizeStatus(status: string): DeliveryReceipt['status'] {
  const s = (status || '').toUpperCase()
  if (s === 'DELIVERED' || s === 'SUCCESS' || s === 'TEXT_DELIVERED') return 'delivered'
  if (s === 'FAILED' || s === 'FAILURE' || s === 'TEXT_FAILED') return 'failed'
  if (s === 'SENT' || s === 'TEXT_SENT') return 'sent'
  if (s === 'PENDING' || s === 'QUEUED') return 'pending'
  return 'unknown'
}

/**
 * Forward delivery receipt to a webhook URL
 */
async function forwardToWebhook(
  url: string,
  receipt: DeliveryReceipt,
  secret?: string,
): Promise<void> {
  const body = JSON.stringify(receipt)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Add signature if secret provided (HMAC-SHA256)
  if (secret) {
    const crypto = await import('node:crypto')
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex')
    headers['X-SMS-Signature'] = signature
    headers['X-SMS-Timestamp'] = Date.now().toString()
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    })

    if (!response.ok) {
      console.error(`Webhook failed: ${response.status} ${response.statusText}`)
    }
  } catch (err: any) {
    console.error(`Webhook error: ${err.message}`)
  }
}

// ============================================
// Phone Number Utilities
// ============================================

/**
 * Normalize a phone number to E.164 format
 * Removes all non-numeric characters except leading +
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return ''

  // Remove all non-numeric except +
  let normalized = phone.replace(/[^\d+]/g, '')

  // If it starts with +, keep it, otherwise assume US
  if (!normalized.startsWith('+')) {
    // If 10 digits, assume US
    if (normalized.length === 10) {
      normalized = `+1${normalized}`
    }
    // If 11 digits and starts with 1, add +
    else if (normalized.length === 11 && normalized.startsWith('1')) {
      normalized = `+${normalized}`
    }
  }

  return normalized
}

/**
 * Format a phone number for display
 */
export function formatPhoneNumber(phone: string, format: 'national' | 'international' | 'e164' = 'national'): string {
  const normalized = normalizePhoneNumber(phone)

  if (format === 'e164') {
    return normalized
  }

  // US number formatting
  if (normalized.startsWith('+1') && normalized.length === 12) {
    const number = normalized.slice(2)
    const areaCode = number.slice(0, 3)
    const exchange = number.slice(3, 6)
    const subscriber = number.slice(6)

    if (format === 'national') {
      return `(${areaCode}) ${exchange}-${subscriber}`
    }
    return `+1 (${areaCode}) ${exchange}-${subscriber}`
  }

  // For other countries, just return the normalized number
  return normalized
}

/**
 * Validate a phone number
 */
export function isValidPhoneNumber(phone: string): boolean {
  const normalized = normalizePhoneNumber(phone)

  // Must start with + and have at least 10 digits
  if (!normalized.startsWith('+')) return false

  const digits = normalized.slice(1)
  if (digits.length < 10 || digits.length > 15) return false

  // Must be all digits
  return /^\d+$/.test(digits)
}

/**
 * Get the country code from a phone number
 */
export function getCountryCode(phone: string): string | null {
  const normalized = normalizePhoneNumber(phone)
  if (!normalized.startsWith('+')) return null

  // Common country codes by length
  const countryCodes: Record<string, string> = {
    '1': 'US/CA',
    '7': 'RU/KZ',
    '20': 'EG',
    '27': 'ZA',
    '30': 'GR',
    '31': 'NL',
    '32': 'BE',
    '33': 'FR',
    '34': 'ES',
    '36': 'HU',
    '39': 'IT',
    '40': 'RO',
    '41': 'CH',
    '43': 'AT',
    '44': 'GB',
    '45': 'DK',
    '46': 'SE',
    '47': 'NO',
    '48': 'PL',
    '49': 'DE',
    '52': 'MX',
    '54': 'AR',
    '55': 'BR',
    '56': 'CL',
    '57': 'CO',
    '60': 'MY',
    '61': 'AU',
    '62': 'ID',
    '63': 'PH',
    '64': 'NZ',
    '65': 'SG',
    '66': 'TH',
    '81': 'JP',
    '82': 'KR',
    '84': 'VN',
    '86': 'CN',
    '90': 'TR',
    '91': 'IN',
    '92': 'PK',
    '93': 'AF',
    '94': 'LK',
    '98': 'IR',
  }

  const digits = normalized.slice(1)

  // Check 1-digit, then 2-digit, then 3-digit codes
  for (const len of [1, 2, 3]) {
    const prefix = digits.slice(0, len)
    if (countryCodes[prefix]) {
      return countryCodes[prefix]
    }
  }

  return null
}

/**
 * Check if two phone numbers are the same (ignoring formatting)
 */
export function isSamePhoneNumber(phone1: string, phone2: string): boolean {
  return normalizePhoneNumber(phone1) === normalizePhoneNumber(phone2)
}
