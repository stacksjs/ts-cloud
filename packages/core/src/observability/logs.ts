/**
 * Log Aggregation
 * Centralized logging across services with CloudWatch Logs
 */

export interface LogGroup {
  id: string
  name: string
  retentionDays?: number
  kmsKeyId?: string
  logStreams?: LogStream[]
  metricFilters?: MetricFilter[]
  subscriptionFilters?: SubscriptionFilter[]
}

export interface LogStream {
  id: string
  name: string
  logGroupName: string
  creationTime: Date
  lastEventTime?: Date
}

export interface MetricFilter {
  id: string
  name: string
  filterPattern: string
  metricTransformations: MetricTransformation[]
}

export interface MetricTransformation {
  metricName: string
  metricNamespace: string
  metricValue: string
  defaultValue?: number
  unit?: string
  dimensions?: Record<string, string>
}

export interface SubscriptionFilter {
  id: string
  name: string
  logGroupName: string
  filterPattern: string
  destinationArn: string
  roleArn?: string
  distribution?: 'Random' | 'ByLogStream'
}

export interface LogQuery {
  id: string
  name: string
  queryString: string
  logGroupNames: string[]
  startTime?: Date
  endTime?: Date
}

export interface LogInsightsQuery {
  id: string
  name: string
  description?: string
  query: string
  logGroupNames: string[]
  schedule?: string
}

/**
 * Logs manager
 */
export class LogsManager {
  private logGroups: Map<string, LogGroup> = new Map()
  private queries: Map<string, LogQuery> = new Map()
  private insightsQueries: Map<string, LogInsightsQuery> = new Map()
  private logGroupCounter = 0
  private filterCounter = 0
  private queryCounter = 0

  /**
   * Create log group
   */
  createLogGroup(group: Omit<LogGroup, 'id'>): LogGroup {
    const id = `log-group-${Date.now()}-${this.logGroupCounter++}`

    const logGroup: LogGroup = {
      id,
      ...group,
    }

    this.logGroups.set(id, logGroup)

    return logGroup
  }

  /**
   * Create Lambda log group
   */
  createLambdaLogGroup(functionName: string, retentionDays: number = 7): LogGroup {
    return this.createLogGroup({
      name: `/aws/lambda/${functionName}`,
      retentionDays,
    })
  }

  /**
   * Create ECS log group
   */
  createECSLogGroup(options: {
    clusterName: string
    serviceName: string
    retentionDays?: number
  }): LogGroup {
    return this.createLogGroup({
      name: `/ecs/${options.clusterName}/${options.serviceName}`,
      retentionDays: options.retentionDays || 14,
    })
  }

  /**
   * Create API Gateway log group
   */
  createAPIGatewayLogGroup(apiName: string, stage: string, retentionDays: number = 30): LogGroup {
    return this.createLogGroup({
      name: `/aws/apigateway/${apiName}/${stage}`,
      retentionDays,
    })
  }

  /**
   * Create application log group
   */
  createApplicationLogGroup(options: {
    appName: string
    environment: string
    retentionDays?: number
    kmsKeyId?: string
  }): LogGroup {
    return this.createLogGroup({
      name: `/application/${options.appName}/${options.environment}`,
      retentionDays: options.retentionDays || 30,
      kmsKeyId: options.kmsKeyId,
    })
  }

  /**
   * Create metric filter
   */
  createMetricFilter(logGroupId: string, filter: Omit<MetricFilter, 'id'>): MetricFilter {
    const logGroup = this.logGroups.get(logGroupId)

    if (!logGroup) {
      throw new Error(`Log group not found: ${logGroupId}`)
    }

    const id = `filter-${Date.now()}-${this.filterCounter++}`

    const metricFilter: MetricFilter = {
      id,
      ...filter,
    }

    if (!logGroup.metricFilters) {
      logGroup.metricFilters = []
    }

    logGroup.metricFilters.push(metricFilter)

    return metricFilter
  }

  /**
   * Create error count metric filter
   */
  createErrorCountFilter(logGroupId: string, namespace: string): MetricFilter {
    return this.createMetricFilter(logGroupId, {
      name: 'ErrorCount',
      filterPattern: '[timestamp, request_id, level = ERROR*, ...]',
      metricTransformations: [
        {
          metricName: 'ErrorCount',
          metricNamespace: namespace,
          metricValue: '1',
          defaultValue: 0,
          unit: 'Count',
        },
      ],
    })
  }

