/**
 * AWS SES (Simple Email Service) Operations
 * Direct API calls without AWS SDK dependency
 */

import { AWSClient } from './client'

export interface EmailIdentity {
  IdentityType?: 'EMAIL_ADDRESS' | 'DOMAIN' | 'MANAGED_DOMAIN'
  IdentityName?: string
  SendingEnabled?: boolean
  VerificationStatus?: 'PENDING' | 'SUCCESS' | 'FAILED' | 'TEMPORARY_FAILURE' | 'NOT_STARTED'
  DkimAttributes?: {
    SigningEnabled?: boolean
    Status?: 'PENDING' | 'SUCCESS' | 'FAILED' | 'TEMPORARY_FAILURE' | 'NOT_STARTED'
    Tokens?: string[]
    SigningAttributesOrigin?: 'AWS_SES' | 'EXTERNAL'
  }
}

export interface SendEmailResult {
  MessageId?: string
}

/**
 * SES email service management using direct API calls
 */
export class SESClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create email identity (domain or email address)
   * Uses SES v2 API
   */
  async createEmailIdentity(params: {
    EmailIdentity: string
    DkimSigningAttributes?: {
      DomainSigningSelector?: string
      DomainSigningPrivateKey?: string
    }
    Tags?: Array<{ Key: string, Value: string }>
  }): Promise<{
    IdentityType?: string
    VerifiedForSendingStatus?: boolean
    DkimAttributes?: {
      SigningEnabled?: boolean
      Status?: string
      Tokens?: string[]
      SigningAttributesOrigin?: string
    }
  }> {
    const result = await this.client.request({
      service: 'email',
      region: this.region,
      method: 'POST',
      path: '/v2/email/identities',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })

    return result
  }

  /**
   * Get email identity details
   */
  async getEmailIdentity(emailIdentity: string): Promise<EmailIdentity> {
    const result = await this.client.request({
      service: 'email',
      region: this.region,
      method: 'GET',
      path: `/v2/email/identities/${encodeURIComponent(emailIdentity)}`,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    return {
      IdentityType: result.IdentityType,
      IdentityName: emailIdentity,
      SendingEnabled: result.VerifiedForSendingStatus,
      VerificationStatus: result.VerificationStatus,
      DkimAttributes: result.DkimAttributes,
    }
  }

  /**
   * List email identities
   */
  async listEmailIdentities(params?: {
    PageSize?: number
    NextToken?: string
  }): Promise<{
    EmailIdentities?: Array<{
      IdentityType?: string
      IdentityName?: string
      SendingEnabled?: boolean
    }>
    NextToken?: string
  }> {
    let path = '/v2/email/identities'
    const queryParams: string[] = []

    if (params?.PageSize) {
      queryParams.push(`PageSize=${params.PageSize}`)
    }
    if (params?.NextToken) {
      queryParams.push(`NextToken=${encodeURIComponent(params.NextToken)}`)
    }

    if (queryParams.length > 0) {
      path += `?${queryParams.join('&')}`
    }

    const result = await this.client.request({
      service: 'email',
      region: this.region,
      method: 'GET',
      path,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    return {
      EmailIdentities: result.EmailIdentities,
      NextToken: result.NextToken,
    }
  }

  /**
   * Delete email identity
   */
  async deleteEmailIdentity(emailIdentity: string): Promise<void> {
    await this.client.request({
      service: 'email',
      region: this.region,
      method: 'DELETE',
      path: `/v2/email/identities/${encodeURIComponent(emailIdentity)}`,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  /**
   * Enable/disable DKIM signing for identity
   */
  async putEmailIdentityDkimAttributes(params: {
    EmailIdentity: string
    SigningEnabled: boolean
  }): Promise<void> {
    await this.client.request({
      service: 'email',
      region: this.region,
      method: 'PUT',
      path: `/v2/email/identities/${encodeURIComponent(params.EmailIdentity)}/dkim`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ SigningEnabled: params.SigningEnabled }),
    })
  }

  /**
   * Send email
   */
  async sendEmail(params: {
    FromEmailAddress: string
    Destination: {
      ToAddresses?: string[]
      CcAddresses?: string[]
      BccAddresses?: string[]
    }
    Content: {
      Simple?: {
        Subject: { Data: string, Charset?: string }
        Body: {
          Text?: { Data: string, Charset?: string }
          Html?: { Data: string, Charset?: string }
        }
      }
      Raw?: {
        Data: string // Base64 encoded
      }
      Template?: {
        TemplateName: string
        TemplateData?: string
      }
    }
    ReplyToAddresses?: string[]
    ConfigurationSetName?: string
  }): Promise<SendEmailResult> {
    const result = await this.client.request({
      service: 'email',
      region: this.region,
      method: 'POST',
      path: '/v2/email/outbound-emails',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })

    return {
      MessageId: result.MessageId,
    }
  }

  /**
   * Send bulk email
   */
  async sendBulkEmail(params: {
    FromEmailAddress: string
    BulkEmailEntries: Array<{
      Destination: {
        ToAddresses?: string[]
        CcAddresses?: string[]
        BccAddresses?: string[]
      }
      ReplacementEmailContent?: {
        ReplacementTemplate?: {
          ReplacementTemplateData?: string
        }
      }
    }>
    DefaultContent: {
      Template: {
        TemplateName: string
        TemplateData?: string
      }
    }
    ConfigurationSetName?: string
  }): Promise<{
    BulkEmailEntryResults?: Array<{
      Status?: string
      Error?: string
      MessageId?: string
    }>
  }> {
    const result = await this.client.request({
      service: 'email',
      region: this.region,
      method: 'POST',
      path: '/v2/email/outbound-bulk-emails',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })

    return {
      BulkEmailEntryResults: result.BulkEmailEntryResults,
    }
  }

  /**
   * Create email template
   */
  async createEmailTemplate(params: {
    TemplateName: string
    TemplateContent: {
      Subject?: string
      Text?: string
      Html?: string
    }
  }): Promise<void> {
    await this.client.request({
      service: 'email',
      region: this.region,
      method: 'POST',
      path: '/v2/email/templates',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    })
  }

  /**
   * Get email template
   */
  async getEmailTemplate(templateName: string): Promise<{
    TemplateName?: string
    TemplateContent?: {
      Subject?: string
      Text?: string
      Html?: string
    }
  }> {
    const result = await this.client.request({
      service: 'email',
      region: this.region,
      method: 'GET',
      path: `/v2/email/templates/${encodeURIComponent(templateName)}`,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    return result
  }

  /**
   * Delete email template
   */
  async deleteEmailTemplate(templateName: string): Promise<void> {
    await this.client.request({
      service: 'email',
      region: this.region,
      method: 'DELETE',
      path: `/v2/email/templates/${encodeURIComponent(templateName)}`,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }

  /**
   * List email templates
   */
  async listEmailTemplates(params?: {
    PageSize?: number
    NextToken?: string
  }): Promise<{
    TemplatesMetadata?: Array<{
      TemplateName?: string
      CreatedTimestamp?: string
    }>
    NextToken?: string
  }> {
    let path = '/v2/email/templates'
    const queryParams: string[] = []

    if (params?.PageSize) {
      queryParams.push(`PageSize=${params.PageSize}`)
    }
    if (params?.NextToken) {
      queryParams.push(`NextToken=${encodeURIComponent(params.NextToken)}`)
    }

    if (queryParams.length > 0) {
      path += `?${queryParams.join('&')}`
    }

    const result = await this.client.request({
      service: 'email',
      region: this.region,
      method: 'GET',
      path,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    return result
  }

  /**
   * Get sending statistics
   */
  async getSendStatistics(): Promise<{
    SendDataPoints?: Array<{
      Timestamp?: string
      DeliveryAttempts?: number
      Bounces?: number
      Complaints?: number
      Rejects?: number
    }>
  }> {
    // Use legacy v1 API for this
    const result = await this.client.request({
      service: 'ses',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'Action=GetSendStatistics&Version=2010-12-01',
    })

    return {
      SendDataPoints: result.GetSendStatisticsResponse?.GetSendStatisticsResult?.SendDataPoints?.member,
    }
  }

  /**
   * Get sending quota
   */
  async getSendQuota(): Promise<{
    Max24HourSend?: number
    MaxSendRate?: number
    SentLast24Hours?: number
  }> {
    // Use legacy v1 API for this
    const result = await this.client.request({
      service: 'ses',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'Action=GetSendQuota&Version=2010-12-01',
    })

    const quota = result.GetSendQuotaResponse?.GetSendQuotaResult
    return {
      Max24HourSend: quota?.Max24HourSend ? Number(quota.Max24HourSend) : undefined,
      MaxSendRate: quota?.MaxSendRate ? Number(quota.MaxSendRate) : undefined,
      SentLast24Hours: quota?.SentLast24Hours ? Number(quota.SentLast24Hours) : undefined,
    }
  }

  // Helper methods

  /**
   * Verify a domain identity
   */
  async verifyDomain(domain: string): Promise<{
    dkimTokens?: string[]
    verificationStatus?: string
  }> {
    const result = await this.createEmailIdentity({
      EmailIdentity: domain,
    })

    return {
      dkimTokens: result.DkimAttributes?.Tokens,
      verificationStatus: result.DkimAttributes?.Status,
    }
  }

  /**
   * Send a simple text email
   */
  async sendSimpleEmail(params: {
    from: string
    to: string | string[]
    subject: string
    text?: string
    html?: string
    replyTo?: string | string[]
  }): Promise<SendEmailResult> {
    const toAddresses = Array.isArray(params.to) ? params.to : [params.to]
    const replyToAddresses = params.replyTo
      ? (Array.isArray(params.replyTo) ? params.replyTo : [params.replyTo])
      : undefined

    const body: any = {}
    if (params.text) {
      body.Text = { Data: params.text }
    }
    if (params.html) {
      body.Html = { Data: params.html }
    }

    return this.sendEmail({
      FromEmailAddress: params.from,
      Destination: {
        ToAddresses: toAddresses,
      },
      Content: {
        Simple: {
          Subject: { Data: params.subject },
          Body: body,
        },
      },
      ReplyToAddresses: replyToAddresses,
    })
  }

  /**
   * Send a templated email
   */
  async sendTemplatedEmail(params: {
    from: string
    to: string | string[]
    templateName: string
    templateData: Record<string, any>
    replyTo?: string | string[]
  }): Promise<SendEmailResult> {
    const toAddresses = Array.isArray(params.to) ? params.to : [params.to]
    const replyToAddresses = params.replyTo
      ? (Array.isArray(params.replyTo) ? params.replyTo : [params.replyTo])
      : undefined

    return this.sendEmail({
      FromEmailAddress: params.from,
      Destination: {
        ToAddresses: toAddresses,
      },
      Content: {
        Template: {
          TemplateName: params.templateName,
          TemplateData: JSON.stringify(params.templateData),
        },
      },
      ReplyToAddresses: replyToAddresses,
    })
  }

  /**
   * Get DKIM DNS records for a domain
   */
  async getDkimRecords(domain: string): Promise<Array<{
    name: string
    type: string
    value: string
  }>> {
    const identity = await this.getEmailIdentity(domain)

    if (!identity.DkimAttributes?.Tokens) {
      return []
    }

    return identity.DkimAttributes.Tokens.map(token => ({
      name: `${token}._domainkey.${domain}`,
      type: 'CNAME',
      value: `${token}.dkim.amazonses.com`,
    }))
  }

  /**
   * Check if domain is verified
   */
  async isDomainVerified(domain: string): Promise<boolean> {
    try {
      const identity = await this.getEmailIdentity(domain)
      return identity.VerificationStatus === 'SUCCESS' && identity.SendingEnabled === true
    }
    catch {
      return false
    }
  }

  /**
   * Wait for domain verification
   */
  async waitForDomainVerification(
    domain: string,
    maxAttempts = 60,
    delayMs = 30000,
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const isVerified = await this.isDomainVerified(domain)

      if (isVerified) {
        return true
      }

      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    return false
  }
}
