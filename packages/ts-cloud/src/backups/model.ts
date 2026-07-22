import type { JsonValue } from '../control-plane'

export type BackupDestinationProvider = 'aws_s3' | 's3_compatible' | 'aws_backup'
export type BackupResourceKind =
  | 'managed_database'
  | 'logical_database'
  | 'volume'
  | 'files'
  | 'control_plane'
  | 'infrastructure'

export interface BackupDestination {
  id: string
  organizationId: string
  projectId: string
  name: string
  provider: BackupDestinationProvider
  endpoint?: string
  endpointPolicy: 'public_https' | 'allow_private'
  bucket?: string
  prefix: string
  region?: string
  forcePathStyle: boolean
  credentialRef?: string
  encryption: 'provider' | 'client_side' | 'both'
  encryptionKeyRef?: string
  immutability: { objectLock?: boolean; defaultRetentionDays?: number }
  status: 'untested' | 'healthy' | 'failing' | 'disabled'
  lastTestedAt?: string
  lastSuccessAt?: string
  lastFailureAt?: string
  lastError?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface BackupRetention {
  keepLast?: number
  hourly?: number
  daily?: number
  weekly?: number
  monthly?: number
  expireAfterDays?: number
}

export interface BackupPolicy {
  id: string
  organizationId: string
  projectId: string
  environmentId?: string
  resourceId?: string
  dataServiceId?: string
  destinationId: string
  name: string
  resourceKind: BackupResourceKind
  schedule: string
  timezone: string
  retention: BackupRetention
  compression: 'none' | 'gzip' | 'zstd'
  encryption: 'destination' | 'client_side' | 'both'
  includePatterns: string[]
  excludePatterns: string[]
  expectedRpoMinutes: number
  expectedRtoMinutes: number
  healthCheckId?: string
  enabled: boolean
  nextRunAt?: string
  lastRunAt?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface RecoveryPoint {
  id: string
  projectId: string
  policyId?: string
  destinationId: string
  resourceId?: string
  dataServiceId?: string
  backupJobId?: string
  kind: BackupResourceKind
  pointInTime: string
  uri: string
  sizeBytes: number
  checksum: string
  manifest: Record<string, JsonValue>
  toolVersion?: string
  engineVersion?: string
  expiresAt?: string
  lockedUntil?: string
  held: boolean
  pinned: boolean
  status: 'pending' | 'available' | 'failed' | 'deleting' | 'deleted'
  verificationState: 'unverified' | 'verifying' | 'verified' | 'corrupt' | 'failed'
  verifiedAt?: string
  durationMs?: number
  createdAt: string
  updatedAt: string
}

export interface BackupJob {
  id: string
  projectId: string
  policyId?: string
  recoveryPointId?: string
  operationId?: string
  kind: 'backup' | 'restore' | 'verify' | 'drill' | 'cleanup'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'cleanup_required'
  idempotencyKey: string
  target: Record<string, JsonValue>
  restoreMode?: 'isolated' | 'in_place'
  cancellability: 'safe' | 'checkpoint_only' | 'provider_uncancellable'
  safetyBackupId?: string
  healthResult?: Record<string, JsonValue>
  progress: Record<string, JsonValue>
  error?: string
  startedAt?: string
  finishedAt?: string
  createdAt: string
  updatedAt: string
}

export interface BackupCoverage {
  policy: BackupPolicy
  lastRecoveryPoint?: RecoveryPoint
  missedRpo: boolean
  unverified: number
  destinationHealthy: boolean
}
