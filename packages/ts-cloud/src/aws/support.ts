/**
 * AWS Support API Operations
 * Automates support ticket creation for service limit increases and sandbox exits
*/

import { AWSClient } from './client'

export interface SupportCase {
  caseId?: string
  displayId?: string
  subject?: string
  status?: string
  serviceCode?: string
  categoryCode?: string
  severityCode?: string
  submittedBy?: string
  timeCreated?: string
  recentCommunications?: {
    communications?: Array<{
      body?: string
      submittedBy?: string
      timeCreated?: string
    }>
  }
}

export interface CreateCaseParams {
  subject: string
  communicationBody: string
  serviceCode: string
  categoryCode: string
  severityCode?: 'low' | 'normal' | 'high' | 'urgent' | 'critical'
  ccEmailAddresses?: string[]
  language?: string
  issueType?: 'customer-service' | 'technical'
  attachmentSetId?: string
}

export interface SupportService {
  code: string
  name: string
  categories?: Array<{
    code: string
    name: string
  }>
}

/**
 * AWS Support client for creating and managing support cases
*/
export class SupportClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Create a new support case
  */
  async createCase(params: CreateCaseParams): Promise<{ caseId?: string }> {
    const result = await this.client.request({
      service: 'support',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSSupport_20130415.CreateCase',
      },
      body: JSON.stringify({
        subject: params.subject,
        communicationBody: params.communicationBody,
        serviceCode: params.serviceCode,
        categoryCode: params.categoryCode,
        severityCode: params.severityCode || 'normal',
        ccEmailAddresses: params.ccEmailAddresses,
        language: params.language || 'en',
        issueType: params.issueType || 'customer-service',
        attachmentSetId: params.attachmentSetId,
      }),
    })

    return result as { caseId?: string }
  }

  /**
   * Get details of a support case
  */
  async describeCase(caseId: string): Promise<SupportCase | null> {
    const result = await this.client.request({
      service: 'support',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSSupport_20130415.DescribeCases',
      },
      body: JSON.stringify({
        caseIdList: [caseId],
        includeResolvedCases: true,
        includeCommunications: true,
      }),
    })

    const cases = (result as { cases?: SupportCase[] }).cases
    return cases?.[0] || null
  }

  /**
   * List all support cases
  */
  async listCases(options?: {
    includeResolved?: boolean
    maxResults?: number
    nextToken?: string
  }): Promise<{ cases: SupportCase[], nextToken?: string }> {
    const result = await this.client.request({
      service: 'support',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSSupport_20130415.DescribeCases',
      },
      body: JSON.stringify({
        includeResolvedCases: options?.includeResolved ?? false,
        maxResults: options?.maxResults,
        nextToken: options?.nextToken,
        includeCommunications: true,
      }),
    })

    return result as { cases: SupportCase[], nextToken?: string }
  }

  /**
   * Add a communication to an existing case
  */
  async addCommunication(caseId: string, message: string, ccEmailAddresses?: string[]): Promise<boolean> {
    const result = await this.client.request({
      service: 'support',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSSupport_20130415.AddCommunicationToCase',
      },
      body: JSON.stringify({
        caseId,
        communicationBody: message,
        ccEmailAddresses,
      }),
    })

    return (result as { result?: boolean }).result ?? true
  }

  /**
   * Resolve a support case
  */
  async resolveCase(caseId: string): Promise<{ initialCaseStatus?: string, finalCaseStatus?: string }> {
    const result = await this.client.request({
      service: 'support',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSSupport_20130415.ResolveCase',
      },
      body: JSON.stringify({
        caseId,
      }),
    })

    return result as { initialCaseStatus?: string, finalCaseStatus?: string }
  }

  /**
   * Get available services and categories for support cases
  */
  async describeServices(serviceCodeList?: string[]): Promise<SupportService[]> {
    const result = await this.client.request({
      service: 'support',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSSupport_20130415.DescribeServices',
      },
      body: JSON.stringify({
        serviceCodeList,
        language: 'en',
      }),
    })

    return (result as { services?: SupportService[] }).services || []
  }

  /**
   * Get available severity levels
  */
  async describeSeverityLevels(): Promise<Array<{ code: string, name: string }>> {
    const result = await this.client.request({
      service: 'support',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSSupport_20130415.DescribeSeverityLevels',
      },
      body: JSON.stringify({
        language: 'en',
      }),
    })

    return (result as { severityLevels?: Array<{ code: string, name: string }> }).severityLevels || []
  }
}

export interface SmsSandboxExitParams {
  companyName: string
  useCase: string
  expectedMonthlyVolume: number
  websiteUrl?: string
}

