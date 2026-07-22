import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { AppendTelemetryInput, TelemetryCollectionStatus, TelemetryPolicy } from '../telemetry'
import { createHash } from 'node:crypto'
import { resolveDeploymentMode } from '@ts-cloud/core'
import { CloudWatchClient } from '../aws/cloudwatch'
import { resolveRuntimeInventory, RuntimeOperationService } from '../runtime'
import { loadTelemetryPolicy, pathTemplate, TelemetryStore } from '../telemetry'
import { resolveDashboardData } from './dashboard-data'
import { resolveServerDashboardData } from './dashboard-data-server'
import { serverlessInfo } from './serverless-app'
import { listTraces } from './serverless-operations'

export class TelemetryCollectionCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; promise: Promise<T> }>()
  constructor(private readonly now: () => number = Date.now) {}
  async getOrCreate(
    key: string,
    ttlMs: number,
    force: boolean,
    loader: () => Promise<T>,
  ): Promise<{ value: T; cached: boolean }> {
    const current = this.entries.get(key)
    if (!force && current && current.expiresAt > this.now()) return { value: await current.promise, cached: true }
    const promise = loader().catch((error) => {
      this.entries.delete(key)
      throw error
    })
    this.entries.set(key, { expiresAt: this.now() + ttlMs, promise })
    return { value: await promise, cached: false }
  }
  invalidate(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key)
  }
}

const collectionCache = new TelemetryCollectionCache<TelemetryCollectionResult>()
const MAX_COLLECTED_LOGS = 2_000

export interface TelemetryCollectionResult {
  collected: number
  cached: boolean
  generatedAt: string
  statuses: TelemetryCollectionStatus[]
  errors: Array<{ source: string; message: string }>
  policy: TelemetryPolicy
}

function retainedByPolicy(record: AppendTelemetryInput, policy: TelemetryPolicy): boolean {
  if (record.kind === 'log' && !policy.collectLogs) return false
  if (record.kind === 'trace' && !policy.collectTraces) return false
  if ((record.kind === 'request' || record.name.startsWith('request.')) && !policy.collectRequestAnalytics) return false
  if (!['log', 'trace', 'request'].includes(record.kind) && !record.name.startsWith('request.')) return true
  const samplingKey =
    record.requestId ?? record.traceId ?? `${record.source}\0${record.workloadId ?? ''}\0${record.timestamp}`
  const bucket = Number.parseInt(createHash('sha256').update(samplingKey).digest('hex').slice(0, 8), 16) / 0xffffffff
  return bucket <= policy.samplingRate
}

export interface TelemetryCollectionContext {
  controlPlane: ControlPlaneStore
  projectId: string
  environmentId?: string
  config: CloudConfig
  environment: EnvironmentType
  force?: boolean
}

function id(...parts: unknown[]): string {
  return `telemetry:${createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\0'))
    .digest('hex')
    .slice(0, 40)}`
}

function resourceBySlug(
  controlPlane: ControlPlaneStore,
  projectId: string,
  environmentId: string | undefined,
  slug?: string,
): string | undefined {
  if (!slug) return undefined
  return controlPlane.listResources(projectId, environmentId).find((item) => item.slug === slug)?.id
}

function severity(message: string, explicit?: unknown): string {
  const level = String(explicit ?? '').toLowerCase()
  if (['debug', 'info', 'warn', 'warning', 'error', 'fatal'].includes(level)) return level === 'fatal' ? 'error' : level
  return /fatal|panic|exception|error/i.test(message)
    ? 'error'
    : /warn|timeout|throttl|retr(?:y|ies)/i.test(message)
      ? 'warning'
      : 'info'
}

