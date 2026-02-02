import { describe, expect, test } from 'bun:test'
import { Deployment } from '../src/modules/deployment'
import { TemplateBuilder } from '../src/template-builder'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'

const slug = 'test-app'
const environment: EnvironmentType = 'development'
const serviceRoleArn = 'arn:aws:iam::123456789012:role/CodeDeployServiceRole'

describe('deployment Module - CodeDeploy Application', () => {
  test('should create a CodeDeploy application for EC2', () => {
    const { application, logicalId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    expect(application.Type).toBe('AWS::CodeDeploy::Application')
    expect(application.Properties?.ApplicationName).toContain('test-app')
    expect(application.Properties?.ComputePlatform).toBe('Server')
    expect(logicalId).toBeTruthy()
  })

  test('should create a CodeDeploy application for Lambda', () => {
    const { application } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Lambda',
    })

    expect(application.Properties?.ComputePlatform).toBe('Lambda')
  })

  test('should create a CodeDeploy application for ECS', () => {
    const { application } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'ECS',
    })

    expect(application.Properties?.ComputePlatform).toBe('ECS')
  })

  test('should create a CodeDeploy application with custom name', () => {
    const { application } = Deployment.createApplication({
      slug,
      environment,
      applicationName: 'my-custom-app',
      computePlatform: 'Server',
    })

    expect(application.Properties?.ApplicationName).toBe('my-custom-app')
  })
})

describe('deployment Module - Deployment Group', () => {
  test('should create a basic deployment group', () => {
    const { logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    const { deploymentGroup, logicalId } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
    })

    expect(deploymentGroup.Type).toBe('AWS::CodeDeploy::DeploymentGroup')
    expect(deploymentGroup.Properties?.DeploymentGroupName).toContain('test-app')
    expect(deploymentGroup.Properties?.ServiceRoleArn).toBe(serviceRoleArn)
    expect(logicalId).toBeTruthy()
  })

  test('should create a deployment group with auto scaling groups', () => {
    const { logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    const { deploymentGroup } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
      autoScalingGroups: ['my-asg-1', 'my-asg-2'],
    })

    expect(deploymentGroup.Properties?.AutoScalingGroups).toEqual(['my-asg-1', 'my-asg-2'])
  })

  test('should create a deployment group with EC2 tag filters', () => {
    const { logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    const { deploymentGroup } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
      ec2TagFilters: [
        {
          key: 'Environment',
          value: 'production',
          type: 'KEY_AND_VALUE',
        },
      ],
    })

    expect(deploymentGroup.Properties?.Ec2TagFilters).toHaveLength(1)
    expect(deploymentGroup.Properties?.Ec2TagFilters?.[0].Key).toBe('Environment')
    expect(deploymentGroup.Properties?.Ec2TagFilters?.[0].Value).toBe('production')
  })

  test('should create a deployment group with auto rollback on failure', () => {
    const { logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    const { deploymentGroup } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
      autoRollbackConfiguration: Deployment.RollbackConfigs.onFailure(),
    })

    expect(deploymentGroup.Properties?.AutoRollbackConfiguration?.Enabled).toBe(true)
    expect(deploymentGroup.Properties?.AutoRollbackConfiguration?.Events).toContain('DEPLOYMENT_FAILURE')
  })

  test('should create a deployment group with alarm configuration', () => {
    const { logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    const { deploymentGroup } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
      alarmConfiguration: {
        enabled: true,
        alarms: [{ name: 'high-cpu-alarm' }],
        ignorePollAlarmFailure: false,
      },
    })

    expect(deploymentGroup.Properties?.AlarmConfiguration?.Enabled).toBe(true)
    expect(deploymentGroup.Properties?.AlarmConfiguration?.Alarms).toHaveLength(1)
  })

  test('should create a deployment group with load balancer', () => {
    const { logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'ECS',
    })

    const { deploymentGroup } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
      loadBalancerInfo: {
        targetGroupInfoList: [
          { name: 'my-target-group' },
        ],
      },
    })

    expect(deploymentGroup.Properties?.LoadBalancerInfo?.TargetGroupInfoList).toHaveLength(1)
    expect(deploymentGroup.Properties?.LoadBalancerInfo?.TargetGroupInfoList?.[0].Name).toBe('my-target-group')
  })

  test('should create a deployment group with blue/green configuration', () => {
    const { logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    const { deploymentGroup } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
      blueGreenDeploymentConfiguration: Deployment.BlueGreenConfigs.standard(),
    })

    expect(deploymentGroup.Properties?.BlueGreenDeploymentConfiguration).toBeDefined()
    expect(deploymentGroup.Properties?.BlueGreenDeploymentConfiguration?.TerminateBlueInstancesOnDeploymentSuccess?.Action).toBe('TERMINATE')
  })
})

