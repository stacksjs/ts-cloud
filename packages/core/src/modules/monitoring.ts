import type {
  CloudWatchAlarm,
  CloudWatchDashboard,
  CloudWatchLogGroup,
  CloudWatchLogStream,
  CloudWatchMetricFilter,
  CloudWatchCompositeAlarm,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface AlarmOptions {
  slug: string
  environment: EnvironmentType
  alarmName?: string
  metricName: string
  namespace: string
  statistic?: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount'
  period?: number
  evaluationPeriods?: number
  threshold: number
  comparisonOperator: 'GreaterThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanThreshold' | 'LessThanOrEqualToThreshold'
  treatMissingData?: 'breaching' | 'notBreaching' | 'ignore' | 'missing'
  actionsEnabled?: boolean
  alarmActions?: string[]
  okActions?: string[]
  insufficientDataActions?: string[]
  dimensions?: Record<string, string>
  unit?: string
  datapointsToAlarm?: number
}

export interface DashboardOptions {
  slug: string
  environment: EnvironmentType
  dashboardName?: string
  widgets: DashboardWidget[]
}

export interface DashboardWidget {
  type: 'metric' | 'log' | 'text' | 'alarm'
  x: number
  y: number
  width: number
  height: number
  properties: Record<string, unknown>
}

export interface LogGroupOptions {
  slug: string
  environment: EnvironmentType
  logGroupName?: string
  retentionInDays?: number
  kmsKeyId?: string
}

export interface LogStreamOptions {
  slug: string
  environment: EnvironmentType
  logStreamName?: string
}

export interface MetricFilterOptions {
  slug: string
  environment: EnvironmentType
  filterName?: string
  filterPattern: string
  metricTransformations: MetricTransformation[]
}

export interface MetricTransformation {
  metricName: string
  metricNamespace: string
  metricValue: string
  defaultValue?: number
  unit?: string
}

export interface CompositeAlarmOptions {
  slug: string
  environment: EnvironmentType
  alarmName?: string
  alarmRule: string
  actionsEnabled?: boolean
  alarmActions?: string[]
  okActions?: string[]
  insufficientDataActions?: string[]
}

/**
 * Monitoring Module - CloudWatch
 * Provides clean API for alarms, dashboards, logs, and metrics
 */
export class Monitoring {
  /**
   * Create a CloudWatch alarm
   */
  static createAlarm(options: AlarmOptions): {
    alarm: CloudWatchAlarm
    logicalId: string
  } {
    const {
      slug,
      environment,
      alarmName,
      metricName,
      namespace,
      statistic = 'Average',
      period = 300,
      evaluationPeriods = 1,
      threshold,
      comparisonOperator,
      treatMissingData = 'notBreaching',
      actionsEnabled = true,
      alarmActions,
      okActions,
      insufficientDataActions,
      dimensions,
      unit,
      datapointsToAlarm,
    } = options

    const resourceName = alarmName || generateResourceName({
      slug,
      environment,
      resourceType: 'alarm',
    })

    const logicalId = generateLogicalId(resourceName)

    const alarm: CloudWatchAlarm = {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        AlarmName: resourceName,
        MetricName: metricName,
        Namespace: namespace,
        Statistic: statistic,
        Period: period,
        EvaluationPeriods: evaluationPeriods,
        Threshold: threshold,
        ComparisonOperator: comparisonOperator,
        TreatMissingData: treatMissingData,
        ActionsEnabled: actionsEnabled,
      },
    }

    if (alarmActions && alarmActions.length > 0) {
      alarm.Properties!.AlarmActions = alarmActions
    }

    if (okActions && okActions.length > 0) {
      alarm.Properties!.OKActions = okActions
    }

    if (insufficientDataActions && insufficientDataActions.length > 0) {
      alarm.Properties!.InsufficientDataActions = insufficientDataActions
    }

    if (dimensions) {
      alarm.Properties!.Dimensions = Object.entries(dimensions).map(([name, value]) => ({
        Name: name,
        Value: value,
      }))
    }

    if (unit) {
      alarm.Properties!.Unit = unit
    }

    if (datapointsToAlarm !== undefined) {
      alarm.Properties!.DatapointsToAlarm = datapointsToAlarm
    }

    return { alarm, logicalId }
  }

  /**
   * Create a composite alarm (combines multiple alarms)
   */
  static createCompositeAlarm(options: CompositeAlarmOptions): {
    alarm: CloudWatchCompositeAlarm
    logicalId: string
  } {
    const {
      slug,
      environment,
      alarmName,
      alarmRule,
      actionsEnabled = true,
      alarmActions,
      okActions,
      insufficientDataActions,
    } = options

    const resourceName = alarmName || generateResourceName({
      slug,
      environment,
      resourceType: 'composite-alarm',
    })

    const logicalId = generateLogicalId(resourceName)

    const alarm: CloudWatchCompositeAlarm = {
      Type: 'AWS::CloudWatch::CompositeAlarm',
      Properties: {
        AlarmName: resourceName,
        AlarmRule: alarmRule,
        ActionsEnabled: actionsEnabled,
      },
    }

    if (alarmActions && alarmActions.length > 0) {
      alarm.Properties!.AlarmActions = alarmActions
    }

    if (okActions && okActions.length > 0) {
      alarm.Properties!.OKActions = okActions
    }

    if (insufficientDataActions && insufficientDataActions.length > 0) {
      alarm.Properties!.InsufficientDataActions = insufficientDataActions
    }

    return { alarm, logicalId }
  }

  /**
   * Create a CloudWatch dashboard
   */
  static createDashboard(options: DashboardOptions): {
    dashboard: CloudWatchDashboard
    logicalId: string
  } {
    const {
      slug,
      environment,
      dashboardName,
      widgets,
    } = options

    const resourceName = dashboardName || generateResourceName({
      slug,
      environment,
      resourceType: 'dashboard',
    })

    const logicalId = generateLogicalId(resourceName)

    const dashboardBody = {
      widgets: widgets.map(widget => ({
        type: widget.type,
        x: widget.x,
        y: widget.y,
        width: widget.width,
        height: widget.height,
        properties: widget.properties,
      })),
    }

    const dashboard: CloudWatchDashboard = {
      Type: 'AWS::CloudWatch::Dashboard',
      Properties: {
        DashboardName: resourceName,
        DashboardBody: JSON.stringify(dashboardBody),
      },
    }

    return { dashboard, logicalId }
  }

  /**
   * Create a CloudWatch log group
   */
  static createLogGroup(options: LogGroupOptions): {
    logGroup: CloudWatchLogGroup
    logicalId: string
  } {
    const {
      slug,
      environment,
      logGroupName,
      retentionInDays,
      kmsKeyId,
    } = options

    const resourceName = logGroupName || generateResourceName({
      slug,
      environment,
      resourceType: 'log-group',
    })

    const logicalId = generateLogicalId(resourceName)

    const logGroup: CloudWatchLogGroup = {
      Type: 'AWS::Logs::LogGroup',
      Properties: {
        LogGroupName: resourceName,
      },
    }

    if (retentionInDays !== undefined) {
      logGroup.Properties!.RetentionInDays = retentionInDays
    }

    if (kmsKeyId) {
      logGroup.Properties!.KmsKeyId = kmsKeyId
    }

    return { logGroup, logicalId }
  }

  /**
   * Create a CloudWatch log stream
   */
  static createLogStream(
    logGroupLogicalId: string,
    options: LogStreamOptions,
  ): {
      logStream: CloudWatchLogStream
      logicalId: string
    } {
    const {
      slug,
      environment,
      logStreamName,
    } = options

    const resourceName = logStreamName || generateResourceName({
      slug,
      environment,
      resourceType: 'log-stream',
    })

    const logicalId = generateLogicalId(resourceName)

    const logStream: CloudWatchLogStream = {
      Type: 'AWS::Logs::LogStream',
      Properties: {
        LogGroupName: Fn.Ref(logGroupLogicalId) as unknown as string,
        LogStreamName: resourceName,
      },
    }

    return { logStream, logicalId }
  }

  /**
   * Create a metric filter for log group
   */
  static createMetricFilter(
    logGroupLogicalId: string,
    options: MetricFilterOptions,
  ): {
      metricFilter: CloudWatchMetricFilter
      logicalId: string
    } {
    const {
      slug,
      environment,
      filterName,
      filterPattern,
      metricTransformations,
    } = options

    const resourceName = filterName || generateResourceName({
      slug,
      environment,
      resourceType: 'metric-filter',
    })

    const logicalId = generateLogicalId(resourceName)

    const metricFilter: CloudWatchMetricFilter = {
      Type: 'AWS::Logs::MetricFilter',
      Properties: {
        LogGroupName: Fn.Ref(logGroupLogicalId) as unknown as string,
        FilterPattern: filterPattern,
        MetricTransformations: metricTransformations.map(t => ({
          MetricName: t.metricName,
          MetricNamespace: t.metricNamespace,
          MetricValue: t.metricValue,
          DefaultValue: t.defaultValue,
          Unit: t.unit,
        })),
      },
    }

    return { metricFilter, logicalId }
  }

  /**
   * Common alarm configurations
   */
  static readonly AlarmTypes = {
    /**
     * High CPU utilization alarm
     */
    highCpu: (
      slug: string,
      environment: EnvironmentType,
      resourceId: string,
      threshold: number = 80,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-high-cpu`,
      metricName: 'CPUUtilization',
      namespace: 'AWS/EC2',
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 2,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { InstanceId: resourceId },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * High memory utilization alarm
     */
    highMemory: (
      slug: string,
      environment: EnvironmentType,
      resourceId: string,
      threshold: number = 80,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-high-memory`,
      metricName: 'MemoryUtilization',
      namespace: 'System/Linux',
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 2,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { InstanceId: resourceId },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * High disk utilization alarm
     */
    highDisk: (
      slug: string,
      environment: EnvironmentType,
      resourceId: string,
      threshold: number = 80,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-high-disk`,
      metricName: 'DiskSpaceUtilization',
      namespace: 'System/Linux',
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 2,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { InstanceId: resourceId, Filesystem: '/dev/xvda1', MountPath: '/' },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * Lambda error rate alarm
     */
    lambdaErrors: (
      slug: string,
      environment: EnvironmentType,
      functionName: string,
      threshold: number = 5,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-lambda-errors`,
      metricName: 'Errors',
      namespace: 'AWS/Lambda',
      statistic: 'Sum',
      period: 300,
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { FunctionName: functionName },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * Lambda throttles alarm
     */
    lambdaThrottles: (
      slug: string,
      environment: EnvironmentType,
      functionName: string,
      threshold: number = 10,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-lambda-throttles`,
      metricName: 'Throttles',
      namespace: 'AWS/Lambda',
      statistic: 'Sum',
      period: 300,
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { FunctionName: functionName },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * API Gateway 5xx errors alarm
     */
    apiGateway5xxErrors: (
      slug: string,
      environment: EnvironmentType,
      apiName: string,
      threshold: number = 10,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-api-5xx-errors`,
      metricName: '5XXError',
      namespace: 'AWS/ApiGateway',
      statistic: 'Sum',
      period: 300,
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { ApiName: apiName },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * API Gateway 4xx errors alarm
     */
    apiGateway4xxErrors: (
      slug: string,
      environment: EnvironmentType,
      apiName: string,
      threshold: number = 50,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-api-4xx-errors`,
      metricName: '4XXError',
      namespace: 'AWS/ApiGateway',
      statistic: 'Sum',
      period: 300,
      evaluationPeriods: 2,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { ApiName: apiName },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * DynamoDB throttled requests alarm
     */
    dynamoDBThrottles: (
      slug: string,
      environment: EnvironmentType,
      tableName: string,
      threshold: number = 5,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-dynamodb-throttles`,
      metricName: 'UserErrors',
      namespace: 'AWS/DynamoDB',
      statistic: 'Sum',
      period: 300,
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { TableName: tableName },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * RDS CPU alarm
     */
    rdsCpu: (
      slug: string,
      environment: EnvironmentType,
      dbInstanceId: string,
      threshold: number = 80,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-rds-cpu`,
      metricName: 'CPUUtilization',
      namespace: 'AWS/RDS',
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 2,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { DBInstanceIdentifier: dbInstanceId },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * RDS free storage alarm
     */
    rdsFreeStorage: (
      slug: string,
      environment: EnvironmentType,
      dbInstanceId: string,
      threshold: number = 5368709120, // 5GB in bytes
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-rds-storage`,
      metricName: 'FreeStorageSpace',
      namespace: 'AWS/RDS',
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'LessThanThreshold',
      dimensions: { DBInstanceIdentifier: dbInstanceId },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
      unit: 'Bytes',
    }),

    /**
     * SQS queue depth alarm
     */
    sqsQueueDepth: (
      slug: string,
      environment: EnvironmentType,
      queueName: string,
      threshold: number = 100,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-sqs-depth`,
      metricName: 'ApproximateNumberOfMessagesVisible',
      namespace: 'AWS/SQS',
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 2,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { QueueName: queueName },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * ALB target unhealthy alarm
     */
    albUnhealthyTargets: (
      slug: string,
      environment: EnvironmentType,
      loadBalancer: string,
      targetGroup: string,
      threshold: number = 1,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-alb-unhealthy`,
      metricName: 'UnHealthyHostCount',
      namespace: 'AWS/ApplicationELB',
      statistic: 'Average',
      period: 300,
      evaluationPeriods: 2,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { LoadBalancer: loadBalancer, TargetGroup: targetGroup },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),
  } as const

  /**
   * Common dashboard widgets
   */
  static readonly DashboardWidgets = {
    /**
     * Metric widget
     */
    metric: (
      x: number,
      y: number,
      width: number,
      height: number,
      metrics: Array<[string, string, Record<string, string>?]>,
      title?: string,
    ): DashboardWidget => ({
      type: 'metric',
      x,
      y,
      width,
      height,
      properties: {
        metrics,
        title: title || 'Metrics',
        region: 'us-east-1',
        period: 300,
      },
    }),

    /**
     * Text widget
     */
    text: (
      x: number,
      y: number,
      width: number,
      height: number,
      markdown: string,
    ): DashboardWidget => ({
      type: 'text',
      x,
      y,
      width,
      height,
      properties: {
        markdown,
      },
    }),

    /**
     * Log widget
     */
    log: (
      x: number,
      y: number,
      width: number,
      height: number,
      logGroupNames: string[],
      title?: string,
    ): DashboardWidget => ({
      type: 'log',
      x,
      y,
      width,
      height,
      properties: {
        query: `SOURCE '${logGroupNames.join("' | SOURCE '")}'
| fields @timestamp, @message
| sort @timestamp desc
| limit 20`,
        region: 'us-east-1',
        title: title || 'Logs',
      },
    }),
  } as const

  /**
   * Common log retention periods
   */
  static readonly RetentionPeriods = {
    ONE_DAY: 1,
    THREE_DAYS: 3,
    FIVE_DAYS: 5,
    ONE_WEEK: 7,
    TWO_WEEKS: 14,
    ONE_MONTH: 30,
    TWO_MONTHS: 60,
    THREE_MONTHS: 90,
    FOUR_MONTHS: 120,
    FIVE_MONTHS: 150,
    SIX_MONTHS: 180,
    ONE_YEAR: 365,
    THIRTEEN_MONTHS: 400,
    EIGHTEEN_MONTHS: 545,
    TWO_YEARS: 731,
    FIVE_YEARS: 1827,
    TEN_YEARS: 3653,
    NEVER_EXPIRE: undefined,
  } as const

  /**
   * Common metric filter patterns
   */
  static readonly FilterPatterns = {
    /**
     * Match ERROR log lines
     */
    errors: '[time, request_id, event_type = ERROR*, ...]',

    /**
     * Match all log lines
     */
    all: '',

    /**
     * Match JSON logs with specific field
     */
    jsonField: (field: string, value: string) => `{ $.${field} = "${value}" }`,

    /**
     * Match HTTP status codes
     */
    httpStatus: (statusCode: number) => `[..., status_code = ${statusCode}, ...]`,

    /**
     * Match 4xx errors
     */
    http4xx: '[..., status_code = 4*, ...]',

    /**
     * Match 5xx errors
     */
    http5xx: '[..., status_code = 5*, ...]',
  } as const
}
