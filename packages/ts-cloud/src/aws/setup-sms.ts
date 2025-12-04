/**
 * SMS Setup Automation Module
 * Handles complete SMS infrastructure setup during deploy
 *
 * This module automates:
 * - Phone number provisioning (toll-free, long codes)
 * - S3 inbox setup for incoming messages
 * - SNS topics for two-way messaging
 * - Spending limit management
 * - Sandbox exit requests via AWS Support
 * - Delivery receipt configuration
 */

import { PinpointSmsVoiceClient } from './pinpoint-sms-voice'
import { SNSClient } from './sns'
import { S3Client } from './s3'
import { IAMClient } from './iam'
import { LambdaClient } from './lambda'
import { SupportClient, SupportTemplates } from './support'
import { AWSClient } from './client'

export interface SmsSetupConfig {
  region?: string
  // Account identifier (used for naming resources)
  accountName?: string
  // AWS account ID
  accountId?: string
  // Phone number configuration
  phoneNumber?: {
    // Request a new phone number if one doesn't exist
    provision?: boolean
    // Type of phone number to provision
    type?: 'TOLL_FREE' | 'LONG_CODE' | 'TEN_DLC'
    // Country code
    countryCode?: string
  }
  // S3 inbox configuration
  inbox?: {
    enabled?: boolean
    bucket?: string
    prefix?: string
    // Create lifecycle rules for retention
    retentionDays?: number
  }
  // SNS topic for incoming SMS
  twoWay?: {
    enabled?: boolean
    topicName?: string
  }
  // Spending configuration
  spending?: {
    monthlyLimit?: number
    // Auto-request increase via AWS Support
    autoRequestIncrease?: boolean
  }
  // Sandbox configuration
  sandbox?: {
    // Auto-request sandbox exit via AWS Support
    autoRequestExit?: boolean
    // Company details for support ticket
    companyName?: string
    // Use case description for support ticket
    useCase?: string
    // Expected monthly SMS volume
    expectedMonthlyVolume?: number
    // Website URL
    websiteUrl?: string
  }
  // Delivery receipts
  deliveryReceipts?: {
    enabled?: boolean
    // SNS topic for delivery receipts
    topicName?: string
    // Store receipts in S3
    s3Bucket?: string
    s3Prefix?: string
  }
  // Lambda function for processing incoming SMS
  inboxLambda?: {
    enabled?: boolean
    functionName?: string
    // Code location (for creating new Lambda)
    codeS3Bucket?: string
    codeS3Key?: string
  }
}

export interface SmsSetupResult {
  success: boolean
  phoneNumber?: string
  phoneNumberId?: string
  phoneNumberStatus?: string
  inboxBucket?: string
  inboxPrefix?: string
  twoWayTopicArn?: string
  deliveryReceiptTopicArn?: string
  inboxLambdaArn?: string
  spendingLimit?: number
  sandboxStatus?: 'IN_SANDBOX' | 'OUT_OF_SANDBOX' | 'EXIT_REQUESTED'
  supportCaseId?: string
  errors: string[]
  warnings: string[]
}

/**
 * Set up complete SMS infrastructure
 * Called automatically during `buddy deploy` when SMS is enabled
 */