export function telemetryRecordsFromLog(input: {
  projectId: string
  environmentId?: string
  resourceId?: string
  source: string
  name: string
  timestamp?: string
  message: string
  workloadId?: string
}): AppendTelemetryInput[] {
  const timestamp =
    input.timestamp && Number.isFinite(new Date(input.timestamp).getTime())
      ? new Date(input.timestamp).toISOString()
      : new Date().toISOString()
  let parsed: Record<string, any> = {}
  try {
    const value = JSON.parse(input.message)
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value
  } catch {}
  const safeParsed = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) =>
        !/^(?:body|requestBody|responseBody|headers|authorization|cookie|cookies|query|queryString)$/i.test(key),
    ),
  )
  const requestId = String(parsed.requestId ?? parsed.request_id ?? parsed['x-request-id'] ?? '') || undefined
  const traceId = String(parsed.traceId ?? parsed.trace_id ?? parsed['x-amzn-trace-id'] ?? '') || undefined
  const durationMs = Number(parsed.durationMs ?? parsed.duration_ms ?? parsed.latencyMs ?? parsed.latency_ms)
  const statusCode = Number(parsed.statusCode ?? parsed.status_code ?? parsed.status)
  const method = String(parsed.method ?? parsed.httpMethod ?? '') || undefined
  const path = pathTemplate(String(parsed.pathTemplate ?? parsed.path ?? parsed.url ?? '') || undefined)
  const releaseId = String(parsed.releaseId ?? parsed.release_id ?? '') || undefined
  const deploymentId = String(parsed.deploymentId ?? parsed.deployment_id ?? '') || undefined
  const base = {
    projectId: input.projectId,
    environmentId: input.environmentId,
    resourceId: input.resourceId,
    source: input.source,
    timestamp,
    requestId,
    traceId,
    releaseId,
    deploymentId,
    workloadId: input.workloadId,
  }
  const safeMessage = Object.keys(parsed).length ? JSON.stringify(safeParsed) : input.message
  const records: AppendTelemetryInput[] = [
    {
      ...base,
      id: id(input.source, input.name, timestamp, safeMessage),
      kind: 'log',
      name: input.name,
      level: severity(safeMessage, parsed.level),
      message: safeMessage,
      attributes: safeParsed,
    },
  ]
  if (method && path && Number.isFinite(statusCode)) {
    records.push({
      ...base,
      id: id('request', requestId, timestamp, method, path, statusCode),
      kind: 'request',
      name: 'http.request',
      method,
      pathTemplate: path,
      host: parsed.host,
      statusCode,
      durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
      bytesIn: Number(parsed.bytesIn) || undefined,
      bytesOut: Number(parsed.bytesOut) || undefined,
      region: parsed.region,
      cacheResult: parsed.cacheResult ?? parsed.cache,
      upstream: parsed.upstream,
      attributes: { userAgentFamily: parsed.userAgentFamily ?? '', protocol: parsed.protocol ?? '' },
    })
    if (Number.isFinite(durationMs))
      records.push({
        ...base,
        id: id('request-duration', requestId, timestamp),
        kind: 'metric',
        name: 'request.duration',
        value: durationMs,
        unit: 'ms',
        attributes: { method, pathTemplate: path, statusCode },
      })
    records.push({
      ...base,
      id: id('request-count', requestId, timestamp),
      kind: 'metric',
      name: 'request.count',
      value: 1,
      unit: 'count',
      attributes: { method, pathTemplate: path, statusCode },
    })
    if (statusCode >= 500)
      records.push({
        ...base,
        id: id('request-error', requestId, timestamp),
        kind: 'metric',
        name: 'request.error',
        value: 1,
        unit: 'count',
        attributes: { method, pathTemplate: path, statusCode },
      })
  }
  return records
}

