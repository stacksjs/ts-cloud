/**
 * Resolve REAL dashboard data for the management UI from live AWS reads, shaped
 * to what the stx dashboard pages consume. `cloud dashboard:build` serializes
 * this to `TSCLOUD_DASHBOARD_DATA` and the pages' `<script server>` blocks read
 * it at build time (falling back to representative sample data per-field/per-page
 * when a value isn't present). Every gather is wrapped so one failing source only
 * drops its own slice — the rest still render live. See `ui/pages/*`.
 */

import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { resolveQueues, resolveServerlessAppStackName } from '@ts-cloud/core'
import { CloudFormationClient } from '../aws/cloudformation'
import { CloudWatchClient } from '../aws/cloudwatch'
import { CloudWatchLogsClient } from '../aws/cloudwatch-logs'
import { CostExplorerClient } from '../aws/cost-explorer'
import { EFSClient } from '../aws/efs'
import { LambdaClient } from '../aws/lambda'
import { S3Client } from '../aws/s3'
import { SecretsManagerClient } from '../aws/secrets-manager'
import { SQSClient } from '../aws/sqs'
import { WAFv2Client } from '../aws/wafv2'
import { runRemoteCommand, serverlessInfo } from './serverless-app'

/** A loosely-typed bag — the pages read named slices, missing ones fall back. */
export type DashboardData = Record<string, any>