export async function setupSmsInfrastructure(config: SmsSetupConfig): Promise<SmsSetupResult> {
  const region = config.region || 'us-east-1'
  const result: SmsSetupResult = {
    success: true,
    errors: [],
    warnings: [],
  }

  const pinpoint = new PinpointSmsVoiceClient(region)
  const sns = new SNSClient(region)
  const s3 = new S3Client(region)
  const iam = new IAMClient(region)
  const support = new SupportClient(region)
  const awsClient = new AWSClient()

  console.log('Setting up SMS infrastructure...')

  // 1. Check current SMS status
  console.log('  Checking SMS account status...')
  try {
    const accountStatus = await checkSmsAccountStatus(pinpoint, sns)
    result.sandboxStatus = accountStatus.inSandbox ? 'IN_SANDBOX' : 'OUT_OF_SANDBOX'

    if (accountStatus.inSandbox) {
      console.log('  Account is in SMS sandbox')

      // Auto-request sandbox exit if configured
      if (config.sandbox?.autoRequestExit && config.sandbox.companyName) {
        console.log('  Requesting SMS sandbox exit via AWS Support...')
        try {
          const caseParams = SupportTemplates.smsSandboxExit({
            companyName: config.sandbox.companyName,
            useCase: config.sandbox.useCase || 'Transactional notifications and verification codes',
            expectedMonthlyVolume: config.sandbox.expectedMonthlyVolume || 1000,
            websiteUrl: config.sandbox.websiteUrl,
          })
          const caseResult = await support.createCase(caseParams)
          result.supportCaseId = caseResult.caseId
          result.sandboxStatus = 'EXIT_REQUESTED'
          console.log(`  Support case created: ${caseResult.caseId}`)
        } catch (err: any) {
          result.warnings.push(`Failed to create sandbox exit support case: ${err.message}`)
          console.log(`  Warning: Could not create support case: ${err.message}`)
        }
      }
    }

    // Check spending limit
    result.spendingLimit = accountStatus.spendingLimit
    console.log(`  Current spending limit: $${accountStatus.spendingLimit}/month`)

    // Request spending limit increase if needed
    if (
      config.spending?.autoRequestIncrease &&
      config.spending.monthlyLimit &&
      accountStatus.spendingLimit < config.spending.monthlyLimit
    ) {
      console.log(`  Requesting spending limit increase to $${config.spending.monthlyLimit}/month...`)
      try {
        // Try to set it directly first (works for small increases)
        await pinpoint.setTextMessageSpendLimitOverride(config.spending.monthlyLimit)
        result.spendingLimit = config.spending.monthlyLimit
        console.log('  Spending limit updated successfully')
      } catch (err: any) {
        // If direct update fails, file a support ticket
        if (config.sandbox?.companyName) {
          try {
            const caseParams = SupportTemplates.smsSpendLimitIncrease({
              companyName: config.sandbox.companyName,
              currentLimit: accountStatus.spendingLimit,
              requestedLimit: config.spending.monthlyLimit,
              useCase: config.sandbox.useCase || 'Production SMS messaging',
            })
            const caseResult = await support.createCase(caseParams)
            result.supportCaseId = caseResult.caseId
            result.warnings.push(`Spending limit increase requested via support case: ${caseResult.caseId}`)
            console.log(`  Support case created for limit increase: ${caseResult.caseId}`)
          } catch (supportErr: any) {
            result.warnings.push(`Failed to request spending limit increase: ${supportErr.message}`)
          }
        } else {
          result.warnings.push('Spending limit increase requires AWS Support ticket. Provide companyName in config.')
        }
      }
    }
  } catch (err: any) {
    result.errors.push(`Failed to check SMS account status: ${err.message}`)
    console.log(`  Error checking status: ${err.message}`)
  }

  // 2. Set up S3 inbox
  if (config.inbox?.enabled && config.inbox.bucket) {
    console.log('  Setting up S3 inbox...')
    try {
      await setupS3Inbox(s3, {
        bucket: config.inbox.bucket,
        prefix: config.inbox.prefix || 'sms/inbox/',
        retentionDays: config.inbox.retentionDays,
      })
      result.inboxBucket = config.inbox.bucket
      result.inboxPrefix = config.inbox.prefix || 'sms/inbox/'
      console.log(`  Inbox configured: s3://${config.inbox.bucket}/${result.inboxPrefix}`)
    } catch (err: any) {
      result.errors.push(`Failed to set up S3 inbox: ${err.message}`)
      console.log(`  Error setting up inbox: ${err.message}`)
    }
  }

  // 3. Set up SNS topic for two-way SMS
  if (config.twoWay?.enabled) {
    console.log('  Setting up two-way SMS...')
    try {
      const topicName = config.twoWay.topicName || `${config.accountName || 'stacks'}-sms-inbox`
      const topicArn = await setupTwoWayTopic(sns, awsClient, region, topicName, config.accountId)
      result.twoWayTopicArn = topicArn
      console.log(`  Two-way topic: ${topicArn}`)
    } catch (err: any) {
      result.errors.push(`Failed to set up two-way SMS topic: ${err.message}`)
      console.log(`  Error setting up two-way: ${err.message}`)
    }
  }

  // 4. Set up delivery receipts topic
  if (config.deliveryReceipts?.enabled) {
    console.log('  Setting up delivery receipts...')
    try {
      const topicName = config.deliveryReceipts.topicName || `${config.accountName || 'stacks'}-sms-delivery-receipts`
      const topicArn = await setupDeliveryReceiptsTopic(sns, awsClient, region, topicName, config.accountId)
      result.deliveryReceiptTopicArn = topicArn
      console.log(`  Delivery receipts topic: ${topicArn}`)
    } catch (err: any) {
      result.errors.push(`Failed to set up delivery receipts: ${err.message}`)
      console.log(`  Error setting up delivery receipts: ${err.message}`)
    }
  }

  // 5. Provision phone number
  if (config.phoneNumber?.provision) {
    console.log('  Checking phone numbers...')
    try {
      // Check if we already have a phone number
      const existingNumbers = await pinpoint.describePhoneNumbers({})
      const activeNumbers = (existingNumbers.PhoneNumbers || []).filter(
        n => n.Status === 'ACTIVE' || n.Status === 'PENDING',
      )

      if (activeNumbers.length > 0) {
        const phone = activeNumbers[0]
        result.phoneNumber = phone.PhoneNumber
        result.phoneNumberId = phone.PhoneNumberId
        result.phoneNumberStatus = phone.Status
        console.log(`  Using existing phone number: ${phone.PhoneNumber} (${phone.Status})`)

        // Enable two-way if we have a topic
        if (result.twoWayTopicArn && !phone.TwoWayEnabled) {
          console.log('  Enabling two-way messaging on phone number...')
          try {
            await pinpoint.enableTwoWaySms(phone.PhoneNumberId!, result.twoWayTopicArn)
            console.log('  Two-way messaging enabled')
          } catch (twoWayErr: any) {
            result.warnings.push(`Failed to enable two-way SMS: ${twoWayErr.message}`)
          }
        }
      } else {
        // Request new phone number
        console.log(`  Requesting new ${config.phoneNumber.type || 'TOLL_FREE'} phone number...`)
        try {
          const newNumber = await pinpoint.requestPhoneNumber({
            IsoCountryCode: config.phoneNumber.countryCode || 'US',
            MessageType: 'TRANSACTIONAL',
            NumberCapabilities: ['SMS'],
            NumberType: config.phoneNumber.type || 'TOLL_FREE',
            OptOutListName: 'Default',
          })
          result.phoneNumber = newNumber.PhoneNumber
          result.phoneNumberId = newNumber.PhoneNumberId
          result.phoneNumberStatus = newNumber.Status
          console.log(`  Phone number requested: ${newNumber.PhoneNumber} (${newNumber.Status})`)

          // Note: Can't enable two-way until number is ACTIVE (may take 24-72 hours for toll-free)
          if (newNumber.Status !== 'ACTIVE') {
            result.warnings.push(
              `Phone number ${newNumber.PhoneNumber} is ${newNumber.Status}. ` +
                'Two-way messaging will be enabled when number becomes ACTIVE.',
            )
          }
        } catch (provisionErr: any) {
          result.errors.push(`Failed to provision phone number: ${provisionErr.message}`)
          console.log(`  Error provisioning phone number: ${provisionErr.message}`)
        }
      }
    } catch (err: any) {
      result.errors.push(`Failed to check/provision phone numbers: ${err.message}`)
      console.log(`  Error with phone numbers: ${err.message}`)
    }
  }

  // Final status
  result.success = result.errors.length === 0
  console.log(result.success ? '  SMS setup completed successfully!' : '  SMS setup completed with errors')

  return result
}

