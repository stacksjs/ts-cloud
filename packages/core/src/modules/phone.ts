/**
 * Phone/Voice Module for CloudFormation
 *
 * Provides CloudFormation resources for Amazon Connect phone infrastructure
 */

import { handler as incomingCallHandler } from '../phone/handlers/incoming-call'
import { handler as voicemailHandler } from '../phone/handlers/voicemail'
import { handler as missedCallHandler } from '../phone/handlers/missed-call'

export interface PhoneConfig {
  slug: string
  environment: string
  instanceAlias: string
  inboundCallsEnabled?: boolean
  outboundCallsEnabled?: boolean
  voicemailEnabled?: boolean
  transcriptionEnabled?: boolean
  notificationTopicArn?: string
  webhookUrl?: string
}

export class Phone {
  /**
   * Lambda code for phone handlers
   */
  static LambdaCode: {
    incomingCall: string;
    voicemail: string;
    missedCall: string;
  } = {
    incomingCall: incomingCallHandler,
    voicemail: voicemailHandler,
    missedCall: missedCallHandler,
  }

  /**
   * Create Amazon Connect instance CloudFormation resource
   */
  static createConnectInstance(config: PhoneConfig): Record<string, any> {
    const { slug, environment, instanceAlias, inboundCallsEnabled = true, outboundCallsEnabled = true } = config

    return {
      [`${slug}ConnectInstance`]: {
        Type: 'AWS::Connect::Instance',
        Properties: {
          InstanceAlias: instanceAlias,
          IdentityManagementType: 'CONNECT_MANAGED',
          Attributes: {
            InboundCalls: inboundCallsEnabled,
            OutboundCalls: outboundCallsEnabled,
            ContactflowLogs: true,
            ContactLens: true,
            AutoResolveBestVoices: true,
            UseCustomTTSVoices: false,
            EarlyMedia: true,
          },
        },
      },
    }
  }

  /**
   * Create hours of operation resource
   */
  static createHoursOfOperation(config: {
    slug: string
    instanceArn: string
    name: string
    timezone: string
    schedule: Array<{
      day: string
      startHour: number
      startMinute: number
      endHour: number
      endMinute: number
    }>
  }): Record<string, any> {
    return {
      [`${config.slug}HoursOfOperation`]: {
        Type: 'AWS::Connect::HoursOfOperation',
        Properties: {
          InstanceArn: config.instanceArn,
          Name: config.name,
          TimeZone: config.timezone,
          Config: config.schedule.map(s => ({
            Day: s.day,
            StartTime: { Hours: s.startHour, Minutes: s.startMinute },
            EndTime: { Hours: s.endHour, Minutes: s.endMinute },
          })),
        },
      },
    }
  }

  /**
   * Create queue resource
   */
  static createQueue(config: {
    slug: string
    instanceArn: string
    name: string
    hoursOfOperationArn: string
    maxContacts?: number
  }): Record<string, any> {
    return {
      [`${config.slug}Queue`]: {
        Type: 'AWS::Connect::Queue',
        Properties: {
          InstanceArn: config.instanceArn,
          Name: config.name,
          HoursOfOperationArn: config.hoursOfOperationArn,
          MaxContacts: config.maxContacts || 10,
        },
      },
    }
  }

  /**
   * Create contact flow resource
   */
  static createContactFlow(config: {
    slug: string
    instanceArn: string
    name: string
    type: 'CONTACT_FLOW' | 'CUSTOMER_QUEUE' | 'CUSTOMER_HOLD' | 'CUSTOMER_WHISPER' | 'AGENT_HOLD' | 'AGENT_WHISPER' | 'OUTBOUND_WHISPER' | 'AGENT_TRANSFER' | 'QUEUE_TRANSFER'
    content: string
  }): Record<string, any> {
    return {
      [`${config.slug}ContactFlow`]: {
        Type: 'AWS::Connect::ContactFlow',
        Properties: {
          InstanceArn: config.instanceArn,
          Name: config.name,
          Type: config.type,
          Content: config.content,
        },
      },
    }
  }

