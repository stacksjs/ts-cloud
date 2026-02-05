/**
 * Database Performance Monitoring
 * Query performance insights, slow query detection, and optimization
*/

export interface PerformanceInsights {
  id: string
  name: string
  databaseIdentifier: string
  enabled: boolean
  retentionPeriod: number // days (7, 731, or 2192)
  kmsKeyId?: string
}

export interface SlowQueryLog {
  id: string
  name: string
  databaseIdentifier: string
  enabled: boolean
  logDestination: 'cloudwatch' | 's3'
  cloudwatchLogGroup?: string
  s3Bucket?: string
  s3Prefix?: string
  minExecutionTime?: number // milliseconds
}

export interface QueryMetric {
  id: string
  queryId: string
  sql: string
  executionCount: number
  avgExecutionTime: number // milliseconds
  maxExecutionTime: number
  minExecutionTime: number
  totalCPUTime: number
  totalIOWait: number
  totalLockWait: number
  rowsExamined: number
  rowsReturned: number
  timestamp: Date
}

export interface PerformanceReport {
  id: string
  name: string
  databaseIdentifier: string
  reportType: 'daily' | 'weekly' | 'monthly'
  metrics: PerformanceMetrics
  topQueries: QueryMetric[]
  slowQueries: QueryMetric[]
  recommendations: PerformanceRecommendation[]
  generatedAt: Date
}

export interface PerformanceMetrics {
  avgCPU: number
  maxCPU: number
  avgConnections: number
  maxConnections: number
  avgReadIOPS: number
  avgWriteIOPS: number
  avgReadThroughput: number // MB/s
  avgWriteThroughput: number // MB/s
  avgReadLatency: number // milliseconds
  avgWriteLatency: number // milliseconds
  cacheHitRatio: number // percentage
  deadlocks: number
  longRunningTransactions: number
}

export interface PerformanceRecommendation {
  type: 'index' | 'query' | 'schema' | 'configuration' | 'scaling'
  severity: 'high' | 'medium' | 'low'
  title: string
  description: string
  impact: string
  effort: 'low' | 'medium' | 'high'
  sqlExample?: string
}

export interface IndexRecommendation {
  id: string
  tableName: string
  columns: string[]
  reason: string
  estimatedImprovement: number // percentage
  estimatedSize: number // MB
  createSQL: string
}

export interface QueryAnalysis {
  id: string
  queryId: string
  sql: string
  executionPlan: ExecutionPlanNode[]
  bottlenecks: Bottleneck[]
  recommendations: string[]
  estimatedCost: number
}

export interface ExecutionPlanNode {
  id: number
  operation: string
  table?: string
  rows: number
  cost: number
  children?: ExecutionPlanNode[]
}

export interface Bottleneck {
  type: 'full_table_scan' | 'missing_index' | 'suboptimal_join' | 'high_cardinality'
  severity: 'critical' | 'warning' | 'info'
  description: string
  tableName?: string
  columnName?: string
}

/**
 * Performance manager
*/
export class PerformanceManager {
  private insights: Map<string, PerformanceInsights> = new Map()
  private slowQueryLogs: Map<string, SlowQueryLog> = new Map()
  private queryMetrics: Map<string, QueryMetric> = new Map()
  private reports: Map<string, PerformanceReport> = new Map()
  private indexRecommendations: Map<string, IndexRecommendation> = new Map()
  private insightsCounter = 0
  private logCounter = 0
  private metricCounter = 0
  private reportCounter = 0
  private recommendationCounter = 0

  /**
   * Enable performance insights
  */
  enablePerformanceInsights(options: {
    name: string
    databaseIdentifier: string
    retentionPeriod?: number
    kmsKeyId?: string
  }): PerformanceInsights {
    const id = `pi-${Date.now()}-${this.insightsCounter++}`

    const insights: PerformanceInsights = {
      id,
      name: options.name,
      databaseIdentifier: options.databaseIdentifier,
      enabled: true,
      retentionPeriod: options.retentionPeriod || 7,
      kmsKeyId: options.kmsKeyId,
    }

    this.insights.set(id, insights)

    return insights
  }

  /**
   * Enable slow query log
  */
  enableSlowQueryLog(options: {
    name: string
    databaseIdentifier: string
    logDestination: 'cloudwatch' | 's3'
    cloudwatchLogGroup?: string
    s3Bucket?: string
    minExecutionTime?: number
  }): SlowQueryLog {
    const id = `slow-query-${Date.now()}-${this.logCounter++}`

    const slowQueryLog: SlowQueryLog = {
      id,
      name: options.name,
      databaseIdentifier: options.databaseIdentifier,
      enabled: true,
      logDestination: options.logDestination,
      cloudwatchLogGroup: options.cloudwatchLogGroup,
      s3Bucket: options.s3Bucket,
      s3Prefix: options.s3Bucket ? 'slow-queries/' : undefined,
      minExecutionTime: options.minExecutionTime || 1000, // 1 second default
    }

    this.slowQueryLogs.set(id, slowQueryLog)

    return slowQueryLog
  }