/**
 * Check SMS account status (sandbox, spending limits)
 */
async function checkSmsAccountStatus(
  pinpoint: PinpointSmsVoiceClient,
  sns: SNSClient,
): Promise<{
  inSandbox: boolean
  spendingLimit: number
  usedThisMonth: number
}> {
  let inSandbox = true
  let spendingLimit = 1
  let usedThisMonth = 0

  // Check Pinpoint SMS Voice V2 status
  try {
    const spendLimits = await pinpoint.describeSpendLimits()
    const textLimit = spendLimits.SpendLimits?.find(l => l.Name === 'TEXT_MESSAGE_MONTHLY_SPEND_LIMIT')
    if (textLimit) {
      spendingLimit = textLimit.EnforcedLimit || 1
      // If limit is > $1, likely out of sandbox
      inSandbox = spendingLimit <= 1
    }
  } catch {
    // Fall back to SNS sandbox check
    try {
      const sandboxStatus = await sns.getSMSSandboxAccountStatus()
      inSandbox = sandboxStatus.IsInSandbox
    } catch {
      // Assume sandbox if we can't check
      inSandbox = true
    }
  }

  // Get sending quota from SNS
  try {
    const smsAttrs = await sns.getSMSAttributes()
    if (smsAttrs.MonthlySpendLimit) {
      spendingLimit = Math.max(spendingLimit, parseFloat(smsAttrs.MonthlySpendLimit))
    }
  } catch {
    // Ignore
  }

  return { inSandbox, spendingLimit, usedThisMonth }
}

