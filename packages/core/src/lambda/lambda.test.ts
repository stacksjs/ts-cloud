import { describe, expect, it, beforeEach } from 'bun:test'
import {
  LambdaLayersManager,
  lambdaLayersManager,
  LambdaVersionsManager,
  lambdaVersionsManager,
  LambdaConcurrencyManager,
  lambdaConcurrencyManager,
  LambdaDestinationsManager,
  lambdaDestinationsManager,
  LambdaVPCManager,
  lambdaVPCManager,
  LambdaDLQManager,
  lambdaDLQManager,
} from '.'

describe('Lambda Layers Manager', () => {
  let manager: LambdaLayersManager

  beforeEach(() => {
    manager = new LambdaLayersManager()
  })

  describe('Layer Creation', () => {
    it('should create Lambda layer', () => {
      const layer = manager.createLayer({
        layerName: 'my-layer',
        description: 'Test layer',
        compatibleRuntimes: ['nodejs18.x'],
        content: {
          type: 's3',
          s3Bucket: 'my-bucket',
          s3Key: 'layer.zip',
        },
        size: 1024 * 1024,
      })

      expect(layer.id).toContain('layer')
      expect(layer.layerName).toBe('my-layer')
      expect(layer.version).toBe(1)
      expect(layer.layerArn).toContain('my-layer:1')
    })

    it('should create Node.js dependencies layer', () => {
      const layer = manager.createNodeDependenciesLayer({
        layerName: 'node-deps',
        nodeVersion: '18',
        s3Bucket: 'my-bucket',
        s3Key: 'deps.zip',
      })

      expect(layer.compatibleRuntimes).toContain('nodejs18')
      expect(layer.description).toBe('Node.js dependencies layer')
    })

    it('should create utilities layer', () => {
      const layer = manager.createUtilitiesLayer({
        layerName: 'utils',
        runtimes: ['nodejs18.x', 'python3.9'],
        s3Bucket: 'my-bucket',
        s3Key: 'utils.zip',
      })

      expect(layer.compatibleRuntimes).toHaveLength(2)
    })
  })

  describe('Layer Versioning', () => {
    it('should publish layer version', () => {
      const layer = manager.createLayer({
        layerName: 'test-layer',
        compatibleRuntimes: ['nodejs18.x'],
        content: { type: 's3', s3Bucket: 'bucket', s3Key: 'key' },
        size: 1024,
      })

      const version = manager.publishVersion(layer.id)

      expect(version.version).toBe(2)
      expect(version.layerName).toBe('test-layer')
      expect(layer.version).toBe(2)
      expect(layer.layerArn).toContain(':2')
    })
  })

  describe('Layer Permissions', () => {
    it('should add layer permission', () => {
      const permission = manager.addPermission({
        layerName: 'my-layer',
        version: 1,
        principal: '123456789012',
      })

      expect(permission.id).toContain('permission')
      expect(permission.action).toBe('lambda:GetLayerVersion')
    })

    it('should add organization permission', () => {
      const permission = manager.addPermission({
        layerName: 'my-layer',
        version: 1,
        principal: '*',
        organizationId: 'o-123456',
      })

      expect(permission.organizationId).toBe('o-123456')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate layer CloudFormation', () => {
      const layer = manager.createLayer({
        layerName: 'test-layer',
        compatibleRuntimes: ['nodejs18.x'],
        content: { type: 's3', s3Bucket: 'bucket', s3Key: 'key' },
        size: 1024,
      })

      const cf = manager.generateLayerCF(layer)

      expect(cf.Type).toBe('AWS::Lambda::LayerVersion')
      expect(cf.Properties.LayerName).toBe('test-layer')
      expect(cf.Properties.Content.S3Bucket).toBe('bucket')
    })
  })

  it('should use global instance', () => {
    expect(lambdaLayersManager).toBeInstanceOf(LambdaLayersManager)
  })
})

