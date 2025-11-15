import type { CloudFormationResource } from './index'

export interface SNSTopic extends CloudFormationResource {
  Type: 'AWS::SNS::Topic'
  Properties?: {
    TopicName?: string
    DisplayName?: string
    Subscription?: Array<{
      Endpoint: string
      Protocol: 'http' | 'https' | 'email' | 'email-json' | 'sms' | 'sqs' | 'application' | 'lambda' | 'firehose'
    }>
    KmsMasterKeyId?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface SNSSubscription extends CloudFormationResource {
  Type: 'AWS::SNS::Subscription'
  Properties: {
    TopicArn: string | { Ref: string }
    Protocol: 'http' | 'https' | 'email' | 'email-json' | 'sms' | 'sqs' | 'application' | 'lambda' | 'firehose'
    Endpoint: string
    FilterPolicy?: unknown
    RawMessageDelivery?: boolean
  }
}

export interface SNSTopicPolicy extends CloudFormationResource {
  Type: 'AWS::SNS::TopicPolicy'
  Properties: {
    Topics: (string | { Ref: string })[]
    PolicyDocument: {
      Version: '2012-10-17'
      Statement: Array<{
        Effect: 'Allow' | 'Deny'
        Principal: unknown
        Action: string | string[]
        Resource: string | string[]
      }>
    }
  }
}
