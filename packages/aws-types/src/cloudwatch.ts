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
    /** Unit of the metric (e.g., 'Seconds', 'Bytes', 'Count') */
    Unit?: string
    /** Number of datapoints that must be breaching to trigger the alarm */
    DatapointsToAlarm?: number
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

export interface CloudWatchLogStream extends CloudFormationResource {
  Type: 'AWS::Logs::LogStream'
  Properties: {
    LogGroupName: string | { Ref: string }
    LogStreamName?: string
  }
}

export interface CloudWatchMetricFilter extends CloudFormationResource {
  Type: 'AWS::Logs::MetricFilter'
  Properties: {
    LogGroupName: string | { Ref: string }
    FilterPattern: string
    MetricTransformations: Array<{
      MetricName: string
      MetricNamespace: string
      MetricValue: string
      DefaultValue?: number
      Unit?: string
      Dimensions?: Array<{
        Key: string
        Value: string
      }>
    }>
    FilterName?: string
  }
}

export interface CloudWatchCompositeAlarm extends CloudFormationResource {
  Type: 'AWS::CloudWatch::CompositeAlarm'
  Properties: {
    AlarmName: string
    AlarmRule: string
    AlarmDescription?: string
    ActionsEnabled?: boolean
    AlarmActions?: string[]
    InsufficientDataActions?: string[]
    OKActions?: string[]
    ActionsSuppressor?: string
    ActionsSuppressorExtensionPeriod?: number
    ActionsSuppressorWaitPeriod?: number
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