describe('Lambda Versions Manager', () => {
  let manager: LambdaVersionsManager

  beforeEach(() => {
    manager = new LambdaVersionsManager()
  })

  describe('Version Publishing', () => {
    it('should publish function version', () => {
      const version = manager.publishVersion({
        functionName: 'my-function',
        description: 'Version 1',
        runtime: 'nodejs18.x',
        memorySize: 256,
        timeout: 30,
      })

      expect(version.id).toContain('version')
      expect(version.version).toBe('1')
      expect(version.functionArn).toContain('my-function:1')
    })

    it('should increment version numbers', () => {
      const v1 = manager.publishVersion({
        functionName: 'test-function',
        runtime: 'nodejs18.x',
        memorySize: 256,
        timeout: 30,
      })

      const v2 = manager.publishVersion({
        functionName: 'test-function',
        runtime: 'nodejs18.x',
        memorySize: 256,
        timeout: 30,
      })

      expect(v1.version).toBe('1')
      expect(v2.version).toBe('2')
    })
  })

  describe('Alias Management', () => {
    it('should create alias', () => {
      const alias = manager.createAlias({
        functionName: 'my-function',
        aliasName: 'prod',
        functionVersion: '1',
        description: 'Production alias',
      })

      expect(alias.id).toContain('alias')
      expect(alias.aliasName).toBe('prod')
      expect(alias.aliasArn).toContain(':prod')
    })

    it('should create production alias', () => {
      const alias = manager.createProductionAlias({
        functionName: 'my-function',
        version: '5',
      })

      expect(alias.aliasName).toBe('production')
      expect(alias.functionVersion).toBe('5')
    })

    it('should create staging alias', () => {
      const alias = manager.createStagingAlias({
        functionName: 'my-function',
        version: '3',
      })

      expect(alias.aliasName).toBe('staging')
    })

    it('should update alias', () => {
      const alias = manager.createAlias({
        functionName: 'my-function',
        aliasName: 'test',
        functionVersion: '1',
      })

      const updated = manager.updateAlias(alias.id, '2')

      expect(updated.functionVersion).toBe('2')
    })
  })

  describe('Weighted Routing', () => {
    it('should configure weighted routing', () => {
      const alias = manager.createAlias({
        functionName: 'my-function',
        aliasName: 'prod',
        functionVersion: '1',
      })

      manager.configureWeightedRouting(alias.id, {
        '2': 0.1,
      })

      expect(alias.routingConfig?.additionalVersionWeights).toEqual({ '2': 0.1 })
    })
  })

  describe('Canary Deployments', () => {
    it('should create canary deployment', () => {
      const deployment = manager.createCanaryDeployment({
        functionName: 'my-function',
        fromVersion: '1',
        toVersion: '2',
        aliasName: 'prod',
        canaryWeight: 0.1,
      })

      expect(deployment.id).toContain('deployment')
      expect(deployment.strategy).toBe('canary')
      expect(deployment.status).toBe('in_progress')
    })

    it('should complete deployment', () => {
      const deployment = manager.createCanaryDeployment({
        functionName: 'my-function',
        fromVersion: '1',
        toVersion: '2',
        aliasName: 'prod',
        canaryWeight: 0.1,
      })

      const completed = manager.completeDeployment(deployment.id)

      expect(completed.status).toBe('completed')
      expect(completed.completedAt).toBeDefined()
    })

    it('should rollback deployment', () => {
      const deployment = manager.createCanaryDeployment({
        functionName: 'my-function',
        fromVersion: '1',
        toVersion: '2',
        aliasName: 'prod',
        canaryWeight: 0.1,
      })

      const rolledBack = manager.rollbackDeployment(deployment.id)

      expect(rolledBack.status).toBe('failed')
    })
  })

  it('should use global instance', () => {
    expect(lambdaVersionsManager).toBeInstanceOf(LambdaVersionsManager)
  })
})

