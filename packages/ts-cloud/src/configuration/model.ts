import type { JsonValue } from '../control-plane'

export type ConfigurationScopeType = 'project' | 'environment' | 'service' | 'function' | 'preview'
export type ConfigurationKind = 'variable' | 'secret'
export type ConfigurationBackend = 'plaintext' | 'local_encrypted' | 'aws_secrets_manager' | 'aws_ssm' | 'external'

export interface ConfigurationScope {
  type: ConfigurationScopeType
  id: string
  environmentId?: string
  resourceId?: string
  previewId?: string
}

export interface ConfigurationEntry {
  id: string
  organizationId: string
  projectId: string
  scope: ConfigurationScope
  key: string
  kind: ConfigurationKind
  value?: string
  valueFingerprint: string
  secretRef?: string
  backend: ConfigurationBackend
  backendVersion?: string
  origin: 'managed' | 'config' | 'migrated'
  required: boolean
  metadata: Record<string, JsonValue>
  lastUsedAt?: string
  rotatedAt?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ConfigurationDependency {
  entryId: string
  resourceId: string
  injectionTarget: 'environment' | 'native_reference' | 'file'
  required: boolean
  requiresRedeploy: boolean
  lastDeployedVersion?: number
  createdAt: string
  updatedAt: string
}

export interface ConfigurationMutationResult {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: string[]
  affectedResourceIds: string[]
  versions: Record<string, number>
}
