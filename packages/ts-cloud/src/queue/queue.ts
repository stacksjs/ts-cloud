import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneOperation, ControlPlaneStore, JsonValue, OperationState } from '../control-plane'
import type { EnqueueOperationInput, OperationJob, OperationLogEntry, QueueConcurrencyLimits, QueueExecutionContext, QueueLogInput, QueueOperationHandler, QueueOperationView, QueueRecoveryResult, QueueRunResult } from './types'
import { sanitizeControlPlaneValue } from '../control-plane'
import { QueueCancellationError, QueueTimeoutError, RetryableOperationError } from './types'

type Row = Record<string, unknown>

const DEFAULT_LIMITS: QueueConcurrencyLimits = { project: 2, environment: 1, provider: 2, builds: 1 }
const DEFAULT_RETENTION_DAYS = 30
const MAX_LOG_BYTES = 16 * 1024
const TERMINAL_STATES: readonly OperationState[] = ['succeeded', 'failed', 'cancelled', 'timed_out']

function optional(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function parsedStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.map(String) : []
  }
  catch { return [] }
}
function job(row: Row): OperationJob {
  return { operationId: String(row.operation_id), lockKey: optional(row.lock_key), providerKey: optional(row.provider_key), buildSlot: Number(row.build_slot) === 1, maxAttempts: Number(row.max_attempts), availableAt: String(row.available_at), timeoutSeconds: Number(row.timeout_seconds), heartbeatAt: optional(row.heartbeat_at), currentStep: optional(row.current_step), blockedReason: optional(row.blocked_reason), retryClasses: parsedStrings(row.retry_classes), resumePolicy: String(row.resume_policy) as OperationJob['resumePolicy'], cancellationMode: String(row.cancellation_mode) as OperationJob['cancellationMode'], retentionUntil: String(row.retention_until), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}
function logEntry(row: Row): OperationLogEntry {
  return { sequence: Number(row.sequence), id: String(row.id), operationId: String(row.operation_id), stream: String(row.stream) as OperationLogEntry['stream'], step: optional(row.step), message: String(row.message), redacted: Number(row.redacted) === 1, truncated: Number(row.truncated) === 1, createdAt: String(row.created_at) }
}
function positive(value: number | undefined, fallback: number, maximum: number): number { return Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value!))) : fallback }

export class DurableOperationQueue {
  private readonly nowFn: () => Date
  private readonly idFn: () => string
  private readonly workerId: string
  private readonly leaseMs: number
  readonly limits: QueueConcurrencyLimits

  constructor(readonly controlPlane: ControlPlaneStore, options: { workerId?: string, leaseMs?: number, limits?: Partial<QueueConcurrencyLimits>, now?: () => Date, id?: () => string } = {}) {
    this.workerId = options.workerId ?? `worker:${process.pid}:${crypto.randomUUID()}`
    this.leaseMs = positive(options.leaseMs, 60_000, 60 * 60 * 1000)
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
    const stored = controlPlane.getSetting('queue.concurrency') as Partial<QueueConcurrencyLimits> | undefined
    this.limits = {
      project: positive(options.limits?.project ?? stored?.project, DEFAULT_LIMITS.project, 100),
      environment: positive(options.limits?.environment ?? stored?.environment, DEFAULT_LIMITS.environment, 100),
      provider: positive(options.limits?.provider ?? stored?.provider, DEFAULT_LIMITS.provider, 100),
      builds: positive(options.limits?.builds ?? stored?.builds, DEFAULT_LIMITS.builds, 100),
    }
  }

  private now(): string { return this.nowFn().toISOString() }
  private leaseExpiry(): string { return new Date(this.nowFn().getTime() + this.leaseMs).toISOString() }