describe('deployment Module - Deployment Config', () => {
  test('should create a deployment config with minimum healthy hosts', () => {
    const { deploymentConfig, logicalId } = Deployment.createDeploymentConfig({
      slug,
      environment,
      minimumHealthyHosts: Deployment.DeploymentConfigs.halfAtATime(),
    })

    expect(deploymentConfig.Type).toBe('AWS::CodeDeploy::DeploymentConfig')
    expect(deploymentConfig.Properties?.DeploymentConfigName).toContain('test-app')
    expect(deploymentConfig.Properties?.MinimumHealthyHosts?.Type).toBe('FLEET_PERCENT')
    expect(deploymentConfig.Properties?.MinimumHealthyHosts?.Value).toBe(50)
    expect(logicalId).toBeTruthy()
  })

  test('should create a deployment config with canary traffic routing', () => {
    const { deploymentConfig } = Deployment.createDeploymentConfig({
      slug,
      environment,
      trafficRoutingConfig: Deployment.TrafficRouting.canary(10, 5),
    })

    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.Type).toBe('TimeBasedCanary')
    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.TimeBasedCanary?.CanaryPercentage).toBe(10)
    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.TimeBasedCanary?.CanaryInterval).toBe(5)
  })

  test('should create a deployment config with linear traffic routing', () => {
    const { deploymentConfig } = Deployment.createDeploymentConfig({
      slug,
      environment,
      trafficRoutingConfig: Deployment.TrafficRouting.linear(20, 10),
    })

    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.Type).toBe('TimeBasedLinear')
    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.TimeBasedLinear?.LinearPercentage).toBe(20)
    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.TimeBasedLinear?.LinearInterval).toBe(10)
  })

  test('should create a deployment config with all at once traffic routing', () => {
    const { deploymentConfig } = Deployment.createDeploymentConfig({
      slug,
      environment,
      trafficRoutingConfig: Deployment.TrafficRouting.allAtOnce(),
    })

    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.Type).toBe('AllAtOnce')
  })
})

describe('deployment Module - Deployment Configs', () => {
  test('should have all at once config', () => {
    const config = Deployment.DeploymentConfigs.allAtOnce()

    expect(config!.type).toBe('FLEET_PERCENT')
    expect(config!.value).toBe(0)
  })

  test('should have half at a time config', () => {
    const config = Deployment.DeploymentConfigs.halfAtATime()

    expect(config!.type).toBe('FLEET_PERCENT')
    expect(config!.value).toBe(50)
  })

  test('should have one at a time config', () => {
    const config = Deployment.DeploymentConfigs.oneAtATime()

    expect(config!.type).toBe('HOST_COUNT')
    expect(config!.value).toBe(1)
  })

  test('should have custom config', () => {
    const config = Deployment.DeploymentConfigs.custom('FLEET_PERCENT', 75)

    expect(config!.type).toBe('FLEET_PERCENT')
    expect(config!.value).toBe(75)
  })
})

