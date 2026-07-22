import type { JsonValue } from '../control-plane'

export type PreviewDatabaseStrategy = 'disabled' | 'isolated' | 'snapshot' | 'shared_read_only'
export type PreviewStatus =
  'queued' | 'deploying' | 'active' | 'updating' | 'destroying' | 'destroyed' | 'failed' | 'cleanup_failed'

export interface PreviewDefinition {
  id: string
  projectId: string
  resourceId: string
  baseEnvironmentId: string
  enabled: boolean
  branchRule?: string
  domainPattern: string
  ttlHours: number
  keepCount: number
  publicAccess: boolean
  authenticationRequired: boolean
  allowForks: boolean
  inheritedSecrets: string[]
  resourceOverrides: JsonValue
  databaseStrategy: PreviewDatabaseStrategy
  maxMonthlyCost: number
  maxCpu: number
  maxMemoryMb: number
  cleanupOnClose: boolean
  version: number
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export interface PreviewInstance {
  id: string
  definitionId: string
  projectId: string
  resourceId: string
  baseEnvironmentId: string
  identityKey: string
  sourceProvider?: string
  repository?: string
  branch: string
  pullRequestNumber?: number
  fork: boolean
  commitSha: string
  name: string
  stackName: string
  url?: string
  status: PreviewStatus
  expiresAt: string
  latestOperationId?: string
  createdByActorId?: string
  costEstimate?: number
  desiredState: JsonValue
  observedState: JsonValue
  teardownError?: string
  version: number
  createdAt: string
  updatedAt: string
  destroyedAt?: string
}

export interface PreviewResource {
  id: string
  previewId: string
  provider: string
  providerResourceId: string
  kind: string
  tags: Record<string, string>
  observedState: JsonValue
  discoveredAt: string
  deletedAt?: string
}

export interface CreatePreviewDefinitionInput {
  projectId: string
  resourceId: string
  baseEnvironmentId: string
  branchRule?: string
  domainPattern: string
  ttlHours?: number
  keepCount?: number
  publicAccess?: boolean
  authenticationRequired?: boolean
  allowForks?: boolean
  inheritedSecrets?: string[]
  resourceOverrides?: JsonValue
  databaseStrategy?: PreviewDatabaseStrategy
  maxMonthlyCost?: number
  maxCpu?: number
  maxMemoryMb?: number
  cleanupOnClose?: boolean
  createdByActorId?: string
}

export interface UpsertPreviewInput {
  definitionId: string
  sourceProvider?: string
  repository?: string
  branch: string
  pullRequestNumber?: number
  fork?: boolean
  commitSha: string
  createdByActorId?: string
  now?: Date
}