  enqueue(input: EnqueueOperationInput): QueueOperationView {
    const operation = this.controlPlane.createOperation(input)
    const existing = this.getJob(operation.id)
    if (existing) return this.view(operation.id)!
    const now = this.now()
    const maxAttempts = positive(input.maxAttempts, 1, 20)
    const timeoutSeconds = positive(input.timeoutSeconds, 30 * 60, 24 * 60 * 60)
    const retentionDays = positive(input.retentionDays, DEFAULT_RETENTION_DAYS, 3650)
    const availableAt = input.availableAt ? new Date(input.availableAt).toISOString() : now
    const retentionUntil = new Date(this.nowFn().getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
    this.controlPlane.database.run(
      `INSERT OR IGNORE INTO operation_jobs (operation_id, lock_key, provider_key, build_slot, max_attempts, available_at, timeout_seconds, retry_classes, resume_policy, cancellation_mode, retention_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [operation.id, input.lockKey ?? input.resourceId ?? null, input.providerKey ?? null, input.buildSlot ? 1 : 0, maxAttempts, availableAt, timeoutSeconds, JSON.stringify([...new Set(input.retryClasses ?? [])]), input.resumePolicy ?? 'fail', input.cancellationMode ?? 'cooperative', retentionUntil, now, now],
    )
    this.appendLog(operation.id, 'Queued for durable execution.', { stream: 'system' })
    return this.view(operation.id)!
  }

  getJob(operationId: string): OperationJob | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM operation_jobs WHERE operation_id=?').get(operationId)
    return row ? job(row) : undefined
  }

  view(operationId: string): QueueOperationView | undefined {
    const operation = this.controlPlane.getOperation(operationId); const metadata = this.getJob(operationId)
    if (!operation || !metadata) return undefined
    let approximatePosition: QueueOperationView['approximatePosition']
    if (operation.state === 'queued') {
      const ahead = Number(this.controlPlane.database.query<Row, [string, number, number, string]>('SELECT COUNT(*) AS count FROM operations o JOIN operation_jobs j ON j.operation_id=o.id WHERE o.state=\'queued\' AND j.available_at<=? AND (o.priority>? OR (o.priority=? AND o.created_at<?))').get(this.now(), operation.priority, operation.priority, operation.createdAt)?.count ?? 0)
      approximatePosition = { ahead, precision: 'bounded' }
    }
    return { operation, job: metadata, approximatePosition }
  }

  list(input: { projectId?: string, state?: OperationState, limit?: number } = {}): QueueOperationView[] {
    return this.controlPlane.listOperations({ projectId: input.projectId, state: input.state, limit: input.limit ?? 200 }).map(operation => this.view(operation.id)).filter((value): value is QueueOperationView => !!value)
  }

  configureConcurrency(limits: Partial<QueueConcurrencyLimits>, input: { organizationId?: string, actorId?: string } = {}): QueueConcurrencyLimits {
    const next = {
      project: positive(limits.project, this.limits.project, 100),
      environment: positive(limits.environment, this.limits.environment, 100),
      provider: positive(limits.provider, this.limits.provider, 100),
      builds: positive(limits.builds, this.limits.builds, 100),
    }
    Object.assign(this.limits, next)
    this.controlPlane.setSetting('queue.concurrency', next)
    this.controlPlane.appendEvent({ organizationId: input.organizationId, actorId: input.actorId, type: 'queue.concurrency.updated', level: 'warning', payload: next })
    return next
  }

  private runningCount(sql: string, bindings: SQLQueryBindings[]): number {
    return Number(this.controlPlane.database.query<Row, SQLQueryBindings[]>(sql).get(...bindings)?.count ?? 0)
  }

  private blockReason(operation: ControlPlaneOperation, metadata: OperationJob): string | undefined {
    if (metadata.lockKey) {
      const lock = this.controlPlane.database.query<Row, [string, string, string]>('SELECT * FROM operation_locks WHERE lock_key=? AND operation_id!=? AND lease_expires_at>?').get(metadata.lockKey, operation.id, this.now())
      if (lock) return `resource_lock:${metadata.lockKey}`
    }
    if (operation.projectId && this.runningCount('SELECT COUNT(*) AS count FROM operations WHERE state=\'running\' AND project_id=?', [operation.projectId]) >= this.limits.project) return 'project_concurrency'
    if (operation.environmentId && this.runningCount('SELECT COUNT(*) AS count FROM operations WHERE state=\'running\' AND environment_id=?', [operation.environmentId]) >= this.limits.environment) return 'environment_concurrency'
    if (metadata.providerKey && this.runningCount('SELECT COUNT(*) AS count FROM operations o JOIN operation_jobs j ON j.operation_id=o.id WHERE o.state=\'running\' AND j.provider_key=?', [metadata.providerKey]) >= this.limits.provider) return 'provider_concurrency'
    if (metadata.buildSlot && this.runningCount('SELECT COUNT(*) AS count FROM operations o JOIN operation_jobs j ON j.operation_id=o.id WHERE o.state=\'running\' AND j.build_slot=1', []) >= this.limits.builds) return 'build_concurrency'
    return undefined
  }

  claim(operationId: string): QueueOperationView | undefined {
    return this.controlPlane.transaction(() => {
      const now = this.now()
      this.controlPlane.database.run('DELETE FROM operation_locks WHERE lease_expires_at<=?', [now])
      const operation = this.controlPlane.getOperation(operationId); const metadata = operation ? this.getJob(operation.id) : undefined
      if (!operation || !metadata || operation.state !== 'queued' || metadata.availableAt > now) return undefined
      if (operation.cancelRequestedAt) {
        this.controlPlane.transitionOperation(operation.id, { to: 'cancelled', expectedVersion: operation.version, output: { cancelledBeforeStart: true } })
        this.appendLog(operation.id, 'Cancelled before execution began.', { stream: 'system' })
        return undefined
      }
      const blocked = this.blockReason(operation, metadata)
      if (blocked) { this.controlPlane.database.run('UPDATE operation_jobs SET blocked_reason=?, updated_at=? WHERE operation_id=?', [blocked, now, operation.id]); return undefined }
      const claimed = this.controlPlane.claimOperation(operation.id, this.workerId, this.leaseMs)
      if (!claimed) return undefined
      const expiry = claimed.leaseExpiresAt ?? this.leaseExpiry()
      if (metadata.lockKey) this.controlPlane.database.run('INSERT INTO operation_locks (lock_key, operation_id, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [metadata.lockKey, operation.id, this.workerId, expiry, now, now])
      this.controlPlane.database.run('UPDATE operation_jobs SET heartbeat_at=?, blocked_reason=NULL, updated_at=? WHERE operation_id=?', [now, now, operation.id])
      this.appendLog(operation.id, `Claimed by ${this.workerId}; attempt ${claimed.attempt}.`, { stream: 'system' })
      return this.view(operation.id)
    })
  }

  claimNext(kinds?: readonly string[]): QueueOperationView | undefined {
    const now = this.now()
    const kindSql = kinds?.length ? `AND o.kind IN (${kinds.map(() => '?').join(',')})` : ''
    const rows = this.controlPlane.database.query<Row, SQLQueryBindings[]>(`SELECT o.id FROM operations o JOIN operation_jobs j ON j.operation_id=o.id WHERE o.state='queued' AND j.available_at<=? ${kindSql} ORDER BY o.priority DESC, o.created_at ASC, o.id ASC LIMIT 100`).all(now, ...(kinds ?? []))
    for (const row of rows) {
      const claimed = this.claim(String(row.id))
      if (claimed) return claimed
    }
    return undefined
  }

  heartbeat(operationId: string, step?: string): void {
    const operation = this.controlPlane.getOperation(operationId); if (!operation || operation.state !== 'running' || operation.leaseOwner !== this.workerId) throw new Error('Operation lease is not owned by this worker')
    const now = this.now(); const expiry = this.leaseExpiry(); const metadata = this.getJob(operationId)
    const changed = this.controlPlane.database.run('UPDATE operations SET lease_expires_at=?, updated_at=?, version=version+1 WHERE id=? AND state=\'running\' AND lease_owner=? AND version=?', [expiry, now, operationId, this.workerId, operation.version]).changes
    if (changed !== 1) throw new Error('Operation lease changed before heartbeat')
    this.controlPlane.database.run('UPDATE operation_jobs SET heartbeat_at=?, current_step=COALESCE(?, current_step), updated_at=? WHERE operation_id=?', [now, step ?? null, now, operationId])
    if (metadata?.lockKey) this.controlPlane.database.run('UPDATE operation_locks SET lease_expires_at=?, updated_at=? WHERE lock_key=? AND operation_id=? AND lease_owner=?', [expiry, now, metadata.lockKey, operationId, this.workerId])
    if (step && step !== metadata?.currentStep) this.controlPlane.appendEvent({ projectId: operation.projectId, operationId, resourceId: operation.resourceId, actorId: operation.actorId, correlationId: operation.correlationId, type: 'operation.step', payload: { step } })
  }

  appendLog(operationId: string, message: string, input: QueueLogInput = {}): OperationLogEntry {
    if (!this.getJob(operationId)) throw new Error(`Queue job ${operationId} was not found`)
    let safe = message; let redacted = false
    for (const secret of input.secrets ?? []) if (secret && safe.includes(secret)) { safe = safe.split(secret).join('[REDACTED]'); redacted = true }
    const sanitized = sanitizeControlPlaneValue({ message: safe }) as { message?: string }
    if (sanitized.message !== safe) redacted = true
    safe = sanitized.message ?? '[output unavailable]'
    const bytes = Buffer.from(safe); const truncated = bytes.byteLength > MAX_LOG_BYTES
    if (truncated) safe = `${bytes.subarray(0, MAX_LOG_BYTES - 32).toString('utf8')}\n[output truncated]`
    const id = this.idFn(); const now = this.now()
    this.controlPlane.database.run('INSERT INTO operation_logs (id, operation_id, stream, step, message, redacted, truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, operationId, input.stream ?? 'stdout', input.step ?? null, safe, redacted ? 1 : 0, truncated ? 1 : 0, now])
    return logEntry(this.controlPlane.database.query<Row, [string]>('SELECT * FROM operation_logs WHERE id=?').get(id)!)
  }

  logs(operationId: string, input: { after?: number, limit?: number } = {}): OperationLogEntry[] {
    const limit = Math.min(1000, Math.max(1, input.limit ?? 200))
    return this.controlPlane.database.query<Row, [string, number, number]>('SELECT * FROM operation_logs WHERE operation_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?').all(operationId, input.after ?? 0, limit).map(logEntry)
  }

  requestCancellation(operationId: string, actorId?: string): ControlPlaneOperation {
    const current = this.controlPlane.getOperation(operationId); if (!current || TERMINAL_STATES.includes(current.state)) throw new Error('Only queued or running operations can be cancelled')
    const requested = this.controlPlane.requestCancellation(operationId)
    this.controlPlane.appendEvent({ projectId: current.projectId, operationId, resourceId: current.resourceId, actorId, correlationId: current.correlationId, type: 'operation.cancellation_requested', level: 'warning', payload: { state: current.state } })
    this.appendLog(operationId, current.state === 'queued' ? 'Cancellation accepted before execution.' : 'Cancellation requested; waiting for the current provider step.', { stream: 'system' })
    if (requested.state === 'queued') return this.finish(operationId, 'cancelled', { cancelledBeforeStart: true })
    return requested
  }

  retry(operationId: string, errorClass: string, input: { delayMs?: number, actorId?: string } = {}): ControlPlaneOperation {
    const operation = this.controlPlane.getOperation(operationId); const metadata = this.getJob(operationId)
    if (!operation || !metadata || !['failed', 'cancelled', 'timed_out'].includes(operation.state)) throw new Error('Only failed, cancelled, or timed-out queue jobs can be retried')
    if (operation.attempt >= metadata.maxAttempts) throw new Error(`Operation reached its ${metadata.maxAttempts}-attempt limit`)
    if (!metadata.retryClasses.includes(errorClass)) throw new Error(`Retry class ${errorClass} is not allowed for this operation`)
    const queued = this.controlPlane.transitionOperation(operationId, { to: 'queued', expectedVersion: operation.version, error: `Retry requested after ${errorClass}` })
    const available = new Date(this.nowFn().getTime() + Math.max(0, input.delayMs ?? 0)).toISOString()
    this.controlPlane.database.run('UPDATE operations SET cancel_requested_at=NULL, finished_at=NULL WHERE id=?', [operationId])
    this.controlPlane.database.run('UPDATE operation_jobs SET available_at=?, blocked_reason=NULL, updated_at=? WHERE operation_id=?', [available, this.now(), operationId])
    this.controlPlane.appendEvent({ projectId: operation.projectId, operationId, resourceId: operation.resourceId, actorId: input.actorId, correlationId: operation.correlationId, type: 'operation.retry_requested', payload: { errorClass, availableAt: available, nextAttempt: operation.attempt + 1 } })
    this.appendLog(operationId, `Retry queued for error class ${errorClass}.`, { stream: 'system' })
    return this.controlPlane.getOperation(queued.id)!
  }

  private release(operationId: string): void { this.controlPlane.database.run('DELETE FROM operation_locks WHERE operation_id=?', [operationId]) }
  private finish(operationId: string, state: Extract<OperationState, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>, output: JsonValue = {}, error?: string): ControlPlaneOperation {
    const current = this.controlPlane.getOperation(operationId); if (!current) throw new Error(`Operation ${operationId} was not found`)
    const result = this.controlPlane.transitionOperation(operationId, { to: state, expectedVersion: current.version, output, error })
    this.release(operationId)
    return result
  }

  complete(operationId: string, output: JsonValue = {}): ControlPlaneOperation {
    const operation = this.controlPlane.getOperation(operationId)
    if (!operation || operation.state !== 'running' || operation.leaseOwner !== this.workerId) throw new Error('Only the lease owner can complete a running operation')
    this.appendLog(operationId, 'Operation completed successfully.', { stream: 'system' })
    return this.finish(operationId, 'succeeded', output)
  }

  fail(operationId: string, error: string, output: JsonValue = {}): ControlPlaneOperation {
    const operation = this.controlPlane.getOperation(operationId)
    if (!operation || operation.state !== 'running' || operation.leaseOwner !== this.workerId) throw new Error('Only the lease owner can fail a running operation')
    this.appendLog(operationId, error, { stream: 'stderr' })
    return this.finish(operationId, 'failed', output, error)
  }

  async runOne(handlers: Record<string, QueueOperationHandler>): Promise<QueueRunResult> {
    const claimed = this.claimNext(Object.keys(handlers)); if (!claimed) return { handled: false }
    const { operation, job: metadata } = claimed; const handler = handlers[operation.kind]; if (!handler) return { handled: false }
    const controller = new AbortController(); let timeout = false
    const timeoutTimer = setTimeout(() => { timeout = true; controller.abort(new QueueTimeoutError(metadata.timeoutSeconds)) }, metadata.timeoutSeconds * 1000)
    const heartbeatTimer = setInterval(() => { try { this.heartbeat(operation.id) } catch {} }, Math.max(250, Math.floor(this.leaseMs / 3)))
    const cancellationTimer = setInterval(() => { if (this.controlPlane.getOperation(operation.id)?.cancelRequestedAt) controller.abort(new QueueCancellationError()) }, 100)
    const context: QueueExecutionContext = {
      operation,
      signal: controller.signal,
      log: (message, input) => this.appendLog(operation.id, message, input),
      checkpoint: (step, message) => { this.heartbeat(operation.id, step); this.appendLog(operation.id, message ?? step, { stream: 'step', step }) },
      heartbeat: () => this.heartbeat(operation.id),
      cancellationRequested: () => !!this.controlPlane.getOperation(operation.id)?.cancelRequestedAt,
      throwIfCancellationRequested: () => { if (this.controlPlane.getOperation(operation.id)?.cancelRequestedAt) throw new QueueCancellationError() },
    }
    try {
      const output = await Promise.race([handler(context), new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))])
      const latest = this.controlPlane.getOperation(operation.id)!
      if (latest.cancelRequestedAt) {
        const providerCompleted = metadata.cancellationMode === 'provider_non_cancellable'
        this.appendLog(operation.id, providerCompleted ? 'Provider step completed after cancellation was requested; reconciliation is required.' : 'Operation cancelled cooperatively.', { stream: 'system' })
        const result = this.finish(operation.id, 'cancelled', { providerCompleted, reconciliationRequired: providerCompleted })
        return { handled: true, operation: result, terminalState: 'cancelled' }
      }
      const result = this.complete(operation.id, output ?? {})
      return { handled: true, operation: result, terminalState: 'succeeded' }
    }
    catch (error) {
      if (timeout || error instanceof QueueTimeoutError) {
        this.appendLog(operation.id, `Timed out after ${metadata.timeoutSeconds}s.`, { stream: 'system' })
        const result = this.finish(operation.id, 'timed_out', { reconciliationRequired: metadata.cancellationMode === 'provider_non_cancellable' }, error instanceof Error ? error.message : String(error))
        return { handled: true, operation: result, terminalState: 'timed_out' }
      }
      if (error instanceof QueueCancellationError || this.controlPlane.getOperation(operation.id)?.cancelRequestedAt) {
        const result = this.finish(operation.id, 'cancelled', { cooperativelyCancelled: true })
        return { handled: true, operation: result, terminalState: 'cancelled' }
      }
      if (error instanceof RetryableOperationError && metadata.retryClasses.includes(error.errorClass) && operation.attempt < metadata.maxAttempts) {
        const current = this.controlPlane.getOperation(operation.id)!
        this.controlPlane.transitionOperation(operation.id, { to: 'queued', expectedVersion: current.version, error: error.message })
        const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, operation.attempt - 1))
        const available = new Date(this.nowFn().getTime() + delay).toISOString()
        this.controlPlane.database.run('UPDATE operation_jobs SET available_at=?, blocked_reason=?, updated_at=? WHERE operation_id=?', [available, `retry_backoff:${error.errorClass}`, this.now(), operation.id])
        this.release(operation.id); this.appendLog(operation.id, `Retryable ${error.errorClass} failure; next attempt is delayed.`, { stream: 'system' })
        return { handled: true, operation: this.controlPlane.getOperation(operation.id), requeued: true }
      }
      const message = error instanceof Error ? error.message : String(error)
      this.appendLog(operation.id, message, { stream: 'stderr' })
      const result = this.finish(operation.id, 'failed', {}, message)
      return { handled: true, operation: result, terminalState: 'failed' }
    }
    finally { clearTimeout(timeoutTimer); clearInterval(heartbeatTimer); clearInterval(cancellationTimer) }
  }

  recoverExpired(): QueueRecoveryResult {
    const rows = this.controlPlane.database.query<Row, [string]>(`SELECT o.id FROM operations o JOIN operation_jobs j ON j.operation_id=o.id WHERE o.state='running' AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=?)`).all(this.now())
    const result: QueueRecoveryResult = { requeued: 0, failed: 0, cancelled: 0 }
    for (const row of rows) {
      const operation = this.controlPlane.getOperation(String(row.id))!; const metadata = this.getJob(operation.id)!
      this.release(operation.id)
      if (operation.cancelRequestedAt) { this.finish(operation.id, 'cancelled', { recoveredAfterWorkerLoss: true }); result.cancelled++; continue }
      if (metadata.resumePolicy === 'requeue' && operation.attempt < metadata.maxAttempts) {
        this.controlPlane.transitionOperation(operation.id, { to: 'queued', expectedVersion: operation.version, error: 'Worker lease expired; safely requeued from the last checkpoint.' })
        this.controlPlane.database.run('UPDATE operation_jobs SET available_at=?, blocked_reason=\'worker_restart\', updated_at=? WHERE operation_id=?', [this.now(), this.now(), operation.id])
        this.appendLog(operation.id, 'Worker lease expired; operation requeued from its persisted checkpoint.', { stream: 'system' }); result.requeued++
      }
      else { this.finish(operation.id, 'failed', { recoverable: true, lastCheckpoint: metadata.currentStep ?? null }, 'Worker lease expired; retry explicitly after reconciling provider state.'); result.failed++ }
    }
    return result
  }

  clearCompleted(input: { before?: string, actorId?: string, projectId?: string } = {}): number {
    const now = this.now()
    const bindings: SQLQueryBindings[] = [now]
    const project = input.projectId ? 'AND o.project_id=?' : ''; if (input.projectId) bindings.push(input.projectId)
    const finished = input.before ? 'AND o.finished_at<=?' : ''; if (input.before) bindings.push(new Date(input.before).toISOString())
    const rows = this.controlPlane.database.query<Row, SQLQueryBindings[]>(`SELECT o.id, o.project_id, o.correlation_id FROM operations o JOIN operation_jobs j ON j.operation_id=o.id WHERE o.state IN ('succeeded','failed','cancelled','timed_out') AND j.retention_until<=? ${project} ${finished}`).all(...bindings)
    for (const row of rows) {
      this.controlPlane.appendEvent({ projectId: optional(row.project_id), actorId: input.actorId, correlationId: String(row.correlation_id), type: 'queue.history.cleared', level: 'warning', payload: { operationId: String(row.id), retentionCutoff: now } })
      this.controlPlane.database.run('DELETE FROM operations WHERE id=?', [String(row.id)])
    }
    return rows.length
  }
}
