import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type {
  JobExecution,
  JobExecutionStatus,
  ReconciliationStatus,
  ScheduledJob,
  WorkerDefinition,
} from './model'
import { previewSchedule } from './schedule'

type Row = Record<string, unknown>
const optional = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined
const bool = (value: unknown): boolean => Number(value) === 1
const json = (value: unknown): any => {
  try {
    return JSON.parse(String(value))
  } catch {
    return {}
  }
}
const clamp = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, Math.floor(parsed)))
    : fallback
}
function job(row: Row): ScheduledJob {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: optional(row.environment_id),
    resourceId: optional(row.resource_id),
    name: String(row.name),
    provider: String(row.provider) as ScheduledJob['provider'],
    expression: String(row.expression),
    normalizedExpression: String(row.normalized_expression),
    timezone: String(row.timezone),
    startsAt: optional(row.starts_at),
    endsAt: optional(row.ends_at),
    flexibleMinutes: Number(row.flexible_minutes),
    target: json(row.target),
    payloadRefs: json(row.payload_refs),
    missedRunPolicy: String(
      row.missed_run_policy,
    ) as ScheduledJob['missedRunPolicy'],
    overlapPolicy: String(row.overlap_policy) as ScheduledJob['overlapPolicy'],
    retryPolicy: json(row.retry_policy),
    timeoutSeconds: Number(row.timeout_seconds),
    enabled: bool(row.enabled),
    origin: String(row.origin) as ScheduledJob['origin'],
    sourceKey: optional(row.source_key),
    ownerActorId: optional(row.owner_actor_id),
    observedState: json(row.observed_state),
    reconciliationStatus: String(
      row.reconciliation_status,
    ) as ReconciliationStatus,
    nextRunAt: optional(row.next_run_at),
    lastScheduledFor: optional(row.last_scheduled_for),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
function execution(row: Row): JobExecution {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    operationId: optional(row.operation_id),
    trigger: String(row.trigger) as JobExecution['trigger'],
    scheduledFor: String(row.scheduled_for),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as JobExecutionStatus,
    attempt: Number(row.attempt),
    startedAt: optional(row.started_at),
    finishedAt: optional(row.finished_at),
    output: json(row.output),
    error: optional(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
function worker(row: Row): WorkerDefinition {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: optional(row.environment_id),
    resourceId: optional(row.resource_id),
    name: String(row.name),
    provider: String(row.provider) as WorkerDefinition['provider'],
    queue: String(row.queue),
    processes: Number(row.processes),
    timeoutSeconds: Number(row.timeout_seconds),
    restartPolicy: String(
      row.restart_policy,
    ) as WorkerDefinition['restartPolicy'],
    target: json(row.target),
    enabled: bool(row.enabled),
    origin: String(row.origin) as WorkerDefinition['origin'],
    sourceKey: optional(row.source_key),
    ownerActorId: optional(row.owner_actor_id),
    observedState: json(row.observed_state),
    reconciliationStatus: String(
      row.reconciliation_status,
    ) as ReconciliationStatus,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export class JobStore {
  constructor(
    readonly controlPlane: ControlPlaneStore,
    private readonly options: { now?: () => Date } = {},
  ) {}
  now(): Date {
    return this.options.now?.() ?? new Date()
  }
  create(
    input: Omit<
      ScheduledJob,
      | 'id'
      | 'normalizedExpression'
      | 'nextRunAt'
      | 'lastScheduledFor'
      | 'version'
      | 'createdAt'
      | 'updatedAt'
    >,
  ): ScheduledJob {
    if (!input.name.trim()) throw new Error('Scheduled jobs require a name.')
    const preview = previewSchedule(
        input.expression,
        input.timezone,
        this.now(),
        1,
      ),
      id = crypto.randomUUID(),
      now = this.now().toISOString(),
      starts = input.startsAt
        ? new Date(input.startsAt).toISOString()
        : undefined,
      ends = input.endsAt ? new Date(input.endsAt).toISOString() : undefined
    if (starts && ends && starts >= ends)
      throw new Error('Schedule start must be before end.')
    const next = preview.nextRuns.find(
      (value) => (!starts || value >= starts) && (!ends || value <= ends),
    )
    this.controlPlane.database.run(
      'INSERT INTO scheduled_jobs (id,organization_id,project_id,environment_id,resource_id,name,provider,expression,normalized_expression,timezone,starts_at,ends_at,flexible_minutes,target,payload_refs,missed_run_policy,overlap_policy,retry_policy,timeout_seconds,enabled,origin,source_key,owner_actor_id,observed_state,reconciliation_status,next_run_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId,
        input.environmentId ?? null,
        input.resourceId ?? null,
        input.name.trim().slice(0, 120),
        input.provider,
        input.expression,
        preview.normalized,
        input.timezone,
        starts ?? null,
        ends ?? null,
        clamp(input.flexibleMinutes, 0, 0, 1440),
        JSON.stringify(input.target),
        JSON.stringify(input.payloadRefs),
        input.missedRunPolicy,
        input.overlapPolicy,
        JSON.stringify({
          maxAttempts: clamp(input.retryPolicy.maxAttempts, 3, 1, 20),
          backoffSeconds: clamp(input.retryPolicy.backoffSeconds, 30, 0, 86400),
          deadLetterRef: input.retryPolicy.deadLetterRef,
        }),
        clamp(input.timeoutSeconds, 900, 1, 86400),
        input.enabled ? 1 : 0,
        input.origin,
        input.sourceKey ?? null,
        input.ownerActorId ?? null,
        JSON.stringify(input.observedState),
        input.reconciliationStatus,
        next ?? null,
        1,
        now,
        now,
      ],
    )
    return this.get(id)!
  }
  get(id: string): ScheduledJob | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM scheduled_jobs WHERE id=?')
      .get(id)
    return row ? job(row) : undefined
  }
  getBySource(
    projectId: string,
    environmentId: string | undefined,
    sourceKey: string,
  ): ScheduledJob | undefined {
    const row = this.controlPlane.database
      .query<
        Row,
        [string, string | null, string]
      >('SELECT * FROM scheduled_jobs WHERE project_id=? AND environment_id IS ? AND source_key=?')
      .get(projectId, environmentId ?? null, sourceKey)
    return row ? job(row) : undefined
  }
  list(
    projectId: string,
    input: {
      environmentId?: string
      resourceIds?: string[]
      enabled?: boolean
    } = {},
  ): ScheduledJob[] {
    const clauses = ['project_id=?'],
      bindings: SQLQueryBindings[] = [projectId]
    if (input.environmentId) {
      clauses.push('environment_id=?')
      bindings.push(input.environmentId)
    }
    if (input.resourceIds?.length) {
      clauses.push(
        `resource_id IN (${input.resourceIds.map(() => '?').join(',')})`,
      )
      bindings.push(...input.resourceIds)
    }
    if (input.enabled != null) {
      clauses.push('enabled=?')
      bindings.push(input.enabled ? 1 : 0)
    }
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM scheduled_jobs WHERE ${clauses.join(' AND ')} ORDER BY next_run_at IS NULL,next_run_at,name`,
      )
      .all(...bindings)
      .map(job)
  }
  setEnabled(id: string, enabled: boolean): ScheduledJob {
    this.controlPlane.database.run(
      'UPDATE scheduled_jobs SET enabled=?,version=version+1,updated_at=? WHERE id=?',
      [enabled ? 1 : 0, this.now().toISOString(), id],
    )
    const value = this.get(id)
    if (!value) throw new Error('Scheduled job was not found.')
    return value
  }
  updateSchedule(
    id: string,
    input: {
      expression?: string
      timezone?: string
      missedRunPolicy?: ScheduledJob['missedRunPolicy']
      overlapPolicy?: ScheduledJob['overlapPolicy']
      timeoutSeconds?: number
    },
  ): ScheduledJob {
    const current = this.get(id)
    if (!current) throw new Error('Scheduled job was not found.')
    const expression = input.expression ?? current.expression,
      timezone = input.timezone ?? current.timezone,
      preview = previewSchedule(expression, timezone, this.now(), 1),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'UPDATE scheduled_jobs SET expression=?,normalized_expression=?,timezone=?,missed_run_policy=?,overlap_policy=?,timeout_seconds=?,next_run_at=?,reconciliation_status=?,version=version+1,updated_at=? WHERE id=?',
      [
        expression,
        preview.normalized,
        timezone,
        input.missedRunPolicy ?? current.missedRunPolicy,
        input.overlapPolicy ?? current.overlapPolicy,
        clamp(input.timeoutSeconds, current.timeoutSeconds, 1, 86400),
        preview.nextRuns[0],
        'pending',
        now,
        id,
      ],
    )
    return this.get(id)!
  }
  remove(id: string): void {
    const current = this.get(id)
    if (!current) throw new Error('Scheduled job was not found.')
    if (current.origin === 'config')
      throw new Error(
        'Config-defined jobs must be removed from configuration, not destructively deleted.',
      )
    this.controlPlane.database.run('DELETE FROM scheduled_jobs WHERE id=?', [
      id,
    ])
  }
  markScheduled(id: string, scheduledFor: string, nextRunAt?: string): void {
    this.controlPlane.database.run(
      'UPDATE scheduled_jobs SET last_scheduled_for=?,next_run_at=?,updated_at=? WHERE id=?',
      [scheduledFor, nextRunAt ?? null, this.now().toISOString(), id],
    )
  }
  reconcile(
    id: string,
    status: ReconciliationStatus,
    observedState: Record<string, JsonValue>,
  ): ScheduledJob {
    this.controlPlane.database.run(
      'UPDATE scheduled_jobs SET reconciliation_status=?,observed_state=?,updated_at=? WHERE id=?',
      [status, JSON.stringify(observedState), this.now().toISOString(), id],
    )
    return this.get(id)!
  }
  upsertConfigJob(
    input: Omit<
      ScheduledJob,
      | 'id'
      | 'normalizedExpression'
      | 'nextRunAt'
      | 'lastScheduledFor'
      | 'version'
      | 'createdAt'
      | 'updatedAt'
    > & { sourceKey: string },
  ): ScheduledJob {
    const existing = this.getBySource(
      input.projectId,
      input.environmentId,
      input.sourceKey,
    )
    if (!existing) return this.create(input)
    const preview = previewSchedule(
        input.expression,
        input.timezone,
        this.now(),
        1,
      ),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'UPDATE scheduled_jobs SET resource_id=?,name=?,provider=?,expression=?,normalized_expression=?,timezone=?,target=?,payload_refs=?,missed_run_policy=?,overlap_policy=?,retry_policy=?,timeout_seconds=?,enabled=?,observed_state=?,reconciliation_status=?,next_run_at=COALESCE(next_run_at,?),version=version+1,updated_at=? WHERE id=?',
      [
        input.resourceId ?? null,
        input.name,
        input.provider,
        input.expression,
        preview.normalized,
        input.timezone,
        JSON.stringify(input.target),
        JSON.stringify(input.payloadRefs),
        input.missedRunPolicy,
        input.overlapPolicy,
        JSON.stringify(input.retryPolicy),
        input.timeoutSeconds,
        input.enabled ? 1 : 0,
        JSON.stringify(input.observedState),
        input.reconciliationStatus,
        preview.nextRuns[0],
        now,
        existing.id,
      ],
    )
    return this.get(existing.id)!
  }
  due(at: string = this.now().toISOString()): ScheduledJob[] {
    return this.controlPlane.database
      .query<
        Row,
        [string, string, string]
      >('SELECT * FROM scheduled_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>=?) ORDER BY next_run_at LIMIT 200')
      .all(at, at, at)
      .map(job)
  }
  createExecution(
    input: Omit<
      JobExecution,
      'id' | 'attempt' | 'startedAt' | 'finishedAt' | 'createdAt' | 'updatedAt'
    >,
  ): JobExecution {
    const existing = this.controlPlane.database
      .query<
        Row,
        [string]
      >('SELECT * FROM job_executions WHERE idempotency_key=?')
      .get(input.idempotencyKey)
    if (existing) return execution(existing)
    const id = crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO job_executions (id,job_id,operation_id,trigger,scheduled_for,idempotency_key,status,attempt,output,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.jobId,
        input.operationId ?? null,
        input.trigger,
        input.scheduledFor,
        input.idempotencyKey,
        input.status,
        0,
        JSON.stringify(input.output),
        now,
        now,
      ],
    )
    return this.getExecution(id)!
  }
  getExecution(id: string): JobExecution | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM job_executions WHERE id=?')
      .get(id)
    return row ? execution(row) : undefined
  }
  listExecutions(jobId: string, limit = 100): JobExecution[] {
    return this.controlPlane.database
      .query<Row, [string, number]>(
        'SELECT * FROM job_executions WHERE job_id=? ORDER BY scheduled_for DESC,created_at DESC LIMIT ?',
      )
      .all(jobId, Math.min(1000, Math.max(1, limit)))
      .map(execution)
  }
  activeExecution(jobId: string): JobExecution | undefined {
    const row = this.controlPlane.database
      .query<
        Row,
        [string]
      >("SELECT * FROM job_executions WHERE job_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
      .get(jobId)
    return row ? execution(row) : undefined
  }
  attachOperation(id: string, operationId: string): JobExecution {
    this.controlPlane.database.run(
      'UPDATE job_executions SET operation_id=?,updated_at=? WHERE id=?',
      [operationId, this.now().toISOString(), id],
    )
    return this.getExecution(id)!
  }
  transitionExecution(
    id: string,
    status: JobExecutionStatus,
    input: {
      attempt?: number
      output?: Record<string, JsonValue>
      error?: string
    } = {},
  ): JobExecution {
    const now = this.now().toISOString(),
      started = status === 'running' ? now : null,
      finished = ['succeeded', 'failed', 'skipped', 'dead'].includes(status)
        ? now
        : null
    this.controlPlane.database.run(
      'UPDATE job_executions SET status=?,attempt=COALESCE(?,attempt),started_at=COALESCE(started_at,?),finished_at=?,output=COALESCE(?,output),error=?,updated_at=? WHERE id=?',
      [
        status,
        input.attempt ?? null,
        started,
        finished,
        input.output ? JSON.stringify(input.output) : null,
        input.error?.slice(0, 2000) ?? null,
        now,
        id,
      ],
    )
    return this.getExecution(id)!
  }
  upsertWorker(
    input: Omit<WorkerDefinition, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): WorkerDefinition {
    const existing = input.sourceKey
        ? this.controlPlane.database
            .query<
              Row,
              [string, string, string | null]
            >('SELECT * FROM worker_definitions WHERE project_id=? AND source_key=? AND environment_id IS ?')
            .get(input.projectId, input.sourceKey, input.environmentId ?? null)
        : undefined,
      id = existing ? String(existing.id) : crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      `INSERT INTO worker_definitions (id,organization_id,project_id,environment_id,resource_id,name,provider,queue,processes,timeout_seconds,restart_policy,target,enabled,origin,source_key,owner_actor_id,observed_state,reconciliation_status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,resource_id=excluded.resource_id,queue=excluded.queue,processes=excluded.processes,timeout_seconds=excluded.timeout_seconds,restart_policy=excluded.restart_policy,target=excluded.target,enabled=excluded.enabled,observed_state=excluded.observed_state,reconciliation_status=excluded.reconciliation_status,version=worker_definitions.version+1,updated_at=excluded.updated_at`,
      [
        id,
        input.organizationId,
        input.projectId,
        input.environmentId ?? null,
        input.resourceId ?? null,
        input.name.slice(0, 120),
        input.provider,
        input.queue.slice(0, 200),
        clamp(input.processes, 1, 0, 1000),
        clamp(input.timeoutSeconds, 60, 1, 86400),
        input.restartPolicy,
        JSON.stringify(input.target),
        input.enabled ? 1 : 0,
        input.origin,
        input.sourceKey ?? null,
        input.ownerActorId ?? null,
        JSON.stringify(input.observedState),
        input.reconciliationStatus,
        1,
        existing ? String(existing.created_at) : now,
        now,
      ],
    )
    return this.getWorker(id)!
  }
  getWorker(id: string): WorkerDefinition | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM worker_definitions WHERE id=?')
      .get(id)
    return row ? worker(row) : undefined
  }
  listWorkers(projectId: string, environmentId?: string): WorkerDefinition[] {
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM worker_definitions WHERE project_id=?${environmentId ? ' AND environment_id=?' : ''} ORDER BY name`,
      )
      .all(projectId, ...(environmentId ? [environmentId] : []))
      .map(worker)
  }
  setWorkerProcesses(id: string, processes: number): WorkerDefinition {
    this.controlPlane.database.run(
      "UPDATE worker_definitions SET processes=?,reconciliation_status='pending',version=version+1,updated_at=? WHERE id=?",
      [clamp(processes, 1, 0, 1000), this.now().toISOString(), id],
    )
    const value = this.getWorker(id)
    if (!value) throw new Error('Worker was not found.')
    return value
  }
  reconcileWorker(
    id: string,
    status: ReconciliationStatus,
    observedState: Record<string, JsonValue>,
  ): WorkerDefinition {
    this.controlPlane.database.run(
      'UPDATE worker_definitions SET reconciliation_status=?,observed_state=?,updated_at=? WHERE id=?',
      [status, JSON.stringify(observedState), this.now().toISOString(), id],
    )
    const value = this.getWorker(id)
    if (!value) throw new Error('Worker was not found.')
    return value
  }
}
