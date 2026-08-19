import type { ControlPlaneOperation, ControlPlaneStore, JsonValue } from '../control-plane'
import type { PreviewInstance } from './types'
import { DurableOperationQueue } from '../queue'
import { PreviewEnvironmentStore } from './store'

export interface PreviewCleanupCandidate {
  preview: PreviewInstance
  reasons: string[]
}
export interface PreviewCleanupResult {
  candidates: PreviewCleanupCandidate[]
  operations: ControlPlaneOperation[]
  dryRun: boolean
}
export interface DiscoveredPreviewResource {
  provider: string
  providerResourceId: string
  kind: string
  tags: Record<string, string>
  observedState?: JsonValue
  estimatedMonthlyCost?: number
}

export class PreviewEnvironmentService {
  readonly previews: PreviewEnvironmentStore
  readonly queue: DurableOperationQueue
  constructor(readonly controlPlane: ControlPlaneStore) {
    this.previews = new PreviewEnvironmentStore(controlPlane)
    this.queue = new DurableOperationQueue(controlPlane)
  }

  enqueueDeploy(
    preview: PreviewInstance,
    input: { created?: boolean; actorId?: string; reason?: string } = {},
  ): ControlPlaneOperation {
    const kind = input.created ? 'preview.create' : 'preview.update'
    const nonce = input.reason === 'manual_rebuild' ? `:${crypto.randomUUID()}` : ''
    const operation = this.queue.enqueue({
      projectId: preview.projectId,
      environmentId: preview.baseEnvironmentId,
      resourceId: preview.resourceId,
      actorId: input.actorId,
      kind,
      correlationId: `preview:${preview.id}`,
      idempotencyKey: `preview:${preview.id}:${preview.commitSha}${nonce}`,
      input: {
        previewId: preview.id,
        reason: input.reason ?? (input.created ? 'create' : 'commit_update'),
        source: {
          repository: preview.repository ?? null,
          branch: preview.branch,
          commitSha: preview.commitSha,
          pullRequestNumber: preview.pullRequestNumber ?? null,
          fork: preview.fork,
        },
      },
      lockKey: `preview:${preview.id}`,
      providerKey: 'preview',
      buildSlot: true,
      maxAttempts: 3,
      retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 90,
    }).operation
    this.previews.transition(preview.id, 'queued', { operationId: operation.id })
    return operation
  }

  enqueueDestroy(preview: PreviewInstance, reason: string, actorId?: string): ControlPlaneOperation {
    if (preview.status === 'destroyed') throw new Error('Preview is already destroyed')
    const operation = this.queue.enqueue({
      projectId: preview.projectId,
      environmentId: preview.baseEnvironmentId,
      resourceId: preview.resourceId,
      actorId,
      kind: 'preview.destroy',
      correlationId: `preview:${preview.id}`,
      idempotencyKey: `preview:${preview.id}:destroy:${reason}`,
      input: { previewId: preview.id, reason },
      lockKey: `preview:${preview.id}`,
      providerKey: 'preview',
      maxAttempts: 3,
      retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 90,
    }).operation
    this.previews.transition(preview.id, 'queued', { operationId: operation.id })
    return operation
  }

  cleanup(
    input: { now?: Date; maxAgeHours?: number; keepCount?: number; dryRun?: boolean; actorId?: string } = {},
  ): PreviewCleanupResult {
    const now = input.now ?? new Date()
    const candidates = new Map<string, PreviewCleanupCandidate>()
    const active = this.previews.listInstances().filter((item) => !['destroyed', 'destroying'].includes(item.status))
    const add = (preview: PreviewInstance, reason: string) => {
      const found = candidates.get(preview.id) ?? { preview, reasons: [] }
      if (!found.reasons.includes(reason)) found.reasons.push(reason)
      candidates.set(preview.id, found)
    }
    for (const preview of active) {
      if (new Date(preview.expiresAt) <= now) add(preview, 'ttl_expired')
      if (input.maxAgeHours && now.getTime() - new Date(preview.createdAt).getTime() >= input.maxAgeHours * 3600000)
        add(preview, 'max_age')
    }
    const byDefinition = new Map<string, PreviewInstance[]>()
    for (const preview of active)
      byDefinition.set(preview.definitionId, [...(byDefinition.get(preview.definitionId) ?? []), preview])
    for (const [definitionId, values] of byDefinition) {
      const policy = this.previews.getDefinition(definitionId)
      const keep = input.keepCount ?? policy?.keepCount
      if (!keep) continue
      values
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(keep)
        .forEach((preview) => add(preview, 'keep_count'))
    }
    const selected = [...candidates.values()].sort((left, right) =>
      left.preview.createdAt.localeCompare(right.preview.createdAt),
    )
    const operations = input.dryRun
      ? []
      : selected.map((item) => this.enqueueDestroy(item.preview, item.reasons.sort().join('+'), input.actorId))
    if (selected.length)
      this.controlPlane.appendEvent({
        actorId: input.actorId,
        type: input.dryRun ? 'preview.cleanup.planned' : 'preview.cleanup.queued',
        payload: {
          previewIds: selected.map((item) => item.preview.id),
          reasons: Object.fromEntries(selected.map((item) => [item.preview.id, item.reasons])),
          dryRun: !!input.dryRun,
        },
      })
    return { candidates: selected, operations, dryRun: !!input.dryRun }
  }

  reconcile(discovered: DiscoveredPreviewResource[]): {
    matched: string[]
    unknownPreviewResources: string[]
    ignoredUntagged: string[]
  } {
    const matched: string[] = []
    const unknownPreviewResources: string[] = []
    const ignoredUntagged: string[] = []
    for (const found of discovered) {
      const previewId = found.tags['ts-cloud:preview']
      const projectId = found.tags['ts-cloud:project']
      const expiresAt = found.tags['ts-cloud:expires-at']
      if (!previewId || !projectId || !expiresAt) {
        ignoredUntagged.push(found.providerResourceId)
        continue
      }
      const preview = this.previews.getInstance(previewId)
      if (!preview || preview.projectId !== projectId || preview.expiresAt !== expiresAt) {
        unknownPreviewResources.push(found.providerResourceId)
        continue
      }
      this.previews.recordResource({ ...found, previewId: preview.id })
      if (found.estimatedMonthlyCost !== undefined)
        this.previews.transition(preview.id, preview.status, {
          costEstimate: found.estimatedMonthlyCost,
          observedState: {
            ...(preview.observedState as Record<string, JsonValue>),
            lastReconciledAt: new Date().toISOString(),
          },
        })
      matched.push(found.providerResourceId)
    }
    if (unknownPreviewResources.length)
      this.controlPlane.appendEvent({
        type: 'preview.reconciliation.leaks',
        level: 'error',
        payload: { providerResourceIds: unknownPreviewResources },
      })
    return { matched, unknownPreviewResources, ignoredUntagged }
  }
}