/**
 * Set up S3 bucket for SMS inbox
 */
async function setupS3Inbox(
  s3: S3Client,
  config: {
    bucket: string
    prefix: string
    retentionDays?: number
  },
): Promise<void> {
  // Check if bucket exists
  try {
    const buckets = await s3.listBuckets()
    const bucketExists = buckets.Buckets?.some(b => b.Name === config.bucket)

    if (!bucketExists) {
      // Create bucket
      await s3.createBucket({ Bucket: config.bucket })
    }

    // Create placeholder files to ensure prefixes exist
    const prefixes = [
      `${config.prefix}.keep`,
      'sms/sent/.keep',
      'sms/conversations/.keep',
      'sms/templates/.keep',
      'sms/scheduled/.keep',
      'sms/receipts/.keep',
    ]

    for (const key of prefixes) {
      try {
        await s3.putObject({
          bucket: config.bucket,
          key,
          body: `SMS folder created ${new Date().toISOString()}`,
          contentType: 'text/plain',
        })
      } catch {
        // Ignore if already exists
      }
    }

    // Set up lifecycle rules for retention
    if (config.retentionDays) {
      try {
        await s3.putBucketLifecycleConfiguration({
          Bucket: config.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'SmsInboxRetention',
                Status: 'Enabled',
                Filter: { Prefix: config.prefix },
                Expiration: { Days: config.retentionDays },
              },
              {
                ID: 'SmsReceiptsRetention',
                Status: 'Enabled',
                Filter: { Prefix: 'sms/receipts/' },
                Expiration: { Days: config.retentionDays },
              },
            ],
          },
        })
      } catch (err: any) {
        // Lifecycle configuration might fail if not owner, continue anyway
        console.log(`  Note: Could not set lifecycle rules: ${err.message}`)
      }
    }
  } catch (err: any) {
    throw new Error(`Failed to set up S3 inbox: ${err.message}`)
  }
}

/**
 * Set up SNS topic for two-way SMS
 */
