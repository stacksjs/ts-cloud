/**
 * Unified Communication Module
 *
 * Generates all CloudFormation resources for Email, Phone, and SMS services
 * including advanced features like analytics, scheduling, and campaigns.
 *
 * This module is the main entry point for `buddy deploy` communication services.
 */

import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface CommunicationConfig {
  slug: string
  environment: EnvironmentType
  region?: string

  email?: EmailServiceConfig
  phone?: PhoneServiceConfig
  sms?: SmsServiceConfig
}

export interface EmailServiceConfig {
  enabled: boolean
  domain: string
  mailboxes?: string[]

  server?: {
    enabled: boolean
    scan?: boolean
    storage?: {
      retentionDays?: number
      archiveAfterDays?: number
    }
  }

  advanced?: {
    search?: boolean // OpenSearch integration
    threading?: boolean
    scheduling?: boolean
    analytics?: boolean
    templates?: boolean
    sharedMailboxes?: boolean
    rules?: boolean
  }

  notifications?: {
    newEmail?: boolean
    bounces?: boolean
    complaints?: boolean
  }
}

export interface PhoneServiceConfig {
  enabled: boolean
  instanceAlias?: string

  voicemail?: {
    enabled: boolean
    transcription?: boolean
    maxDurationSeconds?: number
  }

  advanced?: {
    recording?: boolean
    analytics?: boolean
    callbacks?: boolean
  }

  notifications?: {
    incomingCall?: boolean
    missedCall?: boolean
    voicemail?: boolean
  }
}

export interface SmsServiceConfig {
  enabled: boolean
  senderId?: string
  originationNumber?: string
  messageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'

  advanced?: {
    campaigns?: boolean
    analytics?: boolean
    mms?: boolean
    chatbot?: boolean
    linkTracking?: boolean
    abTesting?: boolean
  }

  optOut?: {
    enabled: boolean
    keywords?: string[]
  }
}

/**
 * Communication Module
 *
 * Generates complete CloudFormation stack for communication services
 */
export class Communication {
  /**
   * Generate all communication resources
   */
  static generate(config: CommunicationConfig): Record<string, any> {
    const resources: Record<string, any> = {}
    const { slug, environment, region = 'us-east-1' } = config

    // Generate IAM role for all Lambda functions
    const lambdaRole = Communication.createLambdaExecutionRole(slug, environment)
    Object.assign(resources, lambdaRole.resources)

    // Email resources
    if (config.email?.enabled) {
      const emailResources = Communication.generateEmailResources(config, lambdaRole.roleArn)
      Object.assign(resources, emailResources)
    }

    // Phone resources
    if (config.phone?.enabled) {
      const phoneResources = Communication.generatePhoneResources(config, lambdaRole.roleArn)
      Object.assign(resources, phoneResources)
    }

    // SMS resources
    if (config.sms?.enabled) {
      const smsResources = Communication.generateSmsResources(config, lambdaRole.roleArn)
      Object.assign(resources, smsResources)
    }

    return resources
  }

