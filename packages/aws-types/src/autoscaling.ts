/**
 * AWS Auto Scaling Types
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/AWS_AutoScaling.html
*/

import type { Tag } from './common'

/**
 * AWS::AutoScaling::AutoScalingGroup
*/
export interface AutoScalingGroup {
  Type: 'AWS::AutoScaling::AutoScalingGroup'
  Properties: {
    AutoScalingGroupName?: string
    MinSize: string | number
    MaxSize: string | number
    DesiredCapacity?: string | number
    DefaultInstanceWarmup?: number
    HealthCheckType?: 'EC2' | 'ELB'
    HealthCheckGracePeriod?: number
    LaunchTemplate?: {
      LaunchTemplateId?: string | { Ref: string }
      LaunchTemplateName?: string
      Version: string | { 'Fn::GetAtt': [string, string] }
    }
    LaunchConfigurationName?: string | { Ref: string }
    AvailabilityZones?: string[] | { 'Fn::GetAZs': string }
    VPCZoneIdentifier?: string[] | { Ref: string }
    TargetGroupARNs?: Array<string | { Ref: string }>
    LoadBalancerNames?: Array<string | { Ref: string }>
    TerminationPolicies?: Array<'OldestInstance' | 'NewestInstance' | 'OldestLaunchConfiguration' | 'ClosestToNextInstanceHour' | 'Default' | 'OldestLaunchTemplate' | 'AllocationStrategy'>
    NewInstancesProtectedFromScaleIn?: boolean
    Tags?: Array<Tag & { PropagateAtLaunch: boolean }>
    MetricsCollection?: Array<{
      Granularity: string
      Metrics?: string[]
    }>
    Cooldown?: string | number
    CapacityRebalance?: boolean
  }
  DependsOn?: string | string[]
  CreationPolicy?: {
    ResourceSignal?: {
      Count?: number
      Timeout?: string
    }
    AutoScalingCreationPolicy?: {
      MinSuccessfulInstancesPercent?: number
    }
  }
  UpdatePolicy?: {
    AutoScalingReplacingUpdate?: {
      WillReplace?: boolean
    }
    AutoScalingRollingUpdate?: {
      MaxBatchSize?: number
      MinInstancesInService?: number
      MinSuccessfulInstancesPercent?: number
      PauseTime?: string
      SuspendProcesses?: string[]
      WaitOnResourceSignals?: boolean
    }
    AutoScalingScheduledAction?: {
      IgnoreUnmodifiedGroupSizeProperties?: boolean
    }
  }
}

/**
 * AWS::AutoScaling::LaunchConfiguration
*/
export interface AutoScalingLaunchConfiguration {
  Type: 'AWS::AutoScaling::LaunchConfiguration'
  Properties: {
    LaunchConfigurationName?: string
    ImageId: string
    InstanceType: string
    KeyName?: string
    SecurityGroups?: Array<string | { Ref: string }>
    UserData?: string | { 'Fn::Base64': any }
    IamInstanceProfile?: string | { Ref: string } | { 'Fn::GetAtt': [string, string] }
    BlockDeviceMappings?: Array<{
      DeviceName: string
      Ebs?: {
        DeleteOnTermination?: boolean
        Encrypted?: boolean
        Iops?: number
        SnapshotId?: string
        Throughput?: number
        VolumeSize?: number
        VolumeType?: 'gp2' | 'gp3' | 'io1' | 'io2' | 'sc1' | 'st1' | 'standard'
      }
      NoDevice?: boolean
      VirtualName?: string
    }>
    AssociatePublicIpAddress?: boolean
    EbsOptimized?: boolean
    InstanceMonitoring?: boolean
    PlacementTenancy?: 'default' | 'dedicated'
    SpotPrice?: string
  }
}

/**
 * AWS::AutoScaling::ScalingPolicy
*/
export interface AutoScalingScalingPolicy {
  Type: 'AWS::AutoScaling::ScalingPolicy'
  Properties: {
    PolicyName?: string
    PolicyType?: 'TargetTrackingScaling' | 'StepScaling' | 'SimpleScaling'
    AutoScalingGroupName: string | { Ref: string }
    AdjustmentType?: 'ChangeInCapacity' | 'ExactCapacity' | 'PercentChangeInCapacity'
    ScalingAdjustment?: number
    Cooldown?: string | number
    MinAdjustmentMagnitude?: number
    MetricAggregationType?: 'Minimum' | 'Maximum' | 'Average'
    EstimatedInstanceWarmup?: number
    TargetTrackingConfiguration?: {
      PredefinedMetricSpecification?: {
        PredefinedMetricType: 'ASGAverageCPUUtilization' | 'ASGAverageNetworkIn' | 'ASGAverageNetworkOut' | 'ALBRequestCountPerTarget'
        ResourceLabel?: string
      }
      CustomizedMetricSpecification?: {
        MetricName: string
        Namespace: string
        Statistic: 'Average' | 'Minimum' | 'Maximum' | 'SampleCount' | 'Sum'
        Unit?: string
        Dimensions?: Array<{
          Name: string
          Value: string
        }>
      }
      TargetValue: number
      DisableScaleIn?: boolean
    }
    StepAdjustments?: Array<{
      MetricIntervalLowerBound?: number
      MetricIntervalUpperBound?: number
      ScalingAdjustment: number
    }>
  }
}

/**
 * AWS::AutoScaling::ScheduledAction
*/
export interface AutoScalingScheduledAction {
  Type: 'AWS::AutoScaling::ScheduledAction'
  Properties: {
    AutoScalingGroupName: string | { Ref: string }
    DesiredCapacity?: number
    MinSize?: number
    MaxSize?: number
    Recurrence?: string
    StartTime?: string
    EndTime?: string
    TimeZone?: string
  }
}

/**
 * AWS::AutoScaling::LifecycleHook
*/
export interface AutoScalingLifecycleHook {
  Type: 'AWS::AutoScaling::LifecycleHook'
  Properties: {
    LifecycleHookName?: string
    AutoScalingGroupName: string | { Ref: string }
    LifecycleTransition: 'autoscaling:EC2_INSTANCE_LAUNCHING' | 'autoscaling:EC2_INSTANCE_TERMINATING'
    DefaultResult?: 'CONTINUE' | 'ABANDON'
    HeartbeatTimeout?: number
    NotificationTargetARN?: string | { Ref: string } | { 'Fn::GetAtt': [string, string] }
    RoleARN?: string | { 'Fn::GetAtt': [string, string] }
    NotificationMetadata?: string
  }
}

/**
 * AWS::AutoScaling::WarmPool
*/
export interface AutoScalingWarmPool {
  Type: 'AWS::AutoScaling::WarmPool'
  Properties: {
    AutoScalingGroupName: string | { Ref: string }
    MaxGroupPreparedCapacity?: number
    MinSize?: number
    PoolState?: 'Hibernated' | 'Running' | 'Stopped'
    InstanceReusePolicy?: {
      ReuseOnScaleIn?: boolean
    }
  }
}

export type AutoScalingResource =
  | AutoScalingGroup
  | AutoScalingLaunchConfiguration
  | AutoScalingScalingPolicy
  | AutoScalingScheduledAction
  | AutoScalingLifecycleHook
  | AutoScalingWarmPool
