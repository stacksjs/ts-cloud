import type { ControlPlaneOperation, ControlPlaneStore, JsonValue } from '../control-plane'
import type { ReleaseRecord } from './types'
import { DurableOperationQueue } from '../queue'
import { ReleaseStore } from './store'

export class ReleaseService {
  readonly releases: ReleaseStore
  readonly queue: DurableOperationQueue
  constructor(readonly controlPlane: ControlPlaneStore) {
    this.releases = new ReleaseStore(controlPlane)
    this.queue = new DurableOperationQueue(controlPlane)
  }
  enqueueActivation(
    release: ReleaseRecord,
    input: { actorId?: string; action?: 'activate' | 'rollback'; targetReleaseId?: string } = {},
  ): ControlPlaneOperation {
    const current = this.releases.get(release.id)
    if (!current) throw new Error('Release was not found')
    if (!['built', 'failed', 'rolled_back', 'superseded'].includes(current.status))
      throw new Error(`Release ${current.status} cannot be activated`)
    const action = input.action ?? 'activate'
    const operation = this.queue.enqueue({
      projectId: current.projectId,
      environmentId: current.environmentId,
      resourceId: current.resourceId,
      actorId: input.actorId,
      kind: `release.${action}`,
      idempotencyKey: `release:${current.id}:${action}:${current.rollbackAttempts}`,
      correlationId: `release:${current.id}`,
      input: { releaseId: current.id, targetReleaseId: input.targetReleaseId ?? null },
      lockKey: `resource:${current.resourceId}`,
      providerKey: this.controlPlane.getResource(current.resourceId)?.provider ?? 'default',
      maxAttempts: current.automaticRollback ? 2 : 1,
      retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 365,
    }).operation
    this.releases.transition(current.id, 'activating', {
      message: `${action} queued.`,
      operationId: operation.id,
      trafficPercent: 0,
    })
    return operation
  }
  completeHealthGate(
    releaseId: string,
    input: { healthy: boolean; operationId?: string; health?: JsonValue; message?: string },
  ): { release: ReleaseRecord; rollbackOperation?: ControlPlaneOperation } {
    const release = this.releases.get(releaseId)
    if (!release || release.status !== 'activating') throw new Error('Release is not activating')
    if (input.healthy)
      return {
        release: this.releases.transition(release.id, 'active', {
          message: input.message ?? 'Health gate passed; activation completed.',
          operationId: input.operationId,
          trafficPercent: 100,
          health: input.health,
        }),
      }
    const failed = this.releases.transition(release.id, 'failed', {
      message: input.message ?? 'Health gate failed.',
      operationId: input.operationId,
      trafficPercent: 0,
      health: input.health,
    })
    const previous = release.previousReleaseId ? this.releases.get(release.previousReleaseId) : undefined
    if (!release.automaticRollback || release.rollbackAttempts >= 1 || !previous) return { release: failed }
    const rollbackOperation = this.queue.enqueue({
      projectId: release.projectId,
      environmentId: release.environmentId,
      resourceId: release.resourceId,
      kind: 'release.rollback',
      idempotencyKey: `release:${release.id}:automatic-rollback`,
      correlationId: `release:${release.id}`,
      input: { releaseId: release.id, targetReleaseId: previous.id, automatic: true },
      lockKey: `resource:${release.resourceId}`,
      providerKey: this.controlPlane.getResource(release.resourceId)?.provider ?? 'default',
      maxAttempts: 1,
      retryClasses: [],
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 365,
    }).operation
    return { release: failed, rollbackOperation }
  }
  enqueueRollback(
    release: ReleaseRecord,
    input: { actorId?: string; targetReleaseId?: string } = {},
  ): ControlPlaneOperation {
    const current = this.releases.get(release.id)
    if (!current || current.status !== 'active') throw new Error('Only the active release can be rolled back')
    const target = input.targetReleaseId
      ? this.releases.get(input.targetReleaseId)
      : current.previousReleaseId
        ? this.releases.get(current.previousReleaseId)
        : undefined
    if (!target || target.resourceId !== current.resourceId || !['superseded', 'active'].includes(target.status))
      throw new Error('Rollback requires a preserved prior release for the same resource')
    return this.queue.enqueue({
      projectId: current.projectId,
      environmentId: current.environmentId,
      resourceId: current.resourceId,
      actorId: input.actorId,
      kind: 'release.rollback',
      idempotencyKey: `release:${current.id}:manual-rollback:${target.id}`,
      correlationId: `release:${current.id}`,
      input: { releaseId: current.id, targetReleaseId: target.id, automatic: false },
      lockKey: `resource:${current.resourceId}`,
      providerKey: this.controlPlane.getResource(current.resourceId)?.provider ?? 'default',
      maxAttempts: 1,
      retryClasses: [],
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 365,
    }).operation
  }
}
