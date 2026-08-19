import type { JsonValue } from '../control-plane'

export type RegionalOperationKind = 'rollout' | 'failover' | 'failback' | 'destroy' | 'reconcile'
export interface RegionalTarget {
  id: string
  topologyId: string
  region: string
  role: 'primary' | 'secondary'
  provider: string
  stackId?: string
  stackRevision?: string
  status: 'pending' | 'provisioning' | 'ready' | 'degraded' | 'failed' | 'deleting' | 'deleted'
  health: Record<string, JsonValue>
  lastHealthyAt?: string
  version: number
  createdAt: string
  updatedAt: string
}
export interface ReplicationChannel {
  id: string
  topologyId: string
  kind: 's3' | 'dynamodb' | 'secrets'
  sourceRegion: string
  targetRegion: string
  config: Record<string, JsonValue>
  status: 'pending' | 'configuring' | 'in_sync' | 'lagging' | 'failed' | 'disabled'
  checkpoint?: string
  lagSeconds?: number
  lastVerifiedAt?: string
  version: number
  createdAt: string
  updatedAt: string
}
export interface RegionalTrafficRoute {
  id: string
  topologyId: string
  hostname: string
  dnsProvider: string
  cdnEnabled: boolean
  wafEnabled: boolean
  weights: Record<string, number>
  desiredWeights: Record<string, number>
  status: 'pending' | 'applying' | 'in_sync' | 'failed' | 'drained'
  providerState: Record<string, JsonValue>
  version: number
  createdAt: string
  updatedAt: string
}
export interface RegionalTopology {
  id: string
  organizationId: string
  projectId: string
  environmentId?: string
  name: string
  hostname: string
  homeRegion: string
  regions: Array<{ region: string; role: 'primary' | 'secondary'; provider: string }>
  trafficPolicy: 'active_passive' | 'weighted' | 'latency'
  dataPolicy: { replicate: Array<'s3' | 'dynamodb' | 'secrets'>; maxLagSeconds: number; retainOnDestroy: boolean }
  status:
    | 'draft'
    | 'provisioning'
    | 'ready'
    | 'degraded'
    | 'failing_over'
    | 'failed_over'
    | 'failing_back'
    | 'destroying'
    | 'destroyed'
    | 'failed'
  activeRegion: string
  revision?: string
  version: number
  createdAt: string
  updatedAt: string
}
export interface RegionalExecution {
  id: string
  topologyId: string
  operationId?: string
  kind: RegionalOperationKind
  requestedRegion?: string
  revision?: string
  plan: string[]
  currentStep?: string
  completedSteps: string[]
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  error?: string
  createdAt: string
  updatedAt: string
}
export interface RegionalProviderDriver {
  provider: string
  applyStack(input: {
    target: RegionalTarget
    revision: string
    manifest: JsonValue
    signal: AbortSignal
  }): Promise<{ stackId: string }>
  deleteStack(input: { target: RegionalTarget; retainData: boolean; signal: AbortSignal }): Promise<void>
  health(input: { target: RegionalTarget }): Promise<{ healthy: boolean; evidence: Record<string, JsonValue> }>
  configureReplication(input: {
    channel: ReplicationChannel
    topology: RegionalTopology
  }): Promise<{ checkpoint: string; lagSeconds: number }>
  verifyReplication(input: {
    channel: ReplicationChannel
    topology: RegionalTopology
  }): Promise<{ healthy: boolean; checkpoint: string; lagSeconds: number }>
  applyTraffic(input: {
    route: RegionalTrafficRoute
    topology: RegionalTopology
    weights: Record<string, number>
  }): Promise<{ providerState: Record<string, JsonValue> }>
}