  /**
   * Create latency metric filter
   */
  createLatencyFilter(logGroupId: string, namespace: string): MetricFilter {
    return this.createMetricFilter(logGroupId, {
      name: 'Latency',
      filterPattern: '[timestamp, request_id, level, duration, ...]',
      metricTransformations: [
        {
          metricName: 'ResponseTime',
          metricNamespace: namespace,
          metricValue: '$duration',
          unit: 'Milliseconds',
        },
      ],
    })
  }

  /**
   * Create custom pattern filter
   */
  createCustomPatternFilter(options: {
    logGroupId: string
    name: string
    pattern: string
    metricName: string
    namespace: string
  }): MetricFilter {
    return this.createMetricFilter(options.logGroupId, {
      name: options.name,
      filterPattern: options.pattern,
      metricTransformations: [
        {
          metricName: options.metricName,
          metricNamespace: options.namespace,
          metricValue: '1',
          defaultValue: 0,
          unit: 'Count',
        },
      ],
    })
  }

  /**
   * Create subscription filter
   */
  createSubscriptionFilter(logGroupId: string, filter: Omit<SubscriptionFilter, 'id'>): SubscriptionFilter {
    const logGroup = this.logGroups.get(logGroupId)

    if (!logGroup) {
      throw new Error(`Log group not found: ${logGroupId}`)
    }

    const id = `subscription-${Date.now()}-${this.filterCounter++}`

    const subscriptionFilter: SubscriptionFilter = {
      id,
      ...filter,
    }

    if (!logGroup.subscriptionFilters) {
      logGroup.subscriptionFilters = []
    }

    logGroup.subscriptionFilters.push(subscriptionFilter)

    return subscriptionFilter
  }

  /**
   * Create Kinesis subscription (for real-time log processing)
   */
  createKinesisSubscription(options: {
    logGroupId: string
    kinesisStreamArn: string
    roleArn: string
    filterPattern?: string
  }): SubscriptionFilter {
    const logGroup = this.logGroups.get(options.logGroupId)
    if (!logGroup) {
      throw new Error(`Log group not found: ${options.logGroupId}`)
    }
    return this.createSubscriptionFilter(options.logGroupId, {
      name: 'KinesisSubscription',
      logGroupName: logGroup.name,
      filterPattern: options.filterPattern || '',
      destinationArn: options.kinesisStreamArn,
      roleArn: options.roleArn,
      distribution: 'Random',
    })
  }

  /**
   * Create Lambda subscription (for log processing)
   */
  createLambdaSubscription(options: {
    logGroupId: string
    lambdaFunctionArn: string
    filterPattern?: string
  }): SubscriptionFilter {
    const logGroup = this.logGroups.get(options.logGroupId)
    if (!logGroup) {
      throw new Error(`Log group not found: ${options.logGroupId}`)
    }
    return this.createSubscriptionFilter(options.logGroupId, {
      name: 'LambdaSubscription',
      logGroupName: logGroup.name,
      filterPattern: options.filterPattern || '',
      destinationArn: options.lambdaFunctionArn,
      distribution: 'ByLogStream',
    })
  }

  /**
   * Create Log Insights query
   */
  createInsightsQuery(query: Omit<LogInsightsQuery, 'id'>): LogInsightsQuery {
    const id = `query-${Date.now()}-${this.queryCounter++}`

    const insightsQuery: LogInsightsQuery = {
      id,
      ...query,
    }

    this.insightsQueries.set(id, insightsQuery)

    return insightsQuery
  }

  /**
   * Create error analysis query
   */
  createErrorAnalysisQuery(logGroupNames: string[]): LogInsightsQuery {
    return this.createInsightsQuery({
      name: 'Error Analysis',
      description: 'Analyze error patterns and frequencies',
      query: `fields @timestamp, @message
| filter @message like /ERROR/
| stats count() by bin(5m)
| sort @timestamp desc`,
      logGroupNames,
    })
  }

  /**
   * Create latency analysis query
   */
  createLatencyAnalysisQuery(logGroupNames: string[]): LogInsightsQuery {
    return this.createInsightsQuery({
      name: 'Latency Analysis',
      description: 'Analyze request latency patterns',
      query: `fields @timestamp, @duration
| filter @duration > 1000
| stats avg(@duration), max(@duration), min(@duration), count() by bin(5m)
| sort @timestamp desc`,
      logGroupNames,
    })
  }

