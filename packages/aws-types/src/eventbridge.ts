import type { CloudFormationResource } from './index'

/**
 * AWS EventBridge Types
 */

export interface EventBridgeRule extends CloudFormationResource {
  Type: 'AWS::Events::Rule'
  Properties: {
    Name?: string
    Description?: string
    State?: 'ENABLED' | 'DISABLED' | 'ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS'
    ScheduleExpression?: string
    EventPattern?: {
      source?: string[]
      'detail-type'?: string[]
      detail?: Record<string, unknown>
      account?: string[]
      region?: string[]
      resources?: string[]
    }
    EventBusName?: string
    RoleArn?: string
    Targets?: Array<{
      Id: string
      Arn: string
      RoleArn?: string
      Input?: string
      InputPath?: string
      InputTransformer?: {
        InputPathsMap?: Record<string, string>
        InputTemplate: string
      }
      KinesisParameters?: {
        PartitionKeyPath: string
      }
      EcsParameters?: {
        TaskDefinitionArn: string
        TaskCount?: number
        LaunchType?: 'EC2' | 'FARGATE' | 'EXTERNAL'
        NetworkConfiguration?: {
          awsvpcConfiguration: {
            Subnets: string[]
            SecurityGroups?: string[]
            AssignPublicIp?: 'ENABLED' | 'DISABLED'
          }
        }
        PlatformVersion?: string
        Group?: string
        CapacityProviderStrategy?: Array<{
          capacityProvider: string
          weight?: number
          base?: number
        }>
        EnableECSManagedTags?: boolean
        EnableExecuteCommand?: boolean
        PlacementConstraints?: Array<{
          type?: string
          expression?: string
        }>
        PlacementStrategy?: Array<{
          type?: string
          field?: string
        }>
        PropagateTags?: 'TASK_DEFINITION'
        ReferenceId?: string
        Tags?: Array<{
          Key: string
          Value: string
        }>
      }
      SqsParameters?: {
        MessageGroupId: string
      }
      HttpParameters?: {
        PathParameterValues?: string[]
        HeaderParameters?: Record<string, string>
        QueryStringParameters?: Record<string, string>
      }
      RedshiftDataParameters?: {
        Database: string
        Sql: string
        DbUser?: string
        SecretManagerArn?: string
        StatementName?: string
        WithEvent?: boolean
      }
      SageMakerPipelineParameters?: {
        PipelineParameterList?: Array<{
          Name: string
          Value: string
        }>
      }
      DeadLetterConfig?: {
        Arn: string
      }
      RetryPolicy?: {
        MaximumRetryAttempts?: number
        MaximumEventAge?: number
      }
    }>
  }
}

export interface EventBridgeEventBus extends CloudFormationResource {
  Type: 'AWS::Events::EventBus'
  Properties: {
    Name: string
    EventSourceName?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EventBridgeArchive extends CloudFormationResource {
  Type: 'AWS::Events::Archive'
  Properties: {
    ArchiveName?: string
    Description?: string
    EventPattern?: {
      source?: string[]
      'detail-type'?: string[]
      detail?: Record<string, unknown>
    }
    RetentionDays?: number
    SourceArn: string
  }
}
