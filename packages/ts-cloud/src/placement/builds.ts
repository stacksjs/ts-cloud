import type { JsonValue } from '../control-plane'
import type { PlacementRequirements, RemoteBuild } from './types'
import { DurableOperationQueue } from '../queue'
import { PlacementService } from './service'
import { PlacementStore } from './store'

export class RemoteBuildService {
  readonly queue: DurableOperationQueue
  constructor(
    readonly store: PlacementStore,
    readonly placement: PlacementService,
    queue?: DurableOperationQueue,
    private now: () => Date = () => new Date(),
  ) {
    this.queue = queue ?? new DurableOperationQueue(store.control)
  }
  enqueue(input: {
    projectId: string
    resourceId: string
    sourceSha: string
    buildSpec: JsonValue
    requirements?: Partial<PlacementRequirements>
  }): RemoteBuild {
    if (!/^[a-f0-9]{7,64}$/i.test(input.sourceSha)) throw new Error('A pinned source commit SHA is required.')
    const requirements: PlacementRequirements = {
      purpose: 'build',
      resources: { cpu: 1, memoryBytes: 1_073_741_824, diskBytes: 5_368_709_120 },
      leaseSeconds: 3600,
      ...input.requirements,
    }
    const placement = this.placement.place({ projectId: input.projectId, resourceId: input.resourceId, requirements })
    const tokenExpiresAt = new Date(this.now().getTime() + 15 * 60_000).toISOString()
    let build = this.store.createBuild({
      projectId: input.projectId,
      resourceId: input.resourceId,
      poolId: placement.poolId,
      placementId: placement.id,
      sourceSha: input.sourceSha,
      buildSpec: input.buildSpec,
      tokenExpiresAt,
    })
    const operation = this.queue.enqueue({
      projectId: input.projectId,
      resourceId: input.resourceId,
      kind: 'build.remote',
      input: { buildId: build.id },
      lockKey: `build:${build.id}`,
      providerKey: `pool:${placement.poolId}`,
      buildSlot: true,
      timeoutSeconds: 3600,
      cancellationMode: 'cooperative',
      resumePolicy: 'fail',
    }).operation
    build = this.store.updateBuild(build.id, { operationId: operation.id })
    return build
  }
  cancel(id: string): RemoteBuild {
    const build = this.store.getBuild(id)
    if (!build) throw new Error('Remote build was not found.')
    if (build.operationId) this.queue.requestCancellation(build.operationId)
    return this.store.updateBuild(id, { status: 'cancelled' })
  }
}
