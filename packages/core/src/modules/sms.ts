/**
 * SMS Module for CloudFormation
 *
 * Provides CloudFormation resources for AWS Pinpoint SMS infrastructure
 */

import { handler as sendHandler } from '../sms/handlers/send'
import { handler as receiveHandler } from '../sms/handlers/receive'
import { handler as deliveryStatusHandler } from '../sms/handlers/delivery-status'

export interface SmsConfig {
  slug: string
  environment: string
  senderId?: string
  originationNumber?: string
  messageType?: 'TRANSACTIONAL' | 'PROMOTIONAL'
  twoWayEnabled?: boolean
  webhookUrl?: string
}

export class SMS {
  /**
   * Lambda code for SMS handlers
   */
  static LambdaCode: { send: typeof sendHandler; receive: typeof receiveHandler; deliveryStatus: typeof deliveryStatusHandler } = {
    send: sendHandler,
    receive: receiveHandler,
    deliveryStatus: deliveryStatusHandler,
  }

  /**
   * Create Pinpoint application
   */
  static createPinpointApp(config: { slug: string; name?: string }): Record<string, any> {
    return {
      [`${config.slug}PinpointApp`]: {
        Type: 'AWS::Pinpoint::App',
        Properties: {
          Name: config.name || `${config.slug}-sms`,
        },
      },
    }
  }

  /**
   * Create SMS channel for Pinpoint app
   */
  static createSmsChannel(config: {
    slug: string
    applicationId: string | { Ref: string }
    senderId?: string
    shortCode?: string
    enabled?: boolean
  }): Record<string, any> {
    const properties: Record<string, any> = {
      ApplicationId: config.applicationId,
      Enabled: config.enabled !== false,
    }

    if (config.senderId) {
      properties.SenderId = config.senderId
    }

    if (config.shortCode) {
      properties.ShortCode = config.shortCode
    }

    return {
      [`${config.slug}SmsChannel`]: {
        Type: 'AWS::Pinpoint::SMSChannel',
        Properties: properties,
      },
    }
  }

