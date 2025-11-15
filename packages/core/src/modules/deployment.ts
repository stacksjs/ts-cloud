import type {
  CodeDeployApplication,
  CodeDeployDeploymentGroup,
  CodeDeployDeploymentConfig,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface CodeDeployApplicationOptions {
  slug: string
  environment: EnvironmentType
  applicationName?: string
  computePlatform: 'Server' | 'Lambda' | 'ECS'
}

export interface CodeDeployDeploymentGroupOptions {
  slug: string
  environment: EnvironmentType
  deploymentGroupName?: string
  serviceRoleArn: string
  autoScalingGroups?: string[]
  ec2TagFilters?: Array<{
    key?: string
    value?: string
    type?: 'KEY_ONLY' | 'VALUE_ONLY' | 'KEY_AND_VALUE'
  }>
  deploymentConfigName?: string
  autoRollbackConfiguration?: {
    enabled: boolean
    events?: ('DEPLOYMENT_FAILURE' | 'DEPLOYMENT_STOP_ON_ALARM' | 'DEPLOYMENT_STOP_ON_REQUEST')[]
  }
  alarmConfiguration?: {
    enabled: boolean
    alarms?: Array<{
      name: string
    }>
    ignorePollAlarmFailure?: boolean
  }
  loadBalancerInfo?: {
    targetGroupInfoList?: Array<{
      name: string
    }>
    elbInfoList?: Array<{
      name: string
    }>
  }
  blueGreenDeploymentConfiguration?: {
    terminateBlueInstancesOnDeploymentSuccess?: {
      action?: 'TERMINATE' | 'KEEP_ALIVE'
      terminationWaitTimeInMinutes?: number
    }
    deploymentReadyOption?: {
      actionOnTimeout?: 'CONTINUE_DEPLOYMENT' | 'STOP_DEPLOYMENT'
      waitTimeInMinutes?: number
    }
    greenFleetProvisioningOption?: {
      action?: 'DISCOVER_EXISTING' | 'COPY_AUTO_SCALING_GROUP'
    }
  }
}

export interface CodeDeployDeploymentConfigOptions {
  slug: string
  environment: EnvironmentType
  deploymentConfigName?: string
  minimumHealthyHosts?: {
    type: 'HOST_COUNT' | 'FLEET_PERCENT'
    value: number
  }
  trafficRoutingConfig?: {
    type: 'TimeBasedCanary' | 'TimeBasedLinear' | 'AllAtOnce'
    timeBasedCanary?: {
      canaryPercentage: number
      canaryInterval: number
    }
    timeBasedLinear?: {
      linearPercentage: number
      linearInterval: number
    }
  }
}

export interface DeploymentStrategyOptions {
  type: 'rolling' | 'blue-green' | 'canary' | 'all-at-once'
  batchSize?: number
  batchPercentage?: number
  canaryPercentage?: number
  canaryInterval?: number
}

/**
 * Deployment Module - CodeDeploy and Deployment Utilities
 * Provides clean API for deployment infrastructure and strategies
 */
export class Deployment {
  /**
   * Create a CodeDeploy Application
   */
  static createApplication(options: CodeDeployApplicationOptions): {
    application: CodeDeployApplication
    logicalId: string
  } {
    const {
      slug,
      environment,
      applicationName,
      computePlatform,
    } = options

    const resourceName = applicationName || generateResourceName({
      slug,
      environment,
      resourceType: 'deploy-app',
    })

    const logicalId = generateLogicalId(resourceName)

    const application: CodeDeployApplication = {
      Type: 'AWS::CodeDeploy::Application',
      Properties: {
        ApplicationName: resourceName,
        ComputePlatform: computePlatform,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { application, logicalId }
  }

  /**
   * Create a CodeDeploy Deployment Group
   */
  static createDeploymentGroup(
    applicationLogicalId: string,
    options: CodeDeployDeploymentGroupOptions,
  ): {
      deploymentGroup: CodeDeployDeploymentGroup
      logicalId: string
    } {
    const {
      slug,
      environment,
      deploymentGroupName,
      serviceRoleArn,
      autoScalingGroups,
      ec2TagFilters,
      deploymentConfigName,
      autoRollbackConfiguration,
      alarmConfiguration,
      loadBalancerInfo,
      blueGreenDeploymentConfiguration,
    } = options

    const resourceName = deploymentGroupName || generateResourceName({
      slug,
      environment,
      resourceType: 'deploy-group',
    })

    const logicalId = generateLogicalId(resourceName)

    const deploymentGroup: CodeDeployDeploymentGroup = {
      Type: 'AWS::CodeDeploy::DeploymentGroup',
      Properties: {
        ApplicationName: Fn.Ref(applicationLogicalId) as unknown as string,
        DeploymentGroupName: resourceName,
        ServiceRoleArn: serviceRoleArn,
        AutoScalingGroups: autoScalingGroups,
        Ec2TagFilters: ec2TagFilters,
        DeploymentConfigName: deploymentConfigName,
        AutoRollbackConfiguration: autoRollbackConfiguration,
        AlarmConfiguration: alarmConfiguration,
        LoadBalancerInfo: loadBalancerInfo,
        BlueGreenDeploymentConfiguration: blueGreenDeploymentConfiguration,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { deploymentGroup, logicalId }
  }

  /**
   * Create a CodeDeploy Deployment Configuration
   */
  static createDeploymentConfig(options: CodeDeployDeploymentConfigOptions): {
    deploymentConfig: CodeDeployDeploymentConfig
    logicalId: string
  } {
    const {
      slug,
      environment,
      deploymentConfigName,
      minimumHealthyHosts,
      trafficRoutingConfig,
    } = options

    const resourceName = deploymentConfigName || generateResourceName({
      slug,
      environment,
      resourceType: 'deploy-config',
    })

    const logicalId = generateLogicalId(resourceName)

    const deploymentConfig: CodeDeployDeploymentConfig = {
      Type: 'AWS::CodeDeploy::DeploymentConfig',
      Properties: {
        DeploymentConfigName: resourceName,
        MinimumHealthyHosts: minimumHealthyHosts,
        TrafficRoutingConfig: trafficRoutingConfig,
      },
    }

    return { deploymentConfig, logicalId }
  }

  /**
   * Common deployment configurations
   */
  static readonly DeploymentConfigs = {
    /**
     * All at once deployment (fastest, but downtime)
     */
    allAtOnce: (): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type: 'FLEET_PERCENT',
      value: 0,
    }),

    /**
     * Half at a time deployment
     */
    halfAtATime: (): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type: 'FLEET_PERCENT',
      value: 50,
    }),

    /**
     * One at a time deployment (slowest, but safest)
     */
    oneAtATime: (): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type: 'HOST_COUNT',
      value: 1,
    }),

    /**
     * Custom deployment configuration
     */
    custom: (
      type: 'HOST_COUNT' | 'FLEET_PERCENT',
      value: number,
    ): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type,
      value,
    }),
  } as const

  /**
   * Traffic routing configurations
   */
  static readonly TrafficRouting = {
    /**
     * All traffic at once
     */
    allAtOnce: (): CodeDeployDeploymentConfigOptions['trafficRoutingConfig'] => ({
      type: 'AllAtOnce',
    }),

    /**
     * Canary deployment (shift traffic in two steps)
     */
    canary: (
      canaryPercentage: number,
      canaryInterval: number,
    ): CodeDeployDeploymentConfigOptions['trafficRoutingConfig'] => ({
      type: 'TimeBasedCanary',
      timeBasedCanary: {
        canaryPercentage,
        canaryInterval,
      },
    }),

    /**
     * Linear deployment (shift traffic gradually)
     */
    linear: (
      linearPercentage: number,
      linearInterval: number,
    ): CodeDeployDeploymentConfigOptions['trafficRoutingConfig'] => ({
      type: 'TimeBasedLinear',
      timeBasedLinear: {
        linearPercentage,
        linearInterval,
      },
    }),
  } as const

  /**
   * Rollback configurations
   */
  static readonly RollbackConfigs = {
    /**
     * Auto rollback on deployment failure
     */
    onFailure: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: true,
      events: ['DEPLOYMENT_FAILURE'],
    }),

    /**
     * Auto rollback on alarm or failure
     */
    onAlarmOrFailure: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: true,
      events: ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM'],
    }),

    /**
     * Auto rollback on all events
     */
    onAllEvents: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: true,
      events: ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM', 'DEPLOYMENT_STOP_ON_REQUEST'],
    }),

    /**
     * No auto rollback
     */
    disabled: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: false,
    }),
  } as const

  /**
   * Blue/Green deployment configurations
   */
  static readonly BlueGreenConfigs = {
    /**
     * Standard blue/green with immediate termination
     */
    standard: (): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
        terminationWaitTimeInMinutes: 5,
      },
      deploymentReadyOption: {
        actionOnTimeout: 'CONTINUE_DEPLOYMENT',
        waitTimeInMinutes: 0,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),

    /**
     * Blue/green with delayed termination
     */
    withDelay: (
      terminationWaitTimeInMinutes: number,
    ): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
        terminationWaitTimeInMinutes,
      },
      deploymentReadyOption: {
        actionOnTimeout: 'CONTINUE_DEPLOYMENT',
        waitTimeInMinutes: 0,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),

    /**
     * Blue/green with manual approval
     */
    withManualApproval: (
      waitTimeInMinutes: number,
    ): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
        terminationWaitTimeInMinutes: 5,
      },
      deploymentReadyOption: {
        actionOnTimeout: 'STOP_DEPLOYMENT',
        waitTimeInMinutes,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),

    /**
     * Blue/green keeping old instances
     */
    keepBlue: (): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'KEEP_ALIVE',
      },
      deploymentReadyOption: {
        actionOnTimeout: 'CONTINUE_DEPLOYMENT',
        waitTimeInMinutes: 0,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),
  } as const

  /**
   * Common use cases
   */
  static readonly UseCases = {
    /**
     * Create basic EC2 deployment
     */
    ec2Deployment: (
      slug: string,
      environment: EnvironmentType,
      serviceRoleArn: string,
      autoScalingGroups: string[],
    ) => {
      const { application, logicalId: appId } = Deployment.createApplication({
        slug,
        environment,
        computePlatform: 'Server',
      })

      const { deploymentGroup, logicalId: groupId } = Deployment.createDeploymentGroup(appId, {
        slug,
        environment,
        serviceRoleArn,
        autoScalingGroups,
        deploymentConfigName: 'CodeDeployDefault.OneAtATime',
        autoRollbackConfiguration: Deployment.RollbackConfigs.onFailure(),
      })

      return { application, appId, deploymentGroup, groupId }
    },

    /**
     * Create Lambda deployment with canary
     */
    lambdaCanaryDeployment: (
      slug: string,
      environment: EnvironmentType,
      serviceRoleArn: string,
      canaryPercentage: number = 10,
      canaryInterval: number = 5,
    ) => {
      const { application, logicalId: appId } = Deployment.createApplication({
        slug,
        environment,
        computePlatform: 'Lambda',
      })

      const { deploymentConfig, logicalId: configId } = Deployment.createDeploymentConfig({
        slug,
        environment,
        trafficRoutingConfig: Deployment.TrafficRouting.canary(canaryPercentage, canaryInterval),
      })

      const { deploymentGroup, logicalId: groupId } = Deployment.createDeploymentGroup(appId, {
        slug,
        environment,
        serviceRoleArn,
        deploymentConfigName: Fn.Ref(configId) as unknown as string,
        autoRollbackConfiguration: Deployment.RollbackConfigs.onAlarmOrFailure(),
      })

      return { application, appId, deploymentConfig, configId, deploymentGroup, groupId }
    },

    /**
     * Create ECS blue/green deployment
     */
    ecsBlueGreenDeployment: (
      slug: string,
      environment: EnvironmentType,
      serviceRoleArn: string,
      targetGroupName: string,
    ) => {
      const { application, logicalId: appId } = Deployment.createApplication({
        slug,
        environment,
        computePlatform: 'ECS',
      })

      const { deploymentGroup, logicalId: groupId } = Deployment.createDeploymentGroup(appId, {
        slug,
        environment,
        serviceRoleArn,
        loadBalancerInfo: {
          targetGroupInfoList: [{ name: targetGroupName }],
        },
        blueGreenDeploymentConfiguration: Deployment.BlueGreenConfigs.standard(),
        autoRollbackConfiguration: Deployment.RollbackConfigs.onFailure(),
      })

      return { application, appId, deploymentGroup, groupId }
    },
  } as const

  /**
   * Deployment strategy helpers
   */
  static readonly Strategies = {
    /**
     * Rolling deployment strategy
     */
    rolling: (batchPercentage: number = 25): DeploymentStrategyOptions => ({
      type: 'rolling',
      batchPercentage,
    }),

    /**
     * Blue-green deployment strategy
     */
    blueGreen: (): DeploymentStrategyOptions => ({
      type: 'blue-green',
    }),

    /**
     * Canary deployment strategy
     */
    canary: (canaryPercentage: number = 10, canaryInterval: number = 5): DeploymentStrategyOptions => ({
      type: 'canary',
      canaryPercentage,
      canaryInterval,
    }),

    /**
     * All at once deployment strategy
     */
    allAtOnce: (): DeploymentStrategyOptions => ({
      type: 'all-at-once',
    }),
  } as const
}
