import type { ControlPlaneOperation, ControlPlaneStore } from '../control-plane'
import type { ComposeApplicationRecord } from './types'
import { DurableOperationQueue } from '../queue'
import { ComposeApplicationStore } from './store'

export type ComposeLifecycleAction = 'deploy' | 'redeploy' | 'start' | 'stop' | 'delete' | 'scale'
export class ComposeApplicationService {
  readonly applications: ComposeApplicationStore
  readonly queue: DurableOperationQueue
  constructor(readonly controlPlane: ControlPlaneStore) {
    this.applications = new ComposeApplicationStore(controlPlane)
    this.queue = new DurableOperationQueue(controlPlane)
  }
  enqueue(
    application: ComposeApplicationRecord,
    action: ComposeLifecycleAction,
    input: {
      actorId?: string
      service?: string
      replicas?: number
      removeVolumes?: boolean
      confirmation?: string
    } = {},
  ): ControlPlaneOperation {
    if (application.status === 'deleted') throw new Error('Deleted Compose applications cannot be operated')
    if (input.service && !application.manifest.spec.services[input.service])
      throw new Error(`Compose service ${input.service} was not found`)
    if (action === 'delete') {
      const expected = input.removeVolumes ? `${application.slug} delete volumes` : application.slug
      if (input.confirmation !== expected)
        throw new Error(
          `Type ${expected} to confirm ${input.removeVolumes ? 'persistent data removal' : 'stack deletion'}`,
        )
    }
    if (
      action === 'scale' &&
      (!input.service || !Number.isInteger(input.replicas) || input.replicas! < 0 || input.replicas! > 100)
    )
      throw new Error('Scale requires a service and 0-100 replicas')
    const operation = this.queue.enqueue({
      projectId: application.projectId,
      environmentId: application.environmentId,
      resourceId: application.resourceId,
      actorId: input.actorId,
      kind: `compose.${action}`,
      idempotencyKey: `compose:${application.id}:${action}:${input.service ?? 'stack'}:${input.replicas ?? ''}:${application.version}`,
      correlationId: `compose:${application.id}`,
      input: {
        applicationId: application.id,
        service: input.service ?? null,
        replicas: input.replicas ?? null,
        removeVolumes: !!input.removeVolumes,
      },
      lockKey: `compose:${application.id}`,
      providerKey: this.controlPlane.getResource(application.resourceId)?.provider ?? 'default',
      buildSlot: action === 'deploy' || action === 'redeploy',
      maxAttempts: 3,
      retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 90,
    }).operation
    this.applications.transition(
      application.id,
      action === 'delete'
        ? 'deleting'
        : action === 'stop'
          ? 'stopped'
          : action === 'start'
            ? 'deploying'
            : action === 'scale'
              ? application.status
              : 'deploying',
      { operationId: operation.id },
    )
    return operation
  }
}