describe('Lambda Concurrency Manager', () => {
  let manager: LambdaConcurrencyManager

  beforeEach(() => {
    manager = new LambdaConcurrencyManager()
  })

  describe('Reserved Concurrency', () => {
    it('should set reserved concurrency', () => {
      const config = manager.setReservedConcurrency({
        functionName: 'my-function',
        reservedConcurrency: 10,
      })

      expect(config.id).toContain('concurrency')
      expect(config.reservedConcurrency).toBe(10)
    })
  })

  describe('Provisioned Concurrency', () => {
    it('should set provisioned concurrency', async () => {
      const config = manager.setProvisionedConcurrency({
        functionName: 'my-function',
        qualifier: 'prod',
        provisionedConcurrentExecutions: 5,
      })

      expect(config.id).toContain('provisioned')
      expect(config.status).toBe('pending')

      // Wait for provisioning
      await new Promise(resolve => setTimeout(resolve, 150))

      expect(config.status).toBe('ready')
      expect(config.allocatedConcurrency).toBe(5)
    })

    it('should configure warm pool', () => {
      const config = manager.configureWarmPool({
        functionName: 'my-function',
        alias: 'prod',
        minInstances: 3,
      })

      expect(config.provisionedConcurrentExecutions).toBe(3)
    })
  })

  describe('Concurrency Schedules', () => {
    it('should create schedule', () => {
      const schedule = manager.createSchedule({
        name: 'business-hours',
        functionName: 'my-function',
        qualifier: 'prod',
        schedule: [
          {
            name: 'morning',
            cronExpression: '0 8 * * MON-FRI',
            targetConcurrency: 10,
          },
        ],
      })

      expect(schedule.id).toContain('schedule')
      expect(schedule.schedule).toHaveLength(1)
    })

    it('should create business hours schedule', () => {
      const schedule = manager.createBusinessHoursSchedule({
        functionName: 'my-function',
        qualifier: 'prod',
        businessHoursConcurrency: 10,
        offHoursConcurrency: 2,
      })

      expect(schedule.schedule).toHaveLength(3)
      expect(schedule.schedule[0].name).toBe('business-hours')
      expect(schedule.schedule[1].name).toBe('off-hours')
      expect(schedule.schedule[2].name).toBe('weekend')
    })
  })

  describe('Auto-Scaling', () => {
    it('should configure auto-scaling', () => {
      const config = manager.configureAutoScaling({
        functionName: 'my-function',
        qualifier: 'prod',
        minCapacity: 1,
        maxCapacity: 10,
        targetUtilization: 0.7,
      })

      expect(config.id).toContain('autoscaling')
      expect(config.targetUtilization).toBe(0.7)
    })

    it('should configure predictive scaling', () => {
      const config = manager.configurePredictiveScaling({
        functionName: 'my-function',
        qualifier: 'prod',
        baselineCapacity: 2,
        peakCapacity: 20,
      })

      expect(config.minCapacity).toBe(2)
      expect(config.maxCapacity).toBe(20)
      expect(config.targetUtilization).toBe(0.7)
    })
  })

  it('should use global instance', () => {
    expect(lambdaConcurrencyManager).toBeInstanceOf(LambdaConcurrencyManager)
  })
})

describe('Lambda Destinations Manager', () => {
  let manager: LambdaDestinationsManager

  beforeEach(() => {
    manager = new LambdaDestinationsManager()
  })

  describe('Destination Configuration', () => {
    it('should configure SQS destination', () => {
      const config = manager.configureSQSDestination({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:my-queue',
        onFailure: true,
      })

      expect(config.id).toContain('destination')
      expect(config.failureDestination?.type).toBe('sqs')
    })

    it('should configure SNS destination', () => {
      const config = manager.configureSNSDestination({
        functionName: 'my-function',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
        onSuccess: true,
      })

      expect(config.successDestination?.type).toBe('sns')
    })

    it('should configure EventBridge destination', () => {
      const config = manager.configureEventBridgeDestination({
        functionName: 'my-function',
        eventBusArn: 'arn:aws:events:us-east-1:123456789012:event-bus/default',
        onSuccess: true,
        onFailure: true,
      })

      expect(config.successDestination?.type).toBe('eventbridge')
      expect(config.failureDestination?.type).toBe('eventbridge')
    })

    it('should configure Lambda destination', () => {
      const config = manager.configureLambdaDestination({
        functionName: 'my-function',
        destinationFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:handler',
        onFailure: true,
      })

      expect(config.failureDestination?.type).toBe('lambda')
    })
  })

  describe('EventBridge Integration', () => {
    it('should create EventBridge integration', () => {
      const integration = manager.createEventBridgeIntegration({
        functionName: 'my-function',
        eventBusArn: 'arn:aws:events:us-east-1:123456789012:event-bus/custom',
      })

      expect(integration.id).toContain('eventbridge')
      expect(integration.source).toContain('my-function')
    })
  })

  describe('Sending to Destinations', () => {
    it('should send to success destination', () => {
      manager.configureSQSDestination({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:queue',
        onSuccess: true,
      })

      const record = manager.sendToDestination({
        functionName: 'my-function',
        requestId: 'req-123',
        status: 'success',
        payload: { result: 'ok' },
      })

      expect(record).toBeDefined()
      expect(record?.status).toBe('success')
      expect(record?.destinationType).toBe('sqs')
    })

    it('should send to failure destination', () => {
      manager.configureSNSDestination({
        functionName: 'my-function',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:topic',
        onFailure: true,
      })

      const record = manager.sendToDestination({
        functionName: 'my-function',
        requestId: 'req-456',
        status: 'failure',
        error: 'Function failed',
      })

      expect(record?.status).toBe('failure')
      expect(record?.error).toBe('Function failed')
    })
  })

  it('should use global instance', () => {
    expect(lambdaDestinationsManager).toBeInstanceOf(LambdaDestinationsManager)
  })
})

