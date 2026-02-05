import type { CloudFormationResource } from './index'

/**
 * AWS SQS (Simple Queue Service) Types
*/

export interface SQSQueue extends CloudFormationResource {
  Type: 'AWS::SQS::Queue'
  Properties?: {
    QueueName?: string
    DelaySeconds?: number
    MaximumMessageSize?: number
    MessageRetentionPeriod?: number
    ReceiveMessageWaitTimeSeconds?: number
    VisibilityTimeout?: number
    KmsMasterKeyId?: string
    KmsDataKeyReusePeriodSeconds?: number
    SqsManagedSseEnabled?: boolean
    FifoQueue?: boolean
    ContentBasedDeduplication?: boolean
    DeduplicationScope?: 'messageGroup' | 'queue'
    FifoThroughputLimit?: 'perQueue' | 'perMessageGroupId'
    RedrivePolicy?: {
      deadLetterTargetArn: string
      maxReceiveCount: number
    }
    RedriveAllowPolicy?: {
      redrivePermission: 'allowAll' | 'denyAll' | 'byQueue'
      sourceQueueArns?: string[]
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface SQSQueuePolicy extends CloudFormationResource {
  Type: 'AWS::SQS::QueuePolicy'
  Properties: {
    Queues: Array<string | { Ref: string }>
    PolicyDocument: {
      Version: '2012-10-17'
      Statement: Array<{
        Sid?: string
        Effect: 'Allow' | 'Deny'
        Principal: unknown
        Action: string | string[]
        Resource: string | string[]
        Condition?: unknown
      }>
    }
  }
}
