/**
 * AWS Email Module
 * High-level email operations for both serverless and server deployments
 *
 * This module provides:
 * - Email sending via SES
 * - Email receiving setup (receipt rules, S3 storage)
 * - Domain verification and DKIM setup
 * - SMTP credential management for client email apps
 */

import { SESClient } from './ses'
import { S3Client } from './s3'
import { IAMClient } from './iam'
import { Route53Client } from './route53'

export interface EmailConfig {
  domain: string
  region?: string
  mailboxes?: string[]
  storage?: {
    bucket?: string
    prefix?: string
    retentionDays?: number
  }
  smtp?: {
    enabled?: boolean
    username?: string
  }
}

export interface EmailSetupResult {
  domainVerified: boolean
  dkimStatus: string
  dkimTokens?: string[]
  mailFromStatus?: string
  receiptRuleSet?: string
  storageBucket?: string
  smtpCredentials?: {
    username: string
    server: string
    port: number
  }
}

export interface SendEmailOptions {
  from?: string
  fromName?: string
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject: string
  text?: string
  html?: string
  replyTo?: string | string[]
  attachments?: Array<{
    filename: string
    content: string // Base64 encoded
    contentType?: string
  }>
}

export interface EmailDeploymentConfig {
  domain: string
  accountId: string
  region?: string
  appName: string
  environment: string
  mailboxes?: string[]
  catchAll?: boolean
  storage?: {
    bucketName?: string
    prefix?: string
  }
  notifications?: {
    bounces?: boolean
    complaints?: boolean
    newEmail?: boolean
  }
}

/**
 * High-level Email client for serverless and server deployments
 */
export class EmailClient {
  private ses: SESClient
  private s3: S3Client
  private iam: IAMClient
  private route53: Route53Client
  private region: string
  private domain?: string
  private defaultFrom?: string

  constructor(options: {
    region?: string
    domain?: string
    defaultFrom?: string
  } = {}) {
    this.region = options.region || 'us-east-1'
    this.domain = options.domain
    this.defaultFrom = options.defaultFrom
    this.ses = new SESClient(this.region)
    this.s3 = new S3Client(this.region)
    this.iam = new IAMClient(this.region)
    this.route53 = new Route53Client(this.region)
  }

  // ============================================
  // Email Sending
  // ============================================

  /**
   * Send an email
   */
  async send(options: SendEmailOptions): Promise<{ messageId: string }> {
    const from = options.from || this.defaultFrom
    if (!from) {
      throw new Error('From address is required. Set defaultFrom in constructor or provide from in options.')
    }

    const fromAddress = options.fromName
      ? `${options.fromName} <${from}>`
      : from

    const toAddresses = Array.isArray(options.to) ? options.to : [options.to]

    // Handle simple email (no attachments)
    if (!options.attachments || options.attachments.length === 0) {
      const result = await this.ses.sendSimpleEmail({
        from: fromAddress,
        to: toAddresses,
        subject: options.subject,
        text: options.text,
        html: options.html,
        replyTo: options.replyTo,
      })
      return { messageId: result.MessageId || '' }
    }

    // Handle email with attachments using raw email
    const rawEmail = this.buildRawEmail(options, fromAddress, toAddresses)
    const result = await this.ses.sendEmail({
      FromEmailAddress: fromAddress,
      Destination: {
        ToAddresses: toAddresses,
        CcAddresses: options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : undefined,
        BccAddresses: options.bcc ? (Array.isArray(options.bcc) ? options.bcc : [options.bcc]) : undefined,
      },
      Content: {
        Raw: {
          Data: Buffer.from(rawEmail).toString('base64'),
        },
      },
    })
    return { messageId: result.MessageId || '' }
  }

  /**
   * Send a templated email
   */
  async sendTemplate(options: {
    from?: string
    fromName?: string
    to: string | string[]
    templateName: string
    templateData: Record<string, any>
    replyTo?: string | string[]
  }): Promise<{ messageId: string }> {
    const from = options.from || this.defaultFrom
    if (!from) {
      throw new Error('From address is required')
    }

    const fromAddress = options.fromName
      ? `${options.fromName} <${from}>`
      : from

    const result = await this.ses.sendTemplatedEmail({
      from: fromAddress,
      to: options.to,
      templateName: options.templateName,
      templateData: options.templateData,
      replyTo: options.replyTo,
    })
    return { messageId: result.MessageId || '' }
  }