function pad(n: number): string { return String(n).padStart(2, '0') }
function isoDate(d: Date): string { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` }

/** Aggregate a Lambda metric over a window. */
async function lambdaMetric(cw: CloudWatchClient, fn: string, name: string, kind: 'Sum' | 'Average' | 'Maximum', start: Date, end: Date): Promise<number> {
  const pts = await cw.getMetricStatistics({
    Namespace: 'AWS/Lambda', MetricName: name, Dimensions: [{ Name: 'FunctionName', Value: fn }],
    StartTime: start, EndTime: end, Period: 86400, Statistics: [kind],
  }).catch(() => [])
  if (!pts.length) return 0
  if (kind === 'Sum') return pts.reduce((n, p) => n + (p.Sum ?? 0), 0)
  if (kind === 'Maximum') return Math.max(...pts.map(p => p.Maximum ?? 0))
  return pts.reduce((n, p) => n + (p.Average ?? 0), 0) / pts.length
}

/** Aggregate any CloudWatch metric over a window (generic namespace/dimensions). */
async function cwMetric(cw: CloudWatchClient, namespace: string, name: string, dims: Array<{ Name: string, Value: string }>, kind: 'Sum' | 'Average' | 'Maximum', start: Date, end: Date): Promise<number> {
  const pts = await cw.getMetricStatistics({ Namespace: namespace, MetricName: name, Dimensions: dims, StartTime: start, EndTime: end, Period: 86400, Statistics: [kind] }).catch(() => [])
  if (!pts.length) return 0
  if (kind === 'Sum') return pts.reduce((n, p) => n + (p.Sum ?? 0), 0)
  if (kind === 'Maximum') return Math.max(...pts.map(p => p.Maximum ?? 0))
  return pts.reduce((n, p) => n + (p.Average ?? 0), 0) / pts.length
}

/** Percentile (p50/p95/p99) of Duration for a function over a window. */
async function durationPct(cw: CloudWatchClient, fn: string, p: string, start: Date, end: Date): Promise<number> {
  const pts = await cw.getMetricStatistics({
    Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: [{ Name: 'FunctionName', Value: fn }],
    StartTime: start, EndTime: end, Period: 86400, ExtendedStatistics: [p],
  }).catch(() => [])
  return Math.round(pts.reduce((n, x) => n + (x.Percentiles?.[p] ?? 0), 0))
}

export async function resolveDashboardData(config: CloudConfig, environment: EnvironmentType): Promise<DashboardData> {
  const info = await serverlessInfo(config, environment)
  const region = info.region
  const cw = new CloudWatchClient(region)
  const lambda = new LambdaClient(region)
  const logs = new CloudWatchLogsClient(region)
  const end = new Date()
  const start = new Date(end.getTime() - 86_400_000)
  const app = config.environments?.[environment]?.app
  const out: DashboardData = {}

  // ── App header + headline metrics + overview function/queue/scheduler ────────
  out.app = {
    name: info.slug, env: environment, region,
    runtime: app?.kind === 'php' ? `php-${app?.phpVersion ?? '8.3'} (fpm)` : (app?.kind ?? 'node'),
    url: info.endpoint ?? '', build: info.lastRelease?.sha?.slice(0, 7) ?? '—', deployedAt: info.lastRelease?.timestamp ?? '—',
  }
  out.maintenance = { enabled: false }
  out.scheduler = { enabled: info.scheduler !== 'off', expression: info.scheduler === 'sub-minute' ? 'rate(1 minute) · sub-minute' : 'rate(1 minute)', lastRun: '—' }

  let totalInvocations = 0, totalErrors = 0, maxDur = 0
  const fns: any[] = []
  const fnsDetail: any[] = []
  for (const f of info.functions) {
    const [invocations, errors, throttles, durAvg, cfg, p50, p95, p99, spark] = await Promise.all([
      lambdaMetric(cw, f.name, 'Invocations', 'Sum', start, end),
      lambdaMetric(cw, f.name, 'Errors', 'Sum', start, end),
      lambdaMetric(cw, f.name, 'Throttles', 'Sum', start, end),
      lambdaMetric(cw, f.name, 'Duration', 'Average', start, end),
      lambda.getFunction(f.name).catch(() => null),
      durationPct(cw, f.name, 'p50', start, end),
      durationPct(cw, f.name, 'p95', start, end),
      durationPct(cw, f.name, 'p99', start, end),
      cw.getMetricSeries({ Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: f.name }], StartTime: new Date(end.getTime() - 12 * 3_600_000), EndTime: end, Period: 3600, Stat: 'Sum' }).catch(() => []),
    ])
    totalInvocations += invocations
    totalErrors += errors
    maxDur = Math.max(maxDur, durAvg)
    const memory = cfg?.Configuration?.MemorySize ?? 0
    const env = Object.keys(cfg?.Configuration?.Environment?.Variables ?? {})

    // Recent activity + max-memory from the REPORT lines in CloudWatch Logs.
    let recent: any[] = []
    let maxMem = 0
    try {
      const { events = [] } = await logs.filterLogEvents({ logGroupName: `/aws/lambda/${f.name}`, startTime: start.getTime(), limit: 40 })
      for (const e of events) {
        const msg = (e.message ?? '').trim()
        const mm = /Max Memory Used:\s*(\d+)\s*MB/.exec(msg)
        if (mm) maxMem = Math.max(maxMem, Number(mm[1]))
      }
      recent = events.filter(e => !/^(?:START|END|REPORT|INIT_START)/.test((e.message ?? '').trim()))
        .slice(-6).map(e => ({ ts: new Date(e.timestamp ?? 0).toISOString().slice(11, 19), msg: (e.message ?? '').trim().slice(0, 120), err: /error|exception|fatal/i.test(e.message ?? '') }))
    }
    catch { /* logs optional */ }

    const maxSpark = Math.max(1, ...spark)
    fns.push({ key: f.mode, name: f.name, version: f.version, memory, timeout: cfg?.Configuration?.Timeout ?? 0, runtime: cfg?.Configuration?.Runtime ?? 'provided.al2023', invocations: Math.round(invocations), errors: Math.round(errors), p95: p95 || Math.round(durAvg), status: 'active', provisioned: f.provisioned ? `${f.provisioned.allocated}/${f.provisioned.requested}` : undefined })
    fnsDetail.push({
      key: f.mode, name: f.name, runtime: cfg?.Configuration?.Runtime ?? 'provided.al2023', arch: ((cfg?.Configuration as any)?.Architectures?.[0]) ?? 'x86_64',
      memory, timeout: cfg?.Configuration?.Timeout ?? 0, ephemeral: (cfg?.Configuration as any)?.EphemeralStorage?.Size ?? 512,
      version: f.version, concurrency: app?.concurrency ?? '—',
      invocations: Math.round(invocations), errors: Math.round(errors), throttles: Math.round(throttles),
      p50: p50 || Math.round(durAvg), p95: p95 || Math.round(durAvg), p99: p99 || Math.round(durAvg), maxMem,
      spark: spark.length ? spark.map(v => Math.round((v / maxSpark) * 100)) : [0],
      env: env.length ? env : ['(none)'],
      recent: recent.length ? recent : [{ ts: '—', msg: 'no recent events', err: false }],
    })
  }
  out.functions = fns
  out.functionsDetail = fnsDetail

  const errorRatePct = totalInvocations ? Number(((totalErrors / totalInvocations) * 100).toFixed(2)) : 0
  const concurrency = Math.round(await lambdaMetric(cw, info.functions[0]?.name ?? '', 'ConcurrentExecutions', 'Maximum', start, end))
  out.metrics = { invocations: Math.round(totalInvocations), errorRatePct, p95Ms: Math.round(maxDur), coldStartPct: 0, concurrency, estCostUsd: 0 }

  // ── Queues (+ DLQ) ───────────────────────────────────────────────────────────
  try {
    const sqs = new SQSClient(region)
    const overview: any[] = []
    const detail: any[] = []
    // Shared DLQ depth (one DLQ for all queues).
    let dlqDepth = 0
    try {
      const { QueueUrl } = await sqs.getQueueUrl(`${info.slug}-${environment}-dlq`)
      const { Attributes } = await sqs.getQueueAttributes(QueueUrl)
      dlqDepth = Number(Attributes.ApproximateNumberOfMessages ?? 0)
    }
    catch { /* no dlq */ }

    const resolvedQueues = app ? resolveQueues(app, info.slug, environment) : []
    for (const q of resolvedQueues) {
      const short = q.name.replace(`${info.slug}-${environment}-`, '')
      let visible = 0, inFlight = 0
      try {
        const { QueueUrl } = await sqs.getQueueUrl(q.name)
        const { Attributes } = await sqs.getQueueAttributes(QueueUrl)
        visible = Number(Attributes.ApproximateNumberOfMessages ?? 0)
        inFlight = Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0)
      }
      catch { /* queue may not exist */ }
      const processed = Math.round(await cwMetric(cw, 'AWS/SQS', 'NumberOfMessagesDeleted', [{ Name: 'QueueName', Value: q.name }], 'Sum', start, end))
      overview.push({ name: short, visible, inFlight, processed, dlq: dlqDepth })
      detail.push({ name: q.name, short, visible, inFlight, delayed: 0, processed, oldestSec: 0, concurrency: q.concurrency ?? app?.queueConcurrency ?? '—', tries: app?.queueTries ?? 3, visTimeout: (app?.queueTimeout ?? 120) * 6, dlq: dlqDepth })
    }
    if (overview.length) out.queues = overview
    if (detail.length) out.queuesDetail = detail
    out.dlqItems = []
  }
  catch { /* sqs optional */ }

  // ── Data services (from CFN outputs / config) ────────────────────────────────
  try {
    const cf = new CloudFormationClient(region)
    const { Stacks } = await cf.describeStacks({ stackName: resolveServerlessAppStackName(config, environment) })
    const outputs: Record<string, string> = {}
    for (const o of Stacks?.[0]?.Outputs ?? []) if (o.OutputKey) outputs[o.OutputKey] = o.OutputValue ?? ''
    if (app?.database?.connection === 'aurora-serverless') {
      const clusterId = `${info.slug}-${environment}-db`
      const dim = [{ Name: 'DBClusterIdentifier', Value: clusterId }]
      const [acu, conns] = await Promise.all([
        cwMetric(cw, 'AWS/RDS', 'ServerlessDatabaseCapacity', dim, 'Average', start, end),
        cwMetric(cw, 'AWS/RDS', 'DatabaseConnections', dim, 'Maximum', start, end),
      ])
      out.aurora = { id: clusterId, engine: 'aurora-mysql', minAcu: app?.database?.minCapacity ?? 0.5, maxAcu: app?.database?.maxCapacity ?? 4, currentAcu: acu ? Number(acu.toFixed(1)) : (app?.database?.minCapacity ?? 0.5), database: 'app', connections: Math.round(conns), status: outputs.DbEndpoint ? 'available' : 'creating' }
      if (app?.rdsProxy) out.proxy = { name: `${info.slug}-${environment}-proxy`, endpoint: outputs.DbProxyEndpoint ?? '—', pooledConns: Math.round(conns), status: 'available' }
    }
    if (app?.cache?.driver === 'elasticache') {
      const rgId = `${info.slug}-${environment}-redis`
      const dim = [{ Name: 'CacheClusterId', Value: `${rgId}-001` }]
      const [hits, misses] = await Promise.all([
        cwMetric(cw, 'AWS/ElastiCache', 'CacheHits', dim, 'Sum', start, end),
        cwMetric(cw, 'AWS/ElastiCache', 'CacheMisses', dim, 'Sum', start, end),
      ])
      const hitRate = hits + misses > 0 ? Number(((hits / (hits + misses)) * 100).toFixed(1)) : 0
      out.redis = { id: rgId, node: 'cache.t4g.micro', engine: 'redis', hitRate, status: outputs.CacheEndpoint ? 'available' : 'creating' }
    }
    if (app?.efs) {
      let sizeMb = 0
      try {
        if (outputs.EfsId) {
          const efs = new EFSClient(region)
          const { FileSystems } = await efs.describeFileSystems({ FileSystemId: outputs.EfsId })
          sizeMb = Number((((FileSystems?.[0]?.SizeInBytes?.Value ?? 0)) / 1_048_576).toFixed(1))
        }
      }
      catch { /* efs optional */ }
      out.efs = { id: outputs.EfsId ?? 'efs', mount: '/mnt/local', sizeMb, status: 'available' }
    }
    out.assetsInfo = outputs.AssetsCdnDomain ? { bucket: outputs.AssetsBucketName ?? `${info.slug}-${environment}-assets`, cdn: outputs.AssetsCdnDomain, customDomain: app?.assetDomain ?? '—', assetUrl: info.assetUrl ?? '—', files: 0, sizeMb: 0, cacheHitPct: 0, build: out.app.build } : undefined
  }
  catch { /* cfn optional */ }

  // ── Assets listing (S3) ──────────────────────────────────────────────────────
  if (out.assetsInfo) {
    try {
      const s3 = new S3Client(region)
      const objs = await s3.list({ bucket: out.assetsInfo.bucket, maxKeys: 1000 })
      out.assetsInfo.files = objs.length
      out.assetsInfo.sizeMb = Number((objs.reduce((n, o) => n + (o.Size ?? 0), 0) / 1_048_576).toFixed(1))
      out.assetsRecent = objs.slice(0, 8).map(o => ({ path: `/${o.Key}`, size: `${Math.max(1, Math.round((o.Size ?? 0) / 1024))} KB`, type: o.Key.split('.').pop() ?? '' }))
    }
    catch { /* s3 optional */ }
  }

  // ── Secrets (keys only) ──────────────────────────────────────────────────────
  try {
    if (app?.secrets) {
      const list = Array.isArray(app.secrets) ? app.secrets.map(s => ({ key: s.split('/').pop()!.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), source: s })) : Object.entries(app.secrets).map(([k, v]) => ({ key: k, source: String(v) }))
      out.secretsList = list.map(s => ({ ...s, updated: '—' }))
    }
  }
  catch { /* secrets optional */ }

  // ── Deployments (from release history) ───────────────────────────────────────
  try {
    const s3 = new S3Client(region)
    const bucket = `${info.slug}-${environment}-deployments`
    const hist = await s3.getObjectJson<{ records: any[] }>(bucket, `deployments/${info.slug}/${environment}/history.json`).catch(() => null)
    if (hist?.records?.length) {
      out.deploymentsDetail = hist.records.slice(-12).reverse().map((r: any) => ({ sha: (r.sha ?? '').slice(0, 7), status: r.status ?? 'success', when: r.timestamp ?? '—', took: r.took ?? '—', by: r.by ?? '—', version: r.version ?? '—', hooks: r.hooks ?? [] }))
    }
  }
  catch { /* history optional */ }

  // ── Metrics page (totals + per-fn + invocation series) ───────────────────────
  out.metricsTotals = { invocations: out.metrics.invocations, errors: Math.round(totalErrors), errorRatePct, p95Ms: out.metrics.p95Ms, throttles: fnsDetail.reduce((n, f) => n + f.throttles, 0), coldStartPct: 0, estCostUsd: 0, concurrency }
  out.metricsPerFn = fnsDetail.map(f => ({ key: f.key, invocations: f.invocations, errors: f.errors, throttles: f.throttles, avgMs: f.p50, maxMs: f.p99, costUsd: 0 }))
  try {
    out.invSpark = await cw.getMetricSeries({ Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: info.functions.find(f => f.mode === 'http')?.name ?? '' }], StartTime: new Date(end.getTime() - 24 * 3_600_000), EndTime: end, Period: 3600, Stat: 'Sum' })
  }
  catch { /* series optional */ }

  // ── Cost (Cost Explorer) ─────────────────────────────────────────────────────
  try {
    const ce = new CostExplorerClient(region)
    const now = end
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const [thisMonth, lastMonth] = await Promise.all([
      ce.getCostByService({ start: isoDate(monthStart), end: isoDate(now), granularity: 'MONTHLY' }).catch(() => []),
      ce.getCostByService({ start: isoDate(prevStart), end: isoDate(monthStart), granularity: 'MONTHLY' }).catch(() => []),
    ])
    if (thisMonth.length) {
      const mtd = thisMonth.reduce((n, s) => n + s.amount, 0)
      const lastTotal = lastMonth.reduce((n, s) => n + s.amount, 0)
      const dayOfMonth = now.getUTCDate()
      const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
      out.costSummary = { monthToDateUsd: Number(mtd.toFixed(2)), projectedUsd: Number((mtd / dayOfMonth * daysInMonth).toFixed(2)), lastMonthUsd: Number(lastTotal.toFixed(2)), dailyAvgUsd: Number((mtd / dayOfMonth).toFixed(2)) }
      out.costServices = thisMonth.filter(s => s.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 12).map(s => ({ name: s.service, usd: Number(s.amount.toFixed(2)), note: '' }))
      out.metrics.estCostUsd = Number((mtd / dayOfMonth).toFixed(2))
      out.metricsTotals.estCostUsd = out.metrics.estCostUsd

      // Daily spend trend for the chart.
      out.costTrend = await ce.getDailyTotals({ start: isoDate(monthStart), end: isoDate(now) }).catch(() => [])

      // Per-function cost: split the Lambda service line by each fn's GB-seconds.
      const lambdaCost = thisMonth.find(s => /lambda/i.test(s.service))?.amount ?? 0
      const gbSec = (f: any): number => f.invocations * (f.p50 / 1000) * (f.memory / 1024)
      const totalGbSec = fnsDetail.reduce((n, f) => n + gbSec(f), 0) || 1
      out.costPerFn = fnsDetail.map(f => ({ key: f.key, requests: f.invocations, gbSec: Math.round(gbSec(f)), usd: Number((lambdaCost * (gbSec(f) / totalGbSec)).toFixed(2)) }))
    }
  }
  catch { /* cost optional */ }

  // ── WAF (CloudWatch counts) ──────────────────────────────────────────────────
  if (app?.firewall) {
    try {
      const blocked = await cw.getMetricStatistics({ Namespace: 'AWS/WAFV2', MetricName: 'BlockedRequests', StartTime: start, EndTime: end, Period: 86400, Statistics: ['Sum'] }).catch(() => [])
      const allowed = await cw.getMetricStatistics({ Namespace: 'AWS/WAFV2', MetricName: 'AllowedRequests', StartTime: start, EndTime: end, Period: 86400, Statistics: ['Sum'] }).catch(() => [])
      out.waf = { enabled: true, scope: 'REGIONAL', acl: `${info.slug}-${environment}-waf`, allowed24h: Math.round(allowed.reduce((n, p) => n + (p.Sum ?? 0), 0)), blocked24h: Math.round(blocked.reduce((n, p) => n + (p.Sum ?? 0), 0)) }
      // Rule list from the actual web ACL.
      try {
        const waf = new WAFv2Client(region)
        const acls = await waf.listWebACLs('REGIONAL')
        const acl = acls.find(a => a.Name?.includes(`${info.slug}-${environment}`)) ?? acls[0]
        if (acl?.Name && acl.Id) {
          out.waf.acl = acl.Name
          const rules = await waf.getWebACLRules(acl.Name, acl.Id, 'REGIONAL')
          if (rules.length) out.wafRules = rules.map(r => ({ name: r.Name ?? '—', detail: `priority ${r.Priority ?? 0}`, action: r.Action ?? 'count', blocked24h: 0 }))
        }
      }
      catch { /* rule list optional */ }
    }
    catch { /* waf optional */ }
  }

  // ── Scheduler tasks (Laravel `schedule:list` via the CLI function) ──────────-
  if (info.scheduler !== 'off' && app?.kind === 'php') {
    try {
      const out2 = await runRemoteCommand(config, environment, 'schedule:list')
      const tasks: any[] = []
      for (const line of (out2 || '').split('\n')) {
        // schedule:list rows look like: "*/5 * * * *  php artisan metrics:rollup .... Next Due: ..."
        const m = /^\s*([\d*/,\-\s]+?)\s{2,}(.+?)(?:\s{2,}Next Due.*)?$/.exec(line)
        if (m && /[*\d]/.test(m[1]) && m[1].trim().split(/\s+/).length === 5)
          tasks.push({ command: m[2].trim().replace(/^php artisan /, ''), cron: m[1].trim(), desc: '', lastRun: '—', lastStatus: 'ok' })
      }
      if (tasks.length) out.schedulerTasks = tasks
    }
    catch { /* schedule:list optional (needs the tscloud bridge / a php app) */ }
  }

  return out
}