async function collectNow(context: TelemetryCollectionContext): Promise<TelemetryCollectionResult> {
  const telemetry = new TelemetryStore(context.controlPlane)
  const policy = loadTelemetryPolicy(context.controlPlane, context.projectId)
  const now = new Date()
  const records: AppendTelemetryInput[] = []
  const errors: TelemetryCollectionResult['errors'] = []
  const scope = { projectId: context.projectId, environmentId: context.environmentId }
  const mode = resolveDeploymentMode(context.config)

  try {
    const data =
      (mode === 'serverless'
        ? await resolveDashboardData(context.config, context.environment)
        : await resolveServerDashboardData(context.config, context.environment)) ?? {}
    if (mode === 'serverless') {
      for (const fn of data.functionsDetail ?? []) {
        const resourceId = resourceBySlug(context.controlPlane, context.projectId, context.environmentId, fn.key)
        const base = {
          ...scope,
          resourceId,
          source: 'cloudwatch',
          timestamp: now.toISOString(),
          workloadId: fn.name,
          attributes: { provider: 'aws', functionName: fn.name, aggregationWindow: '24h' },
        }
        for (const [name, value, unit] of [
          ['snapshot.traffic.requests_24h', fn.invocations, 'count'],
          ['snapshot.errors.count_24h', fn.errors, 'count'],
          ['snapshot.latency.p50_24h', fn.p50, 'ms'],
          ['snapshot.latency.p95_24h', fn.p95, 'ms'],
          ['snapshot.latency.p99_24h', fn.p99, 'ms'],
          ['snapshot.saturation.throttles_24h', fn.throttles, 'count'],
          ['snapshot.memory.max_24h', fn.maxMem, 'MB'],
        ] as Array<[string, number, string]>)
          if (Number.isFinite(Number(value)))
            records.push({
              ...base,
              id: id('cloudwatch', fn.name, name, now.toISOString()),
              kind: 'metric',
              name,
              value: Number(value),
              unit,
            })
      }
      try {
        const info = await serverlessInfo(context.config, context.environment)
        const cloudwatch = new CloudWatchClient(info.region)
        const start = new Date(now.getTime() - 3_600_000)
        const period = 300
        for (const fn of info.functions) {
          const dimensions = [{ Name: 'FunctionName', Value: fn.name }]
          const [invocations, failures, duration, throttles, concurrency] = await Promise.all([
            cloudwatch.getMetricStatistics({
              Namespace: 'AWS/Lambda',
              MetricName: 'Invocations',
              Dimensions: dimensions,
              StartTime: start,
              EndTime: now,
              Period: period,
              Statistics: ['Sum'],
            }),
            cloudwatch.getMetricStatistics({
              Namespace: 'AWS/Lambda',
              MetricName: 'Errors',
              Dimensions: dimensions,
              StartTime: start,
              EndTime: now,
              Period: period,
              Statistics: ['Sum'],
            }),
            cloudwatch.getMetricStatistics({
              Namespace: 'AWS/Lambda',
              MetricName: 'Duration',
              Dimensions: dimensions,
              StartTime: start,
              EndTime: now,
              Period: period,
              ExtendedStatistics: ['p50', 'p95', 'p99'],
            }),
            cloudwatch.getMetricStatistics({
              Namespace: 'AWS/Lambda',
              MetricName: 'Throttles',
              Dimensions: dimensions,
              StartTime: start,
              EndTime: now,
              Period: period,
              Statistics: ['Sum'],
            }),
            cloudwatch.getMetricStatistics({
              Namespace: 'AWS/Lambda',
              MetricName: 'ConcurrentExecutions',
              Dimensions: dimensions,
              StartTime: start,
              EndTime: now,
              Period: period,
              Statistics: ['Maximum'],
            }),
          ])
          const resourceId = resourceBySlug(context.controlPlane, context.projectId, context.environmentId, fn.mode)
          const appendPoints = (
            points: typeof invocations,
            name: string,
            value: (point: (typeof invocations)[number]) => number | undefined,
            unit: string,
          ) => {
            for (const point of points) {
              const timestamp =
                point.Timestamp && Number.isFinite(new Date(point.Timestamp).getTime())
                  ? new Date(point.Timestamp).toISOString()
                  : undefined
              const metric = value(point)
              if (timestamp && metric != null && Number.isFinite(metric))
                records.push({
                  ...scope,
                  resourceId,
                  id: id('cloudwatch-series', fn.name, name, timestamp),
                  kind: 'metric',
                  source: 'cloudwatch',
                  name,
                  timestamp,
                  value: metric,
                  unit,
                  workloadId: fn.name,
                  region: info.region,
                  attributes: { provider: 'aws', functionName: fn.name, aggregationWindow: `${period}s` },
                })
            }
          }
          appendPoints(invocations, 'traffic.requests', (point) => point.Sum, 'count')
          appendPoints(failures, 'errors.count', (point) => point.Sum, 'count')
          appendPoints(duration, 'latency.p50', (point) => point.Percentiles?.p50, 'ms')
          appendPoints(duration, 'latency.p95', (point) => point.Percentiles?.p95, 'ms')
          appendPoints(duration, 'latency.p99', (point) => point.Percentiles?.p99, 'ms')
          appendPoints(throttles, 'saturation.throttles', (point) => point.Sum, 'count')
          appendPoints(concurrency, 'saturation.concurrency', (point) => point.Maximum, 'count')
        }
      } catch (error) {
        errors.push({ source: 'cloudwatch:series', message: error instanceof Error ? error.message : String(error) })
      }
      for (const log of (data.serverlessLogs ?? []).slice(0, MAX_COLLECTED_LOGS))
        records.push(
          ...telemetryRecordsFromLog({
            ...scope,
            source: `cloudwatch:${log.source}`,
            name: `${log.source}.log`,
            timestamp: log.timestamp,
            message: String(log.message),
            resourceId: resourceBySlug(context.controlPlane, context.projectId, context.environmentId, log.source),
          }),
        )
      for (const queue of data.queuesDetail ?? []) {
        const base = { ...scope, source: 'cloudwatch', timestamp: now.toISOString(), attributes: { queue: queue.name } }
        records.push({
          ...base,
          id: id('queue-depth', queue.name, now.toISOString()),
          kind: 'metric',
          name: 'queue.depth',
          value: Number(queue.visible ?? queue.depth ?? 0),
          unit: 'count',
        })
        records.push({
          ...base,
          id: id('queue-inflight', queue.name, now.toISOString()),
          kind: 'metric',
          name: 'queue.inflight',
          value: Number(queue.inFlight ?? 0),
          unit: 'count',
        })
      }
      const traces = await listTraces(context.config, context.environment, 30)
      if (!traces.ok) errors.push({ source: 'xray', message: traces.error ?? 'X-Ray traces are unavailable.' })
      for (const trace of traces.traces)
        records.push({
          ...scope,
          id: id('xray', trace.id),
          kind: 'trace',
          source: 'xray',
          name: 'http.trace',
          timestamp: trace.timestamp ?? now.toISOString(),
          traceId: trace.id,
          durationMs: trace.durationMs,
          statusCode: trace.httpStatus,
          method: trace.method,
          pathTemplate: trace.url,
          attributes: { status: trace.status, responseMs: trace.responseMs },
        })
    } else {
      const metrics = data.systemMetrics
      if (data.metricsUnavailable || !metrics)
        errors.push({ source: 'host', message: 'The host metrics probe is unavailable.' })
      else {
        const values: Array<[string, number, string]> = [
          ['host.load', Number(metrics.load), 'load'],
          ['host.cpu.capacity', Number(metrics.cpus), 'count'],
          ['host.memory.used', Number(metrics.memUsedMb) * 1024 * 1024, 'bytes'],
          ['host.memory.total', Number(metrics.memTotalMb) * 1024 * 1024, 'bytes'],
          ['host.disk.used_percent', Number(metrics.diskUsedPct), 'percent'],
          ['host.disk.used', Number(metrics.diskUsedGb) * 1024 ** 3, 'bytes'],
          ['host.disk.total', Number(metrics.diskTotalGb) * 1024 ** 3, 'bytes'],
        ]
        for (const [name, value, unit] of values)
          if (Number.isFinite(value))
            records.push({
              ...scope,
              id: id('host', name, now.toISOString()),
              kind: 'metric',
              source: 'host',
              name,
              timestamp: now.toISOString(),
              value,
              unit,
            })
      }
    }
  } catch (error) {
    errors.push({
      source: mode === 'serverless' ? 'aws' : 'host',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    const inventory = await resolveRuntimeInventory(context.config, context.environment)
    const runtime = new RuntimeOperationService(context.config, context.environment, {
      inventory: async () => inventory,
    })
    for (const workload of inventory.workloads) {
      const resourceId = resourceBySlug(
        context.controlPlane,
        context.projectId,
        context.environmentId,
        workload.links.service,
      )
      const base = {
        ...scope,
        resourceId,
        source: `runtime:${workload.provider}`,
        timestamp: now.toISOString(),
        workloadId: workload.id,
        releaseId: workload.links.release,
        attributes: { status: workload.status, provider: workload.provider, service: workload.links.service ?? '' },
      }
      records.push({
        ...base,
        id: id(workload.id, 'health', now.toISOString()),
        kind: 'metric',
        name: 'health.up',
        value: workload.status === 'running' ? 1 : 0,
        unit: 'boolean',
      })
      records.push({
        ...base,
        id: id(workload.id, 'restarts', now.toISOString()),
        kind: 'metric',
        name: 'saturation.restarts',
        value: workload.restartCount ?? 0,
        unit: 'count',
      })
      if (workload.resources?.memoryBytes != null)
        records.push({
          ...base,
          id: id(workload.id, 'memory', now.toISOString()),
          kind: 'metric',
          name: 'runtime.memory.used',
          value: workload.resources.memoryBytes,
          unit: 'bytes',
        })
      if (!workload.capabilities.logs.supported) continue
      try {
        const result = await runtime.logs(workload.id, { limit: 100, since: new Date(now.getTime() - 5 * 60_000) })
        for (const line of result.lines)
          records.push(
            ...telemetryRecordsFromLog({
              ...scope,
              resourceId,
              source: `runtime:${workload.provider}`,
              name: `${workload.links.service ?? workload.name}.log`,
              timestamp: line.timestamp,
              message: line.message,
              workloadId: workload.id,
            }),
          )
      } catch (error) {
        errors.push({
          source: `runtime:${workload.provider}`,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    for (const source of inventory.sources.filter((source) => source.status !== 'fresh'))
      errors.push({ source: source.id, message: source.message ?? `Runtime source is ${source.status}.` })
  } catch (error) {
    errors.push({ source: 'runtime', message: error instanceof Error ? error.message : String(error) })
  }

  for (const event of context.controlPlane.listEvents({ projectId: context.projectId, limit: 1_000 })) {
    const payload = event.payload as Record<string, JsonValue>
    records.push({
      ...scope,
      id: `telemetry:event:${event.id}`,
      resourceId: event.resourceId,
      kind: 'event',
      source: 'control-plane',
      name: event.type,
      timestamp: event.createdAt,
      level: event.level,
      message: event.type,
      deploymentId: event.operationId,
      releaseId: typeof payload.releaseId === 'string' ? payload.releaseId : undefined,
      traceId: event.correlationId,
      attributes: payload,
    })
  }

  const retained = records
    .filter((record) => retainedByPolicy(record, policy))
    .map((record) => ({
      ...record,
      sampled:
        policy.samplingRate < 1 &&
        (record.kind === 'log' ||
          record.kind === 'trace' ||
          record.kind === 'request' ||
          record.name.startsWith('request.')),
    }))
  const inserted = telemetry.appendMany(retained).length
  telemetry.enforceRetention(policy, context.projectId)
  const statuses = telemetry.status(context.projectId, context.environmentId, policy.rawDays, policy.samplingRate)
  for (const error of errors)
    if (!statuses.some((status) => status.source === error.source))
      statuses.push({
        source: error.source,
        freshness: 'unavailable',
        samplingRate: policy.samplingRate,
        retentionDays: policy.rawDays,
        estimatedDailyBytes: 0,
        message: error.message,
      })
  const generatedAt = now.toISOString()
  context.controlPlane.setSetting(`telemetry.collection:${context.projectId}:${context.environmentId ?? 'all'}`, {
    generatedAt,
    errors,
    statuses,
    policy,
  } as unknown as JsonValue)
  return { collected: inserted, cached: false, generatedAt, statuses, errors, policy }
}

export async function collectDashboardTelemetry(
  context: TelemetryCollectionContext,
): Promise<TelemetryCollectionResult> {
  const key = `${context.projectId}:${context.environmentId ?? 'all'}:${context.environment}`
  const ttl = resolveDeploymentMode(context.config) === 'serverless' ? 5 * 60_000 : 60_000
  const result = await collectionCache.getOrCreate(key, ttl, !!context.force, () => collectNow(context))
  return { ...result.value, cached: result.cached }
}

export function invalidateDashboardTelemetryCache(projectId: string): void {
  collectionCache.invalidate(`${projectId}:`)
}
