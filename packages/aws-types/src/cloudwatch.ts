import type { CloudFormationResource } from './index'

export interface CloudWatchAlarm extends CloudFormationResource {
  Type: 'AWS::CloudWatch::Alarm'
  Properties: {
    AlarmName?: string
    AlarmDescription?: string
    MetricName?: string
    Namespace?: string
    Statistic?: 'SampleCount' | 'Average' | 'Sum' | 'Minimum' | 'Maximum'
    Period?: number
    EvaluationPeriods: number
    Threshold: number
    ComparisonOperator: 'GreaterThanOrEqualToThreshold' | 'GreaterThanThreshold' | 'LessThanThreshold' | 'LessThanOrEqualToThreshold'
    ActionsEnabled?: boolean
    AlarmActions?: string[]
    InsufficientDataActions?: string[]
    OKActions?: string[]
    Dimensions?: Array<{
      Name: string
      Value: string
    }>
    TreatMissingData?: 'breaching' | 'notBreaching' | 'ignore' | 'missing'
  }
}

export interface CloudWatchLogGroup extends CloudFormationResource {
  Type: 'AWS::Logs::LogGroup'
  Properties?: {
    LogGroupName?: string
    RetentionInDays?: 1 | 3 | 5 | 7 | 14 | 30 | 60 | 90 | 120 | 150 | 180 | 365 | 400 | 545 | 731 | 1827 | 3653
    KmsKeyId?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface CloudWatchDashboard extends CloudFormationResource {
  Type: 'AWS::CloudWatch::Dashboard'
  Properties: {
    DashboardName?: string
    DashboardBody: string
  }
}