  /**
   * Create top errors query
   */
  createTopErrorsQuery(logGroupNames: string[]): LogInsightsQuery {
    return this.createInsightsQuery({
      name: 'Top Errors',
      description: 'Find most common errors',
      query: `fields @timestamp, @message
| filter @message like /ERROR/
| stats count() as error_count by @message
| sort error_count desc
| limit 20`,
      logGroupNames,
    })
  }

  /**
   * Get log group
   */
  getLogGroup(id: string): LogGroup | undefined {
    return this.logGroups.get(id)
  }

  /**
   * List log groups
   */
  listLogGroups(): LogGroup[] {
    return Array.from(this.logGroups.values())
  }

  /**
   * Get insights query
   */
  getInsightsQuery(id: string): LogInsightsQuery | undefined {
    return this.insightsQueries.get(id)
  }

  /**
   * List insights queries
   */
  listInsightsQueries(): LogInsightsQuery[] {
    return Array.from(this.insightsQueries.values())
  }

  /**
   * Generate CloudFormation for log group
   */
  generateLogGroupCF(group: LogGroup): any {
    return {
      Type: 'AWS::Logs::LogGroup',
      Properties: {
        LogGroupName: group.name,
        ...(group.retentionDays && { RetentionInDays: group.retentionDays }),
        ...(group.kmsKeyId && { KmsKeyId: group.kmsKeyId }),
      },
    }
  }

  /**
   * Generate CloudFormation for metric filter
   */
  generateMetricFilterCF(logGroup: LogGroup, filter: MetricFilter): any {
    return {
      Type: 'AWS::Logs::MetricFilter',
      Properties: {
        FilterName: filter.name,
        FilterPattern: filter.filterPattern,
        LogGroupName: logGroup.name,
        MetricTransformations: filter.metricTransformations.map(t => ({
          MetricName: t.metricName,
          MetricNamespace: t.metricNamespace,
          MetricValue: t.metricValue,
          ...(t.defaultValue !== undefined && { DefaultValue: t.defaultValue }),
          ...(t.unit && { Unit: t.unit }),
          ...(t.dimensions && { Dimensions: t.dimensions }),
        })),
      },
    }
  }

  /**
   * Generate CloudFormation for subscription filter
   */
  generateSubscriptionFilterCF(filter: SubscriptionFilter): any {
    return {
      Type: 'AWS::Logs::SubscriptionFilter',
      Properties: {
        FilterName: filter.name,
        FilterPattern: filter.filterPattern,
        LogGroupName: filter.logGroupName,
        DestinationArn: filter.destinationArn,
        ...(filter.roleArn && { RoleArn: filter.roleArn }),
        ...(filter.distribution && { Distribution: filter.distribution }),
      },
    }
  }

  /**
   * Generate CloudFormation for Log Insights query definition
   */
  generateQueryDefinitionCF(query: LogInsightsQuery): any {
    return {
      Type: 'AWS::Logs::QueryDefinition',
      Properties: {
        Name: query.name,
        QueryString: query.query,
        LogGroupNames: query.logGroupNames,
      },
    }
  }

  /**
   * Create log aggregation with multiple filters
   */
  createLogAggregation(
    logGroup: string,
    filters: Array<{ pattern: string; metric: string }>,
    retention = 7
  ): {
    id: string
    logGroup: string
    filters: Array<{ pattern: string; metric: string }>
    retention: number
  } {
    const id = `aggregation-${Date.now()}-${this.logGroupCounter++}`

    // Create log group if it doesn't exist
    const group = this.createLogGroup({
      name: logGroup,
      retentionDays: retention,
    })

    // Create metric filters for each pattern
    filters.forEach(filter => {
      this.createMetricFilter(group.id, {
        name: filter.metric,
        filterPattern: filter.pattern,
        metricTransformations: [
          {
            metricName: filter.metric,
            metricNamespace: 'CustomMetrics',
            metricValue: '1',
            defaultValue: 0,
            unit: 'Count',
          },
        ],
      })
    })

    return {
      id,
      logGroup,
      filters,
      retention,
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.logGroups.clear()
    this.queries.clear()
    this.insightsQueries.clear()
    this.logGroupCounter = 0
    this.filterCounter = 0
    this.queryCounter = 0
  }
}

/**
 * Global logs manager instance
 */
export const logsManager = new LogsManager()
