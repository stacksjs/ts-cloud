import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext, QueueOperationHandler } from '../queue'
import type {
  BackupDestination,
  BackupJob,
  BackupPolicy,
  RecoveryPoint,
} from './model'
import type { StoredBackup } from './s3-destination'
import { createHash } from 'node:crypto'
import { DurableOperationQueue } from '../queue'
import { BackupStore } from './store'

export type BackupSourceResult =
  | {
      mode: 'object'
      key: string
      body: Uint8Array
      contentType?: string
      manifest: Record<string, JsonValue>
      toolVersion?: string
      engineVersion?: string
    }
  | {
      mode: 'external'
      uri: string
      checksum: string
      sizeBytes: number
      manifest: Record<string, JsonValue>
      toolVersion?: string
      engineVersion?: string
    }

export interface BackupSourceAdapter {
  create(
    policy: BackupPolicy,
    context: QueueExecutionContext,
  ): Promise<BackupSourceResult>
  verifyExternal?(
    point: RecoveryPoint,
    context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>>
  restore(
    point: RecoveryPoint,
    body: Uint8Array | undefined,
    target: Record<string, JsonValue>,
    context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>>
  cleanup?(
    target: Record<string, JsonValue>,
    context: QueueExecutionContext,
  ): Promise<void>
  deleteExternal?(
    point: RecoveryPoint,
    context: QueueExecutionContext,
  ): Promise<void>
}

export interface BackupDestinationAdapter {
  upload(
    destination: BackupDestination,
    input: {
      key: string
      body: Uint8Array
      contentType?: string
      checkpoint?: (value: Record<string, JsonValue>) => void
    },
  ): Promise<StoredBackup>
  download(
    destination: BackupDestination,
    stored: Pick<StoredBackup, 'key' | 'checksum' | 'manifest'>,
  ): Promise<Buffer>
  delete(destination: BackupDestination, key: string): Promise<void>
}

const digest = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

export class BackupCoordinator {
  constructor(
    readonly store: BackupStore,
    readonly queue: DurableOperationQueue,
    private readonly now: () => Date = () => new Date(),
  ) {}

  enqueueBackup(
    policy: BackupPolicy,
    scheduledFor: string = this.now().toISOString(),
    actorId?: string,
  ): BackupJob {
    if (!policy.enabled) throw new Error('Backup policy is disabled.')
    const job = this.store.createJob({
      projectId: policy.projectId,
      policyId: policy.id,
      kind: 'backup',
      status: 'queued',
      idempotencyKey: `backup:${policy.id}:${scheduledFor}`,
      target: { scheduledFor },
      cancellability: 'checkpoint_only',
      progress: { phase: 'queued' },
    })
    if (!job.operationId) {
      const queued = this.queue.enqueue({
        projectId: policy.projectId,
        environmentId: policy.environmentId,
        resourceId: policy.resourceId,
        actorId,
        kind: 'backup.run',
        input: { backupJobId: job.id },
        lockKey: `backup-target:${policy.dataServiceId ?? policy.resourceId}`,
        providerKey: 'backup',
        maxAttempts: 3,
        timeoutSeconds: 14_400,
        retryClasses: ['provider_transient'],
        resumePolicy: 'requeue',
      })
      return this.store.updateJob(job.id, { operationId: queued.operation.id })
    }
    return job
  }

  enqueueDue(at: Date = this.now()): BackupJob[] {
    return this.store.duePolicies(at).map((policy) => {
      const scheduledFor = policy.nextRunAt!
      this.store.advancePolicy(policy.id, scheduledFor)
      return this.enqueueBackup(policy, scheduledFor)
    })
  }

  enqueueVerification(point: RecoveryPoint): BackupJob {
    const job = this.store.createJob({
      projectId: point.projectId,
      policyId: point.policyId,
      recoveryPointId: point.id,
      kind: 'verify',
      status: 'queued',
      idempotencyKey: `verify:${point.id}:${point.checksum}`,
      target: {},
      cancellability: 'safe',
      progress: { phase: 'queued' },
    })
    if (!job.operationId) {
      const queued = this.queue.enqueue({
        projectId: point.projectId,
        resourceId: point.resourceId,
        kind: 'backup.verify',
        input: { backupJobId: job.id },
        lockKey: `recovery-point:${point.id}`,
        providerKey: 'backup',
        maxAttempts: 2,
        timeoutSeconds: 7200,
        retryClasses: ['provider_transient'],
        resumePolicy: 'requeue',
      })
      return this.store.updateJob(job.id, { operationId: queued.operation.id })
    }
    return job
  }

  planRestore(
    point: RecoveryPoint,
    input: {
      mode: 'isolated' | 'in_place'
      target: Record<string, JsonValue>
      targetName: string
      confirm?: string
      recentAuth?: boolean
      downtimeAcknowledged?: boolean
      safetyBackupId?: string
    },
  ): {
    point: RecoveryPoint
    mode: 'isolated' | 'in_place'
    target: Record<string, JsonValue>
    warnings: string[]
  } {
    if (point.status !== 'available')
      throw new Error('Only available recovery points can be restored.')
    if (point.verificationState !== 'verified')
      throw new Error('Restore requires a verified recovery point.')
    if (input.mode === 'in_place') {
      if (!input.recentAuth)
        throw new Error('In-place restore requires recent authentication.')
      if (input.confirm !== input.targetName)
        throw new Error(`Type ${input.targetName} to confirm in-place restore.`)
      if (!input.downtimeAcknowledged)
        throw new Error('In-place restore requires downtime acknowledgement.')
      const safety = input.safetyBackupId
        ? this.store.getRecoveryPoint(input.safetyBackupId)
        : undefined
      if (
        !safety ||
        safety.id === point.id ||
        safety.status !== 'available' ||
        safety.verificationState !== 'verified' ||
        safety.resourceId !== point.resourceId ||
        safety.dataServiceId !== point.dataServiceId
      )
        throw new Error(
          'In-place restore requires a distinct verified safety backup for the same target.',
        )
    }
    return {
      point,
      mode: input.mode,
      target: input.target,
      warnings:
        input.mode === 'in_place'
          ? [
              'The target is locked against deployments and backup work.',
              'Downtime and data replacement are expected.',
              'Provider cancellation may stop only at a checkpoint.',
            ]
          : [
              'An isolated target is created and health-validated before cleanup.',
            ],
    }
  }

  enqueueRestore(
    point: RecoveryPoint,
    input: Parameters<BackupCoordinator['planRestore']>[1] & {
      drill?: boolean
      actorId?: string
    },
  ): BackupJob {
    const plan = this.planRestore(point, input),
      kind = input.drill ? 'drill' : 'restore',
      key = digest(
        JSON.stringify({
          point: point.id,
          mode: input.mode,
          target: input.target,
          safety: input.safetyBackupId,
          drill: !!input.drill,
        }),
      ),
      job = this.store.createJob({
        projectId: point.projectId,
        policyId: point.policyId,
        recoveryPointId: point.id,
        kind,
        status: 'queued',
        idempotencyKey: `${kind}:${key}`,
        target: plan.target,
        restoreMode: plan.mode,
        cancellability: 'checkpoint_only',
        safetyBackupId: input.safetyBackupId,
        progress: { phase: 'queued', warnings: plan.warnings },
      })
    if (!job.operationId) {
      const queued = this.queue.enqueue({
        projectId: point.projectId,
        resourceId: point.resourceId,
        actorId: input.actorId,
        kind: input.drill ? 'backup.drill' : 'backup.restore',
        input: { backupJobId: job.id },
        lockKey: `backup-target:${point.dataServiceId ?? point.resourceId}`,
        providerKey: 'backup',
        maxAttempts: 1,
        timeoutSeconds: 14_400,
        retryClasses: [],
        resumePolicy: 'fail',
      })
      return this.store.updateJob(job.id, { operationId: queued.operation.id })
    }
    return job
  }

  enqueueRetention(at: Date = this.now()): BackupJob[] {
    return this.store.retentionCandidates(at).map((point) => {
      const job = this.store.createJob({
        projectId: point.projectId,
        policyId: point.policyId,
        recoveryPointId: point.id,
        kind: 'cleanup',
        status: 'queued',
        idempotencyKey: `cleanup:${point.id}:${point.expiresAt}`,
        target: {},
        cancellability: 'safe',
        progress: { phase: 'queued' },
      })
      if (!job.operationId) {
        const queued = this.queue.enqueue({
          projectId: point.projectId,
          resourceId: point.resourceId,
          kind: 'backup.cleanup',
          input: { backupJobId: job.id },
          lockKey: `recovery-point:${point.id}`,
          providerKey: 'backup',
          maxAttempts: 3,
          timeoutSeconds: 7200,
          retryClasses: ['provider_transient'],
          resumePolicy: 'requeue',
        })
        return this.store.updateJob(job.id, { operationId: queued.operation.id })
      }
      return job
    })
  }
}

export function createBackupQueueHandlers(input: {
  store: BackupStore
  queue: DurableOperationQueue
  resolveSource: (policy: BackupPolicy) => BackupSourceAdapter | undefined
  resolveDestination: (
    destination: BackupDestination,
  ) => BackupDestinationAdapter | undefined
  validateHealth?: (
    policy: BackupPolicy,
    target: Record<string, JsonValue>,
  ) => Promise<Record<string, JsonValue>>
  now?: () => Date
}): Record<string, QueueOperationHandler> {
  const now = input.now ?? (() => new Date()),
    coordinator = new BackupCoordinator(input.store, input.queue, now),
    resolve = (job: BackupJob) => {
      const point = job.recoveryPointId
          ? input.store.getRecoveryPoint(job.recoveryPointId)
          : undefined,
        policy = job.policyId
          ? input.store.getPolicy(job.policyId)
          : point?.policyId
            ? input.store.getPolicy(point.policyId)
            : undefined
      if (!policy) throw new Error('Backup policy was not found.')
      const destination = input.store.getDestination(
          point?.destinationId ?? policy.destinationId,
        ),
        source = input.resolveSource(policy)
      if (!destination) throw new Error('Backup destination was not found.')
      if (!source) throw new Error(`No ${policy.resourceKind} backup adapter is configured.`)
      return { point, policy, destination, source }
    },
    claimedJob = (context: QueueExecutionContext) => {
      const operationInput = context.operation.input as Record<
          string,
          JsonValue
        >,
        job = input.store.getJob(String(operationInput.backupJobId ?? ''))
      if (!job) throw new Error('Backup job was not found.')
      input.store.updateJob(job.id, {
        status: 'running',
        startedAt: job.startedAt ?? now().toISOString(),
        progress: { ...job.progress, phase: 'running' },
      })
      return job
    },
    fail = (job: BackupJob, error: unknown) => {
      input.store.updateJob(job.id, {
        status: 'failed',
        finishedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        progress: { ...job.progress, phase: 'failed' },
      })
    }
  return {
    'backup.run': async (context) => {
      const job = claimedJob(context)
      try {
        const { policy, destination, source } = resolve(job),
          result = await source.create(policy, context),
          destinationAdapter = input.resolveDestination(destination),
          stored =
            result.mode === 'object'
              ? await (async () => {
                  if (!destinationAdapter)
                    throw new Error('Backup destination adapter is not configured.')
                  return destinationAdapter.upload(destination, {
                    key: result.key,
                    body: result.body,
                    contentType: result.contentType,
                    checkpoint: (value) => {
                      context.checkpoint(
                        'uploading',
                        `Uploaded ${Number(value.bytesUploaded ?? 0)} backup bytes.`,
                      )
                      input.store.updateJob(job.id, {
                        progress: { phase: 'uploading', multipart: value },
                      })
                    },
                  })
                })()
              : {
                  uri: result.uri,
                  key: result.uri,
                  sizeBytes: result.sizeBytes,
                  checksum: result.checksum,
                  manifest: {
                    format: 'ts-cloud-backup-v1' as const,
                    encrypted: false,
                    plaintextChecksum: result.checksum,
                    storageChecksum: result.checksum,
                    contentType: 'application/provider-snapshot',
                  },
                },
          expiresAt = policy.retention.expireAfterDays
            ? new Date(
                now().getTime() +
                  policy.retention.expireAfterDays * 86_400_000,
              ).toISOString()
            : undefined,
          point = input.store.createRecoveryPoint({
            projectId: policy.projectId,
            policyId: policy.id,
            destinationId: destination.id,
            resourceId: policy.resourceId,
            dataServiceId: policy.dataServiceId,
            backupJobId: job.id,
            kind: policy.resourceKind,
            pointInTime: now().toISOString(),
            uri: stored.uri,
            sizeBytes: stored.sizeBytes,
            checksum: stored.checksum,
            manifest: {
              ...result.manifest,
              ...stored.manifest,
              storageKey: stored.key,
            },
            toolVersion: result.toolVersion,
            engineVersion: result.engineVersion,
            expiresAt,
            lockedUntil: destination.immutability.defaultRetentionDays
              ? new Date(
                  now().getTime() +
                    destination.immutability.defaultRetentionDays * 86_400_000,
                ).toISOString()
              : undefined,
            held: false,
            pinned: false,
            status: 'available',
            verificationState: 'unverified',
          })
        input.store.updateJob(job.id, {
          status: 'succeeded',
          recoveryPointId: point.id,
          finishedAt: now().toISOString(),
          progress: { phase: 'stored', recoveryPointId: point.id },
        })
        coordinator.enqueueVerification(point)
        return { backupJobId: job.id, recoveryPointId: point.id }
      } catch (error) {
        fail(job, error)
        throw error
      }
    },
    'backup.verify': async (context) => {
      const job = claimedJob(context)
      try {
        const { point, destination, source } = resolve(job)
        if (!point) throw new Error('Recovery point was not found.')
        input.store.updateRecoveryPoint(point.id, {
          verificationState: 'verifying',
        })
        let evidence: Record<string, JsonValue>
        if (point.uri.startsWith('s3:')) {
          const adapter = input.resolveDestination(destination)
          if (!adapter)
            throw new Error('Backup destination adapter is not configured.')
          const body = await adapter.download(destination, {
            key: String(point.manifest.storageKey ?? ''),
            checksum: point.checksum,
            manifest: point.manifest as StoredBackup['manifest'],
          })
          evidence = { bytes: body.length, checksum: point.checksum }
        } else if (source.verifyExternal)
          evidence = await source.verifyExternal(point, context)
        else
          throw new Error('External recovery point verification is not supported.')
        input.store.updateRecoveryPoint(point.id, {
          verificationState: 'verified',
          verifiedAt: now().toISOString(),
          manifest: { ...point.manifest, verification: evidence },
        })
        input.store.updateJob(job.id, {
          status: 'succeeded',
          finishedAt: now().toISOString(),
          progress: { phase: 'verified', evidence },
        })
        return { backupJobId: job.id, recoveryPointId: point.id, evidence }
      } catch (error) {
        if (job.recoveryPointId)
          input.store.updateRecoveryPoint(job.recoveryPointId, {
            verificationState: /checksum|corrupt|authentic/i.test(
              error instanceof Error ? error.message : String(error),
            )
              ? 'corrupt'
              : 'failed',
          })
        fail(job, error)
        throw error
      }
    },
    'backup.restore': async (context) => restore(context, false),
    'backup.drill': async (context) => restore(context, true),
    'backup.cleanup': async (context) => {
      const job = claimedJob(context)
      try {
        const { point, destination, source } = resolve(job)
        if (!point) throw new Error('Recovery point was not found.')
        if (!input.store.retentionCandidates(now()).some((item) => item.id === point.id))
          throw new Error('Recovery point is held, pinned, locked, or in active use.')
        input.store.updateRecoveryPoint(point.id, { status: 'deleting' })
        if (point.uri.startsWith('s3:')) {
          const adapter = input.resolveDestination(destination)
          if (!adapter) throw new Error('Destination cleanup is unavailable.')
          await adapter.delete(destination, String(point.manifest.storageKey ?? ''))
        } else if (source.deleteExternal)
          await source.deleteExternal(point, context)
        else throw new Error('External recovery point cleanup is unavailable.')
        input.store.updateRecoveryPoint(point.id, { status: 'deleted' })
        input.store.updateJob(job.id, { status: 'succeeded', finishedAt: now().toISOString(), progress: { phase: 'deleted' } })
        return { backupJobId: job.id, recoveryPointId: point.id, deleted: true }
      } catch (error) {
        fail(job, error)
        throw error
      }
    },
  }

  async function restore(
    context: QueueExecutionContext,
    drill: boolean,
  ): Promise<Record<string, JsonValue>> {
    const job = claimedJob(context)
    try {
      const { point, policy, destination, source } = resolve(job)
      if (!point) throw new Error('Recovery point was not found.')
      const destinationAdapter = point.uri.startsWith('s3:')
        ? input.resolveDestination(destination)
        : undefined
      const body = destinationAdapter
        ? await destinationAdapter.download(destination, {
            key: String(point.manifest.storageKey ?? ''),
            checksum: point.checksum,
            manifest: point.manifest as StoredBackup['manifest'],
          })
        : undefined
      const restored = await source.restore(point, body, job.target, context),
        health = input.validateHealth
          ? await input.validateHealth(policy, job.target)
          : { healthy: true, mode: 'adapter' }
      if (health.healthy !== true)
        throw new Error('Restored target did not pass its configured health check.')
      if (drill && source.cleanup)
        await source.cleanup(
          { ...job.target, provider: point.manifest.provider ?? null },
          context,
        )
      input.store.updateJob(job.id, {
        status: 'succeeded',
        finishedAt: now().toISOString(),
        healthResult: health,
        progress: { phase: drill ? 'drill_cleaned' : 'restored', restored },
      })
      return {
        backupJobId: job.id,
        recoveryPointId: point.id,
        restored,
        health,
        cleaned: drill,
      }
    } catch (error) {
      const resolved = (() => {
        try {
          return resolve(job)
        } catch {
          return undefined
        }
      })(),
        message = error instanceof Error ? error.message : String(error)
      let cleanupRequired = false
      if (drill && resolved?.source.cleanup) {
        try {
          await resolved.source.cleanup(
            {
              ...job.target,
              provider: resolved.point?.manifest.provider ?? null,
            },
            context,
          )
        } catch {
          cleanupRequired = true
        }
      }
      if (cleanupRequired)
        input.store.updateJob(job.id, {
          status: 'cleanup_required',
          finishedAt: now().toISOString(),
          error: message,
          progress: { ...job.progress, phase: 'cleanup_required' },
        })
      else fail(job, error)
      throw error
    }
  }
}
