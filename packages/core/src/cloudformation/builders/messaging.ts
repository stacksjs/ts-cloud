import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface MessagingConfig {
  topics?: Array<{
    name: string
    displayName?: string
    subscriptions?: Array<{
      protocol: 'http' | 'https' | 'email' | 'email-json' | 'sms' | 'sqs' | 'lambda'
      endpoint: string
      filterPolicy?: Record<string, any>
    }>
  }>
}

/**
 * Add SNS topic resources to CloudFormation template
 */
export function addMessagingResources(
  builder: CloudFormationBuilder,
  config: MessagingConfig,
): void {
  if (config.topics) {
    config.topics.forEach(topic => {
      addTopic(builder, topic)
    })
  }
}

/**
 * Add SNS topic with subscriptions
 */
function addTopic(
  builder: CloudFormationBuilder,
  config: MessagingConfig['topics'][0],
): void {
  const logicalId = builder.toLogicalId(`${config.name}-topic`)

  // SNS Topic
  builder.addResource(logicalId, 'AWS::SNS::Topic', {
    TopicName: Fn.sub(`\${AWS::StackName}-${config.name}`),
    DisplayName: config.displayName || config.name,
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${config.name}`) },
    ],
  })

  // Topic Policy
  builder.addResource(`${logicalId}Policy`, 'AWS::SNS::TopicPolicy', {
    Topics: [Fn.ref(logicalId)],
    PolicyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: {
            Service: [
              'events.amazonaws.com',
              'cloudwatch.amazonaws.com',
              's3.amazonaws.com',
            ],
          },
          Action: 'sns:Publish',
          Resource: Fn.ref(logicalId),
        },
        {
          Effect: 'Allow',
          Principal: {
            AWS: Fn.sub('arn:aws:iam::${AWS::AccountId}:root'),
          },
          Action: [
            'sns:Subscribe',
            'sns:Publish',
            'sns:Receive',
          ],
          Resource: Fn.ref(logicalId),
        },
      ],
    },
  }, {
    dependsOn: logicalId,
  })

  // Subscriptions
  if (config.subscriptions) {
    config.subscriptions.forEach((subscription, index) => {
      const subscriptionId = `${logicalId}Subscription${index + 1}`

      const subscriptionProperties: Record<string, any> = {
        Protocol: subscription.protocol,
        TopicArn: Fn.ref(logicalId),
        Endpoint: subscription.endpoint,
      }

      // Filter policy for message filtering
      if (subscription.filterPolicy) {
        subscriptionProperties.FilterPolicy = subscription.filterPolicy
      }

      // For SQS subscriptions, use queue ARN
      if (subscription.protocol === 'sqs') {
        const queueLogicalId = builder.toLogicalId(`${subscription.endpoint}-queue`)
        subscriptionProperties.Endpoint = Fn.getAtt(queueLogicalId, 'Arn')
      }

      // For Lambda subscriptions, use function ARN
      if (subscription.protocol === 'lambda') {
        const functionLogicalId = builder.toLogicalId(subscription.endpoint)
        subscriptionProperties.Endpoint = Fn.getAtt(functionLogicalId, 'Arn')

        // Add Lambda permission for SNS
        builder.addResource(`${subscriptionId}Permission`, 'AWS::Lambda::Permission', {
          FunctionName: Fn.ref(functionLogicalId),
          Action: 'lambda:InvokeFunction',
          Principal: 'sns.amazonaws.com',
          SourceArn: Fn.ref(logicalId),
        }, {
          dependsOn: [functionLogicalId, logicalId],
        })
      }

      builder.addResource(subscriptionId, 'AWS::SNS::Subscription', subscriptionProperties, {
        dependsOn: logicalId,
      })
    })
  }

  // Output
  builder.template.Outputs = {
    ...builder.template.Outputs,
    [`${logicalId}Arn`]: {
      Description: `${config.name} topic ARN`,
      Value: Fn.ref(logicalId),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${config.name}-topic-arn`),
      },
    },
  }
}