  /**
   * Create basic IVR contact flow content
   */
  static createBasicIvrFlow(config: {
    greeting: string
    queueArn: string
    voicemailLambdaArn?: string
  }): string {
    const flow = {
      Version: '2019-10-30',
      StartAction: 'greeting',
      Actions: [
        {
          Identifier: 'greeting',
          Type: 'MessageParticipant',
          Parameters: {
            Text: config.greeting,
          },
          Transitions: {
            NextAction: 'transfer_to_queue',
            Errors: [{ NextAction: 'disconnect' }],
          },
        },
        {
          Identifier: 'transfer_to_queue',
          Type: 'TransferToQueue',
          Parameters: {
            QueueId: config.queueArn,
          },
          Transitions: {
            NextAction: config.voicemailLambdaArn ? 'voicemail' : 'disconnect',
            Errors: [{ NextAction: 'disconnect' }],
          },
        },
        ...(config.voicemailLambdaArn
          ? [
              {
                Identifier: 'voicemail',
                Type: 'InvokeLambdaFunction',
                Parameters: {
                  LambdaFunctionARN: config.voicemailLambdaArn,
                },
                Transitions: {
                  NextAction: 'disconnect',
                  Errors: [{ NextAction: 'disconnect' }],
                },
              },
            ]
          : []),
        {
          Identifier: 'disconnect',
          Type: 'DisconnectParticipant',
          Parameters: {},
          Transitions: {},
        },
      ],
    }

    return JSON.stringify(flow)
  }

