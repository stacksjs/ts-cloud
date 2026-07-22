/**
 * Mutating serverless (Vapor-style) operations for the management cockpit:
 * redeploy, rollback, maintenance mode, Aurora scaling, CloudFront asset
 * invalidation, SQS queue purge, dead-letter-queue viewing + redrive, and
 * Secrets Manager editing.
 *
 * The catalog (`buildServerlessOperations`) is derived purely from the cloud
 * config + resolved dashboard data so it is trivially unit-testable; the runner
 * dispatches each op to the existing serverless-app helpers (which perform the
 * real AWS calls) and returns a structured result (never throws on a remote
 * failure). DLQ + secrets are exposed as dedicated helpers because they carry
 * their own payloads (messages / values) rather than a fixed confirm token.
 */
import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { resolveQueues, resolveServerlessAppStackName } from '@ts-cloud/core'
import { CloudFormationClient } from '../aws/cloudformation'
import { CloudFrontClient } from '../aws/cloudfront'
import { CloudWatchClient } from '../aws/cloudwatch'
import { EventBridgeClient } from '../aws/eventbridge'
import { LambdaClient } from '../aws/lambda'
import { SecretsManagerClient } from '../aws/secrets-manager'
import { SQSClient } from '../aws/sqs'
import { XRayClient } from '../aws/xray'
import { redeployServerlessApp, rollbackServerlessApp, runRemoteCommand, scaleServerlessDatabase, serverlessInfo, setMaintenance } from './serverless-app'

export type ServerlessOperationGroup = 'deploy' | 'maintenance' | 'assets' | 'database' | 'queue'

export interface ServerlessOperationInput {
  name: string
  label: string
  placeholder?: string
}

export interface ServerlessOperation {
  id: string
  label: string
  group: ServerlessOperationGroup
  target: string
  mutates: boolean
  /** Token the operator must type to run a mutating operation. */
  confirm: string
  /** Destructive operations rendered with a danger affordance. */
  danger?: boolean
  /** Extra operator-supplied inputs (e.g. Aurora min/max ACUs). */
  inputs?: ServerlessOperationInput[]
}

export interface ServerlessOperationResult {
  operation: string
  command?: string
  ok: boolean
  stdout?: string
  error?: string
}

const MAX_OUTPUT_BYTES = 64 * 1024

function clampOutput(output: string): string {
  return output.length <= MAX_OUTPUT_BYTES ? output : `${output.slice(0, MAX_OUTPUT_BYTES)}\n\n[output truncated]`
}

function serverlessApp(config: CloudConfig, environment: EnvironmentType): any {
  return config.environments?.[environment]?.app
}

/**
 * Build the serverless operation catalog from config + live data. Pure: every
 * operation here is runnable by {@link runServerlessOperation}.
 */