  /**
   * Send bulk emails using a template
   */
  async sendBulk(options: {
    from?: string
    templateName: string
    defaultTemplateData: Record<string, any>
    recipients: Array<{
      to: string | string[]
      templateData?: Record<string, any>
    }>
  }): Promise<{ results: Array<{ status: string; messageId?: string; error?: string }> }> {
    const from = options.from || this.defaultFrom
    if (!from) {
      throw new Error('From address is required')
    }

    const entries = options.recipients.map(r => ({
      Destination: {
        ToAddresses: Array.isArray(r.to) ? r.to : [r.to],
      },
      ReplacementEmailContent: r.templateData ? {
        ReplacementTemplate: {
          ReplacementTemplateData: JSON.stringify(r.templateData),
        },
      } : undefined,
    }))

    const result = await this.ses.sendBulkEmail({
      FromEmailAddress: from,
      BulkEmailEntries: entries,
      DefaultContent: {
        Template: {
          TemplateName: options.templateName,
          TemplateData: JSON.stringify(options.defaultTemplateData),
        },
      },
    })

    return {
      results: result.BulkEmailEntryResults?.map(r => ({
        status: r.Status || 'UNKNOWN',
        messageId: r.MessageId,
        error: r.Error,
      })) || [],
    }
  }

  // ============================================
  // Domain Setup and Verification
  // ============================================

  /**
   * Set up email for a domain (creates identity, DKIM, etc.)
   */
  async setupDomain(domain: string): Promise<EmailSetupResult> {
    // Create or get the email identity
    let identity
    try {
      identity = await this.ses.getEmailIdentity(domain)
    }
    catch {
      // Create new identity
      const createResult = await this.ses.createEmailIdentity({ EmailIdentity: domain })
      identity = {
        VerificationStatus: createResult.DkimAttributes?.Status,
        DkimAttributes: createResult.DkimAttributes,
        SendingEnabled: createResult.VerifiedForSendingStatus,
      }
    }

    // Enable DKIM signing
    try {
      await this.ses.putEmailIdentityDkimAttributes({
        EmailIdentity: domain,
        SigningEnabled: true,
      })
    }
    catch {
      // Might already be enabled
    }

    // Set up MAIL FROM domain
    try {
      await this.ses.putEmailIdentityMailFromAttributes(domain, {
        MailFromDomain: `mail.${domain}`,
        BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
      })
    }
    catch {
      // Might already be configured
    }

    // Get DKIM tokens for DNS setup
    const dkimRecords = await this.ses.getDkimRecords(domain)

    return {
      domainVerified: identity.SendingEnabled === true,
      dkimStatus: identity.DkimAttributes?.Status || 'UNKNOWN',
      dkimTokens: identity.DkimAttributes?.Tokens,
      mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus,
    }
  }

  /**
   * Get DNS records needed for email verification
   */
  async getDnsRecords(domain: string): Promise<Array<{
    type: string
    name: string
    value: string
    priority?: number
    ttl?: number
  }>> {
    const records: Array<{
      type: string
      name: string
      value: string
      priority?: number
      ttl?: number
    }> = []

    // Get DKIM records
    const dkimRecords = await this.ses.getDkimRecords(domain)
    for (const record of dkimRecords) {
      records.push({
        type: record.type,
        name: record.name,
        value: record.value,
        ttl: 1800,
      })
    }

    // MX record for receiving (inbound via SES)
    records.push({
      type: 'MX',
      name: domain,
      value: `inbound-smtp.${this.region}.amazonaws.com`,
      priority: 10,
      ttl: 3600,
    })

    // MX record for MAIL FROM domain
    records.push({
      type: 'MX',
      name: `mail.${domain}`,
      value: `feedback-smtp.${this.region}.amazonses.com`,
      priority: 10,
      ttl: 3600,
    })

    // SPF record for MAIL FROM
    records.push({
      type: 'TXT',
      name: `mail.${domain}`,
      value: 'v=spf1 include:amazonses.com ~all',
      ttl: 3600,
    })

    // DMARC record
    records.push({
      type: 'TXT',
      name: `_dmarc.${domain}`,
      value: `v=DMARC1;p=quarantine;pct=25;rua=mailto:dmarcreports@${domain}`,
      ttl: 3600,
    })

    return records
  }

  /**
   * Check if domain is fully verified and ready to send
   */
  async isDomainReady(domain: string): Promise<boolean> {
    try {
      const identity = await this.ses.getEmailIdentity(domain)
      return identity.SendingEnabled === true
        && identity.DkimAttributes?.Status === 'SUCCESS'
    }
    catch {
      return false
    }
  }

  // ============================================
  // Email Receiving Setup
  // ============================================