async function setupTwoWayTopic(
  sns: SNSClient,
  awsClient: AWSClient,
  region: string,
  topicName: string,
  accountId?: string,
): Promise<string> {
  // Check if topic exists
  const topics = await sns.listTopics()
  const existingTopic = topics.Topics?.find(t => t.TopicArn?.endsWith(`:${topicName}`))

  if (existingTopic) {
    return existingTopic.TopicArn!
  }

  // Create new topic
  const params = new URLSearchParams({
    Action: 'CreateTopic',
    Version: '2010-03-31',
    Name: topicName,
  })

  const result = await awsClient.request({
    service: 'sns',
    region,
    method: 'POST',
    path: '/',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const topicArn = result?.CreateTopicResponse?.CreateTopicResult?.TopicArn
  if (!topicArn) {
    throw new Error('Failed to create SNS topic')
  }

  // Set up topic policy to allow Pinpoint SMS to publish
  const policyParams = new URLSearchParams({
    Action: 'SetTopicAttributes',
    Version: '2010-03-31',
    TopicArn: topicArn,
    AttributeName: 'Policy',
    AttributeValue: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowPinpointSMSPublish',
          Effect: 'Allow',
          Principal: {
            Service: 'sms-voice.amazonaws.com',
          },
          Action: 'sns:Publish',
          Resource: topicArn,
        },
      ],
    }),
  })

  await awsClient.request({
    service: 'sns',
    region,
    method: 'POST',
    path: '/',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: policyParams.toString(),
  })

  return topicArn
}

/**
 * Set up SNS topic for delivery receipts
 */
async function setupDeliveryReceiptsTopic(
  sns: SNSClient,
  awsClient: AWSClient,
  region: string,
  topicName: string,
  accountId?: string,
): Promise<string> {
  // Same as two-way topic setup
  return setupTwoWayTopic(sns, awsClient, region, topicName, accountId)
}

/**
 * Enable two-way SMS on a phone number
 * Call this after phone number becomes ACTIVE
 */
export async function enableTwoWaySms(config: {
  region?: string
  phoneNumberId: string
  snsTopicArn: string
}): Promise<void> {
  const pinpoint = new PinpointSmsVoiceClient(config.region || 'us-east-1')
  await pinpoint.enableTwoWaySms(config.phoneNumberId, config.snsTopicArn)
}

/**
 * Check if phone number is ready for two-way SMS
 */
export async function checkPhoneNumberStatus(config: {
  region?: string
  phoneNumberId: string
}): Promise<{
  status: string
  phoneNumber?: string
  twoWayEnabled: boolean
}> {
  const pinpoint = new PinpointSmsVoiceClient(config.region || 'us-east-1')
  const result = await pinpoint.describePhoneNumbers({
    PhoneNumberIds: [config.phoneNumberId],
  })

  const phone = result.PhoneNumbers?.[0]
  return {
    status: phone?.Status || 'UNKNOWN',
    phoneNumber: phone?.PhoneNumber,
    twoWayEnabled: phone?.TwoWayEnabled || false,
  }
}

/**
 * Poll until phone number is active (for toll-free verification)
 */
export async function waitForPhoneNumberActive(config: {
  region?: string
  phoneNumberId: string
  timeoutMs?: number
  pollIntervalMs?: number
}): Promise<boolean> {
  const timeout = config.timeoutMs || 300000 // 5 minutes default
  const pollInterval = config.pollIntervalMs || 30000 // 30 seconds default
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const status = await checkPhoneNumberStatus({
      region: config.region,
      phoneNumberId: config.phoneNumberId,
    })

    if (status.status === 'ACTIVE') {
      return true
    }

    if (status.status === 'DELETED') {
      throw new Error('Phone number was deleted')
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }

  return false
}

/**
 * Get complete SMS infrastructure status
 */