export function buildServerlessOperations(config: CloudConfig, environment: EnvironmentType, data: Record<string, any>): ServerlessOperation[] {
  const ops: ServerlessOperation[] = []
  const app = serverlessApp(config, environment)

  // Deploy lifecycle — always available for a serverless project.
  ops.push({ id: 'redeploy', label: 'Redeploy current build', group: 'deploy', target: 'app', mutates: true, confirm: 'redeploy' })
  ops.push({ id: 'rollback', label: 'Roll back to previous build', group: 'deploy', target: 'app', mutates: true, confirm: 'rollback', danger: true })

  // Maintenance mode — offer whichever transition is meaningful from the current
  // state (fall back to offering both when the state is unknown).
  const maint = data.maintenance?.enabled
  if (maint !== true)
    ops.push({ id: 'maintenance:on', label: 'Enable maintenance mode', group: 'maintenance', target: 'app', mutates: true, confirm: 'maintenance', danger: true })
  if (maint !== false)
    ops.push({ id: 'maintenance:off', label: 'Disable maintenance mode', group: 'maintenance', target: 'app', mutates: true, confirm: 'live' })

  // Asset CDN invalidation — only when the app ships a static asset bucket/CDN.
  if (app?.assets || data.assetsInfo)
    ops.push({ id: 'assets:invalidate', label: 'Invalidate CDN cache', group: 'assets', target: 'assets', mutates: true, confirm: 'invalidate' })

  // Aurora Serverless v2 scaling — only when an Aurora database is attached.
  if (app?.database?.connection === 'aurora-serverless') {
    ops.push({
      id: 'db:scale',
      label: 'Scale Aurora capacity',
      group: 'database',
      target: 'database',
      mutates: true,
      confirm: 'scale',
      inputs: [
        { name: 'min', label: 'Min ACUs', placeholder: String(app.database.minCapacity ?? 0.5) },
        { name: 'max', label: 'Max ACUs', placeholder: String(app.database.maxCapacity ?? 4) },
      ],
    })
  }

  // Per-queue purge (destructive) for each resolved queue.
  for (const q of data.queues ?? []) {
    const short = String(q?.name ?? '').trim()
    if (short && /^[A-Za-z0-9_-]+$/.test(short))
      ops.push({ id: `queue:purge:${short}`, label: `Purge queue (${short})`, group: 'queue', target: short, mutates: true, confirm: short, danger: true })
  }

  return ops
}

export function resolveServerlessOperation(id: string, config: CloudConfig, environment: EnvironmentType, data: Record<string, any>): ServerlessOperation | undefined {
  return buildServerlessOperations(config, environment, data).find(op => op.id === id)
}

export interface RunServerlessOperationOptions {
  /** For db:scale — the requested Aurora min/max ACUs. */
  min?: number
  max?: number
}

/** Look up the CloudFront distribution id fronting the asset bucket, via its domain. */
async function assetsDistributionId(config: CloudConfig, environment: EnvironmentType, region: string): Promise<string | null> {
  try {
    const cf = new CloudFormationClient(region)
    const { Stacks } = await cf.describeStacks({ stackName: resolveServerlessAppStackName(config, environment) })
    const outputs: Record<string, string> = {}
    for (const o of Stacks?.[0]?.Outputs ?? []) if (o.OutputKey) outputs[o.OutputKey] = o.OutputValue ?? ''
    const domain = outputs.AssetsCdnDomain
    if (!domain)
      return null
    const dist = await new CloudFrontClient(region).findDistributionByDomain(domain)
    return dist?.Id ?? null
  }
  catch {
    return null
  }
}

/**
 * Run a serverless operation over the live AWS environment. Returns a structured
 * result; a remote failure is captured as `{ ok: false, error }` rather than
 * thrown, so the cockpit always renders an outcome.
 */
