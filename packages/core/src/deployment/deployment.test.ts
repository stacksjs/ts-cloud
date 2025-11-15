import { describe, expect, it, beforeEach } from 'bun:test'
import { BlueGreenManager } from './blue-green'
import { CanaryManager } from './canary'
import { ABTestManager } from './ab-testing'

describe('Blue/Green Deployment', () => {
  let manager: BlueGreenManager

  beforeEach(() => {
    manager = new BlueGreenManager()
  })

  describe('Deployment Creation', () => {
    it('should create ALB deployment', () => {
      const deployment = manager.createALBDeployment({
        name: 'api-deployment',
        listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/abc/def',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
      })

      expect(deployment.id).toMatch(/^bg-deployment-\d+-\d+$/)
      expect(deployment.name).toBe('api-deployment')
      expect(deployment.activeEnvironment).toBe('blue')
      expect(deployment.blueEnvironment.weight).toBe(100)
      expect(deployment.greenEnvironment.weight).toBe(0)
    })

    it('should create Route53 deployment', () => {
      const deployment = manager.createRoute53Deployment({
        name: 'web-deployment',
        hostedZoneId: 'Z1234567890ABC',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
        switchoverTimeSeconds: 120,
      })

      expect(deployment.routingConfig.type).toBe('route53')
      expect(deployment.routingConfig.switchoverTimeSeconds).toBe(120)
    })

    it('should create ECS deployment', () => {
      const deployment = manager.createECSDeployment({
        name: 'ecs-service',
        listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/abc/def',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
        blueTaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:1',
        greenTaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:2',
        autoRollback: true,
      })

      expect(deployment.blueEnvironment.taskDefinitionArn).toBeDefined()
      expect(deployment.greenEnvironment.taskDefinitionArn).toBeDefined()
      expect(deployment.autoRollback).toBe(true)
    })
  })

  describe('Deployment Execution', () => {
    it('should execute deployment in dry-run mode', async () => {
      const deployment = manager.createALBDeployment({
        name: 'test-deployment',
        listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/abc/def',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
      })

      const result = await manager.executeDeployment(deployment.id, true)

      expect(result.success).toBe(true)
      expect(result.deploymentId).toMatch(/^result-\d+-\d+$/)
      expect(result.startTime).toBeInstanceOf(Date)
      expect(result.endTime).toBeInstanceOf(Date)
    })

    it('should switch active environment after deployment', async () => {
      const deployment = manager.createALBDeployment({
        name: 'test-deployment',
        listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/abc/def',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
      })

      expect(deployment.activeEnvironment).toBe('blue')

      await manager.executeDeployment(deployment.id, false)

      const updated = manager.getDeployment(deployment.id)
      expect(updated?.activeEnvironment).toBe('green')
    })

    it('should throw error for non-existent deployment', async () => {
      await expect(manager.executeDeployment('non-existent', true)).rejects.toThrow(
        'Deployment not found: non-existent',
      )
    })
  })

  describe('Rollback', () => {
    it('should rollback deployment', async () => {
      const deployment = manager.createALBDeployment({
        name: 'test-deployment',
        listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/abc/def',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
      })

      await manager.executeDeployment(deployment.id, false)
      const result = await manager.rollback(deployment.id)

      expect(result.success).toBe(true)
      expect(result.rolledBackAt).toBeInstanceOf(Date)

      const updated = manager.getDeployment(deployment.id)
      expect(updated?.activeEnvironment).toBe('blue')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate ALB listener rule', () => {
      const deployment = manager.createALBDeployment({
        name: 'test-deployment',
        listenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-lb/abc/def',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
      })

      const cf = manager.generateALBListenerCF(deployment)

      expect(cf.Type).toBe('AWS::ElasticLoadBalancingV2::ListenerRule')
      expect(cf.Properties.Actions[0].Type).toBe('forward')
    })

    it('should generate Route53 record sets', () => {
      const deployment = manager.createRoute53Deployment({
        name: 'test-deployment',
        hostedZoneId: 'Z1234567890ABC',
        blueTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/blue/123',
        greenTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/green/456',
      })

      const cf = manager.generateRoute53RecordSetCF(deployment, 'app.example.com')

      expect(cf).toHaveLength(2)
      expect(cf[0].Type).toBe('AWS::Route53::RecordSet')
      expect(cf[1].Type).toBe('AWS::Route53::RecordSet')
    })
  })
})