  /**
   * Create SMS Lambda role
   */
  static createSmsLambdaRole(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SmsLambdaRole`]: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: `${config.slug}-sms-lambda-role`,
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
              PolicyName: 'SmsLambdaPolicy',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['mobiletargeting:SendMessages', 'mobiletargeting:GetSmsChannel'],
                    Resource: '*',
                  },
                  {
                    Effect: 'Allow',
                    Action: ['sns:Publish'],
                    Resource: '*',
                  },
                  {
                    Effect: 'Allow',
                    Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem'],
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
   * Create SMS send Lambda function
   */
  static createSendLambda(config: {
    slug: string
    roleArn: string | { 'Fn::GetAtt': string[] }
    pinpointAppId: string | { Ref: string }
    messageLogTable?: string | { Ref: string }
    senderId?: string
    originationNumber?: string
  }): Record<string, any> {
    return {
      [`${config.slug}SmsSendLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-sms-send`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: SMS.LambdaCode.send,
          },
          Environment: {
            Variables: {
              PINPOINT_APP_ID: config.pinpointAppId,
              MESSAGE_LOG_TABLE: config.messageLogTable || '',
              SMS_SENDER_ID: config.senderId || '',
              SMS_ORIGINATION_NUMBER: config.originationNumber || '',
            },
          },
        },
      },
    }
  }

  /**
   * Create SMS receive Lambda function
   */
  static createReceiveLambda(config: {
    slug: string
    roleArn: string | { 'Fn::GetAtt': string[] }
    optOutTable?: string | { Ref: string }
    messageLogTable?: string | { Ref: string }
    notificationTopicArn?: string | { Ref: string }
    webhookUrl?: string
  }): Record<string, any> {
    return {
      [`${config.slug}SmsReceiveLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-sms-receive`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: SMS.LambdaCode.receive,
          },
          Environment: {
            Variables: {
              OPT_OUT_TABLE: config.optOutTable || '',
              MESSAGE_LOG_TABLE: config.messageLogTable || '',
              NOTIFICATION_TOPIC_ARN: config.notificationTopicArn || '',
              WEBHOOK_URL: config.webhookUrl || '',
            },
          },
        },
      },
    }
  }

  /**
   * Create delivery status Lambda function
   */
  static createDeliveryStatusLambda(config: {
    slug: string
    roleArn: string | { 'Fn::GetAtt': string[] }
    messageLogTable?: string | { Ref: string }
    notificationTopicArn?: string | { Ref: string }
    webhookUrl?: string
  }): Record<string, any> {
    return {
      [`${config.slug}SmsDeliveryStatusLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-sms-delivery-status`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: SMS.LambdaCode.deliveryStatus,
          },
          Environment: {
            Variables: {
              MESSAGE_LOG_TABLE: config.messageLogTable || '',
              NOTIFICATION_TOPIC_ARN: config.notificationTopicArn || '',
              WEBHOOK_URL: config.webhookUrl || '',
            },
          },
        },
      },
    }
  }

  /**
   * Create message log DynamoDB table
   */
  static createMessageLogTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SmsMessageLogTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-sms-messages`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'messageId', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'messageId', KeyType: 'HASH' }],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      },
    }
  }

  /**
   * Create opt-out DynamoDB table
   */
  static createOptOutTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SmsOptOutTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-sms-optouts`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [{ AttributeName: 'phoneNumber', AttributeType: 'S' }],
          KeySchema: [{ AttributeName: 'phoneNumber', KeyType: 'HASH' }],
        },
      },
    }
  }

  /**
   * Create notification topic for SMS events
   */
  static createNotificationTopic(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}SmsNotificationTopic`]: {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: `${config.slug}-sms-notifications`,
        },
      },
    }
  }

  /**
   * Create complete SMS setup
   */
  static createCompleteSetup(config: SmsConfig): {
    resources: Record<string, any>
    outputs: Record<string, any>
  } {
    const resources: Record<string, any> = {}
    const outputs: Record<string, any> = {}

    // Create Pinpoint app
    Object.assign(resources, SMS.createPinpointApp({ slug: config.slug }))

    // Create SMS channel
    Object.assign(
      resources,
      SMS.createSmsChannel({
        slug: config.slug,
        applicationId: { Ref: `${config.slug}PinpointApp` },
        senderId: config.senderId,
      }),
    )

    // Create IAM role
    Object.assign(resources, SMS.createSmsLambdaRole({ slug: config.slug }))

    // Create DynamoDB tables
    Object.assign(resources, SMS.createMessageLogTable({ slug: config.slug }))
    Object.assign(resources, SMS.createOptOutTable({ slug: config.slug }))

    // Create notification topic
    Object.assign(resources, SMS.createNotificationTopic({ slug: config.slug }))

    // Create Lambda functions
    const roleArn = { 'Fn::GetAtt': [`${config.slug}SmsLambdaRole`, 'Arn'] }
    const pinpointAppId = { Ref: `${config.slug}PinpointApp` }
    const messageLogTable = { Ref: `${config.slug}SmsMessageLogTable` }
    const optOutTable = { Ref: `${config.slug}SmsOptOutTable` }
    const notificationTopicArn = { Ref: `${config.slug}SmsNotificationTopic` }

    Object.assign(
      resources,
      SMS.createSendLambda({
        slug: config.slug,
        roleArn,
        pinpointAppId,
        messageLogTable,
        senderId: config.senderId,
        originationNumber: config.originationNumber,
      }),
    )

    if (config.twoWayEnabled) {
      Object.assign(
        resources,
        SMS.createReceiveLambda({
          slug: config.slug,
          roleArn,
          optOutTable,
          messageLogTable,
          notificationTopicArn,
          webhookUrl: config.webhookUrl,
        }),
      )
    }

    Object.assign(
      resources,
      SMS.createDeliveryStatusLambda({
        slug: config.slug,
        roleArn,
        messageLogTable,
        notificationTopicArn,
        webhookUrl: config.webhookUrl,
      }),
    )

    // Outputs
    outputs[`${config.slug}PinpointAppId`] = {
      Description: 'Pinpoint application ID',
      Value: { Ref: `${config.slug}PinpointApp` },
    }

    outputs[`${config.slug}SmsSendLambdaArn`] = {
      Description: 'SMS send Lambda ARN',
      Value: { 'Fn::GetAtt': [`${config.slug}SmsSendLambda`, 'Arn'] },
    }

    outputs[`${config.slug}SmsNotificationTopicArn`] = {
      Description: 'SMS notification topic ARN',
      Value: { Ref: `${config.slug}SmsNotificationTopic` },
    }

    outputs[`${config.slug}SmsMessageLogTableName`] = {
      Description: 'SMS message log table name',
      Value: { Ref: `${config.slug}SmsMessageLogTable` },
    }

    return { resources, outputs }
  }
}

export default SMS