describe('Lambda VPC Manager', () => {
  let manager: LambdaVPCManager

  beforeEach(() => {
    manager = new LambdaVPCManager()
  })

  describe('VPC Configuration', () => {
    it('should configure VPC', () => {
      const config = manager.configureVPC({
        functionName: 'my-function',
        vpcId: 'vpc-123456',
        subnetIds: ['subnet-1', 'subnet-2'],
        securityGroupIds: ['sg-123456'],
      })

      expect(config.id).toContain('vpc-config')
      expect(config.subnetIds).toHaveLength(2)
    })

    it('should configure private VPC', () => {
      const config = manager.configurePrivateVPC({
        functionName: 'my-function',
        vpcId: 'vpc-123456',
        privateSubnetIds: ['subnet-1', 'subnet-2'],
        securityGroupId: 'sg-123456',
      })

      expect(config.ipv6Allowed).toBe(false)
    })

    it('should configure multi-AZ VPC', () => {
      const config = manager.configureMultiAZVPC({
        functionName: 'my-function',
        vpcId: 'vpc-123456',
        subnetIds: ['subnet-1', 'subnet-2', 'subnet-3'],
        securityGroupIds: ['sg-123456'],
      })

      expect(config.subnetIds.length).toBeGreaterThanOrEqual(2)
    })

    it('should require at least 2 subnets for multi-AZ', () => {
      expect(() => {
        manager.configureMultiAZVPC({
          functionName: 'my-function',
          vpcId: 'vpc-123456',
          subnetIds: ['subnet-1'],
          securityGroupIds: ['sg-123456'],
        })
      }).toThrow('Multi-AZ configuration requires at least 2 subnets')
    })
  })

  describe('VPC Endpoints', () => {
    it('should create S3 endpoint', () => {
      const endpoint = manager.createS3Endpoint({
        vpcId: 'vpc-123456',
        routeTableIds: ['rtb-1'],
      })

      expect(endpoint.endpointType).toBe('Gateway')
      expect(endpoint.serviceName).toContain('s3')
    })

    it('should create DynamoDB endpoint', () => {
      const endpoint = manager.createDynamoDBEndpoint({
        vpcId: 'vpc-123456',
        routeTableIds: ['rtb-1'],
      })

      expect(endpoint.serviceName).toContain('dynamodb')
    })

    it('should create Secrets Manager endpoint', () => {
      const endpoint = manager.createSecretsManagerEndpoint({
        vpcId: 'vpc-123456',
        subnetIds: ['subnet-1'],
        securityGroupIds: ['sg-123456'],
      })

      expect(endpoint.endpointType).toBe('Interface')
      expect(endpoint.privateDnsEnabled).toBe(true)
    })
  })

  describe('Network Interfaces', () => {
    it('should create network interfaces', async () => {
      const config = manager.configureVPC({
        functionName: 'my-function',
        vpcId: 'vpc-123456',
        subnetIds: ['subnet-1', 'subnet-2'],
        securityGroupIds: ['sg-123456'],
      })

      const enis = manager.getNetworkInterfaces('my-function')

      expect(enis).toHaveLength(2)
      expect(enis[0].subnetId).toBe('subnet-1')

      // Wait for ENIs to become available
      await new Promise(resolve => setTimeout(resolve, 150))

      expect(enis[0].status).toBe('available')
    })
  })

  describe('Connectivity Analysis', () => {
    it('should analyze VPC connectivity', () => {
      manager.configureVPC({
        functionName: 'my-function',
        vpcId: 'vpc-123456',
        subnetIds: ['subnet-1'],
        securityGroupIds: ['sg-123456'],
      })

      const connectivity = manager.analyzeConnectivity({
        functionName: 'my-function',
        hasNATGateway: true,
      })

      expect(connectivity.hasInternetAccess).toBe(true)
      expect(connectivity.hasNATGateway).toBe(true)
    })

    it('should provide recommendations', () => {
      manager.configureVPC({
        functionName: 'my-function',
        vpcId: 'vpc-123456',
        subnetIds: ['subnet-1'],
        securityGroupIds: ['sg-123456'],
      })

      const connectivity = manager.analyzeConnectivity({
        functionName: 'my-function',
        hasNATGateway: false,
      })

      expect(connectivity.recommendations.length).toBeGreaterThan(0)
    })
  })

  it('should use global instance', () => {
    expect(lambdaVPCManager).toBeInstanceOf(LambdaVPCManager)
  })
})