describe('Canary Deployment', () => {
  let manager: CanaryManager

  beforeEach(() => {
    manager = new CanaryManager()
  })

  describe('Predefined Strategies', () => {
    it('should have conservative strategy', () => {
      const stages = CanaryManager.Strategies.CONSERVATIVE

      expect(stages).toHaveLength(4)
      expect(stages[0].trafficPercentage).toBe(10)
      expect(stages[3].trafficPercentage).toBe(100)
    })

    it('should have balanced strategy', () => {
      const stages = CanaryManager.Strategies.BALANCED

      expect(stages).toHaveLength(3)
      expect(stages[0].trafficPercentage).toBe(20)
    })

    it('should have linear 10% strategy', () => {
      const stages = CanaryManager.Strategies.LINEAR_10

      expect(stages).toHaveLength(10)
      expect(stages[0].trafficPercentage).toBe(10)
      expect(stages[9].trafficPercentage).toBe(100)
    })
  })

  describe('Deployment Creation', () => {
    it('should create Lambda canary deployment', () => {
      const deployment = manager.createLambdaCanaryDeployment({
        name: 'lambda-canary',
        baselineVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:1',
        canaryVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:2',
        strategy: 'BALANCED',
        errorRateThreshold: 0.5,
        latencyThreshold: 500,
      })

      expect(deployment.id).toMatch(/^canary-\d+-\d+$/)
      expect(deployment.stages).toHaveLength(3)
      expect(deployment.autoPromote).toBe(true)
      expect(deployment.autoRollback).toBe(true)
    })

    it('should create ECS canary deployment', () => {
      const deployment = manager.createECSCanaryDeployment({
        name: 'ecs-canary',
        baselineTaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:1',
        canaryTaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:2',
        baselineTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/baseline/123',
        canaryTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/canary/456',
        strategy: 'CONSERVATIVE',
      })

      expect(deployment.stages).toHaveLength(4)
    })
  })

  describe('Deployment Execution', () => {
    it('should execute canary deployment', async () => {
      const deployment = manager.createLambdaCanaryDeployment({
        name: 'test-canary',
        baselineVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:1',
        canaryVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:2',
        strategy: 'AGGRESSIVE',
      })

      const result = await manager.executeDeployment(deployment.id, true)

      expect(result.success).toBe(true)
      expect(result.completedStages).toBe(2)
      expect(result.rolledBack).toBe(false)
    })

    it('should track deployment status', async () => {
      const deployment = manager.createLambdaCanaryDeployment({
        name: 'test-canary',
        baselineVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:1',
        canaryVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:2',
      })

      expect(deployment.status).toBe('pending')

      await manager.executeDeployment(deployment.id, false)

      const updated = manager.getDeployment(deployment.id)
      expect(updated?.status).toMatch(/completed|rolled_back/)
    })
  })

  describe('Rollback', () => {
    it('should rollback canary deployment', async () => {
      const deployment = manager.createLambdaCanaryDeployment({
        name: 'test-canary',
        baselineVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:1',
        canaryVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:2',
      })

      await manager.rollback(deployment.id, false)

      const updated = manager.getDeployment(deployment.id)
      expect(updated?.baselineVersion.weight).toBe(100)
      expect(updated?.canaryVersion.weight).toBe(0)
    })
  })

  describe('Promotion', () => {
    it('should promote canary to baseline', () => {
      const deployment = manager.createLambdaCanaryDeployment({
        name: 'test-canary',
        baselineVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:1',
        canaryVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:2',
      })

      const originalCanaryArn = deployment.canaryVersion.functionVersionArn

      manager.promoteCanary(deployment.id)

      const updated = manager.getDeployment(deployment.id)
      expect(updated?.baselineVersion.functionVersionArn).toBe(originalCanaryArn)
      expect(updated?.status).toBe('completed')
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate Lambda alias configuration', () => {
      const deployment = manager.createLambdaCanaryDeployment({
        name: 'test-canary',
        baselineVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:1',
        canaryVersionArn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function:2',
      })

      const cf = manager.generateLambdaAliasCF(deployment, 'live')

      expect(cf.Type).toBe('AWS::Lambda::Alias')
      expect(cf.Properties.Name).toBe('live')
      expect(cf.Properties.RoutingConfig).toBeDefined()
    })

    it('should generate ALB listener rule', () => {
      const deployment = manager.createECSCanaryDeployment({
        name: 'test-canary',
        baselineTaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:1',
        canaryTaskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/app:2',
        baselineTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/baseline/123',
        canaryTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/canary/456',
      })

      const cf = manager.generateALBListenerRuleCF(deployment)

      expect(cf.Type).toBe('AWS::ElasticLoadBalancingV2::ListenerRule')
      expect(cf.Properties.Actions[0].ForwardConfig.TargetGroups).toHaveLength(2)
    })
  })
})