describe('deployment Module - Rollback Configs', () => {
  test('should have rollback on failure', () => {
    const config = Deployment.RollbackConfigs.onFailure()

    expect(config!.enabled).toBe(true)
    expect(config!.events).toContain('DEPLOYMENT_FAILURE')
  })

  test('should have rollback on alarm or failure', () => {
    const config = Deployment.RollbackConfigs.onAlarmOrFailure()

    expect(config!.enabled).toBe(true)
    expect(config!.events).toContain('DEPLOYMENT_FAILURE')
    expect(config!.events).toContain('DEPLOYMENT_STOP_ON_ALARM')
  })

  test('should have rollback on all events', () => {
    const config = Deployment.RollbackConfigs.onAllEvents()

    expect(config!.enabled).toBe(true)
    expect(config!.events).toHaveLength(3)
  })

  test('should have disabled rollback', () => {
    const config = Deployment.RollbackConfigs.disabled()

    expect(config!.enabled).toBe(false)
  })
})

describe('deployment Module - Blue/Green Configs', () => {
  test('should have standard blue/green config', () => {
    const config = Deployment.BlueGreenConfigs.standard()

    expect(config!.terminateBlueInstancesOnDeploymentSuccess?.action).toBe('TERMINATE')
    expect(config!.terminateBlueInstancesOnDeploymentSuccess?.terminationWaitTimeInMinutes).toBe(5)
    expect(config!.deploymentReadyOption?.actionOnTimeout).toBe('CONTINUE_DEPLOYMENT')
  })

  test('should have blue/green with delay', () => {
    const config = Deployment.BlueGreenConfigs.withDelay(30)

    expect(config!.terminateBlueInstancesOnDeploymentSuccess?.action).toBe('TERMINATE')
    expect(config!.terminateBlueInstancesOnDeploymentSuccess?.terminationWaitTimeInMinutes).toBe(30)
  })

  test('should have blue/green with manual approval', () => {
    const config = Deployment.BlueGreenConfigs.withManualApproval(60)

    expect(config!.deploymentReadyOption?.actionOnTimeout).toBe('STOP_DEPLOYMENT')
    expect(config!.deploymentReadyOption?.waitTimeInMinutes).toBe(60)
  })

  test('should have blue/green keeping blue instances', () => {
    const config = Deployment.BlueGreenConfigs.keepBlue()

    expect(config!.terminateBlueInstancesOnDeploymentSuccess?.action).toBe('KEEP_ALIVE')
  })
})

describe('deployment Module - Use Cases', () => {
  test('should create EC2 deployment stack', () => {
    const { application, appId, deploymentGroup, groupId } = Deployment.UseCases.ec2Deployment(
      slug,
      environment,
      serviceRoleArn,
      ['my-asg'],
    )

    expect(application.Type).toBe('AWS::CodeDeploy::Application')
    expect(application.Properties?.ComputePlatform).toBe('Server')
    expect(deploymentGroup.Type).toBe('AWS::CodeDeploy::DeploymentGroup')
    expect(deploymentGroup.Properties?.AutoScalingGroups).toContain('my-asg')
    expect(appId).toBeTruthy()
    expect(groupId).toBeTruthy()
  })

  test('should create Lambda canary deployment stack', () => {
    const {
      application,
      appId,
      deploymentConfig,
      configId,
      deploymentGroup,
      groupId,
    } = Deployment.UseCases.lambdaCanaryDeployment(slug, environment, serviceRoleArn, 20, 10)

    expect(application.Type).toBe('AWS::CodeDeploy::Application')
    expect(application.Properties?.ComputePlatform).toBe('Lambda')
    expect(deploymentConfig.Type).toBe('AWS::CodeDeploy::DeploymentConfig')
    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.Type).toBe('TimeBasedCanary')
    expect(deploymentConfig.Properties?.TrafficRoutingConfig?.TimeBasedCanary?.CanaryPercentage).toBe(20)
    expect(deploymentGroup.Type).toBe('AWS::CodeDeploy::DeploymentGroup')
    expect(appId).toBeTruthy()
    expect(configId).toBeTruthy()
    expect(groupId).toBeTruthy()
  })

  test('should create ECS blue/green deployment stack', () => {
    const { application, appId, deploymentGroup, groupId } = Deployment.UseCases.ecsBlueGreenDeployment(
      slug,
      environment,
      serviceRoleArn,
      'my-target-group',
    )

    expect(application.Type).toBe('AWS::CodeDeploy::Application')
    expect(application.Properties?.ComputePlatform).toBe('ECS')
    expect(deploymentGroup.Type).toBe('AWS::CodeDeploy::DeploymentGroup')
    expect(deploymentGroup.Properties?.LoadBalancerInfo?.TargetGroupInfoList?.[0].Name).toBe('my-target-group')
    expect(deploymentGroup.Properties?.BlueGreenDeploymentConfiguration).toBeDefined()
    expect(appId).toBeTruthy()
    expect(groupId).toBeTruthy()
  })
})

