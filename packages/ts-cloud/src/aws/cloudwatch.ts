import { AWSClient, buildQueryParams } from './client'

/** A single CloudWatch metric datapoint. */
export interface MetricDatapoint {
  Timestamp?: string
  Sum?: number
  Average?: number
  Maximum?: number
  Minimum?: number
  Unit?: string
}

/** A CloudWatch alarm summary. */
export interface MetricAlarm {
  AlarmName?: string
  StateValue?: string
  MetricName?: string
  ComparisonOperator?: string
  Threshold?: number
  Namespace?: string
}

/**
 * Minimal CloudWatch (metrics/alarms) client over the query API — covers what
 * the serverless `metrics` / `alarms` commands need without an AWS SDK.
 */
export class CloudWatchClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async query(params: Record<string, any>): Promise<any> {
    const body = new URLSearchParams(buildQueryParams({ Version: '2010-08-01', ...params })).toString()
    return this.client.request({
      service: 'monitoring',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  }

  /** Fetch aggregated statistics for one metric over a time window. */
  async getMetricStatistics(options: {
    Namespace: string
    MetricName: string
    Dimensions?: Array<{ Name: string, Value: string }>
    StartTime: Date
    EndTime: Date
    Period: number
    Statistics: Array<'Sum' | 'Average' | 'Maximum' | 'Minimum'>
  }): Promise<MetricDatapoint[]> {
    const params: Record<string, any> = {
      Action: 'GetMetricStatistics',
      Namespace: options.Namespace,
      MetricName: options.MetricName,
      StartTime: options.StartTime.toISOString(),
      EndTime: options.EndTime.toISOString(),
      Period: options.Period,
    }
    options.Statistics.forEach((s, i) => { params[`Statistics.member.${i + 1}`] = s })
    ;(options.Dimensions ?? []).forEach((d, i) => {
      params[`Dimensions.member.${i + 1}.Name`] = d.Name
      params[`Dimensions.member.${i + 1}.Value`] = d.Value
    })

    const result = await this.query(params)
    const response = result.GetMetricStatisticsResult || result
    let points = response?.Datapoints?.member ?? []
    if (!Array.isArray(points)) points = points ? [points] : []
    return points.map((p: any) => ({
      Timestamp: p.Timestamp,
      Sum: p.Sum != null ? Number(p.Sum) : undefined,
      Average: p.Average != null ? Number(p.Average) : undefined,
      Maximum: p.Maximum != null ? Number(p.Maximum) : undefined,
      Minimum: p.Minimum != null ? Number(p.Minimum) : undefined,
      Unit: p.Unit,
    }))
  }

  /** List alarms, optionally filtered by name prefix. */
  async describeAlarms(options?: { AlarmNamePrefix?: string, MaxRecords?: number }): Promise<MetricAlarm[]> {
    const params: Record<string, any> = { Action: 'DescribeAlarms' }
    if (options?.AlarmNamePrefix) params.AlarmNamePrefix = options.AlarmNamePrefix
    if (options?.MaxRecords) params.MaxRecords = options.MaxRecords

    const result = await this.query(params)
    const response = result.DescribeAlarmsResult || result
    let alarms = response?.MetricAlarms?.member ?? []
    if (!Array.isArray(alarms)) alarms = alarms ? [alarms] : []
    return alarms.map((a: any) => ({
      AlarmName: a.AlarmName,
      StateValue: a.StateValue,
      MetricName: a.MetricName,
      ComparisonOperator: a.ComparisonOperator,
      Threshold: a.Threshold != null ? Number(a.Threshold) : undefined,
      Namespace: a.Namespace,
    }))
  }

  /** Create or update a metric alarm. */
  async putMetricAlarm(options: {
    AlarmName: string
    Namespace: string
    MetricName: string
    ComparisonOperator: string
    Threshold: number
    EvaluationPeriods: number
    Period: number
    Statistic: 'Sum' | 'Average' | 'Maximum' | 'Minimum'
    Dimensions?: Array<{ Name: string, Value: string }>
    AlarmActions?: string[]
    AlarmDescription?: string
  }): Promise<void> {
    const params: Record<string, any> = {
      Action: 'PutMetricAlarm',
      AlarmName: options.AlarmName,
      Namespace: options.Namespace,
      MetricName: options.MetricName,
      ComparisonOperator: options.ComparisonOperator,
      Threshold: options.Threshold,
      EvaluationPeriods: options.EvaluationPeriods,
      Period: options.Period,
      Statistic: options.Statistic,
    }
    if (options.AlarmDescription) params.AlarmDescription = options.AlarmDescription
    ;(options.Dimensions ?? []).forEach((d, i) => {
      params[`Dimensions.member.${i + 1}.Name`] = d.Name
      params[`Dimensions.member.${i + 1}.Value`] = d.Value
    })
    ;(options.AlarmActions ?? []).forEach((a, i) => { params[`AlarmActions.member.${i + 1}`] = a })
    await this.query(params)
  }
}
