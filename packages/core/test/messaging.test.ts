import { describe, expect, it } from 'bun:test'
import { Messaging } from '../src/modules/messaging'
import { TemplateBuilder } from '../src/template-builder'

describe('Messaging Module', () => {
  describe('createTopic', () => {
    it('should create SNS topic with default settings', () => {
      const { topic, logicalId } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
      })

      expect(topic.Type).toBe('AWS::SNS::Topic')
      expect(topic.Properties?.TopicName).toBeDefined()
      expect(topic.Properties?.DisplayName).toBeDefined()
      expect(topic.Properties?.Tags).toHaveLength(2)
      expect(logicalId).toBeDefined()
    })

    it('should support custom topic name', () => {
      const { topic } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
        topicName: 'custom-topic',
      })

      expect(topic.Properties?.TopicName).toBe('custom-topic')
    })

    it('should support custom display name', () => {
      const { topic } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
        displayName: 'My Custom Topic',
      })

      expect(topic.Properties?.DisplayName).toBe('My Custom Topic')
    })

    it('should support KMS encryption', () => {
      const { topic } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
        encrypted: true,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/abc',
      })

      expect(topic.Properties?.KmsMasterKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
    })
  })

  describe('subscribe', () => {
    it('should create subscription', () => {
      const { subscription, logicalId } = Messaging.subscribe('topic-id', {
        slug: 'my-app',
        environment: 'production',
        protocol: 'email',
        endpoint: 'user@example.com',
      })

      expect(subscription.Type).toBe('AWS::SNS::Subscription')
      expect(subscription.Properties.Protocol).toBe('email')
      expect(subscription.Properties.Endpoint).toBe('user@example.com')
      expect(subscription.Properties.RawMessageDelivery).toBe(false)
      expect(logicalId).toBeDefined()
    })

    it('should support filter policy', () => {
      const { subscription } = Messaging.subscribe('topic-id', {
        slug: 'my-app',
        environment: 'production',
        protocol: 'sqs',
        endpoint: 'arn:aws:sqs:us-east-1:123456789:my-queue',
        filterPolicy: {
          eventType: ['order.created', 'order.updated'],
        },
      })

      expect(subscription.Properties.FilterPolicy).toEqual({
        eventType: ['order.created', 'order.updated'],
      })
    })

    it('should support raw message delivery', () => {
      const { subscription } = Messaging.subscribe('topic-id', {
        slug: 'my-app',
        environment: 'production',
        protocol: 'sqs',
        endpoint: 'arn:aws:sqs:us-east-1:123456789:my-queue',
        rawMessageDelivery: true,
      })

      expect(subscription.Properties.RawMessageDelivery).toBe(true)
    })
  })

  describe('subscribeEmail', () => {
    it('should create email subscription', () => {
      const { subscription } = Messaging.subscribeEmail('topic-id', 'admin@example.com', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(subscription.Properties.Protocol).toBe('email')
      expect(subscription.Properties.Endpoint).toBe('admin@example.com')
    })

    it('should support filter policy for email', () => {
      const { subscription } = Messaging.subscribeEmail('topic-id', 'admin@example.com', {
        slug: 'my-app',
        environment: 'production',
        filterPolicy: { priority: ['high', 'critical'] },
      })

      expect(subscription.Properties.FilterPolicy).toEqual({ priority: ['high', 'critical'] })
    })
  })

  describe('subscribeLambda', () => {
    it('should create Lambda subscription', () => {
      const { subscription } = Messaging.subscribeLambda('topic-id', 'arn:aws:lambda:us-east-1:123456789:function:handler', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(subscription.Properties.Protocol).toBe('lambda')
      expect(subscription.Properties.Endpoint).toBe('arn:aws:lambda:us-east-1:123456789:function:handler')
      expect(subscription.Properties.RawMessageDelivery).toBe(true)
    })
  })

  describe('subscribeSqs', () => {
    it('should create SQS subscription', () => {
      const { subscription } = Messaging.subscribeSqs('topic-id', 'arn:aws:sqs:us-east-1:123456789:my-queue', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(subscription.Properties.Protocol).toBe('sqs')
      expect(subscription.Properties.Endpoint).toBe('arn:aws:sqs:us-east-1:123456789:my-queue')
    })

    it('should support raw message delivery for SQS', () => {
      const { subscription } = Messaging.subscribeSqs('topic-id', 'arn:aws:sqs:us-east-1:123456789:my-queue', {
        slug: 'my-app',
        environment: 'production',
        rawMessageDelivery: true,
      })

      expect(subscription.Properties.RawMessageDelivery).toBe(true)
    })
  })

  describe('subscribeHttp', () => {
    it('should create HTTP subscription', () => {
      const { subscription } = Messaging.subscribeHttp('topic-id', 'http://example.com/webhook', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(subscription.Properties.Protocol).toBe('http')
      expect(subscription.Properties.Endpoint).toBe('http://example.com/webhook')
    })

    it('should create HTTPS subscription', () => {
      const { subscription } = Messaging.subscribeHttp('topic-id', 'https://example.com/webhook', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(subscription.Properties.Protocol).toBe('https')
      expect(subscription.Properties.Endpoint).toBe('https://example.com/webhook')
    })
  })

  describe('subscribeSms', () => {
    it('should create SMS subscription', () => {
      const { subscription } = Messaging.subscribeSms('topic-id', '+1234567890', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(subscription.Properties.Protocol).toBe('sms')
      expect(subscription.Properties.Endpoint).toBe('+1234567890')
    })
  })

  describe('setTopicPolicy', () => {
    it('should create topic policy for AWS principals', () => {
      const { policy, logicalId } = Messaging.setTopicPolicy('topic-id', {
        slug: 'my-app',
        environment: 'production',
        allowedPrincipals: 'arn:aws:iam::123456789:root',
        actions: 'SNS:Publish',
      })

      expect(policy.Type).toBe('AWS::SNS::TopicPolicy')
      expect((policy.Properties.PolicyDocument.Statement[0].Principal as any).AWS).toBe('arn:aws:iam::123456789:root')
      expect(policy.Properties.PolicyDocument.Statement[0].Action).toBe('SNS:Publish')
      expect(logicalId).toBeDefined()
    })

    it('should create topic policy for service principals', () => {
      const { policy } = Messaging.setTopicPolicy('topic-id', {
        slug: 'my-app',
        environment: 'production',
        allowedServices: 'lambda.amazonaws.com',
        actions: 'SNS:Publish',
      })

      expect((policy.Properties.PolicyDocument.Statement[0].Principal as any).Service).toBe('lambda.amazonaws.com')
    })

    it('should support multiple principals', () => {
      const { policy } = Messaging.setTopicPolicy('topic-id', {
        slug: 'my-app',
        environment: 'production',
        allowedPrincipals: ['arn:aws:iam::123456789:root', 'arn:aws:iam::987654321:root'],
      })

      expect((policy.Properties.PolicyDocument.Statement[0].Principal as any).AWS).toEqual([
        'arn:aws:iam::123456789:root',
        'arn:aws:iam::987654321:root',
      ])
    })

    it('should support multiple actions', () => {
      const { policy } = Messaging.setTopicPolicy('topic-id', {
        slug: 'my-app',
        environment: 'production',
        allowedServices: 's3.amazonaws.com',
        actions: ['SNS:Publish', 'SNS:Subscribe'],
      })

      expect(policy.Properties.PolicyDocument.Statement[0].Action).toEqual(['SNS:Publish', 'SNS:Subscribe'])
    })
  })

  describe('allowCloudWatchAlarms', () => {
    it('should create policy for CloudWatch Alarms', () => {
      const { policy } = Messaging.allowCloudWatchAlarms('topic-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect((policy.Properties.PolicyDocument.Statement[0].Principal as any).Service).toBe('cloudwatch.amazonaws.com')
      expect(policy.Properties.PolicyDocument.Statement[0].Action).toBe('SNS:Publish')
    })
  })

  describe('allowEventBridge', () => {
    it('should create policy for EventBridge', () => {
      const { policy } = Messaging.allowEventBridge('topic-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect((policy.Properties.PolicyDocument.Statement[0].Principal as any).Service).toBe('events.amazonaws.com')
    })
  })

  describe('allowS3', () => {
    it('should create policy for S3', () => {
      const { policy } = Messaging.allowS3('topic-id', {
        slug: 'my-app',
        environment: 'production',
      })

      expect((policy.Properties.PolicyDocument.Statement[0].Principal as any).Service).toBe('s3.amazonaws.com')
    })
  })

  describe('enableEncryption', () => {
    it('should enable encryption on topic', () => {
      const { topic } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
      })

      Messaging.enableEncryption(topic, 'arn:aws:kms:us-east-1:123456789:key/abc')

      expect(topic.Properties?.KmsMasterKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
    })
  })

  describe('addInlineSubscription', () => {
    it('should add inline subscription to topic', () => {
      const { topic } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
      })

      Messaging.addInlineSubscription(topic, 'email', 'user@example.com')

      expect(topic.Properties?.Subscription).toHaveLength(1)
      expect(topic.Properties?.Subscription![0].Protocol).toBe('email')
      expect(topic.Properties?.Subscription![0].Endpoint).toBe('user@example.com')
    })

    it('should add multiple inline subscriptions', () => {
      const { topic } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
      })

      Messaging.addInlineSubscription(topic, 'email', 'user1@example.com')
      Messaging.addInlineSubscription(topic, 'email', 'user2@example.com')

      expect(topic.Properties?.Subscription).toHaveLength(2)
    })
  })

  describe('FilterPolicies', () => {
    it('should create event type filter', () => {
      const filter = Messaging.FilterPolicies.eventType(['order.created', 'order.updated'])

      expect(filter).toEqual({
        eventType: ['order.created', 'order.updated'],
      })
    })

    it('should create status filter', () => {
      const filter = Messaging.FilterPolicies.status(['success', 'failed'])

      expect(filter).toEqual({
        status: ['success', 'failed'],
      })
    })

    it('should create numeric range filter', () => {
      const filter = Messaging.FilterPolicies.numericRange('price', 10, 100)

      expect(filter).toEqual({
        price: [{ numeric: ['>=', 10, '<=', 100] }],
      })
    })

    it('should create prefix filter', () => {
      const filter = Messaging.FilterPolicies.prefix('eventType', 'order.')

      expect(filter).toEqual({
        eventType: [{ prefix: 'order.' }],
      })
    })

    it('should create exists filter', () => {
      const filter = Messaging.FilterPolicies.exists('userId', true)

      expect(filter).toEqual({
        userId: [{ exists: true }],
      })
    })

    it('should combine multiple filters with AND', () => {
      const filter = Messaging.FilterPolicies.and(
        Messaging.FilterPolicies.eventType(['order.created']),
        Messaging.FilterPolicies.status(['success']),
      )

      expect(filter).toEqual({
        eventType: ['order.created'],
        status: ['success'],
      })
    })
  })

  describe('UseCases', () => {
    it('should create alert topic', () => {
      const { topic } = Messaging.UseCases.createAlertTopic({
        slug: 'my-app',
        environment: 'production',
      })

      expect(topic.Properties?.TopicName).toContain('alerts')
      expect(topic.Properties?.DisplayName).toBe('Alert Notifications')
    })

    it('should create event fanout topic', () => {
      const { topic } = Messaging.UseCases.createEventFanout({
        slug: 'my-app',
        environment: 'production',
      })

      expect(topic.Properties?.TopicName).toContain('events')
      expect(topic.Properties?.DisplayName).toBe('Event Fanout')
    })

    it('should create notification topic', () => {
      const { topic } = Messaging.UseCases.createNotificationTopic({
        slug: 'my-app',
        environment: 'production',
      })

      expect(topic.Properties?.TopicName).toContain('notifications')
      expect(topic.Properties?.DisplayName).toBe('User Notifications')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create topic with multiple subscriptions', () => {
      const template = new TemplateBuilder('SNS Topic with Subscriptions')

      // Create topic
      const { topic, logicalId: topicId } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
      })

      // Add subscriptions
      const { subscription: emailSub, logicalId: emailSubId } = Messaging.subscribeEmail(topicId, 'admin@example.com', {
        slug: 'my-app',
        environment: 'production',
      })

      const { subscription: lambdaSub, logicalId: lambdaSubId } = Messaging.subscribeLambda(
        topicId,
        'arn:aws:lambda:us-east-1:123456789:function:handler',
        {
          slug: 'my-app',
          environment: 'production',
        },
      )

      template.addResource(topicId, topic)
      template.addResource(emailSubId, emailSub)
      template.addResource(lambdaSubId, lambdaSub)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(3)
      expect(result.Resources[topicId].Type).toBe('AWS::SNS::Topic')
      expect(result.Resources[emailSubId].Type).toBe('AWS::SNS::Subscription')
      expect(result.Resources[lambdaSubId].Type).toBe('AWS::SNS::Subscription')
    })

    it('should create fanout pattern (SNS to multiple SQS)', () => {
      const template = new TemplateBuilder('Event Fanout')

      const { topic, logicalId: topicId } = Messaging.UseCases.createEventFanout({
        slug: 'my-app',
        environment: 'production',
      })

      const { subscription: queue1Sub, logicalId: queue1SubId } = Messaging.subscribeSqs(
        topicId,
        'arn:aws:sqs:us-east-1:123456789:queue1',
        {
          slug: 'my-app',
          environment: 'production',
          filterPolicy: Messaging.FilterPolicies.eventType(['order.created']),
        },
      )

      const { subscription: queue2Sub, logicalId: queue2SubId } = Messaging.subscribeSqs(
        topicId,
        'arn:aws:sqs:us-east-1:123456789:queue2',
        {
          slug: 'my-app',
          environment: 'production',
          filterPolicy: Messaging.FilterPolicies.eventType(['order.updated']),
        },
      )

      template.addResource(topicId, topic)
      template.addResource(queue1SubId, queue1Sub)
      template.addResource(queue2SubId, queue2Sub)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(3)
      expect(result.Resources[queue1SubId]!.Properties!.FilterPolicy).toBeDefined()
      expect(result.Resources[queue2SubId]!.Properties!.FilterPolicy).toBeDefined()
    })

    it('should create topic with policy', () => {
      const template = new TemplateBuilder('Topic with Policy')

      const { topic, logicalId: topicId } = Messaging.createTopic({
        slug: 'my-app',
        environment: 'production',
      })

      const { policy, logicalId: policyId } = Messaging.allowCloudWatchAlarms(topicId, {
        slug: 'my-app',
        environment: 'production',
      })

      template.addResource(topicId, topic)
      template.addResource(policyId, policy)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[policyId].Type).toBe('AWS::SNS::TopicPolicy')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Messaging Test')

      const { topic, logicalId } = Messaging.createTopic({
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, topic)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::SNS::Topic')
      expect(parsed.Resources[logicalId].Properties.TopicName).toBeDefined()
    })
  })
})
