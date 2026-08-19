import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { BackupCoverage, BackupDestination, BackupJob, BackupPolicy, RecoveryPoint } from './model'
import { isIP } from 'node:net'
import { nextScheduleRuns, normalizeScheduleExpression } from '../jobs'

type Row = Record<string, unknown>
const optional = (value: unknown) => (value == null ? undefined : String(value)),
  bool = (value: unknown) => Number(value) === 1,
  json = <T>(value: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(value)) as T
    } catch {
      return fallback
    }
  }

function destination(row: Row): BackupDestination {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    name: String(row.name),
    provider: String(row.provider) as BackupDestination['provider'],
    endpoint: optional(row.endpoint),
    endpointPolicy: String(row.endpoint_policy) as BackupDestination['endpointPolicy'],
    bucket: optional(row.bucket),
    prefix: String(row.prefix),
    region: optional(row.region),
    forcePathStyle: bool(row.force_path_style),
    credentialRef: optional(row.credential_ref),
    encryption: String(row.encryption) as BackupDestination['encryption'],
    encryptionKeyRef: optional(row.encryption_key_ref),
    immutability: json(row.immutability, {}),
    status: String(row.status) as BackupDestination['status'],
    lastTestedAt: optional(row.last_tested_at),
    lastSuccessAt: optional(row.last_success_at),
    lastFailureAt: optional(row.last_failure_at),
    lastError: optional(row.last_error),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function policy(row: Row): BackupPolicy {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: optional(row.environment_id),
    resourceId: optional(row.resource_id),
    dataServiceId: optional(row.data_service_id),
    destinationId: String(row.destination_id),
    name: String(row.name),
    resourceKind: String(row.resource_kind) as BackupPolicy['resourceKind'],
    schedule: String(row.schedule),
    timezone: String(row.timezone),
    retention: json(row.retention, {}),
    compression: String(row.compression) as BackupPolicy['compression'],
    encryption: String(row.encryption) as BackupPolicy['encryption'],
    includePatterns: json(row.include_patterns, []),
    excludePatterns: json(row.exclude_patterns, []),
    expectedRpoMinutes: Number(row.expected_rpo_minutes),
    expectedRtoMinutes: Number(row.expected_rto_minutes),
    healthCheckId: optional(row.health_check_id),
    enabled: bool(row.enabled),
    nextRunAt: optional(row.next_run_at),
    lastRunAt: optional(row.last_run_at),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function point(row: Row): RecoveryPoint {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    policyId: optional(row.policy_id),
    destinationId: String(row.destination_id),
    resourceId: optional(row.resource_id),
    dataServiceId: optional(row.data_service_id),
    backupJobId: optional(row.backup_job_id),
    kind: String(row.kind) as RecoveryPoint['kind'],
    pointInTime: String(row.point_in_time),
    uri: String(row.uri),
    sizeBytes: Number(row.size_bytes),
    checksum: String(row.checksum),
    manifest: json(row.manifest, {}),
    toolVersion: optional(row.tool_version),
    engineVersion: optional(row.engine_version),
    expiresAt: optional(row.expires_at),
    lockedUntil: optional(row.locked_until),
    held: bool(row.held),
    pinned: bool(row.pinned),
    status: String(row.status) as RecoveryPoint['status'],
    verificationState: String(row.verification_state) as RecoveryPoint['verificationState'],
    verifiedAt: optional(row.verified_at),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function job(row: Row): BackupJob {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    policyId: optional(row.policy_id),
    recoveryPointId: optional(row.recovery_point_id),
    operationId: optional(row.operation_id),
    kind: String(row.kind) as BackupJob['kind'],
    status: String(row.status) as BackupJob['status'],
    idempotencyKey: String(row.idempotency_key),
    target: json(row.target, {}),
    restoreMode: optional(row.restore_mode) as BackupJob['restoreMode'],
    cancellability: String(row.cancellability) as BackupJob['cancellability'],
    safetyBackupId: optional(row.safety_backup_id),
    healthResult: row.health_result ? json<Record<string, JsonValue>>(row.health_result, {}) : undefined,
    progress: json(row.progress, {}),
    error: optional(row.error),
    startedAt: optional(row.started_at),
    finishedAt: optional(row.finished_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function privateHost(host: string): boolean {
  const normalized = host.toLowerCase()
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  )
    return true
  if (isIP(normalized) === 6) return normalized === '::1' || normalized.startsWith('fe80:')
  if (isIP(normalized) !== 4) return false
  const [a, b] = normalized.split('.').map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

export function validateBackupDestination(
  input: Omit<BackupDestination, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
): void {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.name))
    throw new Error('Backup destination names must be 2-63 lowercase letters, numbers, or dashes.')
  if (input.provider !== 'aws_backup' && !input.bucket) throw new Error('S3 backup destinations require a bucket.')
  if (input.provider === 's3_compatible' && !input.endpoint)
    throw new Error('S3-compatible destinations require an explicit endpoint.')
  if (input.provider === 's3_compatible' && !input.credentialRef)
    throw new Error('S3-compatible destinations require a credential reference.')
  if (input.encryption !== 'provider' && !input.encryptionKeyRef)
    throw new Error('Client-side encryption requires an encryption key reference.')
  if (input.endpoint) {
    const url = new URL(input.endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error(
        'Backup endpoints must be origin-only HTTPS URLs without credentials, paths, queries, or fragments.',
      )
    if (privateHost(url.hostname) && input.endpointPolicy !== 'allow_private')
      throw new Error('Private backup endpoints require endpointPolicy allow_private.')
  }
}

export class BackupStore {
  constructor(
    readonly controlPlane: ControlPlaneStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createDestination(input: Omit<BackupDestination, 'id' | 'version' | 'createdAt' | 'updatedAt'>): BackupDestination {
    validateBackupDestination(input)
    const id = crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO backup_destinations (id,organization_id,project_id,name,provider,endpoint,endpoint_policy,bucket,prefix,region,force_path_style,credential_ref,encryption,encryption_key_ref,immutability,status,last_tested_at,last_success_at,last_failure_at,last_error,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId,
        input.name,
        input.provider,
        input.endpoint ?? null,
        input.endpointPolicy,
        input.bucket ?? null,
        input.prefix,
        input.region ?? null,
        input.forcePathStyle ? 1 : 0,
        input.credentialRef ?? null,
        input.encryption,
        input.encryptionKeyRef ?? null,
        JSON.stringify(input.immutability),
        input.status,
        input.lastTestedAt ?? null,
        input.lastSuccessAt ?? null,
        input.lastFailureAt ?? null,
        input.lastError ?? null,
        1,
        now,
        now,
      ],
    )
    return this.getDestination(id)!
  }

  getDestination(id: string): BackupDestination | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM backup_destinations WHERE id=?').get(id)
    return row ? destination(row) : undefined
  }

  listDestinations(projectId: string): BackupDestination[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM backup_destinations WHERE project_id=? ORDER BY name')
      .all(projectId)
      .map(destination)
  }

  recordDestinationTest(id: string, result: { ok: boolean; error?: string }): BackupDestination {
    const now = this.now().toISOString()
    this.controlPlane.database.run(
      `UPDATE backup_destinations SET status=?,last_tested_at=?,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,last_failure_at=CASE WHEN ? THEN last_failure_at ELSE ? END,last_error=?,version=version+1,updated_at=? WHERE id=?`,
      [
        result.ok ? 'healthy' : 'failing',
        now,
        result.ok ? 1 : 0,
        now,
        result.ok ? 1 : 0,
        now,
        result.ok ? null : String(result.error ?? 'Destination test failed.').slice(0, 1000),
        now,
        id,
      ],
    )
    return this.getDestination(id)!
  }

  createPolicy(input: Omit<BackupPolicy, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'nextRunAt'>): BackupPolicy {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.name)) throw new Error('Backup policy names must be lowercase slugs.')
    if (!input.resourceId && !input.dataServiceId && !['control_plane', 'infrastructure'].includes(input.resourceKind))
      throw new Error('A backup policy requires a resource or data service target.')
    const destination = this.getDestination(input.destinationId)
    if (!destination || destination.projectId !== input.projectId) throw new Error('Backup destination was not found.')
    if (input.resourceKind === 'control_plane' && destination.encryption === 'provider')
      throw new Error('Control-plane backups require client-side destination encryption.')
    if (
      ['logical_database', 'volume', 'files', 'control_plane'].includes(input.resourceKind) &&
      destination.provider === 'aws_backup'
    )
      throw new Error(`${input.resourceKind} backups require an object-storage destination.`)
    if (input.resourceKind === 'infrastructure' && destination.provider !== 'aws_backup')
      throw new Error('Infrastructure backups require an AWS Backup destination.')
    const expression = normalizeScheduleExpression(input.schedule),
      nextRunAt = nextScheduleRuns(expression.normalized, input.timezone, this.now(), 1)[0],
      id = crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO backup_policies (id,organization_id,project_id,environment_id,resource_id,data_service_id,destination_id,name,resource_kind,schedule,timezone,retention,compression,encryption,include_patterns,exclude_patterns,expected_rpo_minutes,expected_rto_minutes,health_check_id,enabled,next_run_at,last_run_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId,
        input.environmentId ?? null,
        input.resourceId ?? null,
        input.dataServiceId ?? null,
        input.destinationId,
        input.name,
        input.resourceKind,
        expression.normalized,
        input.timezone,
        JSON.stringify(input.retention),
        input.compression,
        input.encryption,
        JSON.stringify(input.includePatterns),
        JSON.stringify(input.excludePatterns),
        input.expectedRpoMinutes,
        input.expectedRtoMinutes,
        input.healthCheckId ?? null,
        input.enabled ? 1 : 0,
        nextRunAt,
        input.lastRunAt ?? null,
        1,
        now,
        now,
      ],
    )
    return this.getPolicy(id)!
  }

  getPolicy(id: string): BackupPolicy | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM backup_policies WHERE id=?').get(id)
    return row ? policy(row) : undefined
  }

  listPolicies(projectId: string, environmentId?: string): BackupPolicy[] {
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM backup_policies WHERE project_id=?${environmentId ? ' AND environment_id=?' : ''} ORDER BY name`,
      )
      .all(projectId, ...(environmentId ? [environmentId] : []))
      .map(policy)
  }

  duePolicies(at: Date = this.now()): BackupPolicy[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM backup_policies WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at,id')
      .all(at.toISOString())
      .map(policy)
  }

  advancePolicy(id: string, scheduledFor: string): BackupPolicy {
    const current = this.getPolicy(id)
    if (!current) throw new Error('Backup policy was not found.')
    const next = nextScheduleRuns(current.schedule, current.timezone, new Date(scheduledFor), 1)[0]
    this.controlPlane.database.run(
      'UPDATE backup_policies SET last_run_at=?,next_run_at=?,version=version+1,updated_at=? WHERE id=?',
      [scheduledFor, next, this.now().toISOString(), id],
    )
    return this.getPolicy(id)!
  }

  createJob(input: Omit<BackupJob, 'id' | 'createdAt' | 'updatedAt'>): BackupJob {
    const existing = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM backup_jobs WHERE idempotency_key=?')
      .get(input.idempotencyKey)
    if (existing) return job(existing)
    const id = crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO backup_jobs (id,project_id,policy_id,recovery_point_id,operation_id,kind,status,idempotency_key,target,restore_mode,cancellability,safety_backup_id,health_result,progress,error,started_at,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.projectId,
        input.policyId ?? null,
        input.recoveryPointId ?? null,
        input.operationId ?? null,
        input.kind,
        input.status,
        input.idempotencyKey,
        JSON.stringify(input.target),
        input.restoreMode ?? null,
        input.cancellability,
        input.safetyBackupId ?? null,
        input.healthResult ? JSON.stringify(input.healthResult) : null,
        JSON.stringify(input.progress),
        input.error ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        now,
        now,
      ],
    )
    return this.getJob(id)!
  }

  getJob(id: string): BackupJob | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM backup_jobs WHERE id=?').get(id)
    return row ? job(row) : undefined
  }

  listJobs(projectId: string): BackupJob[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM backup_jobs WHERE project_id=? ORDER BY created_at DESC')
      .all(projectId)
      .map(job)
  }

  updateJob(
    id: string,
    patch: Partial<
      Pick<
        BackupJob,
        | 'status'
        | 'operationId'
        | 'recoveryPointId'
        | 'progress'
        | 'healthResult'
        | 'error'
        | 'startedAt'
        | 'finishedAt'
        | 'safetyBackupId'
      >
    >,
  ): BackupJob {
    const current = this.getJob(id)
    if (!current) throw new Error('Backup job was not found.')
    const next = { ...current, ...patch }
    this.controlPlane.database.run(
      'UPDATE backup_jobs SET status=?,operation_id=?,recovery_point_id=?,progress=?,health_result=?,error=?,started_at=?,finished_at=?,safety_backup_id=?,updated_at=? WHERE id=?',
      [
        next.status,
        next.operationId ?? null,
        next.recoveryPointId ?? null,
        JSON.stringify(next.progress),
        next.healthResult ? JSON.stringify(next.healthResult) : null,
        next.error ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.safetyBackupId ?? null,
        this.now().toISOString(),
        id,
      ],
    )
    return this.getJob(id)!
  }

  createRecoveryPoint(input: Omit<RecoveryPoint, 'id' | 'createdAt' | 'updatedAt'>): RecoveryPoint {
    if (!/^sha256:[a-f0-9]{64}$/i.test(input.checksum)) throw new Error('Recovery points require a SHA-256 checksum.')
    if (
      typeof input.uri !== 'string' ||
      !['s3:', 'aws-backup:', 'file:'].some((scheme) => input.uri.startsWith(scheme))
    )
      throw new Error('Recovery point URI uses an unsupported destination scheme.')
    const id = crypto.randomUUID(),
      now = this.now().toISOString()
    this.controlPlane.database.run(
      'INSERT INTO recovery_points (id,project_id,policy_id,destination_id,resource_id,data_service_id,backup_job_id,kind,point_in_time,uri,size_bytes,checksum,manifest,tool_version,engine_version,expires_at,locked_until,held,pinned,status,verification_state,verified_at,duration_ms,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.projectId,
        input.policyId ?? null,
        input.destinationId,
        input.resourceId ?? null,
        input.dataServiceId ?? null,
        input.backupJobId ?? null,
        input.kind,
        input.pointInTime,
        input.uri,
        input.sizeBytes,
        input.checksum,
        JSON.stringify(input.manifest),
        input.toolVersion ?? null,
        input.engineVersion ?? null,
        input.expiresAt ?? null,
        input.lockedUntil ?? null,
        input.held ? 1 : 0,
        input.pinned ? 1 : 0,
        input.status,
        input.verificationState,
        input.verifiedAt ?? null,
        input.durationMs ?? null,
        now,
        now,
      ],
    )
    return this.getRecoveryPoint(id)!
  }

  getRecoveryPoint(id: string): RecoveryPoint | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM recovery_points WHERE id=?').get(id)
    return row ? point(row) : undefined
  }

  listRecoveryPoints(projectId: string, policyId?: string): RecoveryPoint[] {
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM recovery_points WHERE project_id=?${policyId ? ' AND policy_id=?' : ''} ORDER BY point_in_time DESC`,
      )
      .all(projectId, ...(policyId ? [policyId] : []))
      .map(point)
  }

  updateRecoveryPoint(
    id: string,
    patch: Partial<
      Pick<RecoveryPoint, 'status' | 'verificationState' | 'verifiedAt' | 'held' | 'pinned' | 'manifest' | 'durationMs'>
    >,
  ): RecoveryPoint {
    const current = this.getRecoveryPoint(id)
    if (!current) throw new Error('Recovery point was not found.')
    const next = { ...current, ...patch }
    this.controlPlane.database.run(
      'UPDATE recovery_points SET status=?,verification_state=?,verified_at=?,held=?,pinned=?,manifest=?,duration_ms=?,updated_at=? WHERE id=?',
      [
        next.status,
        next.verificationState,
        next.verifiedAt ?? null,
        next.held ? 1 : 0,
        next.pinned ? 1 : 0,
        JSON.stringify(next.manifest),
        next.durationMs ?? null,
        this.now().toISOString(),
        id,
      ],
    )
    return this.getRecoveryPoint(id)!
  }

  retentionCandidates(at: Date = this.now()): RecoveryPoint[] {
    const candidates = this.controlPlane.database
      .query<Row, [string, string]>(
        `SELECT rp.* FROM recovery_points rp
        WHERE rp.status='available' AND rp.held=0 AND rp.pinned=0
          AND rp.expires_at IS NOT NULL AND rp.expires_at<=?
          AND (rp.locked_until IS NULL OR rp.locked_until<=?)
          AND NOT EXISTS (
            SELECT 1 FROM backup_jobs bj WHERE bj.recovery_point_id=rp.id
            AND bj.kind IN ('restore','drill') AND bj.status IN ('queued','running','cleanup_required')
          )
        ORDER BY rp.expires_at,rp.id`,
      )
      .all(at.toISOString(), at.toISOString())
      .map(point)
    const protectedIds = new Set<string>()
    for (const projectId of new Set(candidates.map((item) => item.projectId))) {
      for (const policy of this.listPolicies(projectId)) {
        const points = this.listRecoveryPoints(policy.projectId, policy.id)
          .filter((item) => item.status === 'available')
          .sort((a, b) => b.pointInTime.localeCompare(a.pointInTime))
        for (const item of points.slice(0, Math.max(0, policy.retention.keepLast ?? 0))) protectedIds.add(item.id)
        const buckets: Array<[number | undefined, (date: Date) => string]> = [
          [policy.retention.hourly, (date) => date.toISOString().slice(0, 13)],
          [policy.retention.daily, (date) => date.toISOString().slice(0, 10)],
          [
            policy.retention.weekly,
            (date) => {
              const monday = new Date(
                Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)),
              )
              return monday.toISOString().slice(0, 10)
            },
          ],
          [policy.retention.monthly, (date) => date.toISOString().slice(0, 7)],
        ]
        for (const [count, bucket] of buckets) {
          const seen = new Set<string>()
          for (const item of points) {
            const key = bucket(new Date(item.pointInTime))
            if (seen.has(key)) continue
            seen.add(key)
            if (seen.size <= Math.max(0, count ?? 0)) protectedIds.add(item.id)
          }
        }
      }
    }
    return candidates.filter((item) => !protectedIds.has(item.id))
  }

  coverage(projectId: string, at: Date = this.now()): BackupCoverage[] {
    const destinations = new Map(this.listDestinations(projectId).map((item) => [item.id, item]))
    return this.listPolicies(projectId).map((item) => {
      const points = this.listRecoveryPoints(projectId, item.id).filter(
          (candidate) => candidate.status === 'available',
        ),
        lastRecoveryPoint = points[0],
        ageMinutes = lastRecoveryPoint
          ? (at.getTime() - new Date(lastRecoveryPoint.pointInTime).getTime()) / 60_000
          : Number.POSITIVE_INFINITY
      return {
        policy: item,
        lastRecoveryPoint,
        missedRpo: item.enabled && ageMinutes > item.expectedRpoMinutes,
        unverified: points.filter((candidate) => candidate.verificationState !== 'verified').length,
        destinationHealthy: destinations.get(item.destinationId)?.status === 'healthy',
      }
    })
  }
}
