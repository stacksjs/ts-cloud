import type { FleetServer, FleetStore } from '../fleet'
import type { CapacityPool, CapacityVector, PlacementDecision, PlacementRequirements, WorkloadPlacement } from './types'
import { capacity, PlacementStore } from './store'

const keys = ['cpu', 'memoryBytes', 'diskBytes', 'gpu'] as const
const matches = (actual: Record<string, string>, required: Record<string, string> = {}) =>
  Object.entries(required).every(([key, value]) => actual[key] === value)
const available = (total: CapacityVector, used: CapacityVector, reserved: Partial<CapacityVector>): CapacityVector =>
  Object.fromEntries(
    keys.map((key) => [key, Math.max(0, total[key] - used[key] - (reserved[key] ?? 0))]),
  ) as unknown as CapacityVector
const fits = (have: CapacityVector, want: Partial<CapacityVector>) => keys.every((key) => have[key] >= (want[key] ?? 0))
const fitScore = (have: CapacityVector, want: Partial<CapacityVector>) =>
  keys.reduce((score, key) => score + (want[key] ?? 0) / (have[key] || 1), 0)

export class PlacementService {
  constructor(
    readonly store: PlacementStore,
    readonly fleet: FleetStore,
  ) {}
  private poolCandidates(
    projectId: string,
    requirements: PlacementRequirements,
    excludePoolId?: string,
  ): PlacementDecision[] {
    const decisions: PlacementDecision[] = []
    for (const pool of this.store.listPools(projectId)) {
      if (pool.id === excludePoolId) continue
      const poolReasons: string[] = []
      if (pool.status !== 'active') poolReasons.push(`pool is ${pool.status}`)
      if (pool.purpose !== requirements.purpose) poolReasons.push(`purpose is ${pool.purpose}`)
      if (requirements.region && pool.region !== requirements.region)
        poolReasons.push(`region is ${pool.region ?? 'unset'}`)
      if (requirements.architecture && pool.architecture !== requirements.architecture)
        poolReasons.push(`architecture is ${pool.architecture ?? 'unset'}`)
      if (!matches(pool.labels, requirements.labels)) poolReasons.push('pool labels do not match')
      if (pool.backend === 'server') {
        const members = this.store.members(pool.id)
        if (!members.length)
          decisions.push(this.decision(pool, undefined, requirements, [...poolReasons, 'pool has no servers']))
        for (const member of members) {
          const server = this.fleet.get(member.serverId)
          const reasons = [...poolReasons]
          if (!server) reasons.push('server is missing')
          else this.serverReasons(pool, server, member.status, requirements, reasons)
          decisions.push(this.decision(pool, server, requirements, reasons, member.capacityOverride))
        }
      } else decisions.push(this.decision(pool, undefined, requirements, poolReasons))
    }
    return decisions.sort(
      (left, right) =>
        Number(right.eligible) - Number(left.eligible) ||
        left.score.cost - right.score.cost ||
        left.score.spread - right.score.spread ||
        left.score.fit - right.score.fit ||
        left.poolName.localeCompare(right.poolName) ||
        (left.serverId ?? '').localeCompare(right.serverId ?? ''),
    )
  }
  private serverReasons(
    pool: CapacityPool,
    server: FleetServer,
    memberStatus: string,
    requirements: PlacementRequirements,
    reasons: string[],
  ): void {
    if (memberStatus !== 'active') reasons.push(`member is ${memberStatus}`)
    if (server.status !== 'ready') reasons.push(`server is ${server.status}`)
    if (!server.roles.includes(requirements.purpose === 'build' ? 'build' : (requirements.purpose as any)))
      reasons.push(`server lacks ${requirements.purpose} role`)
    if (!matches(server.labels, pool.requiredServerLabels)) reasons.push('server labels do not match pool selector')
    for (const taint of server.taints)
      if (!pool.toleratedTaints.includes(taint)) reasons.push(`taint ${taint} is not tolerated`)
  }
  private decision(
    pool: CapacityPool,
    server: FleetServer | undefined,
    requirements: PlacementRequirements,
    reasons: string[],
    override: Partial<CapacityVector> = {},
  ): PlacementDecision {
    const serverCapacity = capacity({ ...server?.capacity, ...override }),
      total = server
        ? (Object.fromEntries(
            keys.map((key) => [key, Math.min(pool.capacity[key], serverCapacity[key])]),
          ) as unknown as CapacityVector)
        : pool.capacity,
      usage = this.store.activeUsage(pool.id, server?.id),
      free = available(total, usage.resources, pool.reserved)
    if (usage.count >= pool.maxWorkloads) reasons.push('workload limit reached')
    if (requirements.purpose === 'build' && usage.count >= pool.concurrency) reasons.push('build concurrency reached')
    if (!fits(free, requirements.resources)) reasons.push('insufficient capacity')
    return {
      poolId: pool.id,
      poolName: pool.name,
      serverId: server?.id,
      eligible: reasons.length === 0,
      reasons,
      available: free,
      score: { fit: fitScore(free, requirements.resources), spread: usage.count, cost: pool.costWeight },
    }
  }
  explain(projectId: string, requirements: PlacementRequirements): PlacementDecision[] {
    return this.poolCandidates(projectId, requirements)
  }
  place(input: {
    projectId: string
    environmentId?: string
    resourceId: string
    releaseId?: string
    requirements: PlacementRequirements
  }): WorkloadPlacement {
    return this.store.control.transaction(() => {
      const decision = this.poolCandidates(input.projectId, input.requirements).find((item) => item.eligible)
      if (!decision)
        throw new Error(
          `No eligible capacity: ${this.explain(input.projectId, input.requirements)
            .flatMap((item) => item.reasons)
            .join('; ')}`,
        )
      return this.store.reserve({ ...input, decision })
    })
  }
  activate(id: string): WorkloadPlacement {
    return this.store.transitionPlacement(id, 'active')
  }
  release(id: string): WorkloadPlacement {
    return this.store.transitionPlacement(id, 'released')
  }
  drainPool(id: string): { pool: CapacityPool; moved: WorkloadPlacement[]; blocked: WorkloadPlacement[] } {
    const pool = this.store.updatePool(id, { status: 'draining' }),
      moved: WorkloadPlacement[] = [],
      blocked: WorkloadPlacement[] = []
    for (const current of this.store
      .listPlacements(pool.projectId, ['reserved', 'active'])
      .filter((item) => item.poolId === id)) {
      if (current.stateful) {
        blocked.push(this.store.transitionPlacement(current.id, 'blocked'))
        continue
      }
      this.store.transitionPlacement(current.id, 'moving')
      const next = this.place({
        projectId: current.projectId,
        environmentId: current.environmentId,
        resourceId: current.resourceId,
        releaseId: current.releaseId,
        requirements: current.requirements,
      })
      moved.push(this.activate(next.id))
      this.store.transitionPlacement(current.id, 'released')
    }
    return { pool, moved, blocked }
  }
  drainServer(poolId: string, serverId: string): { moved: WorkloadPlacement[]; blocked: WorkloadPlacement[] } {
    this.store.memberStatus(poolId, serverId, 'draining')
    const pool = this.store.getPool(poolId)
    if (!pool) throw new Error('Capacity pool was not found.')
    const moved: WorkloadPlacement[] = [],
      blocked: WorkloadPlacement[] = []
    for (const current of this.store
      .listPlacements(pool.projectId, ['reserved', 'active'])
      .filter((item) => item.poolId === poolId && item.serverId === serverId)) {
      if (current.stateful) {
        blocked.push(this.store.transitionPlacement(current.id, 'blocked'))
        continue
      }
      this.store.transitionPlacement(current.id, 'moving')
      const decision = this.poolCandidates(current.projectId, current.requirements).find((item) => item.eligible)
      if (!decision) {
        blocked.push(this.store.transitionPlacement(current.id, 'blocked'))
        continue
      }
      const next = this.store.reserve({
        projectId: current.projectId,
        environmentId: current.environmentId,
        resourceId: current.resourceId,
        releaseId: current.releaseId,
        requirements: current.requirements,
        decision,
      })
      moved.push(this.activate(next.id))
      this.store.transitionPlacement(current.id, 'released')
    }
    return { moved, blocked }
  }
  reconcileFailure(serverId: string): { rescheduled: WorkloadPlacement[]; blocked: WorkloadPlacement[] } {
    const server = this.fleet.get(serverId)
    if (!server) throw new Error('Server was not found.')
    const rescheduled: WorkloadPlacement[] = [],
      blocked: WorkloadPlacement[] = []
    for (const current of this.store
      .listPlacements(server.projectId, ['active'])
      .filter((item) => item.serverId === serverId)) {
      if (current.stateful || !current.autoReschedule) {
        blocked.push(this.store.transitionPlacement(current.id, 'blocked'))
        continue
      }
      this.store.transitionPlacement(current.id, 'failed')
      const next = this.place({
        projectId: current.projectId,
        environmentId: current.environmentId,
        resourceId: current.resourceId,
        releaseId: current.releaseId,
        requirements: current.requirements,
      })
      rescheduled.push(this.activate(next.id))
    }
    return { rescheduled, blocked }
  }
}
