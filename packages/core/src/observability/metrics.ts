/**
 * Custom CloudWatch Metrics
 * Application and business metrics collection
*/

export interface MetricNamespace {
  id: string
  name: string
  description?: string
  metrics: CustomMetric[]
}

export interface CustomMetric {
  id: string
  name: string
  namespace: string
  unit: MetricUnit
  dimensions?: MetricDimension[]
  statisticValues?: MetricStatistic[]
  alarms?: MetricAlarm[]
}

export type MetricUnit =
  | 'Seconds'
  | 'Microseconds'
  | 'Milliseconds'
  | 'Bytes'
  | 'Kilobytes'
  | 'Megabytes'
  | 'Gigabytes'
  | 'Terabytes'
  | 'Bits'
  | 'Kilobits'
  | 'Megabits'
  | 'Gigabits'
  | 'Terabits'
  | 'Percent'
  | 'Count'
  | 'Bytes/Second'
  | 'Kilobytes/Second'
  | 'Megabytes/Second'
  | 'Gigabytes/Second'
  | 'Terabytes/Second'
  | 'Bits/Second'
  | 'Kilobits/Second'
  | 'Megabits/Second'
  | 'Gigabits/Second'
  | 'Terabits/Second'
  | 'Count/Second'
  | 'None'

export interface MetricDimension {
  name: string
  value: string
}

export interface MetricStatistic {
  sampleCount: number
  sum: number
  minimum: number
  maximum: number
  timestamp: Date
}

export interface MetricAlarm {
  id: string
  name: string
  description?: string
  comparisonOperator: 'GreaterThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanThreshold' | 'LessThanOrEqualToThreshold'
  evaluationPeriods: number
  threshold: number
  period: number // seconds
  statistic: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount'
  treatMissingData?: 'notBreaching' | 'breaching' | 'ignore' | 'missing'
  actionsEnabled?: boolean
  alarmActions?: string[] // SNS topic ARNs
  okActions?: string[]
  insufficientDataActions?: string[]
}

/**
 * Metrics manager
*/
export class MetricsManager {
  private namespaces: Map<string, MetricNamespace> = new Map()
  private metrics: Map<string, CustomMetric> = new Map()
  private namespaceCounter = 0
  private metricCounter = 0
  private alarmCounter = 0

  /**
   * Create metric namespace
  */
  createNamespace(namespace: Omit<MetricNamespace, 'id'>): MetricNamespace {
    const id = `namespace-${Date.now()}-${this.namespaceCounter++}`

    const metricNamespace: MetricNamespace = {
      id,
      ...namespace,
    }

    this.namespaces.set(id, metricNamespace)

    return metricNamespace
  }

  /**
   * Create custom metric
  */
  createMetric(metric: Omit<CustomMetric, 'id'>): CustomMetric {
    const id = `metric-${Date.now()}-${this.metricCounter++}`

    const customMetric: CustomMetric = {
      id,
      ...metric,
    }

    this.metrics.set(id, customMetric)

    return customMetric
  }

  /**
   * Create business metric (e.g., orders, signups, revenue)
  */
  createBusinessMetric(options: {
    name: string
    namespace: string
    unit: MetricUnit
    description?: string
  }): CustomMetric {
    return this.createMetric({
      name: options.name,
      namespace: options.namespace,
      unit: options.unit,
      dimensions: [
        { name: 'Environment', value: 'production' },
        { name: 'Type', value: 'Business' },
      ],
    })
  }

  /**
   * Create application metric (e.g., cache hits, queue depth)
  */
  createApplicationMetric(options: {
    name: string
    namespace: string
    unit: MetricUnit
    serviceName: string
  }): CustomMetric {
    return this.createMetric({
      name: options.name,
      namespace: options.namespace,
      unit: options.unit,
      dimensions: [
        { name: 'Service', value: options.serviceName },
        { name: 'Type', value: 'Application' },
      ],
    })
  }

  /**
   * Create performance metric
  */
  createPerformanceMetric(options: {
    name: string
    namespace: string
    operation: string
  }): CustomMetric {
    return this.createMetric({
      name: options.name,
      namespace: options.namespace,
      unit: 'Milliseconds',
      dimensions: [
        { name: 'Operation', value: options.operation },
        { name: 'Type', value: 'Performance' },
      ],
    })
  }

  /**
   * Create error metric
  */
  createErrorMetric(options: {
    name: string
    namespace: string
    errorType: string
  }): CustomMetric {
    return this.createMetric({
      name: options.name,
      namespace: options.namespace,
      unit: 'Count',
      dimensions: [
        { name: 'ErrorType', value: options.errorType },
        { name: 'Type', value: 'Error' },
      ],
    })
  }

  /**
   * Create metric alarm
  */
  createAlarm(metricId: string, alarm: Omit<MetricAlarm, 'id'>): MetricAlarm {
    const metric = this.metrics.get(metricId)

    if (!metric) {
      throw new Error(`Metric not found: ${metricId}`)
    }

    const id = `alarm-${Date.now()}-${this.alarmCounter++}`

    const metricAlarm: MetricAlarm = {
      id,
      ...alarm,
    }

    if (!metric.alarms) {
      metric.alarms = []
    }

    metric.alarms.push(metricAlarm)

    return metricAlarm
  }