  /**
   * Create Lambda role for phone handlers
   */
  static createPhoneLambdaRole(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}PhoneLambdaRole`]: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${config.slug}-phone-lambda-role`,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'lambda.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            ],
          },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
          Policies: [
            {
              PolicyName: 'PhoneLambdaPolicy',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
                    Resource: '*',
                  },
                  {
                    Effect: 'Allow',
                    Action: ['sns:Publish'],
                    Resource: '*',
                  },
                  {
                    Effect: 'Allow',
                    Action: ['s3:GetObject', 's3:PutObject'],
                    Resource: '*',
                  },
                  {
                    Effect: 'Allow',
                    Action: ['transcribe:StartTranscriptionJob', 'transcribe:GetTranscriptionJob'],
                    Resource: '*',
                  },
                  {
                    Effect: 'Allow',
                    Action: ['connect:*'],
                    Resource: '*',
                  },
                ],
              },
            },
          ],
        },
      },
    }
  }

  /**
   * Create incoming call Lambda function
   */
  static createIncomingCallLambda(config: {
    slug: string
    roleArn: string
    notificationTopicArn?: string
    callLogTable?: string
    webhookUrl?: string
  }): Record<string, any> {
    return {
      [`${config.slug}IncomingCallLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-incoming-call`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: Phone.LambdaCode.incomingCall,
          },
          Environment: {
            Variables: {
              NOTIFICATION_TOPIC_ARN: config.notificationTopicArn || '',
              CALL_LOG_TABLE: config.callLogTable || '',
              WEBHOOK_URL: config.webhookUrl || '',
            },
          },
        },
      },
    }
  }

  /**
   * Create voicemail Lambda function
   */
  static createVoicemailLambda(config: {
    slug: string
    roleArn: string
    voicemailBucket: string
    notificationTopicArn?: string
    callLogTable?: string
    transcriptionEnabled?: boolean
  }): Record<string, any> {
    return {
      [`${config.slug}VoicemailLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-voicemail`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 300, // 5 minutes for transcription
          MemorySize: 512,
          Code: {
            ZipFile: Phone.LambdaCode.voicemail,
          },
          Environment: {
            Variables: {
              VOICEMAIL_BUCKET: config.voicemailBucket,
              NOTIFICATION_TOPIC_ARN: config.notificationTopicArn || '',
              CALL_LOG_TABLE: config.callLogTable || '',
              TRANSCRIPTION_ENABLED: config.transcriptionEnabled ? 'true' : 'false',
            },
          },
        },
      },
    }
  }

  /**
   * Create missed call Lambda function
   */
  static createMissedCallLambda(config: {
    slug: string
    roleArn: string
    notificationTopicArn?: string
    callLogTable?: string
    webhookUrl?: string
  }): Record<string, any> {
    return {
      [`${config.slug}MissedCallLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-missed-call`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: Phone.LambdaCode.missedCall,
          },
          Environment: {
            Variables: {
              NOTIFICATION_TOPIC_ARN: config.notificationTopicArn || '',
              CALL_LOG_TABLE: config.callLogTable || '',
              WEBHOOK_URL: config.webhookUrl || '',
            },
          },
        },
      },
    }
  }

  /**
   * Create call log DynamoDB table
   */
  static createCallLogTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}CallLogTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-call-log`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'contactId', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'contactId', KeyType: 'HASH' }],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      },
    }
  }

  /**
   * Create complete phone setup
   */
  static createCompleteSetup(config: PhoneConfig): {
    resources: Record<string, any>
    outputs: Record<string, any>
  } {
    const resources: Record<string, any> = {}
    const outputs: Record<string, any> = {}

    // Create IAM role
    Object.assign(resources, Phone.createPhoneLambdaRole({ slug: config.slug }))

    // Create call log table
    Object.assign(resources, Phone.createCallLogTable({ slug: config.slug }))

    // Create notification topic
    resources[`${config.slug}PhoneNotificationTopic`] = {
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: `${config.slug}-phone-notifications`,
      },
    }

    // Create voicemail bucket
    resources[`${config.slug}VoicemailBucket`] = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: `${config.slug}-voicemails`,
        LifecycleConfiguration: {
          Rules: [
            {
              Id: 'DeleteOldVoicemails',
              Status: 'Enabled',
              ExpirationInDays: 90,
            },
          ],
        },
      },
    }

    // Create Lambda functions
    const roleArn = { 'Fn::GetAtt': [`${config.slug}PhoneLambdaRole`, 'Arn'] }
    const topicArn = { Ref: `${config.slug}PhoneNotificationTopic` }
    const callLogTable = { Ref: `${config.slug}CallLogTable` }
    const voicemailBucket = { Ref: `${config.slug}VoicemailBucket` }

    Object.assign(
      resources,
      Phone.createIncomingCallLambda({
        slug: config.slug,
        roleArn: roleArn as any,
        notificationTopicArn: topicArn as any,
        callLogTable: callLogTable as any,
        webhookUrl: config.webhookUrl,
      }),
    )

    if (config.voicemailEnabled !== false) {
      Object.assign(
        resources,
        Phone.createVoicemailLambda({
          slug: config.slug,
          roleArn: roleArn as any,
          voicemailBucket: voicemailBucket as any,
          notificationTopicArn: topicArn as any,
          callLogTable: callLogTable as any,
          transcriptionEnabled: config.transcriptionEnabled,
        }),
      )
    }

    Object.assign(
      resources,
      Phone.createMissedCallLambda({
        slug: config.slug,
        roleArn: roleArn as any,
        notificationTopicArn: topicArn as any,
        callLogTable: callLogTable as any,
        webhookUrl: config.webhookUrl,
      }),
    )

    // Outputs
    outputs[`${config.slug}PhoneNotificationTopicArn`] = {
      Description: 'Phone notification topic ARN',
      Value: { Ref: `${config.slug}PhoneNotificationTopic` },
    }

    outputs[`${config.slug}CallLogTableName`] = {
      Description: 'Call log table name',
      Value: { Ref: `${config.slug}CallLogTable` },
    }

    outputs[`${config.slug}VoicemailBucketName`] = {
      Description: 'Voicemail bucket name',
      Value: { Ref: `${config.slug}VoicemailBucket` },
    }

    return { resources, outputs }
  }
}

export default Phone