describe('A/B Testing', () => {
  let manager: ABTestManager

  beforeEach(() => {
    manager = new ABTestManager()
  })

  describe('Test Creation', () => {
    it('should create simple A/B test', () => {
      const test = manager.createSimpleABTest({
        name: 'Homepage Redesign',
        description: 'Test new homepage design',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
        variantTrafficPercentage: 30,
        stickySession: true,
      })

      expect(test.id).toMatch(/^abtest-\d+-\d+$/)
      expect(test.variants).toHaveLength(2)
      expect(test.variants[0].trafficPercentage).toBe(70)
      expect(test.variants[1].trafficPercentage).toBe(30)
      expect(test.routingStrategy.stickySession).toBe(true)
    })

    it('should create multivariate test', () => {
      const test = manager.createMultivariateTest({
        name: 'Pricing Page Test',
        variants: [
          {
            name: 'Control',
            trafficPercentage: 25,
            targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
          },
          {
            name: 'Variant A',
            trafficPercentage: 25,
            targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant-a/456',
          },
          {
            name: 'Variant B',
            trafficPercentage: 25,
            targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant-b/789',
          },
          {
            name: 'Variant C',
            trafficPercentage: 25,
            targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant-c/012',
          },
        ],
      })

      expect(test.variants).toHaveLength(4)
      expect(test.variants.every(v => v.trafficPercentage === 25)).toBe(true)
    })

    it('should throw error if percentages do not sum to 100', () => {
      expect(() =>
        manager.createMultivariateTest({
          name: 'Invalid Test',
          variants: [
            {
              name: 'Variant A',
              trafficPercentage: 60,
              targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant-a/123',
            },
            {
              name: 'Variant B',
              trafficPercentage: 30,
              targetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant-b/456',
            },
          ],
        }),
      ).toThrow('Traffic percentages must sum to 100')
    })

    it('should create header-based test', () => {
      const test = manager.createHeaderBasedTest({
        name: 'Beta Feature Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/beta/456',
        headerName: 'X-Beta-User',
        headerValue: 'true',
      })

      expect(test.routingStrategy.type).toBe('header')
      expect(test.routingStrategy.headerName).toBe('X-Beta-User')
    })

    it('should create geo-based test', () => {
      const test = manager.createGeoBasedTest({
        name: 'Regional Feature Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
        regions: ['US', 'CA'],
      })

      expect(test.routingStrategy.type).toBe('geo')
      expect(test.variants[1].name).toContain('US, CA')
    })
  })

  describe('Test Management', () => {
    it('should start test', () => {
      const test = manager.createSimpleABTest({
        name: 'Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
      })

      expect(test.status).toBe('draft')

      manager.startTest(test.id)

      const updated = manager.getTest(test.id)
      expect(updated?.status).toBe('active')
    })

    it('should pause test', () => {
      const test = manager.createSimpleABTest({
        name: 'Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
      })

      manager.startTest(test.id)
      manager.pauseTest(test.id)

      const updated = manager.getTest(test.id)
      expect(updated?.status).toBe('paused')
    })

    it('should update traffic split', () => {
      const test = manager.createSimpleABTest({
        name: 'Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
        variantTrafficPercentage: 50,
      })

      manager.updateTrafficSplit(test.id, 'variant-a', 75)

      const updated = manager.getTest(test.id)
      const variant = updated?.variants.find(v => v.id === 'variant-a')
      expect(variant?.trafficPercentage).toBe(75)
    })
  })

  describe('Results Analysis', () => {
    it('should analyze test results', () => {
      const test = manager.createSimpleABTest({
        name: 'Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
      })

      const results = manager.analyzeResults(test.id)

      expect(results.testId).toBe(test.id)
      expect(results.winningVariant).toBeDefined()
      expect(results.confidence).toBeGreaterThan(0)
      expect(results.metrics).toBeDefined()
      expect(results.recommendation).toBeDefined()
    })

    it('should declare winner', () => {
      const test = manager.createSimpleABTest({
        name: 'Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
      })

      manager.declareWinner(test.id, 'variant-a')

      const updated = manager.getTest(test.id)
      expect(updated?.status).toBe('completed')
      expect(updated?.winner).toBe('variant-a')

      const winner = updated?.variants.find(v => v.id === 'variant-a')
      expect(winner?.trafficPercentage).toBe(100)
    })
  })

  describe('CloudFormation Generation', () => {
    it('should generate ALB listener rule', () => {
      const test = manager.createSimpleABTest({
        name: 'Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
        stickySession: true,
      })

      const cf = manager.generateALBListenerRuleCF(test)

      expect(cf.Type).toBe('AWS::ElasticLoadBalancingV2::ListenerRule')
      expect(cf.Properties.Actions[0].ForwardConfig.TargetGroups).toHaveLength(2)
      expect(cf.Properties.Actions[0].ForwardConfig.TargetGroupStickinessConfig.Enabled).toBe(true)
    })

    it('should generate Lambda@Edge function', () => {
      const test = manager.createSimpleABTest({
        name: 'Test',
        controlTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/control/123',
        variantTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/variant/456',
        stickySession: true,
      })

      const code = manager.generateLambdaEdgeFunction(test)

      expect(code).toContain('exports.handler')
      expect(code).toContain('ab_variant')
      expect(code).toContain('Set-Cookie')
    })
  })
})
