import type {
  SNSSubscription,
  SNSTopic,
  SNSTopicPolicy,
} from '@stacksjs/ts-cloud-aws-types'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface TopicOptions {
  slug: string
  environment: EnvironmentType
  topicName?: string
  displayName?: string
  encrypted?: boolean
  kmsKeyId?: string
}

export interface SubscriptionOptions {
  slug: string
  environment: EnvironmentType
  protocol: 'http' | 'https' | 'email' | 'email-json' | 'sms' | 'sqs' | 'application' | 'lambda' | 'firehose'
  endpoint: string
  filterPolicy?: Record<string, unknown>
  rawMessageDelivery?: boolean
}

export interface TopicPolicyOptions {
  slug: string
  environment: EnvironmentType
  allowedPrincipals?: string | string[]
  allowedServices?: string | string[]
  actions?: string | string[]
}

/**
 * Messaging Module - SNS (Simple Notification Service)
 * Provides clean API for pub/sub messaging, notifications, and event routing
*/
export class Messaging {
  /**
   * Create an SNS topic
  */
  static createTopic(options: TopicOptions): {
    topic: SNSTopic
    logicalId: string
  } {
    const {
      slug,
      environment,
      topicName,
      displayName,
      encrypted = false,
      kmsKeyId,
    } = options

    const resourceName = topicName || generateResourceName({
      slug,
      environment,
      resourceType: 'topic',
    })

    const logicalId = generateLogicalId(resourceName)

    const topic: SNSTopic = {
      Type: 'AWS::SNS::Topic',
      Properties: {
        TopicName: resourceName,
        DisplayName: displayName || resourceName,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (encrypted && kmsKeyId) {
      topic.Properties!.KmsMasterKeyId = kmsKeyId
    }

    return { topic, logicalId }
  }

  /**
   * Subscribe to a topic
  */
  static subscribe(
    topicLogicalId: string,
    options: SubscriptionOptions,
  ): {
      subscription: SNSSubscription
      logicalId: string
    } {
    const {
      slug,
      environment,
      protocol,
      endpoint,
      filterPolicy,
      rawMessageDelivery = false,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'subscription',
    })

    // Create unique ID by including protocol and using the endpoint
    // Extract alphanumeric chars and take last 12 chars to ensure uniqueness
    const endpointClean = endpoint.replace(/[^a-zA-Z0-9]/g, '')
    const endpointHash = endpointClean.length > 12 ? endpointClean.slice(-12) : endpointClean
    const logicalId = generateLogicalId(`${resourceName}-${protocol}-${endpointHash}`)

    const subscription: SNSSubscription = {
      Type: 'AWS::SNS::Subscription',
      Properties: {
        TopicArn: Fn.Ref(topicLogicalId) as unknown as string,
        Protocol: protocol,
        Endpoint: endpoint,
        RawMessageDelivery: rawMessageDelivery,
      },
    }

    if (filterPolicy) {
      subscription.Properties.FilterPolicy = filterPolicy
    }

    return { subscription, logicalId }
  }

  /**
   * Subscribe email to topic
  */
  static subscribeEmail(
    topicLogicalId: string,
    email: string,
    options: {
      slug: string
      environment: EnvironmentType
      filterPolicy?: Record<string, unknown>
    },
  ): {
      subscription: SNSSubscription
      logicalId: string
    } {
    return Messaging.subscribe(topicLogicalId, {
      ...options,
      protocol: 'email',
      endpoint: email,
    })
  }

  /**
   * Subscribe Lambda function to topic
  */
  static subscribeLambda(
    topicLogicalId: string,
    functionArn: string,
    options: {
      slug: string
      environment: EnvironmentType
      filterPolicy?: Record<string, unknown>
    },
  ): {
      subscription: SNSSubscription
      logicalId: string
    } {
    return Messaging.subscribe(topicLogicalId, {
      ...options,
      protocol: 'lambda',
      endpoint: functionArn,
      rawMessageDelivery: true,
    })
  }

  /**
   * Subscribe SQS queue to topic
  */
  static subscribeSqs(
    topicLogicalId: string,
    queueArn: string,
    options: {
      slug: string
      environment: EnvironmentType
      filterPolicy?: Record<string, unknown>
      rawMessageDelivery?: boolean
    },
  ): {
      subscription: SNSSubscription
      logicalId: string
    } {
    return Messaging.subscribe(topicLogicalId, {
      ...options,
      protocol: 'sqs',
      endpoint: queueArn,
    })
  }

  /**
   * Subscribe HTTP/HTTPS endpoint to topic
  */
  static subscribeHttp(
    topicLogicalId: string,
    url: string,
    options: {
      slug: string
      environment: EnvironmentType
      filterPolicy?: Record<string, unknown>
    },
  ): {
      subscription: SNSSubscription
      logicalId: string
    } {
    const protocol = url.startsWith('https://') ? 'https' : 'http'

    return Messaging.subscribe(topicLogicalId, {
      ...options,
      protocol,
      endpoint: url,
    })
  }

  /**
   * Subscribe SMS to topic
  */
  static subscribeSms(
    topicLogicalId: string,
    phoneNumber: string,
    options: {
      slug: string
      environment: EnvironmentType
    },
  ): {
      subscription: SNSSubscription
      logicalId: string
    } {
    return Messaging.subscribe(topicLogicalId, {
      ...options,
      protocol: 'sms',
      endpoint: phoneNumber,
    })
  }

  /**
   * Create a topic policy
  */
  static setTopicPolicy(
    topicLogicalId: string,
    options: TopicPolicyOptions,
  ): {
      policy: SNSTopicPolicy
      logicalId: string
    } {
    const {
      slug,
      environment,
      allowedPrincipals,
      allowedServices,
      actions = 'SNS:Publish',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'topic-policy',
    })

    const logicalId = generateLogicalId(resourceName)

    const principal: Record<string, unknown> = {}

    if (allowedPrincipals) {
      principal.AWS = allowedPrincipals
    }

    if (allowedServices) {
      principal.Service = allowedServices
    }

    const policy: SNSTopicPolicy = {
      Type: 'AWS::SNS::TopicPolicy',
      Properties: {
        Topics: [Fn.Ref(topicLogicalId) as unknown as string],
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: principal,
              Action: actions,
              Resource: Fn.Ref(topicLogicalId) as unknown as string,
            },
          ],
        },
      },
    }

    return { policy, logicalId }
  }

  /**
   * Allow CloudWatch Alarms to publish to topic
  */
  static allowCloudWatchAlarms(
    topicLogicalId: string,
    options: {
      slug: string
      environment: EnvironmentType
    },
  ): {
      policy: SNSTopicPolicy
      logicalId: string
    } {
    return Messaging.setTopicPolicy(topicLogicalId, {
      ...options,
      allowedServices: 'cloudwatch.amazonaws.com',
      actions: 'SNS:Publish',
    })
  }

  /**
   * Allow EventBridge to publish to topic
  */
  static allowEventBridge(
    topicLogicalId: string,
    options: {
      slug: string
      environment: EnvironmentType
    },
  ): {
      policy: SNSTopicPolicy
      logicalId: string
    } {
    return Messaging.setTopicPolicy(topicLogicalId, {
      ...options,
      allowedServices: 'events.amazonaws.com',
      actions: 'SNS:Publish',
    })
  }

  /**
   * Allow S3 to publish to topic
  */
  static allowS3(
    topicLogicalId: string,
    options: {
      slug: string
      environment: EnvironmentType
    },
  ): {
      policy: SNSTopicPolicy
      logicalId: string
    } {
    return Messaging.setTopicPolicy(topicLogicalId, {
      ...options,
      allowedServices: 's3.amazonaws.com',
      actions: 'SNS:Publish',
    })
  }

  /**
   * Enable encryption on topic
  */
  static enableEncryption(
    topic: SNSTopic,
    kmsKeyId: string,
  ): SNSTopic {
    if (!topic.Properties) {
      topic.Properties = {}
    }

    topic.Properties.KmsMasterKeyId = kmsKeyId

    return topic
  }

  /**
   * Add inline subscription to topic
  */
  static addInlineSubscription(
    topic: SNSTopic,
    protocol: SubscriptionOptions['protocol'],
    endpoint: string,
  ): SNSTopic {
    if (!topic.Properties) {
      topic.Properties = {}
    }

    if (!topic.Properties.Subscription) {
      topic.Properties.Subscription = []
    }

    topic.Properties.Subscription.push({
      Protocol: protocol,
      Endpoint: endpoint,
    })

    return topic
  }

  /**
   * Common filter policy patterns
  */
  static readonly FilterPolicies = {
    /**
     * Filter by event type
    */
    eventType: (types: string[]): { eventType: string[] } => ({
      eventType: types,
    }),

    /**
     * Filter by status
    */
    status: (statuses: string[]): { status: string[] } => ({
      status: statuses,
    }),

    /**
     * Filter by numeric range
    */
    numericRange: (attribute: string, min: number, max: number): Record<string, Array<{ numeric: (string | number)[] }>> => ({
      [attribute]: [{ numeric: ['>=', min, '<=', max] }],
    }),

    /**
     * Filter by string prefix
    */
    prefix: (attribute: string, prefixValue: string): Record<string, Array<{ prefix: string }>> => ({
      [attribute]: [{ prefix: prefixValue }],
    }),

    /**
     * Filter by multiple attributes (AND logic)
    */
    and: (...policies: Record<string, unknown>[]): Record<string, unknown> => {
      return Object.assign({}, ...policies)
    },

    /**
     * Filter by exists/not exists
    */
    exists: (attribute: string, existsValue: boolean): Record<string, Array<{ exists: boolean }>> => ({
      [attribute]: [{ exists: existsValue }],
    }),
  } as const

  /**
   * Common use cases for SNS topics
  */
  static readonly UseCases = {
    /**
     * Create alert topic for CloudWatch alarms
    */
    createAlertTopic: (options: TopicOptions): { topic: SNSTopic; logicalId: string } => {
      return Messaging.createTopic({
        ...options,
        topicName: options.topicName || `${options.slug}-${options.environment}-alerts`,
        displayName: options.displayName || 'Alert Notifications',
      })
    },

    /**
     * Create event fanout topic for distributing events
    */
    createEventFanout: (options: TopicOptions): { topic: SNSTopic; logicalId: string } => {
      return Messaging.createTopic({
        ...options,
        topicName: options.topicName || `${options.slug}-${options.environment}-events`,
        displayName: options.displayName || 'Event Fanout',
      })
    },

    /**
     * Create notification topic for user notifications
    */
    createNotificationTopic: (options: TopicOptions): { topic: SNSTopic; logicalId: string } => {
      return Messaging.createTopic({
        ...options,
        topicName: options.topicName || `${options.slug}-${options.environment}-notifications`,
        displayName: options.displayName || 'User Notifications',
      })
    },
  } as const
}