export interface SmsSpendLimitIncreaseParams {
  companyName: string
  currentLimit: number
  requestedLimit: number
  useCase: string
}

export interface SesSandboxExitParams {
  companyName: string
  websiteUrl: string
  useCase: string
  expectedDailyVolume: number
}

export interface ConnectPhoneNumberIncreaseParams {
  companyName: string
  instanceId: string
  currentLimit: number
  requestedLimit: number
  useCase: string
}

/**
 * Pre-built support case templates for common requests
*/
export const SupportTemplates = {
  /**
   * Request to exit SMS sandbox
  */
  smsSandboxExit: (params: SmsSandboxExitParams): CreateCaseParams => ({
    subject: 'Request to exit SMS sandbox for production use',
    serviceCode: 'service-limit-increase',
    categoryCode: 'service-limit-increase-sms-pinpoint',
    severityCode: 'normal',
    communicationBody: `Hello,

I would like to request that our AWS account be moved out of the SMS sandbox to enable production SMS messaging.

**Company/Project**: ${params.companyName}
**Website**: ${params.websiteUrl || 'N/A'}

**Use Case**:
${params.useCase}

**Expected Monthly SMS Volume**: ${params.expectedMonthlyVolume.toLocaleString()} messages

**Message Types**:
- Transactional (verification codes, order confirmations, etc.)
- Account notifications

**Opt-out Handling**:
We have implemented standard opt-out handling with STOP, UNSUBSCRIBE, CANCEL, END, and QUIT keywords.

**Compliance**:
- We will only send SMS to users who have explicitly opted in
- We will include opt-out instructions in promotional messages
- We will honor all opt-out requests immediately

Thank you for reviewing this request.`,
  }),

  /**
   * Request to increase SMS spending limit
  */
  smsSpendLimitIncrease: (params: SmsSpendLimitIncreaseParams): CreateCaseParams => ({
    subject: `Request to increase SMS spending limit from $${params.currentLimit} to $${params.requestedLimit}`,
    serviceCode: 'service-limit-increase',
    categoryCode: 'service-limit-increase-sms-pinpoint',
    severityCode: 'normal',
    communicationBody: `Hello,

I would like to request an increase to our monthly SMS spending limit.

**Company/Project**: ${params.companyName}

**Current Limit**: $${params.currentLimit}/month
**Requested Limit**: $${params.requestedLimit}/month

**Justification**:
${params.useCase}

**Message Types**:
- Transactional notifications
- Verification codes
- Account alerts

We have proper opt-out handling in place and comply with all SMS messaging regulations.

Thank you for reviewing this request.`,
  }),

  /**
   * Request SES production access (exit sandbox)
  */
  sesSandboxExit: (params: SesSandboxExitParams): CreateCaseParams => ({
    subject: 'Request to move out of Amazon SES sandbox',
    serviceCode: 'service-limit-increase',
    categoryCode: 'service-limit-increase-ses-702',
    severityCode: 'normal',
    communicationBody: `Hello,

I would like to request that our AWS account be moved out of the Amazon SES sandbox to enable production email sending.

**Company/Project**: ${params.companyName}
**Website**: ${params.websiteUrl}

**Use Case**:
${params.useCase}

**Expected Daily Email Volume**: ${params.expectedDailyVolume.toLocaleString()} emails

**Email Types**:
- Transactional emails (password resets, order confirmations, etc.)
- Account notifications
- System alerts

**Compliance**:
- We will only send emails to users who have explicitly opted in
- We have implemented proper bounce and complaint handling
- We will include unsubscribe links in all marketing emails
- We maintain a clean mailing list and honor all unsubscribe requests

**Technical Setup**:
- Domain verification: Complete (DKIM, SPF, DMARC configured)
- Bounce/complaint handling: SNS notifications configured
- Email authentication: Fully implemented

Thank you for reviewing this request.`,
  }),

  /**
   * Request Connect phone number limit increase
  */
  connectPhoneNumberIncrease: (params: ConnectPhoneNumberIncreaseParams): CreateCaseParams => ({
    subject: `Request to increase Amazon Connect phone number limit from ${params.currentLimit} to ${params.requestedLimit}`,
    serviceCode: 'service-limit-increase',
    categoryCode: 'service-limit-increase-connect',
    severityCode: 'normal',
    communicationBody: `Hello,

I would like to request an increase to our Amazon Connect phone number limit.

**Company/Project**: ${params.companyName}
**Connect Instance ID**: ${params.instanceId}

**Current Limit**: ${params.currentLimit} phone numbers
**Requested Limit**: ${params.requestedLimit} phone numbers

**Use Case**:
${params.useCase}

Thank you for reviewing this request.`,
  }),
}

export default SupportClient
