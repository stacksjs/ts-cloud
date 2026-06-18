/**
 * Resolve REAL dashboard data for the management UI from live AWS reads, shaped
 * to what the stx dashboard pages consume. `cloud dashboard:build` serializes
 * this to `TSCLOUD_DASHBOARD_DATA` and the pages' `<script server>` blocks read
 * it at build time (falling back to representative sample data per-field when a
 * value isn't present). See `ui/pages/*`.
 */

import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { CloudWatchClient } from '../aws/cloudwatch'
import { LambdaClient } from '../aws/lambda'
import { SQSClient } from '../aws/sqs'
import { serverlessInfo } from './serverless-app'

export interface DashboardData {
  app: { name: string, env: string, region: string, runtime: string, url: string, build: string, deployedAt: string }
  maintenance: { enabled: boolean }
  metrics: { invocations: number, errorRatePct: number, p95Ms: number, coldStartPct: number, concurrency: number, estCostUsd: number }
  functions: Array<{ key: string, name: string, version: string, memory: number, timeout: number, runtime: string, invocations: number, errors: number, p95: number, status: string, provisioned?: string }>
  queues: Array<{ name: string, visible: number, inFlight: number, processed: number, dlq: number }>
  scheduler: { enabled: boolean, expression: string }
}

/** Sum/avg helper over a metric's datapoints. */
async function metric(cw: CloudWatchClient, fn: string, name: string, kind: 'Sum' | 'Average' | 'Maximum', start: Date, end: Date): Promise<number> {
  const pts = await cw.getMetricStatistics({
    Namespace: 'AWS/Lambda', MetricName: name, Dimensions: [{ Name: 'FunctionName', Value: fn }],
    StartTime: start, EndTime: end, Period: 86400, Statistics: [kind],
  }).catch(() => [])
  if (!pts.length) return 0
  if (kind === 'Sum') return pts.reduce((n, p) => n + (p.Sum ?? 0), 0)
  if (kind === 'Maximum') return Math.max(...pts.map(p => p.Maximum ?? 0))
  return pts.reduce((n, p) => n + (p.Average ?? 0), 0) / pts.length
}

/** Gather a live snapshot of the serverless app for the dashboard. */
export async function resolveDashboardData(config: CloudConfig, environment: EnvironmentType): Promise<DashboardData> {
  const info = await serverlessInfo(config, environment)
  const cw = new CloudWatchClient(info.region)
  const lambda = new LambdaClient(info.region)
  const end = new Date()
  const start = new Date(end.getTime() - 86_400_000)

  let totalInvocations = 0
  let totalErrors = 0
  let maxP95 = 0
  const functions: DashboardData['functions'] = []
  for (const f of info.functions) {
    const [invocations, errors, durAvg, cfg] = await Promise.all([
      metric(cw, f.name, 'Invocations', 'Sum', start, end),
      metric(cw, f.name, 'Errors', 'Sum', start, end),
      metric(cw, f.name, 'Duration', 'Average', start, end),
      lambda.getFunction(f.name).catch(() => null),
    ])
    totalInvocations += invocations
    totalErrors += errors
    maxP95 = Math.max(maxP95, durAvg)
    functions.push({
      key: f.mode,
      name: f.name,
      version: f.version,
      memory: cfg?.Configuration?.MemorySize ?? 0,
      timeout: cfg?.Configuration?.Timeout ?? 0,
      runtime: cfg?.Configuration?.Runtime ?? 'provided.al2023',
      invocations: Math.round(invocations),
      errors: Math.round(errors),
      p95: Math.round(durAvg),
      status: 'active',
      provisioned: f.provisioned ? `${f.provisioned.allocated}/${f.provisioned.requested}` : undefined,
    })
  }

  // Queue depth from SQS (best-effort).
  const sqs = new SQSClient(info.region)
  const queues: DashboardData['queues'] = []
  for (const qName of info.queues) {
    try {
      const { QueueUrl } = await sqs.getQueueUrl(qName)
      const { Attributes } = await sqs.getQueueAttributes(QueueUrl)
      queues.push({
        name: qName.replace(`${info.slug}-${environment}-`, ''),
        visible: Number(Attributes.ApproximateNumberOfMessages ?? 0),
        inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
        processed: 0,
        dlq: 0,
      })
    }
    catch {
      queues.push({ name: qName.replace(`${info.slug}-${environment}-`, ''), visible: 0, inFlight: 0, processed: 0, dlq: 0 })
    }
  }

  const errorRatePct = totalInvocations ? Number(((totalErrors / totalInvocations) * 100).toFixed(2)) : 0

  return {
    app: {
      name: info.slug,
      env: environment,
      region: info.region,
      runtime: `${config.environments?.[environment]?.app?.kind ?? 'node'}`,
      url: info.endpoint ?? '',
      build: info.lastRelease?.sha?.slice(0, 7) ?? '—',
      deployedAt: info.lastRelease?.timestamp ?? '—',
    },
    maintenance: { enabled: false },
    metrics: {
      invocations: Math.round(totalInvocations),
      errorRatePct,
      p95Ms: Math.round(maxP95),
      coldStartPct: 0,
      concurrency: 0,
      estCostUsd: 0,
    },
    functions,
    queues,
    scheduler: { enabled: info.scheduler !== 'off', expression: info.scheduler === 'sub-minute' ? 'rate(1 minute) · sub-minute' : 'rate(1 minute)' },
  }
}