  /**
   * Create Lambda execution role with all necessary permissions
   */
  private static createLambdaExecutionRole(slug: string, environment: EnvironmentType): {
    resources: Record<string, any>
    roleArn: any
    roleName: string
  } {
    const roleName = `${slug}-${environment}-communication-role`
    const roleLogicalId = generateLogicalId(roleName)

    const resources: Record<string, any> = {
      [roleLogicalId]: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: roleName,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { Service: 'lambda.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }],
          },
          ManagedPolicyArns: [
            'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          ],
          Policies: [{
            PolicyName: 'CommunicationPolicy',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: [
                    's3:GetObject',
                    's3:PutObject',
                    's3:DeleteObject',
                    's3:ListBucket',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'ses:SendEmail',
                    'ses:SendRawEmail',
                    'ses:GetIdentityVerificationAttributes',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'sns:Publish',
                    'sns:Subscribe',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'dynamodb:GetItem',
                    'dynamodb:PutItem',
                    'dynamodb:UpdateItem',
                    'dynamodb:DeleteItem',
                    'dynamodb:Query',
                    'dynamodb:Scan',
                    'dynamodb:BatchWriteItem',
                    'dynamodb:BatchGetItem',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'connect:*',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'mobiletargeting:SendMessages',
                    'mobiletargeting:GetEndpoint',
                    'mobiletargeting:UpdateEndpoint',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'transcribe:StartTranscriptionJob',
                    'transcribe:GetTranscriptionJob',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'bedrock:InvokeModel',
                  ],
                  Resource: '*',
                },
                {
                  Effect: 'Allow',
                  Action: [
                    'es:ESHttpGet',
                    'es:ESHttpPost',
                    'es:ESHttpPut',
                    'es:ESHttpDelete',
                  ],
                  Resource: '*',
                },
              ],
            },
          }],
        },
      },
    }

    return {
      resources,
      roleArn: Fn.GetAtt(roleLogicalId, 'Arn'),
      roleName,
    }
  }

  /**
   * Generate Email service resources
   */
  private static generateEmailResources(config: CommunicationConfig, roleArn: any): Record<string, any> {
    const { slug, environment, email } = config
    if (!email) return {}

    const resources: Record<string, any> = {}
    const prefix = `${slug}-${environment}`

    // Email storage bucket
    const bucketName = `${prefix}-email-storage`
    const bucketLogicalId = generateLogicalId(bucketName)
    resources[bucketLogicalId] = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: bucketName,
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'ArchiveOldEmails',
              Status: 'Enabled',
              Transitions: email.server?.storage?.archiveAfterDays ? [{
                StorageClass: 'GLACIER',
                TransitionInDays: email.server.storage.archiveAfterDays,
              }] : [],
              ExpirationInDays: email.server?.storage?.retentionDays || 365,
            },
          ],
        },
        NotificationConfiguration: {
          LambdaConfigurations: [],
        },
      },
    }

    // SES Domain Identity
    const identityLogicalId = generateLogicalId(`${prefix}-ses-identity`)
    resources[identityLogicalId] = {
      Type: 'AWS::SES::EmailIdentity',
      Properties: {
        EmailIdentity: email.domain,
        DkimSigningAttributes: {
          NextSigningKeyLength: 'RSA_2048_BIT',
        },
        FeedbackAttributes: {
          EmailForwardingEnabled: true,
        },
      },
    }

    // SNS Topics for notifications
    if (email.notifications?.bounces || email.notifications?.complaints) {
      const bounceTopicLogicalId = generateLogicalId(`${prefix}-bounce-topic`)
      resources[bounceTopicLogicalId] = {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: `${prefix}-email-bounces`,
        },
      }

      const complaintTopicLogicalId = generateLogicalId(`${prefix}-complaint-topic`)
      resources[complaintTopicLogicalId] = {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: `${prefix}-email-complaints`,
        },
      }
    }

    // Inbound email Lambda
    if (email.server?.enabled) {
      const inboundLambdaLogicalId = generateLogicalId(`${prefix}-inbound-email`)
      resources[inboundLambdaLogicalId] = {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${prefix}-inbound-email`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: roleArn,
          Timeout: 60,
          MemorySize: 256,
          Code: {
            ZipFile: Communication.InboundEmailCode,
          },
          Environment: {
            Variables: {
              EMAIL_BUCKET: bucketName,
              DOMAIN: email.domain,
            },
          },
        },
      }

      // Outbound email Lambda
      const outboundLambdaLogicalId = generateLogicalId(`${prefix}-outbound-email`)
      resources[outboundLambdaLogicalId] = {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${prefix}-outbound-email`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: Communication.OutboundEmailCode,
          },
          Environment: {
            Variables: {
              EMAIL_BUCKET: bucketName,
              DOMAIN: email.domain,
            },
          },
        },
      }
    }

    // Advanced: Analytics
    if (email.advanced?.analytics) {
      const analyticsTableLogicalId = generateLogicalId(`${prefix}-email-analytics`)
      resources[analyticsTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-email-analytics`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'messageId', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'messageId', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      }
    }

    // Advanced: Scheduling
    if (email.advanced?.scheduling) {
      const schedulerLambdaLogicalId = generateLogicalId(`${prefix}-email-scheduler`)
      resources[schedulerLambdaLogicalId] = {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${prefix}-email-scheduler`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: roleArn,
          Timeout: 300,
          MemorySize: 256,
          Code: {
            ZipFile: Communication.EmailSchedulerCode,
          },
          Environment: {
            Variables: {
              EMAIL_BUCKET: bucketName,
            },
          },
        },
      }

      // EventBridge rule to trigger scheduler
      const schedulerRuleLogicalId = generateLogicalId(`${prefix}-email-scheduler-rule`)
      resources[schedulerRuleLogicalId] = {
        Type: 'AWS::Events::Rule',
        Properties: {
          Name: `${prefix}-email-scheduler`,
          ScheduleExpression: 'rate(1 minute)',
          State: 'ENABLED',
          Targets: [{
            Id: 'EmailSchedulerTarget',
            Arn: Fn.GetAtt(schedulerLambdaLogicalId, 'Arn'),
          }],
        },
      }
    }

    // Advanced: Threading
    if (email.advanced?.threading) {
      const threadingLambdaLogicalId = generateLogicalId(`${prefix}-email-threading`)
      resources[threadingLambdaLogicalId] = {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${prefix}-email-threading`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: roleArn,
          Timeout: 60,
          MemorySize: 256,
          Code: {
            ZipFile: Communication.EmailThreadingCode,
          },
          Environment: {
            Variables: {
              EMAIL_BUCKET: bucketName,
            },
          },
        },
      }
    }

    // Advanced: Rules
    if (email.advanced?.rules) {
      const rulesTableLogicalId = generateLogicalId(`${prefix}-email-rules`)
      resources[rulesTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-email-rules`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'mailbox', AttributeType: 'S' },
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'mailbox', KeyType: 'HASH' },
            { AttributeName: 'id', KeyType: 'RANGE' },
          ],
        },
      }
    }

    // Advanced: Shared Mailboxes
    if (email.advanced?.sharedMailboxes) {
      const sharedMailboxTableLogicalId = generateLogicalId(`${prefix}-shared-mailboxes`)
      resources[sharedMailboxTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-shared-mailboxes`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
            { AttributeName: 'type', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
          GlobalSecondaryIndexes: [{
            IndexName: 'type-index',
            KeySchema: [{ AttributeName: 'type', KeyType: 'HASH' }],
            Projection: { ProjectionType: 'ALL' },
          }],
        },
      }
    }

    // Advanced: Search (OpenSearch)
    if (email.advanced?.search) {
      const searchDomainLogicalId = generateLogicalId(`${prefix}-email-search`)
      resources[searchDomainLogicalId] = {
        Type: 'AWS::OpenSearchService::Domain',
        Properties: {
          DomainName: `${prefix}-email-search`.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 28),
          EngineVersion: 'OpenSearch_2.11',
          ClusterConfig: {
            InstanceType: 't3.small.search',
            InstanceCount: 1,
          },
          EBSOptions: {
            EBSEnabled: true,
            VolumeType: 'gp3',
            VolumeSize: 10,
          },
          NodeToNodeEncryptionOptions: { Enabled: true },
          EncryptionAtRestOptions: { Enabled: true },
          DomainEndpointOptions: { EnforceHTTPS: true },
        },
      }
    }

    return resources
  }

  /**
   * Generate Phone service resources
   */
  private static generatePhoneResources(config: CommunicationConfig, roleArn: any): Record<string, any> {
    const { slug, environment, phone } = config
    if (!phone) return {}

    const resources: Record<string, any> = {}
    const prefix = `${slug}-${environment}`

    // Call log DynamoDB table
    const callLogTableLogicalId = generateLogicalId(`${prefix}-call-log`)
    resources[callLogTableLogicalId] = {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        TableName: `${prefix}-call-log`,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'contactId', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'contactId', KeyType: 'HASH' },
        ],
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      },
    }

    // Voicemail storage bucket
    if (phone.voicemail?.enabled) {
      const voicemailBucketLogicalId = generateLogicalId(`${prefix}-voicemail`)
      resources[voicemailBucketLogicalId] = {
        Type: 'AWS::S3::Bucket',
        Properties: {
          BucketName: `${prefix}-voicemail`,
          LifecycleConfiguration: {
            Rules: [{
              Id: 'DeleteOldVoicemails',
              Status: 'Enabled',
              ExpirationInDays: 90,
            }],
          },
        },
      }
    }

    // SNS topic for phone notifications
    const phoneTopicLogicalId = generateLogicalId(`${prefix}-phone-notifications`)
    resources[phoneTopicLogicalId] = {
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: `${prefix}-phone-notifications`,
      },
    }

    // Incoming call Lambda
    const incomingCallLambdaLogicalId = generateLogicalId(`${prefix}-incoming-call`)
    resources[incomingCallLambdaLogicalId] = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${prefix}-incoming-call`,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: roleArn,
        Timeout: 30,
        MemorySize: 256,
        Code: {
          ZipFile: Communication.IncomingCallCode,
        },
        Environment: {
          Variables: {
            CALL_LOG_TABLE: `${prefix}-call-log`,
            NOTIFICATION_TOPIC_ARN: Fn.Ref(phoneTopicLogicalId),
          },
        },
      },
    }

    // Voicemail Lambda
    if (phone.voicemail?.enabled) {
      const voicemailLambdaLogicalId = generateLogicalId(`${prefix}-voicemail-handler`)
      resources[voicemailLambdaLogicalId] = {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${prefix}-voicemail-handler`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: roleArn,
          Timeout: phone.voicemail.transcription ? 300 : 60,
          MemorySize: 256,
          Code: {
            ZipFile: Communication.VoicemailCode,
          },
          Environment: {
            Variables: {
              VOICEMAIL_BUCKET: `${prefix}-voicemail`,
              TRANSCRIPTION_ENABLED: String(phone.voicemail.transcription || false),
              NOTIFICATION_TOPIC_ARN: Fn.Ref(phoneTopicLogicalId),
            },
          },
        },
      }
    }

    // Advanced: Recording
    if (phone.advanced?.recording) {
      const recordingsTableLogicalId = generateLogicalId(`${prefix}-call-recordings`)
      resources[recordingsTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-call-recordings`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'recordingId', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'recordingId', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      }
    }

    // Advanced: Callbacks
    if (phone.advanced?.callbacks) {
      const callbacksTableLogicalId = generateLogicalId(`${prefix}-callbacks`)
      resources[callbacksTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-callbacks`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      }
    }

    // Advanced: Analytics
    if (phone.advanced?.analytics) {
      const metricsTableLogicalId = generateLogicalId(`${prefix}-call-metrics`)
      resources[metricsTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-call-metrics`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'period', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'period', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      }
    }

    return resources
  }

  /**
   * Generate SMS service resources
   */
  private static generateSmsResources(config: CommunicationConfig, roleArn: any): Record<string, any> {
    const { slug, environment, sms } = config
    if (!sms) return {}

    const resources: Record<string, any> = {}
    const prefix = `${slug}-${environment}`

    // Pinpoint Application
    const pinpointAppLogicalId = generateLogicalId(`${prefix}-pinpoint-app`)
    resources[pinpointAppLogicalId] = {
      Type: 'AWS::Pinpoint::App',
      Properties: {
        Name: `${prefix}-sms`,
      },
    }

    // SMS Channel
    const smsChannelLogicalId = generateLogicalId(`${prefix}-sms-channel`)
    resources[smsChannelLogicalId] = {
      Type: 'AWS::Pinpoint::SMSChannel',
      Properties: {
        ApplicationId: Fn.Ref(pinpointAppLogicalId),
        Enabled: true,
        SenderId: sms.senderId,
      },
    }

    // Message log table
    const messageLogTableLogicalId = generateLogicalId(`${prefix}-sms-log`)
    resources[messageLogTableLogicalId] = {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        TableName: `${prefix}-sms-log`,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'messageId', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'messageId', KeyType: 'HASH' },
        ],
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      },
    }

    // Opt-out table
    if (sms.optOut?.enabled) {
      const optOutTableLogicalId = generateLogicalId(`${prefix}-sms-optout`)
      resources[optOutTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-sms-optout`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'phoneNumber', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'phoneNumber', KeyType: 'HASH' },
          ],
        },
      }
    }

    // SNS topic for SMS notifications
    const smsTopicLogicalId = generateLogicalId(`${prefix}-sms-notifications`)
    resources[smsTopicLogicalId] = {
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: `${prefix}-sms-notifications`,
      },
    }

    // SMS Send Lambda
    const sendSmsLambdaLogicalId = generateLogicalId(`${prefix}-send-sms`)
    resources[sendSmsLambdaLogicalId] = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${prefix}-send-sms`,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: roleArn,
        Timeout: 30,
        MemorySize: 256,
        Code: {
          ZipFile: Communication.SendSmsCode,
        },
        Environment: {
          Variables: {
            PINPOINT_APP_ID: Fn.Ref(pinpointAppLogicalId),
            MESSAGE_LOG_TABLE: `${prefix}-sms-log`,
            OPT_OUT_TABLE: sms.optOut?.enabled ? `${prefix}-sms-optout` : '',
            MESSAGE_TYPE: sms.messageType || 'TRANSACTIONAL',
          },
        },
      },
    }

    // SMS Receive Lambda
    const receiveSmsLambdaLogicalId = generateLogicalId(`${prefix}-receive-sms`)
    resources[receiveSmsLambdaLogicalId] = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: `${prefix}-receive-sms`,
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: roleArn,
        Timeout: 30,
        MemorySize: 256,
        Code: {
          ZipFile: Communication.ReceiveSmsCode,
        },
        Environment: {
          Variables: {
            MESSAGE_LOG_TABLE: `${prefix}-sms-log`,
            OPT_OUT_TABLE: sms.optOut?.enabled ? `${prefix}-sms-optout` : '',
            NOTIFICATION_TOPIC_ARN: Fn.Ref(smsTopicLogicalId),
          },
        },
      },
    }

    // Advanced: Campaigns
    if (sms.advanced?.campaigns) {
      const campaignsTableLogicalId = generateLogicalId(`${prefix}-sms-campaigns`)
      resources[campaignsTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-sms-campaigns`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
        },
      }
    }

    // Advanced: Analytics
    if (sms.advanced?.analytics) {
      const analyticsTableLogicalId = generateLogicalId(`${prefix}-sms-analytics`)
      resources[analyticsTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-sms-analytics`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'period', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'period', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      }
    }

    // Advanced: Link Tracking
    if (sms.advanced?.linkTracking) {
      const linksTableLogicalId = generateLogicalId(`${prefix}-short-links`)
      resources[linksTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-short-links`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      }
    }

    // Advanced: Chatbot
    if (sms.advanced?.chatbot) {
      const sessionsTableLogicalId = generateLogicalId(`${prefix}-chatbot-sessions`)
      resources[sessionsTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-chatbot-sessions`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'phoneNumber', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'phoneNumber', KeyType: 'HASH' },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      }

      const rulesTableLogicalId = generateLogicalId(`${prefix}-chatbot-rules`)
      resources[rulesTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-chatbot-rules`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
        },
      }
    }

    // Advanced: A/B Testing
    if (sms.advanced?.abTesting) {
      const abTestsTableLogicalId = generateLogicalId(`${prefix}-ab-tests`)
      resources[abTestsTableLogicalId] = {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${prefix}-ab-tests`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'id', KeyType: 'HASH' },
          ],
        },
      }
    }

    // Advanced: MMS
    if (sms.advanced?.mms) {
      const mediaBucketLogicalId = generateLogicalId(`${prefix}-mms-media`)
      resources[mediaBucketLogicalId] = {
        Type: 'AWS::S3::Bucket',
        Properties: {
          BucketName: `${prefix}-mms-media`,
          LifecycleConfiguration: {
            Rules: [{
              Id: 'DeleteOldMedia',
              Status: 'Enabled',
              ExpirationInDays: 30,
            }],
          },
        },
      }
    }

    return resources
  }

  // Lambda code snippets
  static InboundEmailCode = `
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
exports.handler = async (event) => {
  console.log('Inbound email:', JSON.stringify(event, null, 2));
  // Process inbound email from SES
  for (const record of event.Records) {
    const sesNotification = record.ses || JSON.parse(record.Sns?.Message || '{}');
    const mail = sesNotification.mail || {};
    const messageId = mail.messageId;
    // Store email metadata
    console.log('Processing email:', messageId);
  }
  return { statusCode: 200 };
};`

  static OutboundEmailCode = `
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const ses = new SESClient({});
exports.handler = async (event) => {
  console.log('Outbound email:', JSON.stringify(event, null, 2));
  const { to, from, subject, html, text } = JSON.parse(event.body || '{}');
  // Build and send email
  const boundary = '----=_Part_' + Date.now();
  let raw = 'From: ' + from + '\\r\\n';
  raw += 'To: ' + to + '\\r\\n';
  raw += 'Subject: ' + subject + '\\r\\n';
  raw += 'MIME-Version: 1.0\\r\\n';
  raw += 'Content-Type: text/html; charset=UTF-8\\r\\n\\r\\n';
  raw += html || text || '';
  const result = await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(raw) }
  }));
  return { statusCode: 200, body: JSON.stringify({ messageId: result.MessageId }) };
};`

  static EmailSchedulerCode = `
const { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');
const s3 = new S3Client({});
const ses = new SESClient({});
exports.handler = async (event) => {
  console.log('Email scheduler running');
  // Check for scheduled emails and send them
  return { statusCode: 200 };
};`

  static EmailThreadingCode = `
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const s3 = new S3Client({});
exports.handler = async (event) => {
  console.log('Email threading:', JSON.stringify(event, null, 2));
  // Group emails by thread
  return { statusCode: 200 };
};`

  static IncomingCallCode = `
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const dynamodb = new DynamoDBClient({});
const sns = new SNSClient({});
exports.handler = async (event) => {
  console.log('Incoming call:', JSON.stringify(event, null, 2));
  const contactData = event.Details?.ContactData || {};
  // Log call and send notification
  return { statusCode: 200 };
};`

  static VoicemailCode = `
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, StartTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const s3 = new S3Client({});
const transcribe = new TranscribeClient({});
const sns = new SNSClient({});
exports.handler = async (event) => {
  console.log('Voicemail:', JSON.stringify(event, null, 2));
  // Store voicemail and optionally transcribe
  return { statusCode: 200 };
};`

  static SendSmsCode = `
const { PinpointClient, SendMessagesCommand } = require('@aws-sdk/client-pinpoint');
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const pinpoint = new PinpointClient({});
const dynamodb = new DynamoDBClient({});
exports.handler = async (event) => {
  console.log('Send SMS:', JSON.stringify(event, null, 2));
  const { to, body } = JSON.parse(event.body || '{}');
  // Check opt-out and send SMS
  const result = await pinpoint.send(new SendMessagesCommand({
    ApplicationId: process.env.PINPOINT_APP_ID,
    MessageRequest: {
      Addresses: { [to]: { ChannelType: 'SMS' } },
      MessageConfiguration: {
        SMSMessage: { Body: body, MessageType: process.env.MESSAGE_TYPE }
      }
    }
  }));
  return { statusCode: 200, body: JSON.stringify(result) };
};`

  static ReceiveSmsCode = `
const { DynamoDBClient, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const dynamodb = new DynamoDBClient({});
const sns = new SNSClient({});
exports.handler = async (event) => {
  console.log('Receive SMS:', JSON.stringify(event, null, 2));
  // Process inbound SMS, handle opt-out keywords
  return { statusCode: 200 };
};`
}

export default Communication
