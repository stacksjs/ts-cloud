import type { JsonValue } from '../control-plane'

export type PoolPurpose = 'application' | 'build' | 'worker' | 'monitoring' | 'backup'
export type PoolBackend = 'server' | 'ecs' | 'asg'
export type CapacityVector = Record<'cpu' | 'memoryBytes' | 'diskBytes' | 'gpu', number>

export interface CapacityPool {
  id: string
  organizationId: string
  projectId: string
  name: string
  purpose: PoolPurpose
  backend: PoolBackend
  region?: string
  architecture?: string
  labels: Record<string, string>
  requiredServerLabels: Record<string, string>
  toleratedTaints: string[]
  capacity: CapacityVector
  reserved: Partial<CapacityVector>
  maxWorkloads: number
  costWeight: number
  spreadKey?: string
  concurrency: number
  ephemeralWorkspaces: boolean
  allowProductionSecrets: boolean
  status: 'active' | 'draining' | 'disabled'
  version: number
  createdAt: string
  updatedAt: string
}

export interface PlacementRequirements {
  purpose: PoolPurpose
  resources: Partial<CapacityVector>
  region?: string
  architecture?: string
  labels?: Record<string, string>
  stateful?: boolean
  autoReschedule?: boolean
  leaseSeconds?: number
}

export interface PlacementDecision {
  poolId: string
  poolName: string
  serverId?: string
  eligible: boolean
  reasons: string[]
  available: CapacityVector
  score: { fit: number, spread: number, cost: number }
}

export interface WorkloadPlacement {
  id: string
  projectId: string
  environmentId?: string
  resourceId: string
  releaseId?: string
  poolId: string
  serverId?: string
  purpose: PoolPurpose
  requirements: PlacementRequirements
  decision: PlacementDecision
  stateful: boolean
  autoReschedule: boolean
  status: 'reserved' | 'active' | 'moving' | 'blocked' | 'released' | 'failed'
  version: number
  createdAt: string
  updatedAt: string
}

export interface RemoteBuild {
  id: string
  projectId: string
  resourceId?: string
  poolId: string
  placementId?: string
  operationId?: string
  sourceSha: string
  buildSpec: JsonValue
  credentialPolicy: { productionSecrets: false, shortLivedTokenExpiresAt: string }
  workspace?: string
  cacheKey?: string
  artifactUri?: string
  artifactDigest?: string
  status: 'queued' | 'running' | 'uploading' | 'succeeded' | 'failed' | 'cancelled' | 'cleanup_required'
  cleanupAt?: string
  createdAt: string
  updatedAt: string
}

export interface RemoteBuildDriver {
  backend: PoolBackend
  run(input: { build: RemoteBuild, pool: CapacityPool, signal: AbortSignal, log(message: string): void }): Promise<{ artifactUri: string, artifactDigest: string, cacheKey?: string }>
  cleanup(input: { build: RemoteBuild, pool: CapacityPool }): Promise<void>
}