  /**
   * Create high error rate alarm
  */
  createErrorRateAlarm(options: {
    metricId: string
    name: string
    threshold: number // errors per minute
    snsTopicArn?: string
  }): MetricAlarm {
    return this.createAlarm(options.metricId, {
      name: options.name,
      description: `Alert when error rate exceeds ${options.threshold} errors/min`,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 2,
      threshold: options.threshold,
      period: 60,
      statistic: 'Sum',
      treatMissingData: 'notBreaching',
      actionsEnabled: true,
      alarmActions: options.snsTopicArn ? [options.snsTopicArn] : undefined,
    })
  }

  /**
   * Create latency alarm
  */
  createLatencyAlarm(options: {
    metricId: string
    name: string
    thresholdMs: number
    snsTopicArn?: string
  }): MetricAlarm {
    return this.createAlarm(options.metricId, {
      name: options.name,
      description: `Alert when latency exceeds ${options.thresholdMs}ms`,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 3,
      threshold: options.thresholdMs,
      period: 300,
      statistic: 'Average',
      treatMissingData: 'notBreaching',
      actionsEnabled: true,
      alarmActions: options.snsTopicArn ? [options.snsTopicArn] : undefined,
    })
  }

  /**
   * Create throughput alarm
  */
  createThroughputAlarm(options: {
    metricId: string
    name: string
    minimumThreshold: number
    snsTopicArn?: string
  }): MetricAlarm {
    return this.createAlarm(options.metricId, {
      name: options.name,
      description: `Alert when throughput drops below ${options.minimumThreshold}`,
      comparisonOperator: 'LessThanThreshold',
      evaluationPeriods: 2,
      threshold: options.minimumThreshold,
      period: 300,
      statistic: 'Sum',
      treatMissingData: 'breaching',
      actionsEnabled: true,
      alarmActions: options.snsTopicArn ? [options.snsTopicArn] : undefined,
    })
  }

  /**
   * Create composite alarm (multiple conditions)
  */
  createCompositeAlarm(options: {
    name: string
    description?: string
    alarmRule: string
    actionsEnabled?: boolean
    alarmActions?: string[]
  }): any {
    return {
      name: options.name,
      description: options.description,
      alarmRule: options.alarmRule,
      actionsEnabled: options.actionsEnabled ?? true,
      alarmActions: options.alarmActions,
    }
  }

  /**
   * Get namespace
  */
  getNamespace(id: string): MetricNamespace | undefined {
    return this.namespaces.get(id)
  }

  /**
   * List namespaces
  */
  listNamespaces(): MetricNamespace[] {
    return Array.from(this.namespaces.values())
  }

  /**
   * Get metric
  */
  getMetric(id: string): CustomMetric | undefined {
    return this.metrics.get(id)
  }

  /**
   * List metrics
  */
  listMetrics(): CustomMetric[] {
    return Array.from(this.metrics.values())
  }

  /**
   * Generate CloudFormation for metric alarm
  */
  generateAlarmCF(metric: CustomMetric, alarm: MetricAlarm): any {
    return {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        AlarmName: alarm.name,
        AlarmDescription: alarm.description,
        ComparisonOperator: alarm.comparisonOperator,
        EvaluationPeriods: alarm.evaluationPeriods,
        MetricName: metric.name,
        Namespace: metric.namespace,
        Period: alarm.period,
        Statistic: alarm.statistic,
        Threshold: alarm.threshold,
        TreatMissingData: alarm.treatMissingData || 'notBreaching',
        ActionsEnabled: alarm.actionsEnabled ?? true,
        ...(alarm.alarmActions && { AlarmActions: alarm.alarmActions }),
        ...(alarm.okActions && { OKActions: alarm.okActions }),
        ...(alarm.insufficientDataActions && {
          InsufficientDataActions: alarm.insufficientDataActions,
        }),
        ...(metric.dimensions && {
          Dimensions: metric.dimensions.map(d => ({
            Name: d.name,
            Value: d.value,
          })),
        }),
      },
    }
  }

  /**
   * Generate CloudFormation for composite alarm
  */
  generateCompositeAlarmCF(alarm: any): any {
    return {
      Type: 'AWS::CloudWatch::CompositeAlarm',
      Properties: {
        AlarmName: alarm.name,
        AlarmDescription: alarm.description,
        AlarmRule: alarm.alarmRule,
        ActionsEnabled: alarm.actionsEnabled,
        ...(alarm.alarmActions && { AlarmActions: alarm.alarmActions }),
      },
    }
  }

  /**
   * Generate dashboard widget for metric
  */
  generateDashboardWidget(metric: CustomMetric): any {
    return {
      type: 'metric',
      properties: {
        metrics: [
          [
            metric.namespace,
            metric.name,
            ...(metric.dimensions?.flatMap(d => [d.name, d.value]) || []),
          ],
        ],
        period: 300,
        stat: 'Average',
        region: 'us-east-1',
        title: metric.name,
      },
    }
  }

  /**
   * Publish a custom metric value directly
  */
  publishCustomMetric(
    namespace: string,
    name: string,
    value: number,
    dimensions: Record<string, string> = {},
    unit: string = 'Count'
  ): {
    id: string
    namespace: string
    name: string
    dimensions: Record<string, string>
    value: number
    unit: string
    timestamp: Date
  } {
    const id = `metric-${Date.now()}-${this.metricCounter++}`
    const metric = {
      id,
      namespace,
      name,
      dimensions,
      value,
      unit,
      timestamp: new Date(),
    }
    return metric
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.namespaces.clear()
    this.metrics.clear()
    this.namespaceCounter = 0
    this.metricCounter = 0
    this.alarmCounter = 0
  }
}

/**
 * Global metrics manager instance
*/
export const metricsManager: MetricsManager = new MetricsManager()
