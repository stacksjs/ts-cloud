import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface QueueConfig {
  [queueName: string]: {
    fifo?: boolean
    visibilityTimeout?: number
    messageRetentionPeriod?: number
    receiveMessageWaitTime?: number
    deadLetterQueue?: boolean
    maxReceiveCount?: number
    contentBasedDeduplication?: boolean
  }
}

/**
 * Add SQS queue resources to CloudFormation template
 */
export function addQueueResources(
  builder: CloudFormationBuilder,
  config: QueueConfig,
): void {
  for (const [queueName, queueConfig] of Object.entries(config)) {
    addQueue(builder, queueName, queueConfig)
  }
}

/**
 * Add SQS queue
 */
function addQueue(
  builder: CloudFormationBuilder,
  name: string,
  config: QueueConfig[string],
): void {
  const logicalId = builder.toLogicalId(`${name}-queue`)
  const isFifo = config.fifo || false

  // Dead Letter Queue (if enabled)
  let dlqArn: any
  if (config.deadLetterQueue) {
    const dlqLogicalId = `${logicalId}DLQ`

    builder.addResource(dlqLogicalId, 'AWS::SQS::Queue', {
      QueueName: isFifo
        ? Fn.sub(`\${AWS::StackName}-${name}-dlq.fifo`)
        : Fn.sub(`\${AWS::StackName}-${name}-dlq`),
      FifoQueue: isFifo,
      MessageRetentionPeriod: 1209600, // 14 days max retention for DLQ
      Tags: [
        { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${name}-dlq`) },
      ],
    })

    dlqArn = Fn.getAtt(dlqLogicalId, 'Arn')
  }

  // Main Queue
  const queueProperties: Record<string, any> = {
    QueueName: isFifo
      ? Fn.sub(`\${AWS::StackName}-${name}.fifo`)
      : Fn.sub(`\${AWS::StackName}-${name}`),
    FifoQueue: isFifo,
    VisibilityTimeout: config.visibilityTimeout || 30,
    MessageRetentionPeriod: config.messageRetentionPeriod || 345600, // 4 days
    ReceiveMessageWaitTimeSeconds: config.receiveMessageWaitTime || 0,
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${name}`) },
    ],
  }

  // FIFO-specific settings
  if (isFifo && config.contentBasedDeduplication) {
    queueProperties.ContentBasedDeduplication = true
  }

  // Dead Letter Queue configuration
  if (config.deadLetterQueue && dlqArn) {
    queueProperties.RedrivePolicy = {
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: config.maxReceiveCount || 3,
    }
  }

  builder.addResource(logicalId, 'AWS::SQS::Queue', queueProperties, {
    dependsOn: config.deadLetterQueue ? `${logicalId}DLQ` : undefined,
  })

  // Queue Policy (allow common AWS services to send messages)
  builder.addResource(`${logicalId}Policy`, 'AWS::SQS::QueuePolicy', {
    Queues: [Fn.ref(logicalId)],
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: [
              'lambda.amazonaws.com',
              'events.amazonaws.com',
              'sns.amazonaws.com',
            ],
          },
          Action: 'sqs:SendMessage',
          Resource: Fn.getAtt(logicalId, 'Arn'),
          Condition: {
            ArnEquals: {
              'aws:SourceArn': Fn.sub('arn:aws:*:${AWS::Region}:${AWS::AccountId}:*'),
            },
          },
        },
      ],
    },
  }, {
    dependsOn: logicalId,
  })

  // Outputs
  builder.template.Outputs = {
    ...builder.template.Outputs,
    [`${logicalId}Url`]: {
      Description: `${name} queue URL`,
      Value: Fn.ref(logicalId),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${name}-queue-url`),
      },
    },
    [`${logicalId}Arn`]: {
      Description: `${name} queue ARN`,
      Value: Fn.getAtt(logicalId, 'Arn'),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${name}-queue-arn`),
      },
    },
  }

  if (config.deadLetterQueue) {
    builder.template.Outputs[`${logicalId}DLQUrl`] = {
      Description: `${name} dead letter queue URL`,
      Value: Fn.ref(`${logicalId}DLQ`),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${name}-dlq-url`),
      },
    }
  }
}