  /**
   * Set up email receiving for a domain
   */
  async setupReceiving(config: {
    domain: string
    ruleSetName: string
    ruleName: string
    bucketName: string
    prefix?: string
    accountId: string
    recipients?: string[] // If not provided, catches all domain emails
    scanEnabled?: boolean
    lambdaArn?: string
  }): Promise<void> {
    // Ensure bucket policy allows SES to write
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowSESPuts',
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: 's3:PutObject',
          Resource: `arn:aws:s3:::${config.bucketName}/*`,
          Condition: {
            StringEquals: { 'AWS:SourceAccount': config.accountId },
          },
        },
      ],
    }

    await this.s3.putBucketPolicy(config.bucketName, policy)

    // Create receipt rule set if it doesn't exist
    try {
      await this.ses.createReceiptRuleSet(config.ruleSetName)
    }
    catch (e: any) {
      if (!e.message?.includes('already exists') && e.code !== 'AlreadyExists') {
        throw e
      }
    }

    // Build actions
    const actions: Array<{
      S3Action?: { BucketName: string; ObjectKeyPrefix?: string }
      LambdaAction?: { FunctionArn: string; InvocationType?: 'Event' | 'RequestResponse' }
    }> = [
      {
        S3Action: {
          BucketName: config.bucketName,
          ObjectKeyPrefix: config.prefix || 'inbox/',
        },
      },
    ]

    // Add Lambda action if provided
    if (config.lambdaArn) {
      actions.push({
        LambdaAction: {
          FunctionArn: config.lambdaArn,
          InvocationType: 'Event',
        },
      })
    }

    // Create receipt rule
    try {
      await this.ses.createReceiptRule({
        RuleSetName: config.ruleSetName,
        Rule: {
          Name: config.ruleName,
          Enabled: true,
          TlsPolicy: 'Optional',
          Recipients: config.recipients || [config.domain],
          ScanEnabled: config.scanEnabled !== false,
          Actions: actions,
        },
      })
    }
    catch (e: any) {
      // Rule might already exist - try to update it
      if (e.message?.includes('already exists')) {
        // Delete and recreate
        await this.ses.deleteReceiptRule(config.ruleSetName, config.ruleName)
        await this.ses.createReceiptRule({
          RuleSetName: config.ruleSetName,
          Rule: {
            Name: config.ruleName,
            Enabled: true,
            TlsPolicy: 'Optional',
            Recipients: config.recipients || [config.domain],
            ScanEnabled: config.scanEnabled !== false,
            Actions: actions,
          },
        })
      }
      else {
        throw e
      }
    }

    // Set as active rule set
    await this.ses.setActiveReceiptRuleSet(config.ruleSetName)
  }

  /**
   * Get incoming emails from S3 bucket
   */
  async getIncomingEmails(options: {
    bucket: string
    prefix?: string
    maxResults?: number
  }): Promise<Array<{ key: string; lastModified: string; size: number }>> {
    const objects = await this.s3.list({
      bucket: options.bucket,
      prefix: options.prefix || 'incoming/',
      maxKeys: options.maxResults || 100,
    })

    return objects.map(obj => ({
      key: obj.Key || '',
      lastModified: obj.LastModified || '',
      size: obj.Size || 0,
    }))
  }

  /**
   * Read an email from S3
   */
  async readEmail(options: {
    bucket: string
    key: string
  }): Promise<string> {
    return await this.s3.getObject(options.bucket, options.key)
  }

  // ============================================
  // SMTP Credentials (for client email apps)
  // ============================================

  /**
   * Create SMTP credentials for sending via email clients
   * Note: These use IAM users and SES SMTP interface
   */
  async createSmtpCredentials(options: {
    username: string
    domain: string
  }): Promise<{
    username: string
    password: string
    server: string
    port: number
  }> {
    // Create IAM user for SMTP using direct API calls
    const iamUsername = `ses-smtp-${options.username.replace(/[^a-zA-Z0-9]/g, '-')}`
    const { AWSClient } = await import('./client')
    const client = new AWSClient()

    // Helper to build form-encoded body
    const buildBody = (action: string, params: Record<string, string>): string => {
      const allParams = { Action: action, Version: '2010-05-08', ...params }
      return Object.entries(allParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    }

    // Create IAM user
    try {
      await client.request({
        service: 'iam',
        region: 'us-east-1', // IAM is global but uses us-east-1
        method: 'POST',
        path: '/',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildBody('CreateUser', { UserName: iamUsername }),
      })
    }
    catch (e: any) {
      if (!e.message?.includes('EntityAlreadyExists')) {
        throw e
      }
    }

    // Attach SES sending policy
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'ses:SendRawEmail',
          Resource: '*',
          Condition: {
            StringLike: {
              'ses:FromAddress': `*@${options.domain}`,
            },
          },
        },
      ],
    }

    const policyName = `ses-smtp-policy-${options.domain.replace(/\./g, '-')}`
    try {
      await client.request({
        service: 'iam',
        region: 'us-east-1',
        method: 'POST',
        path: '/',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildBody('PutUserPolicy', {
          UserName: iamUsername,
          PolicyName: policyName,
          PolicyDocument: JSON.stringify(policy),
        }),
      })
    }
    catch {
      // Policy might already exist
    }

    // Create access key
    const keyResponse: any = await client.request({
      service: 'iam',
      region: 'us-east-1',
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildBody('CreateAccessKey', { UserName: iamUsername }),
    })

    const accessKey = keyResponse?.CreateAccessKeyResult?.AccessKey

    if (!accessKey?.AccessKeyId || !accessKey?.SecretAccessKey) {
      throw new Error('Failed to create access key')
    }

    // Convert secret key to SMTP password
    // AWS SES SMTP passwords are derived from the secret access key
    const smtpPassword = this.deriveSmtpPassword(accessKey.SecretAccessKey)

    return {
      username: accessKey.AccessKeyId,
      password: smtpPassword,
      server: `email-smtp.${this.region}.amazonaws.com`,
      port: 587,
    }
  }

  /**
   * Derive SMTP password from AWS secret access key
   * Based on AWS documentation for SES SMTP credentials
   */
  private deriveSmtpPassword(secretAccessKey: string): string {
    const crypto = require('node:crypto')

    // AWS SES SMTP password derivation algorithm
    const message = 'SendRawEmail'
    const versionInBytes = Buffer.from([0x04])

    // Sign the message
    let signature = crypto
      .createHmac('sha256', `AWS4${secretAccessKey}`)
      .update('11111111')
      .digest()

    signature = crypto
      .createHmac('sha256', signature)
      .update(this.region)
      .digest()

    signature = crypto
      .createHmac('sha256', signature)
      .update('ses')
      .digest()

    signature = crypto
      .createHmac('sha256', signature)
      .update('aws4_request')
      .digest()

    signature = crypto
      .createHmac('sha256', signature)
      .update(message)
      .digest()

    // Prepend version byte and encode as base64
    const signatureWithVersion = Buffer.concat([versionInBytes, signature])
    return signatureWithVersion.toString('base64')
  }

  // ============================================
  // Email Templates
  // ============================================

  /**
   * Create an email template
   */
  async createTemplate(options: {
    name: string
    subject: string
    text?: string
    html?: string
  }): Promise<void> {
    await this.ses.createEmailTemplate({
      TemplateName: options.name,
      TemplateContent: {
        Subject: options.subject,
        Text: options.text,
        Html: options.html,
      },
    })
  }

  /**
   * Get an email template
   */
  async getTemplate(name: string): Promise<{
    name: string
    subject?: string
    text?: string
    html?: string
  } | null> {
    try {
      const result = await this.ses.getEmailTemplate(name)
      return {
        name: result.TemplateName || name,
        subject: result.TemplateContent?.Subject,
        text: result.TemplateContent?.Text,
        html: result.TemplateContent?.Html,
      }
    }
    catch {
      return null
    }
  }

  /**
   * Delete an email template
   */
  async deleteTemplate(name: string): Promise<void> {
    await this.ses.deleteEmailTemplate(name)
  }

  /**
   * List all email templates
   */
  async listTemplates(): Promise<Array<{ name: string; createdAt?: string }>> {
    const result = await this.ses.listEmailTemplates()
    return result.TemplatesMetadata?.map(t => ({
      name: t.TemplateName || '',
      createdAt: t.CreatedTimestamp,
    })) || []
  }

  // ============================================
  // Deployment Automation
  // ============================================

  /**
   * Deploy full email infrastructure for an application
   */
  async deploy(config: EmailDeploymentConfig): Promise<{
    success: boolean
    domainVerified: boolean
    dkimStatus: string
    receiptRuleSet: string
    storageBucket: string
    dnsRecords: Array<{ type: string; name: string; value: string }>
  }> {
    const ruleSetName = `${config.appName}-${config.environment}-email-rules`
    const ruleName = `${config.appName}-inbound-email`
    const bucketName = config.storage?.bucketName || `${config.appName}-${config.environment}-email`

    // 1. Set up domain identity
    const domainSetup = await this.setupDomain(config.domain)

    // 2. Create S3 bucket for email storage if it doesn't exist
    const buckets = await this.s3.listBuckets()
    const bucketExists = buckets.Buckets?.some(b => b.Name === bucketName)
    if (!bucketExists) {
      await this.s3.createBucket(bucketName)
    }

    // 3. Set up email receiving
    await this.setupReceiving({
      domain: config.domain,
      ruleSetName,
      ruleName,
      bucketName,
      prefix: config.storage?.prefix || 'inbox/',
      accountId: config.accountId,
      recipients: config.catchAll ? [config.domain] : config.mailboxes,
      scanEnabled: true,
    })

    // 4. Get DNS records for verification
    const dnsRecords = await this.getDnsRecords(config.domain)

    return {
      success: true,
      domainVerified: domainSetup.domainVerified,
      dkimStatus: domainSetup.dkimStatus,
      receiptRuleSet: ruleSetName,
      storageBucket: bucketName,
      dnsRecords,
    }
  }

  /**
   * Undeploy email infrastructure
   */
  async undeploy(config: {
    appName: string
    environment: string
    domain: string
    deleteBucket?: boolean
  }): Promise<void> {
    const ruleSetName = `${config.appName}-${config.environment}-email-rules`
    const ruleName = `${config.appName}-inbound-email`
    const bucketName = `${config.appName}-${config.environment}-email`

    // 1. Delete receipt rule
    try {
      await this.ses.deleteReceiptRule(ruleSetName, ruleName)
    }
    catch {
      // Rule might not exist
    }

    // 2. Delete receipt rule set
    try {
      await this.ses.deleteReceiptRuleSet(ruleSetName)
    }
    catch {
      // Rule set might not exist or might be active
    }

    // 3. Optionally delete the email identity
    // Note: Usually you want to keep this to maintain domain reputation
    // await this.ses.deleteEmailIdentity(config.domain)

    // 4. Optionally delete the S3 bucket
    if (config.deleteBucket) {
      try {
        await this.s3.emptyAndDeleteBucket(bucketName)
      }
      catch {
        // Bucket might not exist
      }
    }
  }

  // ============================================
  // Statistics and Monitoring
  // ============================================

  /**
   * Get sending statistics
   */
  async getSendingStats(): Promise<{
    sentLast24Hours: number
    maxSendRate: number
    max24HourSend: number
  }> {
    const quota = await this.ses.getSendQuota()
    return {
      sentLast24Hours: quota.SentLast24Hours || 0,
      maxSendRate: quota.MaxSendRate || 0,
      max24HourSend: quota.Max24HourSend || 0,
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Build a raw MIME email with attachments
   */
  private buildRawEmail(
    options: SendEmailOptions,
    from: string,
    to: string[],
  ): string {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(2)}`

    let email = ''
    email += `From: ${from}\r\n`
    email += `To: ${to.join(', ')}\r\n`

    if (options.cc) {
      const ccList = Array.isArray(options.cc) ? options.cc : [options.cc]
      email += `Cc: ${ccList.join(', ')}\r\n`
    }

    email += `Subject: ${options.subject}\r\n`
    email += `MIME-Version: 1.0\r\n`
    email += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`
    email += '\r\n'

    // Text/HTML part
    if (options.text || options.html) {
      email += `--${boundary}\r\n`

      if (options.html && options.text) {
        const altBoundary = `----=_Alt_${Date.now()}`
        email += `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n`
        email += '\r\n'

        email += `--${altBoundary}\r\n`
        email += 'Content-Type: text/plain; charset="UTF-8"\r\n'
        email += '\r\n'
        email += `${options.text}\r\n`

        email += `--${altBoundary}\r\n`
        email += 'Content-Type: text/html; charset="UTF-8"\r\n'
        email += '\r\n'
        email += `${options.html}\r\n`

        email += `--${altBoundary}--\r\n`
      }
      else if (options.html) {
        email += 'Content-Type: text/html; charset="UTF-8"\r\n'
        email += '\r\n'
        email += `${options.html}\r\n`
      }
      else {
        email += 'Content-Type: text/plain; charset="UTF-8"\r\n'
        email += '\r\n'
        email += `${options.text}\r\n`
      }
    }

    // Attachments
    if (options.attachments) {
      for (const attachment of options.attachments) {
        email += `--${boundary}\r\n`
        email += `Content-Type: ${attachment.contentType || 'application/octet-stream'}; name="${attachment.filename}"\r\n`
        email += 'Content-Transfer-Encoding: base64\r\n'
        email += `Content-Disposition: attachment; filename="${attachment.filename}"\r\n`
        email += '\r\n'
        email += `${attachment.content}\r\n`
      }
    }

    email += `--${boundary}--\r\n`

    return email
  }
}

// Export a default instance for convenience
export const email = new EmailClient()