export async function getSmsInfrastructureStatus(config: {
  region?: string
  accountName?: string
}): Promise<{
  phoneNumbers: Array<{
    phoneNumber: string
    status: string
    twoWayEnabled: boolean
    capabilities: string[]
  }>
  sandboxStatus: 'IN_SANDBOX' | 'OUT_OF_SANDBOX' | 'UNKNOWN'
  spendingLimit: number
  topics: Array<{
    name: string
    arn: string
  }>
}> {
  const region = config.region || 'us-east-1'
  const pinpoint = new PinpointSmsVoiceClient(region)
  const sns = new SNSClient(region)

  // Get phone numbers
  const phoneNumbersResult = await pinpoint.describePhoneNumbers({})
  const phoneNumbers = (phoneNumbersResult.PhoneNumbers || []).map(p => ({
    phoneNumber: p.PhoneNumber || '',
    status: p.Status || 'UNKNOWN',
    twoWayEnabled: p.TwoWayEnabled || false,
    capabilities: p.NumberCapabilities || [],
  }))

  // Get sandbox status
  const accountStatus = await checkSmsAccountStatus(pinpoint, sns)

  // Get topics
  const topicsResult = await sns.listTopics()
  const smsTopics = (topicsResult.Topics || [])
    .filter(t => t.TopicArn?.includes('sms'))
    .map(t => ({
      name: t.TopicArn?.split(':').pop() || '',
      arn: t.TopicArn || '',
    }))

  return {
    phoneNumbers,
    sandboxStatus: accountStatus.inSandbox ? 'IN_SANDBOX' : 'OUT_OF_SANDBOX',
    spendingLimit: accountStatus.spendingLimit,
    topics: smsTopics,
  }
}

/**
 * Create SMS infrastructure for Stacks deploy
 * This is the main entry point called by the deploy command
 */
export async function createSmsInfrastructure(smsConfig: {
  enabled: boolean
  provider: 'pinpoint' | 'sns' | 'end-user-messaging'
  originationNumber?: string
  defaultCountryCode: string
  messageType: 'TRANSACTIONAL' | 'PROMOTIONAL'
  maxSpendPerMonth?: number
  inbox?: {
    enabled: boolean
    bucket: string
    prefix?: string
    retentionDays?: number
  }
  twoWay?: {
    enabled: boolean
    snsTopicArn?: string
  }
  optOut: {
    enabled: boolean
    keywords: string[]
  }
}): Promise<SmsSetupResult> {
  if (!smsConfig.enabled) {
    return {
      success: true,
      errors: [],
      warnings: ['SMS is disabled in config'],
    }
  }

  // Build setup config from Stacks SMS config
  const setupConfig: SmsSetupConfig = {
    region: 'us-east-1',
    accountName: 'stacks',
    phoneNumber: {
      provision: true,
      type: 'TOLL_FREE',
      countryCode: smsConfig.defaultCountryCode,
    },
    inbox: smsConfig.inbox
      ? {
          enabled: smsConfig.inbox.enabled,
          bucket: smsConfig.inbox.bucket,
          prefix: smsConfig.inbox.prefix,
          retentionDays: smsConfig.inbox.retentionDays,
        }
      : undefined,
    twoWay: smsConfig.twoWay
      ? {
          enabled: smsConfig.twoWay.enabled,
        }
      : undefined,
    spending: {
      monthlyLimit: smsConfig.maxSpendPerMonth,
      autoRequestIncrease: true,
    },
    sandbox: {
      autoRequestExit: true,
      companyName: 'Stacks',
      useCase: 'Transactional notifications, verification codes, and account alerts for web applications built with Stacks framework.',
      expectedMonthlyVolume: 5000,
      websiteUrl: 'https://stacksjs.com',
    },
    deliveryReceipts: {
      enabled: true,
    },
  }

  return setupSmsInfrastructure(setupConfig)
}

export default {
  setupSmsInfrastructure,
  enableTwoWaySms,
  checkPhoneNumberStatus,
  waitForPhoneNumberActive,
  getSmsInfrastructureStatus,
  createSmsInfrastructure,
}