  /**
   * Record query metric
  */
  recordQueryMetric(metric: Omit<QueryMetric, 'id' | 'timestamp'>): QueryMetric {
    const id = `metric-${Date.now()}-${this.metricCounter++}`

    const queryMetric: QueryMetric = {
      id,
      timestamp: new Date(),
      ...metric,
    }

    this.queryMetrics.set(id, queryMetric)

    return queryMetric
  }

  /**
   * Generate performance report
  */
  generatePerformanceReport(options: {
    name: string
    databaseIdentifier: string
    reportType: 'daily' | 'weekly' | 'monthly'
  }): PerformanceReport {
    const id = `report-${Date.now()}-${this.reportCounter++}`

    // Collect metrics
    const metrics: PerformanceMetrics = {
      avgCPU: Math.random() * 60 + 20, // 20-80%
      maxCPU: Math.random() * 30 + 70, // 70-100%
      avgConnections: Math.floor(Math.random() * 50 + 10),
      maxConnections: Math.floor(Math.random() * 50 + 100),
      avgReadIOPS: Math.floor(Math.random() * 1000 + 500),
      avgWriteIOPS: Math.floor(Math.random() * 500 + 200),
      avgReadThroughput: Math.random() * 50 + 10,
      avgWriteThroughput: Math.random() * 20 + 5,
      avgReadLatency: Math.random() * 5 + 1,
      avgWriteLatency: Math.random() * 8 + 2,
      cacheHitRatio: Math.random() * 10 + 90, // 90-100%
      deadlocks: Math.floor(Math.random() * 5),
      longRunningTransactions: Math.floor(Math.random() * 10),
    }

    // Get top queries by execution count
    const allMetrics = Array.from(this.queryMetrics.values())
    const topQueries = allMetrics
      .sort((a, b) => b.executionCount - a.executionCount)
      .slice(0, 10)

    // Get slow queries
    const slowQueries = allMetrics
      .filter(m => m.avgExecutionTime > 1000)
      .sort((a, b) => b.avgExecutionTime - a.avgExecutionTime)
      .slice(0, 10)

    // Generate recommendations
    const recommendations = this.generateRecommendations(metrics, slowQueries)

    const report: PerformanceReport = {
      id,
      name: options.name,
      databaseIdentifier: options.databaseIdentifier,
      reportType: options.reportType,
      metrics,
      topQueries,
      slowQueries,
      recommendations,
      generatedAt: new Date(),
    }

    this.reports.set(id, report)

    return report
  }

  /**
   * Generate recommendations based on metrics
  */
  private generateRecommendations(
    metrics: PerformanceMetrics,
    slowQueries: QueryMetric[]
  ): PerformanceRecommendation[] {
    const recommendations: PerformanceRecommendation[] = []

    // High CPU usage
    if (metrics.avgCPU > 70) {
      recommendations.push({
        type: 'scaling',
        severity: 'high',
        title: 'High CPU Usage',
        description: `Average CPU usage is ${metrics.avgCPU.toFixed(1)}%, which is above the recommended threshold of 70%.`,
        impact: 'Performance degradation, increased latency, potential timeouts',
        effort: 'medium',
      })
    }

    // Low cache hit ratio
    if (metrics.cacheHitRatio < 95) {
      recommendations.push({
        type: 'configuration',
        severity: 'medium',
        title: 'Low Cache Hit Ratio',
        description: `Cache hit ratio is ${metrics.cacheHitRatio.toFixed(1)}%. Consider increasing buffer pool size.`,
        impact: 'Increased disk I/O, slower query performance',
        effort: 'low',
      })
    }

    // Deadlocks
    if (metrics.deadlocks > 0) {
      recommendations.push({
        type: 'query',
        severity: 'medium',
        title: 'Deadlocks Detected',
        description: `${metrics.deadlocks} deadlock(s) detected. Review transaction isolation levels and query patterns.`,
        impact: 'Transaction failures, application errors',
        effort: 'high',
      })
    }

    // Slow queries
    if (slowQueries.length > 0) {
      recommendations.push({
        type: 'index',
        severity: 'high',
        title: 'Slow Queries Detected',
        description: `${slowQueries.length} slow queries detected. Consider adding indexes or optimizing queries.`,
        impact: 'High latency, poor user experience',
        effort: 'medium',
      })
    }

    // High I/O latency
    if (metrics.avgReadLatency > 10 || metrics.avgWriteLatency > 10) {
      recommendations.push({
        type: 'scaling',
        severity: 'high',
        title: 'High I/O Latency',
        description: 'Read or write latency is high. Consider upgrading to Provisioned IOPS or moving to a larger instance.',
        impact: 'Slow query execution, application timeouts',
        effort: 'medium',
      })
    }

    return recommendations
  }

