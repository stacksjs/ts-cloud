/**
 * AWS CodeDeploy Types
 * CloudFormation resource types for AWS CodeDeploy
*/

import type { CloudFormationResource } from './index'

export interface CodeDeployApplication extends CloudFormationResource {
  Type: 'AWS::CodeDeploy::Application'
  Properties?: {
    ApplicationName?: string
    ComputePlatform?: 'Server' | 'Lambda' | 'ECS'
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface CodeDeployDeploymentGroup extends CloudFormationResource {
  Type: 'AWS::CodeDeploy::DeploymentGroup'
  Properties: {
    ApplicationName: string | { Ref: string }
    DeploymentGroupName?: string
    ServiceRoleArn: string | { Ref: string } | { 'Fn::GetAtt': [string, string] }
    AutoScalingGroups?: string[]
    Ec2TagFilters?: Array<{
      Key?: string
      Value?: string
      Type?: 'KEY_ONLY' | 'VALUE_ONLY' | 'KEY_AND_VALUE'
    }>
    Ec2TagSet?: {
      Ec2TagSetList?: Array<{
        Ec2TagGroup?: Array<{
          Key?: string
          Value?: string
          Type?: 'KEY_ONLY' | 'VALUE_ONLY' | 'KEY_AND_VALUE'
        }>
      }>
    }
    OnPremisesInstanceTagFilters?: Array<{
      Key?: string
      Value?: string
      Type?: 'KEY_ONLY' | 'VALUE_ONLY' | 'KEY_AND_VALUE'
    }>
    DeploymentConfigName?: string | { Ref: string }
    DeploymentStyle?: {
      DeploymentType?: 'IN_PLACE' | 'BLUE_GREEN'
      DeploymentOption?: 'WITH_TRAFFIC_CONTROL' | 'WITHOUT_TRAFFIC_CONTROL'
    }
    AutoRollbackConfiguration?: {
      Enabled?: boolean
      Events?: ('DEPLOYMENT_FAILURE' | 'DEPLOYMENT_STOP_ON_ALARM' | 'DEPLOYMENT_STOP_ON_REQUEST')[]
    }
    AlarmConfiguration?: {
      Enabled?: boolean
      Alarms?: Array<{
        Name?: string
      }>
      IgnorePollAlarmFailure?: boolean
    }
    LoadBalancerInfo?: {
      TargetGroupInfoList?: Array<{
        Name?: string
      }>
      ElbInfoList?: Array<{
        Name?: string
      }>
      TargetGroupPairInfoList?: Array<{
        TargetGroups?: Array<{
          Name?: string
        }>
        ProdTrafficRoute?: {
          ListenerArns?: string[]
        }
        TestTrafficRoute?: {
          ListenerArns?: string[]
        }
      }>
    }
    BlueGreenDeploymentConfiguration?: {
      TerminateBlueInstancesOnDeploymentSuccess?: {
        Action?: 'TERMINATE' | 'KEEP_ALIVE'
        TerminationWaitTimeInMinutes?: number
      }
      DeploymentReadyOption?: {
        ActionOnTimeout?: 'CONTINUE_DEPLOYMENT' | 'STOP_DEPLOYMENT'
        WaitTimeInMinutes?: number
      }
      GreenFleetProvisioningOption?: {
        Action?: 'DISCOVER_EXISTING' | 'COPY_AUTO_SCALING_GROUP'
      }
    }
    TriggerConfigurations?: Array<{
      TriggerName?: string
      TriggerTargetArn?: string
      TriggerEvents?: string[]
    }>
    ECSServices?: Array<{
      ClusterName: string
      ServiceName: string
    }>
    OutdatedInstancesStrategy?: 'UPDATE' | 'IGNORE'
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface CodeDeployDeploymentConfig extends CloudFormationResource {
  Type: 'AWS::CodeDeploy::DeploymentConfig'
  Properties?: {
    DeploymentConfigName?: string
    ComputePlatform?: 'Server' | 'Lambda' | 'ECS'
    MinimumHealthyHosts?: {
      Type: 'HOST_COUNT' | 'FLEET_PERCENT'
      Value: number
    }
    TrafficRoutingConfig?: {
      Type: 'TimeBasedCanary' | 'TimeBasedLinear' | 'AllAtOnce'
      TimeBasedCanary?: {
        CanaryPercentage: number
        CanaryInterval: number
      }
      TimeBasedLinear?: {
        LinearPercentage: number
        LinearInterval: number
      }
    }
  }
}
