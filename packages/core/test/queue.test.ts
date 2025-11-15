import { describe, expect, it } from 'bun:test'
import { Queue } from '../src/modules/queue'
import { TemplateBuilder } from '../src/template-builder'

describe('Queue Module', () => {
  describe('createQueue', () => {
    it('should create SQS queue with default settings', () => {
      const { queue, logicalId } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
      })

      expect(queue.Type).toBe('AWS::SQS::Queue')
      expect(queue.Properties?.DelaySeconds).toBe(0)
      expect(queue.Properties?.VisibilityTimeout).toBe(30)
      expect(queue.Properties?.MessageRetentionPeriod).toBe(345600) // 4 days
      expect(queue.Properties?.MaximumMessageSize).toBe(262144) // 256 KB
      expect(queue.Properties?.ReceiveMessageWaitTimeSeconds).toBe(0)
      expect(queue.Properties?.SqsManagedSseEnabled).toBe(true)
      expect(logicalId).toBeDefined()
    })

    it('should create FIFO queue', () => {
      const { queue } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
        fifo: true,
      })

      expect(queue.Properties?.FifoQueue).toBe(true)
      expect(queue.Properties?.QueueName).toContain('.fifo')
    })

    it('should enable content-based deduplication for FIFO queues', () => {
      const { queue } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
        fifo: true,
        contentBasedDeduplication: true,
      })

      expect(queue.Properties?.ContentBasedDeduplication).toBe(true)
    })

    it('should support custom KMS encryption', () => {
      const { queue } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
        encrypted: true,
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789:key/abc',
      })

      expect(queue.Properties?.KmsMasterKeyId).toBe('arn:aws:kms:us-east-1:123456789:key/abc')
      expect(queue.Properties?.SqsManagedSseEnabled).toBeUndefined()
    })

    it('should support custom queue settings', () => {
      const { queue } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
        delaySeconds: 10,
        visibilityTimeout: 60,
        messageRetentionPeriod: 1209600, // 14 days
        maxMessageSize: 131072, // 128 KB
        receiveMessageWaitTime: 20,
      })

      expect(queue.Properties?.DelaySeconds).toBe(10)
      expect(queue.Properties?.VisibilityTimeout).toBe(60)
      expect(queue.Properties?.MessageRetentionPeriod).toBe(1209600)
      expect(queue.Properties?.MaximumMessageSize).toBe(131072)
      expect(queue.Properties?.ReceiveMessageWaitTimeSeconds).toBe(20)
    })

    it('should support custom queue name', () => {
      const { queue } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
        name: 'custom-queue',
      })

      expect(queue.Properties?.QueueName).toBe('custom-queue')
    })

    it('should disable encryption when requested', () => {
      const { queue } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
        encrypted: false,
      })

      expect(queue.Properties?.KmsMasterKeyId).toBeUndefined()
      expect(queue.Properties?.SqsManagedSseEnabled).toBeUndefined()
    })
  })

  describe('createDeadLetterQueue', () => {
    it('should create dead letter queue with default settings', () => {
      const { deadLetterQueue, updatedSourceQueue, deadLetterLogicalId } = Queue.createDeadLetterQueue(
        'source-queue-id',
        {
          slug: 'my-app',
          environment: 'production',
        },
      )

      expect(deadLetterQueue.Type).toBe('AWS::SQS::Queue')
      expect(deadLetterQueue.Properties?.MessageRetentionPeriod).toBe(1209600) // 14 days
      expect(updatedSourceQueue.Properties?.RedrivePolicy?.maxReceiveCount).toBe(3)
      expect(deadLetterLogicalId).toBeDefined()
    })

    it('should support custom max receive count', () => {
      const { updatedSourceQueue } = Queue.createDeadLetterQueue('source-queue-id', {
        slug: 'my-app',
        environment: 'production',
        maxReceiveCount: 5,
      })

      expect(updatedSourceQueue.Properties?.RedrivePolicy?.maxReceiveCount).toBe(5)
    })
  })

  describe('createSchedule', () => {
    it('should create EventBridge rule with cron schedule', () => {
      const { rule, logicalId } = Queue.createSchedule('cron(0 12 * * ? *)', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(rule.Type).toBe('AWS::Events::Rule')
      expect(rule.Properties.ScheduleExpression).toBe('cron(0 12 * * ? *)')
      expect(rule.Properties.State).toBe('ENABLED')
      expect(rule.Properties.Targets).toEqual([])
      expect(logicalId).toBeDefined()
    })

    it('should support custom name and description', () => {
      const { rule } = Queue.createSchedule('cron(0 12 * * ? *)', {
        slug: 'my-app',
        environment: 'production',
        name: 'daily-task',
        description: 'Runs daily at noon',
      })

      expect(rule.Properties.Name).toBe('daily-task')
      expect(rule.Properties.Description).toBe('Runs daily at noon')
    })

    it('should support disabled state', () => {
      const { rule } = Queue.createSchedule('cron(0 12 * * ? *)', {
        slug: 'my-app',
        environment: 'production',
        enabled: false,
      })

      expect(rule.Properties.State).toBe('DISABLED')
    })
  })

  describe('scheduleEcsTask', () => {
    it('should create EventBridge rule for ECS task', () => {
      const { rule, logicalId } = Queue.scheduleEcsTask(
        'cron(0 2 * * ? *)',
        'arn:aws:iam::123456789:role/ecsEventsRole',
        {
          slug: 'my-app',
          environment: 'production',
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789:task-definition/my-task:1',
          clusterArn: 'arn:aws:ecs:us-east-1:123456789:cluster/my-cluster',
          subnets: ['subnet-1', 'subnet-2'],
          securityGroups: ['sg-123'],
        },
      )

      expect(rule.Type).toBe('AWS::Events::Rule')
      expect(rule.Properties.ScheduleExpression).toBe('cron(0 2 * * ? *)')
      expect(rule.Properties.Targets).toHaveLength(1)
      expect(rule.Properties.Targets[0].Arn).toBe('arn:aws:ecs:us-east-1:123456789:cluster/my-cluster')
      expect(rule.Properties.Targets[0].RoleArn).toBe('arn:aws:iam::123456789:role/ecsEventsRole')
      expect(rule.Properties.Targets[0].EcsParameters?.TaskDefinitionArn).toBe('arn:aws:ecs:us-east-1:123456789:task-definition/my-task:1')
      expect(rule.Properties.Targets[0].EcsParameters?.LaunchType).toBe('FARGATE')
      expect(rule.Properties.Targets[0].EcsParameters?.NetworkConfiguration?.awsvpcConfiguration.Subnets).toEqual(['subnet-1', 'subnet-2'])
      expect(rule.Properties.Targets[0].EcsParameters?.NetworkConfiguration?.awsvpcConfiguration.SecurityGroups).toEqual(['sg-123'])
      expect(logicalId).toBeDefined()
    })

    it('should support public IP assignment', () => {
      const { rule } = Queue.scheduleEcsTask(
        'cron(0 2 * * ? *)',
        'arn:aws:iam::123456789:role/ecsEventsRole',
        {
          slug: 'my-app',
          environment: 'production',
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789:task-definition/my-task:1',
          clusterArn: 'arn:aws:ecs:us-east-1:123456789:cluster/my-cluster',
          subnets: ['subnet-1'],
          assignPublicIp: true,
        },
      )

      expect(rule.Properties.Targets[0].EcsParameters?.NetworkConfiguration?.awsvpcConfiguration.AssignPublicIp).toBe('ENABLED')
    })

    it('should support custom task count', () => {
      const { rule } = Queue.scheduleEcsTask(
        'cron(0 2 * * ? *)',
        'arn:aws:iam::123456789:role/ecsEventsRole',
        {
          slug: 'my-app',
          environment: 'production',
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789:task-definition/my-task:1',
          clusterArn: 'arn:aws:ecs:us-east-1:123456789:cluster/my-cluster',
          subnets: ['subnet-1'],
          taskCount: 3,
        },
      )

      expect(rule.Properties.Targets[0].EcsParameters?.TaskCount).toBe(3)
    })

    it('should support container overrides', () => {
      const { rule } = Queue.scheduleEcsTask(
        'cron(0 2 * * ? *)',
        'arn:aws:iam::123456789:role/ecsEventsRole',
        {
          slug: 'my-app',
          environment: 'production',
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789:task-definition/my-task:1',
          clusterArn: 'arn:aws:ecs:us-east-1:123456789:cluster/my-cluster',
          subnets: ['subnet-1'],
          containerOverrides: [
            {
              name: 'app',
              environment: [
                { name: 'ENV', value: 'production' },
              ],
              command: ['npm', 'run', 'job'],
            },
          ],
        },
      )

      expect(rule.Properties.Targets[0].Input).toBeDefined()
      const input = JSON.parse(rule.Properties.Targets[0].Input!)
      expect(input.containerOverrides).toHaveLength(1)
      expect(input.containerOverrides[0].name).toBe('app')
    })
  })

  describe('scheduleLambda', () => {
    it('should create EventBridge rule for Lambda function', () => {
      const { rule, logicalId } = Queue.scheduleLambda('cron(0 9 * * ? *)', {
        slug: 'my-app',
        environment: 'production',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:my-function',
      })

      expect(rule.Type).toBe('AWS::Events::Rule')
      expect(rule.Properties.ScheduleExpression).toBe('cron(0 9 * * ? *)')
      expect(rule.Properties.Targets).toHaveLength(1)
      expect(rule.Properties.Targets[0].Arn).toBe('arn:aws:lambda:us-east-1:123456789:function:my-function')
      expect(logicalId).toBeDefined()
    })

    it('should support custom input', () => {
      const { rule } = Queue.scheduleLambda('cron(0 9 * * ? *)', {
        slug: 'my-app',
        environment: 'production',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:my-function',
        input: {
          action: 'process',
          batch: 100,
        },
      })

      expect(rule.Properties.Targets[0].Input).toBeDefined()
      const input = JSON.parse(rule.Properties.Targets[0].Input!)
      expect(input.action).toBe('process')
      expect(input.batch).toBe(100)
    })
  })

  describe('scheduleSqsMessage', () => {
    it('should create EventBridge rule for SQS message', () => {
      const { rule, logicalId } = Queue.scheduleSqsMessage('rate(5 minutes)', {
        slug: 'my-app',
        environment: 'production',
        queueArn: 'arn:aws:sqs:us-east-1:123456789:my-queue',
      })

      expect(rule.Type).toBe('AWS::Events::Rule')
      expect(rule.Properties.ScheduleExpression).toBe('rate(5 minutes)')
      expect(rule.Properties.Targets).toHaveLength(1)
      expect(rule.Properties.Targets[0].Arn).toBe('arn:aws:sqs:us-east-1:123456789:my-queue')
      expect(logicalId).toBeDefined()
    })

    it('should support FIFO queue with message group ID', () => {
      const { rule } = Queue.scheduleSqsMessage('rate(5 minutes)', {
        slug: 'my-app',
        environment: 'production',
        queueArn: 'arn:aws:sqs:us-east-1:123456789:my-queue.fifo',
        messageGroupId: 'scheduled-messages',
      })

      expect(rule.Properties.Targets[0].SqsParameters?.MessageGroupId).toBe('scheduled-messages')
    })
  })

  describe('addTarget', () => {
    it('should add target to existing rule', () => {
      const { rule } = Queue.createSchedule('cron(0 12 * * ? *)', {
        slug: 'my-app',
        environment: 'production',
      })

      Queue.addTarget(rule, {
        id: 'target1',
        arn: 'arn:aws:lambda:us-east-1:123456789:function:my-function',
      })

      expect(rule.Properties.Targets).toHaveLength(1)
      expect(rule.Properties.Targets[0].Id).toBe('target1')
      expect(rule.Properties.Targets[0].Arn).toBe('arn:aws:lambda:us-east-1:123456789:function:my-function')
    })

    it('should add multiple targets to rule', () => {
      const { rule } = Queue.createSchedule('cron(0 12 * * ? *)', {
        slug: 'my-app',
        environment: 'production',
      })

      Queue.addTarget(rule, {
        id: 'target1',
        arn: 'arn:aws:lambda:us-east-1:123456789:function:function1',
      })

      Queue.addTarget(rule, {
        id: 'target2',
        arn: 'arn:aws:lambda:us-east-1:123456789:function:function2',
        input: { batch: 50 },
      })

      expect(rule.Properties.Targets).toHaveLength(2)
    })
  })

  describe('toCronExpression', () => {
    it('should wrap plain cron in cron()', () => {
      expect(Queue.toCronExpression('0 12 * * ? *')).toBe('cron(0 12 * * ? *)')
    })

    it('should not wrap if already wrapped', () => {
      expect(Queue.toCronExpression('cron(0 12 * * ? *)')).toBe('cron(0 12 * * ? *)')
      expect(Queue.toCronExpression('rate(5 minutes)')).toBe('rate(5 minutes)')
    })
  })

  describe('rateExpression', () => {
    it('should create rate expression', () => {
      expect(Queue.rateExpression(5, 'minutes')).toBe('rate(5 minutes)')
      expect(Queue.rateExpression(1, 'hour')).toBe('rate(1 hour)')
      expect(Queue.rateExpression(2, 'days')).toBe('rate(2 days)')
    })
  })

  describe('CronExpressions', () => {
    it('should provide common cron expressions', () => {
      expect(Queue.CronExpressions.EveryMinute).toBe('cron(* * * * ? *)')
      expect(Queue.CronExpressions.Every5Minutes).toBe('cron(*/5 * * * ? *)')
      expect(Queue.CronExpressions.Hourly).toBe('cron(0 * * * ? *)')
      expect(Queue.CronExpressions.Daily).toBe('cron(0 0 * * ? *)')
      expect(Queue.CronExpressions.Weekly).toBe('cron(0 0 ? * SUN *)')
      expect(Queue.CronExpressions.Monthly).toBe('cron(0 0 1 * ? *)')
    })
  })

  describe('RateExpressions', () => {
    it('should provide common rate expressions', () => {
      expect(Queue.RateExpressions.Every1Minute).toBe('rate(1 minute)')
      expect(Queue.RateExpressions.Every5Minutes).toBe('rate(5 minutes)')
      expect(Queue.RateExpressions.Every1Hour).toBe('rate(1 hour)')
      expect(Queue.RateExpressions.Every1Day).toBe('rate(1 day)')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create queue with dead letter queue', () => {
      const template = new TemplateBuilder('Queue Infrastructure')

      // Create main queue
      const { queue, logicalId: queueId } = Queue.createQueue({
        slug: 'my-app',
        environment: 'production',
      })

      // Create DLQ
      const { deadLetterQueue, updatedSourceQueue, deadLetterLogicalId } = Queue.createDeadLetterQueue(queueId, {
        slug: 'my-app',
        environment: 'production',
        maxReceiveCount: 5,
      })

      // Merge updated redrive policy into main queue
      queue.Properties = {
        ...queue.Properties,
        ...updatedSourceQueue.Properties,
      }

      template.addResource(queueId, queue)
      template.addResource(deadLetterLogicalId, deadLetterQueue)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[queueId].Type).toBe('AWS::SQS::Queue')
      expect(result.Resources[deadLetterLogicalId].Type).toBe('AWS::SQS::Queue')
    })

    it('should create scheduled Lambda execution', () => {
      const template = new TemplateBuilder('Scheduled Lambda')

      const { rule, logicalId } = Queue.scheduleLambda(Queue.CronExpressions.DailyAt9AM, {
        slug: 'my-app',
        environment: 'production',
        functionArn: 'arn:aws:lambda:us-east-1:123456789:function:daily-report',
        input: {
          reportType: 'daily',
          recipients: ['admin@example.com'],
        },
      })

      template.addResource(logicalId, rule)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId].Type).toBe('AWS::Events::Rule')
      expect(result.Resources[logicalId].Properties.Targets).toHaveLength(1)
    })

    it('should create scheduled ECS task', () => {
      const template = new TemplateBuilder('Scheduled ECS Task')

      const { rule, logicalId } = Queue.scheduleEcsTask(
        Queue.RateExpressions.Every6Hours,
        'arn:aws:iam::123456789:role/ecsEventsRole',
        {
          slug: 'my-app',
          environment: 'production',
          taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789:task-definition/cleanup:1',
          clusterArn: 'arn:aws:ecs:us-east-1:123456789:cluster/production',
          subnets: ['subnet-1', 'subnet-2'],
          securityGroups: ['sg-123'],
        },
      )

      template.addResource(logicalId, rule)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId].Properties.ScheduleExpression).toBe('rate(6 hours)')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Queue Test')

      const { queue, logicalId } = Queue.createQueue({
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, queue)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::SQS::Queue')
      expect(parsed.Resources[logicalId].Properties.QueueName).toBeDefined()
    })
  })
})