  /**
   * Analyze query
  */
  analyzeQuery(sql: string): QueryAnalysis {
    const id = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    // Simulate execution plan
    const executionPlan: ExecutionPlanNode[] = [
      {
        id: 1,
        operation: 'Seq Scan',
        table: 'users',
        rows: 10000,
        cost: 850.5,
        children: [],
      },
    ]

    // Detect bottlenecks
    const bottlenecks: Bottleneck[] = []

    if (sql.toLowerCase().includes('select *')) {
      bottlenecks.push({
        type: 'full_table_scan',
        severity: 'warning',
        description: 'Query selects all columns. Consider selecting only required columns.',
      })
    }

    if (!sql.toLowerCase().includes('where') && sql.toLowerCase().includes('select')) {
      bottlenecks.push({
        type: 'full_table_scan',
        severity: 'critical',
        description: 'Query has no WHERE clause and may scan entire table.',
      })
    }

    const recommendations = [
      'Add appropriate indexes on WHERE clause columns',
      'Consider using EXPLAIN ANALYZE to get actual execution statistics',
      'Review and optimize JOIN conditions',
    ]

    return {
      id,
      queryId: id,
      sql,
      executionPlan,
      bottlenecks,
      recommendations,
      estimatedCost: executionPlan[0].cost,
    }
  }

  /**
   * Recommend index
  */
  recommendIndex(options: {
    tableName: string
    columns: string[]
    reason: string
    estimatedImprovement?: number
  }): IndexRecommendation {
    const id = `index-rec-${Date.now()}-${this.recommendationCounter++}`

    const indexName = `idx_${options.tableName}_${options.columns.join('_')}`

    const recommendation: IndexRecommendation = {
      id,
      tableName: options.tableName,
      columns: options.columns,
      reason: options.reason,
      estimatedImprovement: options.estimatedImprovement || 50,
      estimatedSize: options.columns.length * 10, // Simple estimate
      createSQL: `CREATE INDEX ${indexName} ON ${options.tableName} (${options.columns.join(', ')});`,
    }

    this.indexRecommendations.set(id, recommendation)

    return recommendation
  }

  /**
   * Get performance insights
  */
  getInsights(id: string): PerformanceInsights | undefined {
    return this.insights.get(id)
  }

  /**
   * List performance insights
  */
  listInsights(): PerformanceInsights[] {
    return Array.from(this.insights.values())
  }

  /**
   * Get slow query log
  */
  getSlowQueryLog(id: string): SlowQueryLog | undefined {
    return this.slowQueryLogs.get(id)
  }

  /**
   * List slow query logs
  */
  listSlowQueryLogs(): SlowQueryLog[] {
    return Array.from(this.slowQueryLogs.values())
  }

  /**
   * Get report
  */
  getReport(id: string): PerformanceReport | undefined {
    return this.reports.get(id)
  }

  /**
   * List reports
  */
  listReports(): PerformanceReport[] {
    return Array.from(this.reports.values())
  }

  /**
   * List index recommendations
  */
  listIndexRecommendations(): IndexRecommendation[] {
    return Array.from(this.indexRecommendations.values())
  }

  /**
   * Generate CloudFormation for Performance Insights
  */
  generatePerformanceInsightsCF(insights: PerformanceInsights): any {
    return {
      EnablePerformanceInsights: insights.enabled,
      PerformanceInsightsRetentionPeriod: insights.retentionPeriod,
      ...(insights.kmsKeyId && {
        PerformanceInsightsKMSKeyId: insights.kmsKeyId,
      }),
    }
  }

  /**
   * Generate CloudWatch alarm for slow queries
  */
  generateSlowQueryAlarmCF(options: {
    alarmName: string
    logGroupName: string
    threshold: number
    snsTopicArn?: string
  }): any {
    return {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        AlarmName: options.alarmName,
        AlarmDescription: 'Alert when slow queries exceed threshold',
        MetricName: 'SlowQueryCount',
        Namespace: 'AWS/RDS',
        Statistic: 'Sum',
        Period: 300,
        EvaluationPeriods: 1,
        Threshold: options.threshold,
        ComparisonOperator: 'GreaterThanThreshold',
        ...(options.snsTopicArn && {
          AlarmActions: [options.snsTopicArn],
        }),
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.insights.clear()
    this.slowQueryLogs.clear()
    this.queryMetrics.clear()
    this.reports.clear()
    this.indexRecommendations.clear()
    this.insightsCounter = 0
    this.logCounter = 0
    this.metricCounter = 0
    this.reportCounter = 0
    this.recommendationCounter = 0
  }
}

/**
 * Global performance manager instance
*/
export const performanceManager: PerformanceManager = new PerformanceManager()