export async function runServerlessOperation(
  config: CloudConfig,
  environment: EnvironmentType,
  operation: ServerlessOperation,
  options: RunServerlessOperationOptions = {},
): Promise<ServerlessOperationResult> {
  try {
    if (operation.id === 'redeploy') {
      await redeployServerlessApp(config, environment)
      return { operation: operation.id, command: 'serverless redeploy', ok: true, stdout: 'Redeploy complete.' }
    }
    if (operation.id === 'rollback') {
      await rollbackServerlessApp(config, environment)
      return { operation: operation.id, command: 'serverless rollback', ok: true, stdout: 'Rollback complete.' }
    }
    if (operation.id === 'maintenance:on') {
      await setMaintenance(config, environment, true)
      return { operation: operation.id, command: 'maintenance on', ok: true, stdout: 'Application is now in maintenance mode.' }
    }
    if (operation.id === 'maintenance:off') {
      await setMaintenance(config, environment, false)
      return { operation: operation.id, command: 'maintenance off', ok: true, stdout: 'Application is live.' }
    }
    if (operation.id === 'db:scale') {
      const min = Number(options.min)
      const max = Number(options.max)
      if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min)
        return { operation: operation.id, ok: false, error: 'Provide valid Aurora capacities (0 < min ≤ max).' }
      await scaleServerlessDatabase(config, environment, min, max)
      return { operation: operation.id, command: `db:scale ${min}-${max} ACU`, ok: true, stdout: `Scaling applied (${min}-${max} ACUs); takes effect shortly.` }
    }
    if (operation.id === 'assets:invalidate') {
      const info = await serverlessInfo(config, environment)
      const distId = await assetsDistributionId(config, environment, info.region)
      if (!distId)
        return { operation: operation.id, ok: false, error: 'Could not resolve the asset CloudFront distribution for this environment.' }
      const cf = new CloudFrontClient(info.region)
      const res = await cf.invalidateAll(distId)
      return { operation: operation.id, command: `cloudfront invalidate ${distId} /*`, ok: true, stdout: `Invalidation ${res?.Id ?? 'created'} for ${distId} (/*).` }
    }
    if (operation.group === 'queue' && operation.id.startsWith('queue:purge:')) {
      const short = operation.target
      const info = await serverlessInfo(config, environment)
      const sqs = new SQSClient(info.region)
      const queueName = `${info.slug}-${environment}-${short}`
      const { QueueUrl } = await sqs.getQueueUrl(queueName)
      await sqs.purgeQueue(QueueUrl)
      return { operation: operation.id, command: `sqs purge ${queueName}`, ok: true, stdout: `Purged queue ${queueName}.` }
    }
    return { operation: operation.id, ok: false, error: 'Unknown or unavailable serverless operation.' }
  }
  catch (error: any) {
    return { operation: operation.id, ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

/** Run an arbitrary app command via the CLI function (Vapor-style command runner). */
export async function runServerlessCommand(config: CloudConfig, environment: EnvironmentType, command: string): Promise<ServerlessOperationResult> {
  const trimmed = command.trim()
  if (!trimmed)
    return { operation: 'command', ok: false, error: 'A command is required.' }
  try {
    const output = await runRemoteCommand(config, environment, trimmed)
    return { operation: 'command', command: trimmed, ok: true, stdout: clampOutput(output || '(no output)') }
  }
  catch (error: any) {
    return { operation: 'command', command: trimmed, ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

// ── Dead-letter queue ──────────────────────────────────────────────────────────

export interface DlqMessage {
  id: string
  receiptHandle: string
  body: string
}

const DLQ_UNAVAILABLE = 'No dead-letter queue is provisioned for this environment.'

async function dlqUrl(sqs: SQSClient, slug: string, environment: EnvironmentType): Promise<string | null> {
  try {
    const { QueueUrl } = await sqs.getQueueUrl(`${slug}-${environment}-dlq`)
    return QueueUrl
  }
  catch {
    return null
  }
}

/** Peek at DLQ messages (visibility restored quickly so they aren't consumed). */
export async function listDlqMessages(config: CloudConfig, environment: EnvironmentType, max = 10): Promise<{ ok: boolean, messages: DlqMessage[], error?: string }> {
  try {
    const info = await serverlessInfo(config, environment)
    const sqs = new SQSClient(info.region)
    const url = await dlqUrl(sqs, info.slug, environment)
    if (!url)
      return { ok: false, messages: [], error: DLQ_UNAVAILABLE }
    // Short visibility timeout so a peek doesn't consume the messages — they
    // reappear on the DLQ a couple of seconds after we read them.
    const received = await sqs.receiveMessages({
      queueUrl: url,
      maxMessages: Math.min(10, Math.max(1, max)),
      waitTimeSeconds: 1,
      visibilityTimeout: 2,
    })
    const messages: DlqMessage[] = (received.Messages ?? []).map((m: any) => ({
      id: m.MessageId,
      receiptHandle: m.ReceiptHandle,
      body: clampOutput(String(m.Body ?? '')),
    }))
    return { ok: true, messages }
  }
  catch (error: any) {
    return { ok: false, messages: [], error: clampOutput(error?.message ?? String(error)) }
  }
}

/**
 * Redrive up to `max` messages from the DLQ back onto a source queue (receive →
 * send → delete). `targetQueue` is a configured queue short-name; it defaults to
 * the first resolved queue for the app.
 */
export async function redriveDlq(config: CloudConfig, environment: EnvironmentType, opts: { max?: number, targetQueue?: string } = {}): Promise<ServerlessOperationResult> {
  try {
    const info = await serverlessInfo(config, environment)
    const app = serverlessApp(config, environment)
    const queues = app ? resolveQueues(app, info.slug, environment) : []
    const shortNames = queues.map((q: any) => q.name.replace(`${info.slug}-${environment}-`, ''))
    const target = opts.targetQueue && shortNames.includes(opts.targetQueue) ? opts.targetQueue : shortNames[0]
    if (!target)
      return { operation: 'dlq:redrive', ok: false, error: 'No source queue is configured to redrive into.' }

    const sqs = new SQSClient(info.region)
    const dlq = await dlqUrl(sqs, info.slug, environment)
    if (!dlq)
      return { operation: 'dlq:redrive', ok: false, error: DLQ_UNAVAILABLE }
    const { QueueUrl: targetUrl } = await sqs.getQueueUrl(`${info.slug}-${environment}-${target}`)

    const cap = Math.min(50, Math.max(1, opts.max ?? 10))
    let moved = 0
    while (moved < cap) {
      const batch = await sqs.receiveMessages({ queueUrl: dlq, maxMessages: Math.min(10, cap - moved), waitTimeSeconds: 1, visibilityTimeout: 30 })
      const msgs = batch.Messages ?? []
      if (!msgs.length)
        break
      for (const m of msgs) {
        await sqs.sendMessage({ queueUrl: targetUrl, messageBody: String(m.Body ?? '') })
        await sqs.deleteMessage(dlq, m.ReceiptHandle)
        moved++
      }
    }
    return { operation: 'dlq:redrive', command: `redrive → ${target}`, ok: true, stdout: `Moved ${moved} message(s) from the DLQ to ${target}.` }
  }
  catch (error: any) {
    return { operation: 'dlq:redrive', ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

/** Purge every message from the DLQ (destructive). */
export async function purgeDlq(config: CloudConfig, environment: EnvironmentType): Promise<ServerlessOperationResult> {
  try {
    const info = await serverlessInfo(config, environment)
    const sqs = new SQSClient(info.region)
    const url = await dlqUrl(sqs, info.slug, environment)
    if (!url)
      return { operation: 'dlq:purge', ok: false, error: DLQ_UNAVAILABLE }
    await sqs.purgeQueue(url)
    return { operation: 'dlq:purge', command: 'sqs purge dlq', ok: true, stdout: 'Dead-letter queue purged.' }
  }
  catch (error: any) {
    return { operation: 'dlq:purge', ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

// ── Secrets ────────────────────────────────────────────────────────────────────

/** The Secrets Manager ids the app references (from `app.secrets`). */
export function configuredSecretIds(config: CloudConfig, environment: EnvironmentType): Array<{ key: string, secretId: string }> {
  const app = serverlessApp(config, environment)
  if (!app?.secrets)
    return []
  return Array.isArray(app.secrets)
    ? app.secrets.map((name: string) => ({ key: name.split('/').pop()!.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), secretId: name }))
    : Object.entries(app.secrets).map(([key, secretId]) => ({ key, secretId: String(secretId) }))
}

/**
 * Set (create or update) a Secrets Manager value. The change takes effect on the
 * next deploy (function env is injected at deploy time), so the caller should
 * surface that redeploy hint.
 */
export async function setServerlessSecret(config: CloudConfig, environment: EnvironmentType, secretId: string, value: string): Promise<ServerlessOperationResult> {
  if (!secretId.trim())
    return { operation: 'secret:set', ok: false, error: 'A secret id is required.' }
  try {
    const info = await serverlessInfo(config, environment)
    const sm = new SecretsManagerClient(info.region)
    try {
      await sm.putSecretValue({ SecretId: secretId, SecretString: value })
    }
    catch {
      // The secret may not exist yet — create it, then it is puttable thereafter.
      await sm.createSecret({ Name: secretId, SecretString: value })
    }
    return { operation: 'secret:set', command: `secret set ${secretId}`, ok: true, stdout: `Secret ${secretId} updated. Redeploy to apply it to the functions.` }
  }
  catch (error: any) {
    return { operation: 'secret:set', ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

/** Delete a Secrets Manager entry (scheduled deletion; recoverable for 7 days). */
export async function deleteServerlessSecret(config: CloudConfig, environment: EnvironmentType, secretId: string): Promise<ServerlessOperationResult> {
  if (!secretId.trim())
    return { operation: 'secret:delete', ok: false, error: 'A secret id is required.' }
  try {
    const info = await serverlessInfo(config, environment)
    const sm = new SecretsManagerClient(info.region)
    await sm.deleteSecret({ SecretId: secretId, RecoveryWindowInDays: 7 })
    return { operation: 'secret:delete', command: `secret delete ${secretId}`, ok: true, stdout: `Secret ${secretId} scheduled for deletion (recoverable for 7 days).` }
  }
  catch (error: any) {
    return { operation: 'secret:delete', ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

// ── Per-function configuration (memory / timeout) ────────────────────────────────

const FUNCTION_MODES = new Set(['http', 'queue', 'cli'])

/**
 * Update a function's memory and/or timeout. `mode` is one of the app's function
 * modes (http/queue/cli). Memory takes effect immediately; the change is also
 * re-applied on the next deploy from config.
 */
export async function updateFunctionConfig(
  config: CloudConfig,
  environment: EnvironmentType,
  mode: string,
  opts: { memory?: number, timeout?: number },
): Promise<ServerlessOperationResult> {
  if (!FUNCTION_MODES.has(mode))
    return { operation: 'function:config', ok: false, error: `Unknown function mode '${mode}'.` }
  const memory = opts.memory == null ? undefined : Number(opts.memory)
  const timeout = opts.timeout == null ? undefined : Number(opts.timeout)
  if (memory != null && (!Number.isInteger(memory) || memory < 128 || memory > 10_240))
    return { operation: 'function:config', ok: false, error: 'Memory must be an integer between 128 and 10240 MB.' }
  if (timeout != null && (!Number.isInteger(timeout) || timeout < 1 || timeout > 900))
    return { operation: 'function:config', ok: false, error: 'Timeout must be an integer between 1 and 900 seconds.' }
  if (memory == null && timeout == null)
    return { operation: 'function:config', ok: false, error: 'Provide a memory and/or timeout value.' }
  try {
    const info = await serverlessInfo(config, environment)
    const lambda = new LambdaClient(info.region)
    const name = `${info.slug}-${environment}-${mode}`
    await lambda.updateFunctionConfiguration({
      FunctionName: name,
      ...(memory != null ? { MemorySize: memory } : {}),
      ...(timeout != null ? { Timeout: timeout } : {}),
    })
    const parts = [memory != null ? `${memory} MB` : '', timeout != null ? `${timeout}s` : ''].filter(Boolean).join(', ')
    return { operation: 'function:config', command: `update ${name} (${parts})`, ok: true, stdout: `Updated ${name}: ${parts}.` }
  }
  catch (error: any) {
    return { operation: 'function:config', ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

// ── CloudWatch alarms ────────────────────────────────────────────────────────────

export interface AlarmMetricPreset {
  key: string
  label: string
  namespace: string
  metricName: string
  statistic: 'Sum' | 'Average' | 'Maximum' | 'Minimum'
  comparison: string
  /** Function mode this metric attaches to (http/queue/cli), or undefined for account-wide. */
  fnMode?: 'http' | 'queue' | 'cli'
  unit: string
}

/** The alarm metrics an operator can arm from the dashboard. */
export const ALARM_PRESETS: AlarmMetricPreset[] = [
  { key: 'http-errors', label: 'HTTP function errors', namespace: 'AWS/Lambda', metricName: 'Errors', statistic: 'Sum', comparison: 'GreaterThanThreshold', fnMode: 'http', unit: 'errors / 5 min' },
  { key: 'http-throttles', label: 'HTTP function throttles', namespace: 'AWS/Lambda', metricName: 'Throttles', statistic: 'Sum', comparison: 'GreaterThanThreshold', fnMode: 'http', unit: 'throttles / 5 min' },
  { key: 'http-duration', label: 'HTTP function duration (avg)', namespace: 'AWS/Lambda', metricName: 'Duration', statistic: 'Average', comparison: 'GreaterThanThreshold', fnMode: 'http', unit: 'ms' },
  { key: 'http-concurrency', label: 'HTTP concurrent executions', namespace: 'AWS/Lambda', metricName: 'ConcurrentExecutions', statistic: 'Maximum', comparison: 'GreaterThanThreshold', fnMode: 'http', unit: 'concurrent' },
  { key: 'queue-errors', label: 'Queue function errors', namespace: 'AWS/Lambda', metricName: 'Errors', statistic: 'Sum', comparison: 'GreaterThanThreshold', fnMode: 'queue', unit: 'errors / 5 min' },
]

export function resolveAlarmPreset(key: string): AlarmMetricPreset | undefined {
  return ALARM_PRESETS.find(p => p.key === key)
}

/** List the alarms ts-cloud manages for this environment (name-prefixed). */
export async function listAlarms(config: CloudConfig, environment: EnvironmentType): Promise<{ ok: boolean, alarms: any[], presets: AlarmMetricPreset[], error?: string }> {
  try {
    const info = await serverlessInfo(config, environment)
    const cw = new CloudWatchClient(info.region)
    const all = await cw.describeAlarms({ AlarmNamePrefix: `${info.slug}-${environment}-`, MaxRecords: 100 })
    return { ok: true, alarms: all, presets: ALARM_PRESETS }
  }
  catch (error: any) {
    return { ok: false, alarms: [], presets: ALARM_PRESETS, error: clampOutput(error?.message ?? String(error)) }
  }
}

/** Create (or update) an alarm from a preset + threshold. */
export async function createAlarm(config: CloudConfig, environment: EnvironmentType, presetKey: string, threshold: number): Promise<ServerlessOperationResult> {
  const preset = resolveAlarmPreset(presetKey)
  if (!preset)
    return { operation: 'alarm:create', ok: false, error: `Unknown alarm metric '${presetKey}'.` }
  if (!Number.isFinite(threshold) || threshold < 0)
    return { operation: 'alarm:create', ok: false, error: 'Provide a non-negative threshold.' }
  try {
    const info = await serverlessInfo(config, environment)
    const cw = new CloudWatchClient(info.region)
    const alarmName = `${info.slug}-${environment}-${preset.key}`
    const dims = preset.fnMode ? [{ Name: 'FunctionName', Value: `${info.slug}-${environment}-${preset.fnMode}` }] : []
    await cw.putMetricAlarm({
      AlarmName: alarmName,
      Namespace: preset.namespace,
      MetricName: preset.metricName,
      ComparisonOperator: preset.comparison,
      Threshold: threshold,
      EvaluationPeriods: 1,
      Period: 300,
      Statistic: preset.statistic,
      Dimensions: dims,
      AlarmDescription: `ts-cloud: ${preset.label} > ${threshold} ${preset.unit}`,
    })
    return { operation: 'alarm:create', command: `alarm ${alarmName}`, ok: true, stdout: `Alarm ${alarmName} armed at ${threshold} ${preset.unit}.` }
  }
  catch (error: any) {
    return { operation: 'alarm:create', ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

/** Delete an alarm by name (guarded to this project's prefix). */
export async function deleteAlarm(config: CloudConfig, environment: EnvironmentType, alarmName: string): Promise<ServerlessOperationResult> {
  try {
    const info = await serverlessInfo(config, environment)
    if (!alarmName.startsWith(`${info.slug}-${environment}-`))
      return { operation: 'alarm:delete', ok: false, error: 'Refusing to delete an alarm outside this environment.' }
    const cw = new CloudWatchClient(info.region)
    await cw.deleteAlarms([alarmName])
    return { operation: 'alarm:delete', command: `delete alarm ${alarmName}`, ok: true, stdout: `Alarm ${alarmName} deleted.` }
  }
  catch (error: any) {
    return { operation: 'alarm:delete', ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}

// ── X-Ray distributed tracing ────────────────────────────────────────────────────

export interface ShapedTrace {
  id: string
  timestamp?: string
  durationMs: number
  responseMs: number
  status: 'ok' | 'error' | 'fault' | 'throttle'
  method: string
  url: string
  httpStatus: number
}

function shapeTrace(s: any): ShapedTrace {
  const status: ShapedTrace['status'] = s.HasFault ? 'fault' : s.HasError ? 'error' : s.HasThrottle ? 'throttle' : 'ok'
  return {
    id: String(s.Id ?? ''),
    timestamp: Number.isFinite(Number(s.StartTime)) ? new Date(Number(s.StartTime) * 1000).toISOString() : undefined,
    durationMs: Math.round((s.Duration ?? 0) * 1000),
    responseMs: Math.round((s.ResponseTime ?? 0) * 1000),
    status,
    method: s.Http?.HttpMethod ?? '-',
    url: s.Http?.HttpURL ?? '-',
    httpStatus: s.Http?.HttpStatus ?? 0,
  }
}

/**
 * List recent X-Ray trace summaries for the app's HTTP function (falling back to
 * all traces in the window when the service filter returns nothing). Requires
 * tracing to be enabled on the functions; returns an empty, ok:false result with
 * a hint otherwise.
 */
export async function listTraces(config: CloudConfig, environment: EnvironmentType, minutes = 30): Promise<{ ok: boolean, traces: ShapedTrace[], error?: string }> {
  try {
    const info = await serverlessInfo(config, environment)
    const xray = new XRayClient(info.region)
    const end = new Date()
    const start = new Date(end.getTime() - Math.min(360, Math.max(1, minutes)) * 60_000)
    const httpFn = `${info.slug}-${environment}-http`
    let res = await xray.getTraceSummaries({ startTime: start, endTime: end, filterExpression: `service("${httpFn}")` })
    if (!res.summaries.length)
      res = await xray.getTraceSummaries({ startTime: start, endTime: end })
    return { ok: true, traces: res.summaries.slice(0, 100).map(shapeTrace) }
  }
  catch (error: any) {
    return { ok: false, traces: [], error: clampOutput(error?.message ?? String(error)) }
  }
}

// ── Scheduler control (EventBridge rule + run-now) ───────────────────────────────

/** Enable, disable, or run-now the serverless scheduler. */
export async function controlScheduler(config: CloudConfig, environment: EnvironmentType, action: 'enable' | 'disable' | 'run'): Promise<ServerlessOperationResult> {
  try {
    const info = await serverlessInfo(config, environment)
    const ruleName = `${info.slug}-${environment}-scheduler`
    if (action === 'run') {
      const output = await runRemoteCommand(config, environment, 'schedule:run')
      return { operation: 'scheduler:run', command: 'schedule:run', ok: true, stdout: clampOutput(output || 'Scheduler run triggered.') }
    }
    const eb = new EventBridgeClient(info.region)
    if (action === 'enable')
      await eb.enableRule({ Name: ruleName })
    else
      await eb.disableRule({ Name: ruleName })
    return { operation: `scheduler:${action}`, command: `${action} ${ruleName}`, ok: true, stdout: `Scheduler rule ${ruleName} ${action}d.` }
  }
  catch (error: any) {
    return { operation: `scheduler:${action}`, ok: false, error: clampOutput(error?.message ?? String(error)) }
  }
}