describe('deployment Module - Deployment Strategies', () => {
  test('should have rolling strategy', () => {
    const strategy = Deployment.Strategies.rolling(25)

    expect(strategy.type).toBe('rolling')
    expect(strategy.batchPercentage).toBe(25)
  })

  test('should have blue-green strategy', () => {
    const strategy = Deployment.Strategies.blueGreen()

    expect(strategy.type).toBe('blue-green')
  })

  test('should have canary strategy', () => {
    const strategy = Deployment.Strategies.canary(15, 10)

    expect(strategy.type).toBe('canary')
    expect(strategy.canaryPercentage).toBe(15)
    expect(strategy.canaryInterval).toBe(10)
  })

  test('should have all at once strategy', () => {
    const strategy = Deployment.Strategies.allAtOnce()

    expect(strategy.type).toBe('all-at-once')
  })
})

describe('deployment Module - Integration with TemplateBuilder', () => {
  test('should add CodeDeploy application to template', () => {
    const builder = new TemplateBuilder()

    const { application, logicalId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    builder.addResource(logicalId, application)

    const template = builder.build()

    expect(template.Resources[logicalId]).toBeDefined()
    expect(template.Resources[logicalId].Type).toBe('AWS::CodeDeploy::Application')
  })

  test('should add complete deployment stack to template', () => {
    const builder = new TemplateBuilder()

    const { application, logicalId: appId } = Deployment.createApplication({
      slug,
      environment,
      computePlatform: 'Server',
    })

    const { deploymentConfig, logicalId: configId } = Deployment.createDeploymentConfig({
      slug,
      environment,
      minimumHealthyHosts: Deployment.DeploymentConfigs.halfAtATime(),
    })

    const { deploymentGroup, logicalId: groupId } = Deployment.createDeploymentGroup(appId, {
      slug,
      environment,
      serviceRoleArn,
      autoScalingGroups: ['my-asg'],
      autoRollbackConfiguration: Deployment.RollbackConfigs.onFailure(),
    })

    builder.addResource(appId, application)
    builder.addResource(configId, deploymentConfig)
    builder.addResource(groupId, deploymentGroup)

    const template = builder.build()

    expect(Object.keys(template.Resources)).toHaveLength(3)
    expect(template.Resources[appId].Type).toBe('AWS::CodeDeploy::Application')
    expect(template.Resources[configId].Type).toBe('AWS::CodeDeploy::DeploymentConfig')
    expect(template.Resources[groupId].Type).toBe('AWS::CodeDeploy::DeploymentGroup')
  })

  test('should create Lambda canary deployment in template', () => {
    const builder = new TemplateBuilder()

    const {
      application,
      appId,
      deploymentConfig,
      configId,
      deploymentGroup,
      groupId,
    } = Deployment.UseCases.lambdaCanaryDeployment(slug, environment, serviceRoleArn)

    builder.addResource(appId, application)
    builder.addResource(configId, deploymentConfig)
    builder.addResource(groupId, deploymentGroup)

    const template = builder.build()

    expect(Object.keys(template.Resources)).toHaveLength(3)
    expect(template.Resources[appId]!.Properties!.ComputePlatform).toBe('Lambda')
    expect((template.Resources[configId]!.Properties as any).TrafficRoutingConfig.Type).toBe('TimeBasedCanary')
  })
})
