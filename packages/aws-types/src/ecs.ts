import type { CloudFormationResource } from './index'

export interface ECSCluster extends CloudFormationResource {
  Type: 'AWS::ECS::Cluster'
  Properties?: {
    ClusterName?: string
    CapacityProviders?: string[]
    DefaultCapacityProviderStrategy?: Array<{
      CapacityProvider: string
      Weight?: number
      Base?: number
    }>
    Configuration?: {
      ExecuteCommandConfiguration?: {
        Logging?: string
      }
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ECSTaskDefinition extends CloudFormationResource {
  Type: 'AWS::ECS::TaskDefinition'
  Properties: {
    Family: string
    TaskRoleArn?: string
    ExecutionRoleArn?: string
    NetworkMode?: 'bridge' | 'host' | 'awsvpc' | 'none'
    RequiresCompatibilities?: ('EC2' | 'FARGATE')[]
    Cpu?: string
    Memory?: string
    ContainerDefinitions: Array<{
      Name: string
      Image: string
      Cpu?: number
      Memory?: number
      MemoryReservation?: number
      Essential?: boolean
      PortMappings?: Array<{
        ContainerPort: number
        HostPort?: number
        Protocol?: 'tcp' | 'udp'
      }>
      Environment?: Array<{
        Name: string
        Value: string
      }>
      Secrets?: Array<{
        Name: string
        ValueFrom: string
      }>
      LogConfiguration?: {
        LogDriver: 'awslogs' | 'fluentd' | 'gelf' | 'json-file' | 'journald' | 'logentries' | 'splunk' | 'syslog'
        Options?: Record<string, string>
      }
      HealthCheck?: {
        Command: string[]
        Interval?: number
        Timeout?: number
        Retries?: number
        StartPeriod?: number
      }
      MountPoints?: Array<{
        SourceVolume: string
        ContainerPath: string
        ReadOnly?: boolean
      }>
    }>
    Volumes?: Array<{
      Name: string
      Host?: {
        SourcePath?: string
      }
      EFSVolumeConfiguration?: {
        FileSystemId: string
        RootDirectory?: string
        TransitEncryption?: 'ENABLED' | 'DISABLED'
        AuthorizationConfig?: {
          AccessPointId?: string
          IAM?: 'ENABLED' | 'DISABLED'
        }
      }
    }>
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface ECSService extends CloudFormationResource {
  Type: 'AWS::ECS::Service'
  Properties: {
    ServiceName?: string
    Cluster?: string | { Ref: string }
    TaskDefinition: string | { Ref: string }
    DesiredCount?: number
    LaunchType?: 'EC2' | 'FARGATE' | 'EXTERNAL'
    PlatformVersion?: string
    NetworkConfiguration?: {
      AwsvpcConfiguration: {
        Subnets: string[]
        SecurityGroups?: string[]
        AssignPublicIp?: 'ENABLED' | 'DISABLED'
      }
    }
    LoadBalancers?: Array<{
      TargetGroupArn: string | { Ref: string }
      ContainerName: string
      ContainerPort: number
    }>
    HealthCheckGracePeriodSeconds?: number
    DeploymentConfiguration?: {
      MaximumPercent?: number
      MinimumHealthyPercent?: number
      DeploymentCircuitBreaker?: {
        Enable: boolean
        Rollback: boolean
      }
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