describe('Lambda DLQ Manager', () => {
  let manager: LambdaDLQManager

  beforeEach(() => {
    manager = new LambdaDLQManager()
  })

  describe('DLQ Configuration', () => {
    it('should configure SQS DLQ', () => {
      const config = manager.configureSQSDLQ({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:my-dlq',
      })

      expect(config.id).toContain('dlq')
      expect(config.targetType).toBe('sqs')
      expect(config.maxReceiveCount).toBe(3)
    })

    it('should configure SNS DLQ', () => {
      const config = manager.configureSNSDLQ({
        functionName: 'my-function',
        topicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
      })

      expect(config.targetType).toBe('sns')
    })

    it('should configure DLQ with alarm', () => {
      const config = manager.configureDLQWithAlarm({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
        alarmThreshold: 10,
        notificationTopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
      })

      expect(config.targetType).toBe('sqs')
    })
  })

  describe('DLQ Messages', () => {
    it('should send message to DLQ', () => {
      const message = manager.sendToDLQ({
        functionName: 'my-function',
        requestId: 'req-123',
        errorMessage: 'Function timeout',
        errorType: 'TimeoutError',
        payload: { test: 'data' },
        attemptCount: 3,
      })

      expect(message.id).toContain('message')
      expect(message.errorType).toBe('TimeoutError')
      expect(message.attemptCount).toBe(3)
    })
  })

  describe('DLQ Alarms', () => {
    it('should create DLQ alarm', () => {
      const config = manager.configureSQSDLQ({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
      })

      const alarm = manager.createDLQAlarm({
        dlqConfigId: config.id,
        alarmName: 'test-alarm',
        threshold: 5,
        evaluationPeriods: 2,
        enabled: true,
      })

      expect(alarm.id).toContain('alarm')
      expect(alarm.threshold).toBe(5)
    })

    it('should create age alarm', () => {
      const config = manager.configureSQSDLQ({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
      })

      const alarm = manager.createAgeAlarm({
        dlqConfigId: config.id,
        maxAgeSeconds: 3600,
        notificationTopicArn: 'arn:aws:sns:us-east-1:123456789012:alerts',
      })

      expect(alarm.threshold).toBe(3600)
    })
  })

  describe('Message Reprocessing', () => {
    it('should reprocess message', async () => {
      const config = manager.configureSQSDLQ({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
      })

      const message = manager.sendToDLQ({
        functionName: 'my-function',
        requestId: 'req-123',
        errorMessage: 'Error',
        errorType: 'Error',
        payload: {},
        attemptCount: 1,
      })

      const reprocessing = await manager.reprocessMessage(message.id)

      expect(reprocessing.status).toBe('pending')

      // Wait for reprocessing to complete
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(['success', 'failed']).toContain(reprocessing.status)
    })

    it('should batch reprocess messages', async () => {
      const config = manager.configureSQSDLQ({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
      })

      // Send multiple messages
      for (let i = 0; i < 5; i++) {
        manager.sendToDLQ({
          functionName: 'my-function',
          requestId: `req-${i}`,
          errorMessage: 'Error',
          errorType: 'Error',
          payload: {},
          attemptCount: 1,
        })
      }

      const results = await manager.batchReprocess({
        dlqConfigId: config.id,
        maxMessages: 3,
      })

      expect(results).toHaveLength(3)
    })
  })

  describe('DLQ Statistics', () => {
    it('should get DLQ stats', () => {
      const config = manager.configureSQSDLQ({
        functionName: 'my-function',
        queueArn: 'arn:aws:sqs:us-east-1:123456789012:dlq',
      })

      manager.sendToDLQ({
        functionName: 'my-function',
        requestId: 'req-1',
        errorMessage: 'Error 1',
        errorType: 'TypeError',
        payload: {},
        attemptCount: 2,
      })

      manager.sendToDLQ({
        functionName: 'my-function',
        requestId: 'req-2',
        errorMessage: 'Error 2',
        errorType: 'ValidationError',
        payload: {},
        attemptCount: 3,
      })

      const stats = manager.getDLQStats(config.id)

      expect(stats.totalMessages).toBe(2)
      expect(stats.averageAttempts).toBe(2.5)
      expect(stats.errorTypes).toEqual({
        TypeError: 1,
        ValidationError: 1,
      })
    })
  })

  it('should use global instance', () => {
    expect(lambdaDLQManager).toBeInstanceOf(LambdaDLQManager)
  })
})
