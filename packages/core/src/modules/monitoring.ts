import type {
  CloudWatchAlarm,
  CloudWatchDashboard,
  CloudWatchLogGroup,
  CloudWatchLogStream,
  CloudWatchMetricFilter,
  CloudWatchCompositeAlarm,
} from '@stacksjs/ts-cloud-aws-types'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'
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
      logGroup.Properties!.RetentionInDays = retentionInDays as 1 | 3 | 5 | 7 | 14 | 30 | 60 | 90 | 120 | 150 | 180 | 365 | 400 | 545 | 731 | 1827 | 3653
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

    /**
     * SES bounce rate alarm
     */
    sesBounceRate: (
      slug: string,
      environment: EnvironmentType,
      threshold: number = 5,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-ses-bounce-rate`,
      metricName: 'Reputation.BounceRate',
      namespace: 'AWS/SES',
      statistic: 'Average',
      period: 3600,
      evaluationPeriods: 1,
      threshold: threshold / 100, // Convert percentage to decimal
      comparisonOperator: 'GreaterThanThreshold',
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * SES complaint rate alarm
     */
    sesComplaintRate: (
      slug: string,
      environment: EnvironmentType,
      threshold: number = 0.1,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-ses-complaint-rate`,
      metricName: 'Reputation.ComplaintRate',
      namespace: 'AWS/SES',
      statistic: 'Average',
      period: 3600,
      evaluationPeriods: 1,
      threshold: threshold / 100,
      comparisonOperator: 'GreaterThanThreshold',
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * Pinpoint SMS delivery failure alarm
     */
    smsDeliveryFailure: (
      slug: string,
      environment: EnvironmentType,
      applicationId: string,
      threshold: number = 10,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-sms-delivery-failure`,
      metricName: 'DirectSendMessagePermanentFailure',
      namespace: 'AWS/Pinpoint',
      statistic: 'Sum',
      period: 300,
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { ApplicationId: applicationId },
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * Pinpoint SMS spend alarm
     */
    smsSpendLimit: (
      slug: string,
      environment: EnvironmentType,
      threshold: number = 100,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-sms-spend-limit`,
      metricName: 'DirectSendMessageSpend',
      namespace: 'AWS/Pinpoint',
      statistic: 'Sum',
      period: 86400, // Daily
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      alarmActions: snsTopicArn ? [snsTopicArn] : undefined,
    }),

    /**
     * Connect missed calls alarm
     */
    connectMissedCalls: (
      slug: string,
      environment: EnvironmentType,
      instanceId: string,
      threshold: number = 5,
      snsTopicArn?: string,
    ): AlarmOptions => ({
      slug,
      environment,
      alarmName: `${slug}-${environment}-connect-missed-calls`,
      metricName: 'MissedCalls',
      namespace: 'AWS/Connect',
      statistic: 'Sum',
      period: 3600,
      evaluationPeriods: 1,
      threshold,
      comparisonOperator: 'GreaterThanThreshold',
      dimensions: { InstanceId: instanceId },
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
    jsonField: (field: string, value: string): string => `{ $.${field} = "${value}" }`,

    /**
     * Match HTTP status codes
     */
    httpStatus: (statusCode: number): string => `[..., status_code = ${statusCode}, ...]`,

    /**
     * Match 4xx errors
     */
    http4xx: '[..., status_code = 4*, ...]',

    /**
     * Match 5xx errors
     */
    http5xx: '[..., status_code = 5*, ...]',
  } as const

  /**
   * Create a comprehensive application dashboard
   */
  static createApplicationDashboard(options: {
    slug: string
    environment: EnvironmentType
    region?: string
    components?: {
      ec2InstanceIds?: string[]
      lambdaFunctionNames?: string[]
      ecsClusterName?: string
      ecsServiceName?: string
      albName?: string
      targetGroupName?: string
      rdsInstanceId?: string
      sqsQueueNames?: string[]
      logGroupNames?: string[]
    }
  }): {
    dashboard: CloudWatchDashboard
    logicalId: string
  } {
    const {
      slug,
      environment,
      region = 'us-east-1',
      components = {},
    } = options

    const widgets: DashboardWidget[] = []
    let currentY = 0

    // Header text widget
    widgets.push({
      type: 'text',
      x: 0,
      y: currentY,
      width: 24,
      height: 1,
      properties: {
        markdown: `# ${slug.toUpperCase()} Dashboard (${environment})`,
      },
    })
    currentY += 1

    // EC2 metrics
    if (components.ec2InstanceIds && components.ec2InstanceIds.length > 0) {
      widgets.push({
        type: 'text',
        x: 0,
        y: currentY,
        width: 24,
        height: 1,
        properties: {
          markdown: '## EC2 Instances',
        },
      })
      currentY += 1

      // CPU utilization
      widgets.push({
        type: 'metric',
        x: 0,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'CPU Utilization',
          region,
          metrics: components.ec2InstanceIds.map(id => [
            'AWS/EC2',
            'CPUUtilization',
            'InstanceId',
            id,
          ]),
          period: 300,
          stat: 'Average',
        },
      })

      // Network In/Out
      widgets.push({
        type: 'metric',
        x: 8,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Network Traffic',
          region,
          metrics: [
            ...components.ec2InstanceIds.flatMap(id => [
              ['AWS/EC2', 'NetworkIn', 'InstanceId', id, { label: `${id} In` }],
              ['AWS/EC2', 'NetworkOut', 'InstanceId', id, { label: `${id} Out` }],
            ]),
          ],
          period: 300,
          stat: 'Sum',
        },
      })

      // Status check
      widgets.push({
        type: 'metric',
        x: 16,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Status Checks',
          region,
          metrics: components.ec2InstanceIds.map(id => [
            'AWS/EC2',
            'StatusCheckFailed',
            'InstanceId',
            id,
          ]),
          period: 60,
          stat: 'Maximum',
        },
      })

      currentY += 6
    }

    // Lambda metrics
    if (components.lambdaFunctionNames && components.lambdaFunctionNames.length > 0) {
      widgets.push({
        type: 'text',
        x: 0,
        y: currentY,
        width: 24,
        height: 1,
        properties: {
          markdown: '## Lambda Functions',
        },
      })
      currentY += 1

      // Invocations
      widgets.push({
        type: 'metric',
        x: 0,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Invocations',
          region,
          metrics: components.lambdaFunctionNames.map(name => [
            'AWS/Lambda',
            'Invocations',
            'FunctionName',
            name,
          ]),
          period: 300,
          stat: 'Sum',
        },
      })

      // Duration
      widgets.push({
        type: 'metric',
        x: 8,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Duration',
          region,
          metrics: components.lambdaFunctionNames.map(name => [
            'AWS/Lambda',
            'Duration',
            'FunctionName',
            name,
          ]),
          period: 300,
          stat: 'Average',
        },
      })

      // Errors
      widgets.push({
        type: 'metric',
        x: 16,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Errors',
          region,
          metrics: components.lambdaFunctionNames.map(name => [
            'AWS/Lambda',
            'Errors',
            'FunctionName',
            name,
          ]),
          period: 300,
          stat: 'Sum',
        },
      })

      currentY += 6
    }

    // ECS metrics
    if (components.ecsClusterName && components.ecsServiceName) {
      widgets.push({
        type: 'text',
        x: 0,
        y: currentY,
        width: 24,
        height: 1,
        properties: {
          markdown: '## ECS Service',
        },
      })
      currentY += 1

      // CPU utilization
      widgets.push({
        type: 'metric',
        x: 0,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'CPU Utilization',
          region,
          metrics: [
            ['AWS/ECS', 'CPUUtilization', 'ClusterName', components.ecsClusterName, 'ServiceName', components.ecsServiceName],
          ],
          period: 300,
          stat: 'Average',
        },
      })

      // Memory utilization
      widgets.push({
        type: 'metric',
        x: 8,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Memory Utilization',
          region,
          metrics: [
            ['AWS/ECS', 'MemoryUtilization', 'ClusterName', components.ecsClusterName, 'ServiceName', components.ecsServiceName],
          ],
          period: 300,
          stat: 'Average',
        },
      })

      // Running tasks
      widgets.push({
        type: 'metric',
        x: 16,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Running Tasks',
          region,
          metrics: [
            ['ECS/ContainerInsights', 'RunningTaskCount', 'ClusterName', components.ecsClusterName, 'ServiceName', components.ecsServiceName],
          ],
          period: 60,
          stat: 'Average',
        },
      })

      currentY += 6
    }

    // ALB metrics
    if (components.albName) {
      widgets.push({
        type: 'text',
        x: 0,
        y: currentY,
        width: 24,
        height: 1,
        properties: {
          markdown: '## Application Load Balancer',
        },
      })
      currentY += 1

      // Request count
      widgets.push({
        type: 'metric',
        x: 0,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Request Count',
          region,
          metrics: [
            ['AWS/ApplicationELB', 'RequestCount', 'LoadBalancer', components.albName],
          ],
          period: 60,
          stat: 'Sum',
        },
      })

      // Response time
      widgets.push({
        type: 'metric',
        x: 8,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Response Time',
          region,
          metrics: [
            ['AWS/ApplicationELB', 'TargetResponseTime', 'LoadBalancer', components.albName],
          ],
          period: 60,
          stat: 'Average',
        },
      })

      // HTTP errors
      widgets.push({
        type: 'metric',
        x: 16,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'HTTP Errors',
          region,
          metrics: [
            ['AWS/ApplicationELB', 'HTTPCode_Target_4XX_Count', 'LoadBalancer', components.albName, { label: '4XX' }],
            ['AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', 'LoadBalancer', components.albName, { label: '5XX' }],
          ],
          period: 60,
          stat: 'Sum',
        },
      })

      currentY += 6
    }

    // RDS metrics
    if (components.rdsInstanceId) {
      widgets.push({
        type: 'text',
        x: 0,
        y: currentY,
        width: 24,
        height: 1,
        properties: {
          markdown: '## RDS Database',
        },
      })
      currentY += 1

      // CPU
      widgets.push({
        type: 'metric',
        x: 0,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'CPU Utilization',
          region,
          metrics: [
            ['AWS/RDS', 'CPUUtilization', 'DBInstanceIdentifier', components.rdsInstanceId],
          ],
          period: 300,
          stat: 'Average',
        },
      })

      // Connections
      widgets.push({
        type: 'metric',
        x: 8,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Database Connections',
          region,
          metrics: [
            ['AWS/RDS', 'DatabaseConnections', 'DBInstanceIdentifier', components.rdsInstanceId],
          ],
          period: 60,
          stat: 'Sum',
        },
      })

      // Free storage
      widgets.push({
        type: 'metric',
        x: 16,
        y: currentY,
        width: 8,
        height: 6,
        properties: {
          title: 'Free Storage Space',
          region,
          metrics: [
            ['AWS/RDS', 'FreeStorageSpace', 'DBInstanceIdentifier', components.rdsInstanceId],
          ],
          period: 300,
          stat: 'Average',
        },
      })

      currentY += 6
    }

    // SQS metrics
    if (components.sqsQueueNames && components.sqsQueueNames.length > 0) {
      widgets.push({
        type: 'text',
        x: 0,
        y: currentY,
        width: 24,
        height: 1,
        properties: {
          markdown: '## SQS Queues',
        },
      })
      currentY += 1

      // Messages visible
      widgets.push({
        type: 'metric',
        x: 0,
        y: currentY,
        width: 12,
        height: 6,
        properties: {
          title: 'Messages Visible',
          region,
          metrics: components.sqsQueueNames.map(name => [
            'AWS/SQS',
            'ApproximateNumberOfMessagesVisible',
            'QueueName',
            name,
          ]),
          period: 60,
          stat: 'Sum',
        },
      })

      // Age of oldest message
      widgets.push({
        type: 'metric',
        x: 12,
        y: currentY,
        width: 12,
        height: 6,
        properties: {
          title: 'Message Age',
          region,
          metrics: components.sqsQueueNames.map(name => [
            'AWS/SQS',
            'ApproximateAgeOfOldestMessage',
            'QueueName',
            name,
          ]),
          period: 60,
          stat: 'Maximum',
        },
      })

      currentY += 6
    }

    // Log widget
    if (components.logGroupNames && components.logGroupNames.length > 0) {
      widgets.push({
        type: 'text',
        x: 0,
        y: currentY,
        width: 24,
        height: 1,
        properties: {
          markdown: '## Application Logs',
        },
      })
      currentY += 1

      widgets.push({
        type: 'log',
        x: 0,
        y: currentY,
        width: 24,
        height: 6,
        properties: {
          query: `SOURCE '${components.logGroupNames.join("' | SOURCE '")}'
| fields @timestamp, @message
| filter @message like /ERROR|WARN|Exception/
| sort @timestamp desc
| limit 50`,
          region,
          title: 'Recent Errors and Warnings',
        },
      })

      currentY += 6
    }

    return Monitoring.createDashboard({
      slug,
      environment,
      widgets,
    })
  }

  /**
   * Dashboard templates for common architectures
   */
  static readonly DashboardTemplates = {
    /**
     * Static website dashboard (S3 + CloudFront)
     */
    staticWebsite: (options: {
      slug: string
      environment: EnvironmentType
      region?: string
      cloudFrontDistributionId: string
      s3BucketName: string
    }): DashboardOptions => ({
      slug: options.slug,
      environment: options.environment,
      widgets: [
        {
          type: 'text',
          x: 0,
          y: 0,
          width: 24,
          height: 1,
          properties: {
            markdown: `# ${options.slug.toUpperCase()} Static Website Dashboard`,
          },
        },
        {
          type: 'metric',
          x: 0,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'CloudFront Requests',
            region: 'us-east-1',
            metrics: [
              ['AWS/CloudFront', 'Requests', 'DistributionId', options.cloudFrontDistributionId, 'Region', 'Global'],
            ],
            period: 300,
            stat: 'Sum',
          },
        },
        {
          type: 'metric',
          x: 8,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'Error Rate',
            region: 'us-east-1',
            metrics: [
              ['AWS/CloudFront', '4xxErrorRate', 'DistributionId', options.cloudFrontDistributionId, 'Region', 'Global', { label: '4XX' }],
              ['AWS/CloudFront', '5xxErrorRate', 'DistributionId', options.cloudFrontDistributionId, 'Region', 'Global', { label: '5XX' }],
            ],
            period: 300,
            stat: 'Average',
          },
        },
        {
          type: 'metric',
          x: 16,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'Bytes Downloaded',
            region: 'us-east-1',
            metrics: [
              ['AWS/CloudFront', 'BytesDownloaded', 'DistributionId', options.cloudFrontDistributionId, 'Region', 'Global'],
            ],
            period: 300,
            stat: 'Sum',
          },
        },
        {
          type: 'metric',
          x: 0,
          y: 7,
          width: 12,
          height: 6,
          properties: {
            title: 'S3 Bucket Size',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/S3', 'BucketSizeBytes', 'BucketName', options.s3BucketName, 'StorageType', 'StandardStorage'],
            ],
            period: 86400,
            stat: 'Average',
          },
        },
        {
          type: 'metric',
          x: 12,
          y: 7,
          width: 12,
          height: 6,
          properties: {
            title: 'S3 Number of Objects',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/S3', 'NumberOfObjects', 'BucketName', options.s3BucketName, 'StorageType', 'AllStorageTypes'],
            ],
            period: 86400,
            stat: 'Average',
          },
        },
      ],
    }),

    /**
     * Serverless API dashboard (Lambda + API Gateway)
     */
    serverlessApi: (options: {
      slug: string
      environment: EnvironmentType
      region?: string
      apiGatewayName: string
      lambdaFunctionNames: string[]
    }): DashboardOptions => ({
      slug: options.slug,
      environment: options.environment,
      widgets: [
        {
          type: 'text',
          x: 0,
          y: 0,
          width: 24,
          height: 1,
          properties: {
            markdown: `# ${options.slug.toUpperCase()} Serverless API Dashboard`,
          },
        },
        {
          type: 'metric',
          x: 0,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'API Requests',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ApiGateway', 'Count', 'ApiName', options.apiGatewayName],
            ],
            period: 60,
            stat: 'Sum',
          },
        },
        {
          type: 'metric',
          x: 8,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'API Latency',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ApiGateway', 'Latency', 'ApiName', options.apiGatewayName],
            ],
            period: 60,
            stat: 'Average',
          },
        },
        {
          type: 'metric',
          x: 16,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'API Errors',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ApiGateway', '4XXError', 'ApiName', options.apiGatewayName, { label: '4XX' }],
              ['AWS/ApiGateway', '5XXError', 'ApiName', options.apiGatewayName, { label: '5XX' }],
            ],
            period: 60,
            stat: 'Sum',
          },
        },
        ...options.lambdaFunctionNames.map((name, index) => ({
          type: 'metric' as const,
          x: (index % 3) * 8,
          y: 7 + Math.floor(index / 3) * 6,
          width: 8,
          height: 6,
          properties: {
            title: `${name} Metrics`,
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/Lambda', 'Invocations', 'FunctionName', name],
              ['AWS/Lambda', 'Duration', 'FunctionName', name],
              ['AWS/Lambda', 'Errors', 'FunctionName', name],
            ],
            period: 300,
            stat: 'Sum',
          },
        })),
      ],
    }),

    /**
     * Container service dashboard (ECS + ALB)
     */
    containerService: (options: {
      slug: string
      environment: EnvironmentType
      region?: string
      ecsClusterName: string
      ecsServiceName: string
      albName: string
      rdsInstanceId?: string
    }): DashboardOptions => ({
      slug: options.slug,
      environment: options.environment,
      widgets: [
        {
          type: 'text',
          x: 0,
          y: 0,
          width: 24,
          height: 1,
          properties: {
            markdown: `# ${options.slug.toUpperCase()} Container Service Dashboard`,
          },
        },
        // ECS metrics
        {
          type: 'metric',
          x: 0,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'ECS CPU',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ECS', 'CPUUtilization', 'ClusterName', options.ecsClusterName, 'ServiceName', options.ecsServiceName],
            ],
            period: 60,
            stat: 'Average',
          },
        },
        {
          type: 'metric',
          x: 8,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'ECS Memory',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ECS', 'MemoryUtilization', 'ClusterName', options.ecsClusterName, 'ServiceName', options.ecsServiceName],
            ],
            period: 60,
            stat: 'Average',
          },
        },
        {
          type: 'metric',
          x: 16,
          y: 1,
          width: 8,
          height: 6,
          properties: {
            title: 'Running Tasks',
            region: options.region || 'us-east-1',
            metrics: [
              ['ECS/ContainerInsights', 'RunningTaskCount', 'ClusterName', options.ecsClusterName, 'ServiceName', options.ecsServiceName],
            ],
            period: 60,
            stat: 'Average',
          },
        },
        // ALB metrics
        {
          type: 'metric',
          x: 0,
          y: 7,
          width: 8,
          height: 6,
          properties: {
            title: 'ALB Requests',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ApplicationELB', 'RequestCount', 'LoadBalancer', options.albName],
            ],
            period: 60,
            stat: 'Sum',
          },
        },
        {
          type: 'metric',
          x: 8,
          y: 7,
          width: 8,
          height: 6,
          properties: {
            title: 'Response Time',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ApplicationELB', 'TargetResponseTime', 'LoadBalancer', options.albName],
            ],
            period: 60,
            stat: 'Average',
          },
        },
        {
          type: 'metric',
          x: 16,
          y: 7,
          width: 8,
          height: 6,
          properties: {
            title: 'Healthy Hosts',
            region: options.region || 'us-east-1',
            metrics: [
              ['AWS/ApplicationELB', 'HealthyHostCount', 'LoadBalancer', options.albName],
            ],
            period: 60,
            stat: 'Average',
          },
        },
        ...(options.rdsInstanceId
          ? [
              {
                type: 'metric' as const,
                x: 0,
                y: 13,
                width: 12,
                height: 6,
                properties: {
                  title: 'RDS CPU',
                  region: options.region || 'us-east-1',
                  metrics: [
                    ['AWS/RDS', 'CPUUtilization', 'DBInstanceIdentifier', options.rdsInstanceId],
                  ],
                  period: 300,
                  stat: 'Average',
                },
              },
              {
                type: 'metric' as const,
                x: 12,
                y: 13,
                width: 12,
                height: 6,
                properties: {
                  title: 'RDS Connections',
                  region: options.region || 'us-east-1',
                  metrics: [
                    ['AWS/RDS', 'DatabaseConnections', 'DBInstanceIdentifier', options.rdsInstanceId],
                  ],
                  period: 60,
                  stat: 'Sum',
                },
              },
            ]
          : []),
      ],
    }),
  }

  /**
   * Monitoring Configuration helpers
   * Provides Stacks configuration parity for monitoring options
   */
  static readonly Config = {
    /**
     * Create alarm configuration
     */
    createAlarmConfig: (options: {
      metricName: string
      namespace: string
      threshold: number
      comparisonOperator?: 'GreaterThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanThreshold' | 'LessThanOrEqualToThreshold'
      evaluationPeriods?: number
      period?: number
      statistic?: 'Average' | 'Sum' | 'Maximum' | 'Minimum' | 'SampleCount'
      treatMissingData?: 'breaching' | 'notBreaching' | 'ignore' | 'missing'
    }): {
      MetricName: string
      Namespace: string
      Threshold: number
      ComparisonOperator: string
      EvaluationPeriods: number
      Period: number
      Statistic: string
      TreatMissingData: string
    } => {
      const {
        metricName,
        namespace,
        threshold,
        comparisonOperator = 'GreaterThanThreshold',
        evaluationPeriods = 1,
        period = 300,
        statistic = 'Average',
        treatMissingData = 'missing',
      } = options

      return {
        MetricName: metricName,
        Namespace: namespace,
        Threshold: threshold,
        ComparisonOperator: comparisonOperator,
        EvaluationPeriods: evaluationPeriods,
        Period: period,
        Statistic: statistic,
        TreatMissingData: treatMissingData,
      }
    },

    /**
     * AWS namespace constants
     */
    namespaces: {
      ec2: 'AWS/EC2',
      ecs: 'AWS/ECS',
      lambda: 'AWS/Lambda',
      rds: 'AWS/RDS',
      sqs: 'AWS/SQS',
      sns: 'AWS/SNS',
      s3: 'AWS/S3',
      cloudfront: 'AWS/CloudFront',
      alb: 'AWS/ApplicationELB',
      nlb: 'AWS/NetworkELB',
      apiGateway: 'AWS/ApiGateway',
      dynamodb: 'AWS/DynamoDB',
      elasticache: 'AWS/ElastiCache',
    } as const,

    /**
     * Comparison operator options
     */
    comparisonOperators: {
      greaterThan: 'GreaterThanThreshold',
      greaterOrEqual: 'GreaterThanOrEqualToThreshold',
      lessThan: 'LessThanThreshold',
      lessOrEqual: 'LessThanOrEqualToThreshold',
    } as const,

    /**
     * Common metric configurations by service
     */
    metrics: {
      ec2: {
        cpu: { metricName: 'CPUUtilization', namespace: 'AWS/EC2' },
        networkIn: { metricName: 'NetworkIn', namespace: 'AWS/EC2' },
        networkOut: { metricName: 'NetworkOut', namespace: 'AWS/EC2' },
        statusCheck: { metricName: 'StatusCheckFailed', namespace: 'AWS/EC2' },
      },
      ecs: {
        cpu: { metricName: 'CPUUtilization', namespace: 'AWS/ECS' },
        memory: { metricName: 'MemoryUtilization', namespace: 'AWS/ECS' },
      },
      lambda: {
        invocations: { metricName: 'Invocations', namespace: 'AWS/Lambda' },
        errors: { metricName: 'Errors', namespace: 'AWS/Lambda' },
        duration: { metricName: 'Duration', namespace: 'AWS/Lambda' },
        throttles: { metricName: 'Throttles', namespace: 'AWS/Lambda' },
        concurrentExecutions: { metricName: 'ConcurrentExecutions', namespace: 'AWS/Lambda' },
      },
      rds: {
        cpu: { metricName: 'CPUUtilization', namespace: 'AWS/RDS' },
        connections: { metricName: 'DatabaseConnections', namespace: 'AWS/RDS' },
        freeStorage: { metricName: 'FreeStorageSpace', namespace: 'AWS/RDS' },
        readLatency: { metricName: 'ReadLatency', namespace: 'AWS/RDS' },
        writeLatency: { metricName: 'WriteLatency', namespace: 'AWS/RDS' },
      },
      alb: {
        requestCount: { metricName: 'RequestCount', namespace: 'AWS/ApplicationELB' },
        responseTime: { metricName: 'TargetResponseTime', namespace: 'AWS/ApplicationELB' },
        httpCode4xx: { metricName: 'HTTPCode_Target_4XX_Count', namespace: 'AWS/ApplicationELB' },
        httpCode5xx: { metricName: 'HTTPCode_Target_5XX_Count', namespace: 'AWS/ApplicationELB' },
        healthyHosts: { metricName: 'HealthyHostCount', namespace: 'AWS/ApplicationELB' },
      },
      sqs: {
        messagesVisible: { metricName: 'ApproximateNumberOfMessagesVisible', namespace: 'AWS/SQS' },
        messagesDelayed: { metricName: 'ApproximateNumberOfMessagesDelayed', namespace: 'AWS/SQS' },
        messageAge: { metricName: 'ApproximateAgeOfOldestMessage', namespace: 'AWS/SQS' },
      },
    },

    /**
     * Common alarm presets
     */
    presets: {
      /**
       * High CPU alarm
       */
      highCpu: (threshold: number = 80): {
        metricName: string;
        threshold: number;
        comparisonOperator: 'GreaterThanThreshold';
        evaluationPeriods: number;
        period: number;
        statistic: 'Average';
      } => ({
        metricName: 'CPUUtilization',
        threshold,
        comparisonOperator: 'GreaterThanThreshold' as const,
        evaluationPeriods: 3,
        period: 300,
        statistic: 'Average' as const,
      }),

      /**
       * High memory alarm (for ECS)
       */
      highMemory: (threshold: number = 80): {
        metricName: string;
        threshold: number;
        comparisonOperator: 'GreaterThanThreshold';
        evaluationPeriods: number;
        period: number;
        statistic: 'Average';
      } => ({
        metricName: 'MemoryUtilization',
        threshold,
        comparisonOperator: 'GreaterThanThreshold' as const,
        evaluationPeriods: 3,
        period: 300,
        statistic: 'Average' as const,
      }),

      /**
       * High error rate alarm
       */
      highErrors: (threshold: number = 10): {
        metricName: string;
        threshold: number;
        comparisonOperator: 'GreaterThanThreshold';
        evaluationPeriods: number;
        period: number;
        statistic: 'Sum';
      } => ({
        metricName: 'Errors',
        threshold,
        comparisonOperator: 'GreaterThanThreshold' as const,
        evaluationPeriods: 1,
        period: 60,
        statistic: 'Sum' as const,
      }),

      /**
       * High latency alarm
       */
      highLatency: (threshold: number = 5000): {
        metricName: string;
        threshold: number;
        comparisonOperator: 'GreaterThanThreshold';
        evaluationPeriods: number;
        period: number;
        statistic: 'Average';
      } => ({
        metricName: 'Duration',
        threshold,
        comparisonOperator: 'GreaterThanThreshold' as const,
        evaluationPeriods: 3,
        period: 300,
        statistic: 'Average' as const,
      }),

      /**
       * Low healthy hosts alarm
       */
      lowHealthyHosts: (threshold: number = 1): {
        metricName: string;
        namespace: string;
        threshold: number;
        comparisonOperator: 'LessThanThreshold';
        evaluationPeriods: number;
        period: number;
        statistic: 'Minimum';
      } => ({
        metricName: 'HealthyHostCount',
        namespace: 'AWS/ApplicationELB',
        threshold,
        comparisonOperator: 'LessThanThreshold' as const,
        evaluationPeriods: 2,
        period: 60,
        statistic: 'Minimum' as const,
      }),

      /**
       * Queue depth alarm
       */
      queueDepth: (threshold: number = 1000): {
        metricName: string;
        namespace: string;
        threshold: number;
        comparisonOperator: 'GreaterThanThreshold';
        evaluationPeriods: number;
        period: number;
        statistic: 'Average';
      } => ({
        metricName: 'ApproximateNumberOfMessagesVisible',
        namespace: 'AWS/SQS',
        threshold,
        comparisonOperator: 'GreaterThanThreshold' as const,
        evaluationPeriods: 3,
        period: 300,
        statistic: 'Average' as const,
      }),

      /**
       * Low storage alarm
       */
      lowStorage: (threshold: number = 10737418240): {
        metricName: string;
        namespace: string;
        threshold: number;
        comparisonOperator: 'LessThanThreshold';
        evaluationPeriods: number;
        period: number;
        statistic: 'Average';
      } => ({ // 10 GB
        metricName: 'FreeStorageSpace',
        namespace: 'AWS/RDS',
        threshold,
        comparisonOperator: 'LessThanThreshold' as const,
        evaluationPeriods: 1,
        period: 300,
        statistic: 'Average' as const,
      }),
    },
  }
}
