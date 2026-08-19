import type { JsonValue } from '../control-plane'

export type ReleaseDeployableKind =
  'static' | 'compute' | 'serverless_zip' | 'serverless_image' | 'container' | 'compose'
export type ReleaseStrategy = 'atomic' | 'rolling' | 'blue_green' | 'canary'
export type ReleaseStatus =
  'built' | 'awaiting_approval' | 'activating' | 'active' | 'failed' | 'rolled_back' | 'superseded'
export interface ReleaseArtifact {
  id: string
  organizationId: string
  digest: string
  kind: ReleaseDeployableKind
  uri: string
  size: number
  mediaType: string
  provenance: JsonValue
  attestation: JsonValue
  verifiedAt: string
  createdAt: string
}
export interface ReleaseHealthGate {
  name?: string
  protocol: 'http' | 'https' | 'tcp' | 'provider'
  path?: string
  timeoutSeconds: number
  intervalSeconds: number
  healthyThreshold: number
  unhealthyThreshold: number
}
export interface ReleaseHookCompatibility {
  migrations: 'none' | 'backward_compatible' | 'forward_only' | 'irreversible'
  preActivate: string[]
  postActivate: string[]
  notes?: string
}
export interface ReleaseRecord {
  id: string
  organizationId: string
  projectId: string
  environmentId: string
  resourceId: string
  artifactId: string
  kind: ReleaseDeployableKind
  sourceSha?: string
  configHash: string
  manifest: JsonValue
  provenance: JsonValue
  strategy: ReleaseStrategy
  status: ReleaseStatus
  healthGate?: ReleaseHealthGate
  hooks: ReleaseHookCompatibility
  drainSeconds: number
  graceSeconds: number
  automaticRollback: boolean
  rollbackAttempts: number
  previousReleaseId?: string
  promotedFromReleaseId?: string
  actorId?: string
  trigger: string
  pinned: boolean
  pinReason?: string
  activatedAt?: string
  failedAt?: string
  createdAt: string
  updatedAt: string
}
export interface ReleaseTransition {
  sequence: number
  id: string
  releaseId: string
  fromStatus?: ReleaseStatus
  toStatus: ReleaseStatus
  trafficPercent?: number
  health: JsonValue
  message: string
  operationId?: string
  createdAt: string
}
export interface ReleaseApproval {
  id: string
  releaseId: string
  environmentId: string
  decision: 'approved' | 'rejected'
  actorId: string
  comment?: string
  createdAt: string
}
export interface ReleaseStrategyCapability {
  strategy: ReleaseStrategy
  supported: boolean
  explanation: string
  capacityMultiplier: number
  costImpact: 'none' | 'temporary' | 'sustained'
  rollback: string
}
export interface ReleaseCompare {
  artifactChanged: boolean
  sourceChanged: boolean
  configChanged: boolean
  manifestChanges: Array<{ path: string; before?: unknown; after?: unknown }>
  dataCaveat: string
}
