import type { JsonValue } from '../control-plane'

export type ComposeDiagnosticSeverity = 'warning' | 'error'
export interface ComposeDiagnostic { severity: ComposeDiagnosticSeverity, path: string, code: string, message: string, alternative?: string }
export interface ComposePort { target: number, published?: number, protocol: 'tcp' | 'udp' }
export interface ComposeVolumeMount { source: string, target: string, readOnly: boolean }
export interface ComposeDependency { service: string, condition: 'service_started' | 'service_healthy' | 'service_completed_successfully' }
export interface ComposeHealthCheck { test: string[], intervalSeconds: number, timeoutSeconds: number, retries: number, startPeriodSeconds?: number }
export interface ComposeBuild { context: string, dockerfile: string, target?: string, args: Record<string, string | { secretRef: string }> }
export interface ComposeService {
  name: string
  image?: string
  build?: ComposeBuild
  command?: string[]
  entrypoint?: string[]
  environment: Record<string, string | { secretRef: string }>
  ports: ComposePort[]
  volumes: ComposeVolumeMount[]
  networks: string[]
  dependsOn: ComposeDependency[]
  healthCheck?: ComposeHealthCheck
  restart: 'no' | 'always' | 'on-failure' | 'unless-stopped'
  cpu?: number
  memoryMb?: number
  replicas: number
  domains: string[]
}

export interface ComposeApplicationManifest {
  apiVersion: 'ts-cloud.dev/v1'
  kind: 'ComposeApplication'
  metadata: { name: string, slug: string, projectId: string, environmentId: string }
  spec: { services: Record<string, ComposeService>, networks: string[], volumes: string[], dependencyOrder: string[] }
}

export interface ComposeParseResult {
  valid: boolean
  manifest: ComposeApplicationManifest
  diagnostics: ComposeDiagnostic[]
  redactedSource: string
  sourceHash: string
}

export interface ComposeApplicationRecord {
  id: string
  resourceId: string
  projectId: string
  environmentId: string
  name: string
  slug: string
  status: 'draft' | 'ready' | 'deploying' | 'running' | 'stopped' | 'degraded' | 'failed' | 'deleting' | 'deleted'
  sourceKind: 'compose' | 'template'
  sourceHash: string
  redactedSource: string
  manifest: ComposeApplicationManifest
  diagnostics: ComposeDiagnostic[]
  templateId?: string
  templateVersion?: string
  latestOperationId?: string
  createdByActorId?: string
  version: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface ComposeServiceState {
  applicationId: string
  serviceName: string
  status: 'pending' | 'starting' | 'running' | 'stopped' | 'unhealthy' | 'failed' | 'unknown'
  replicas: number
  healthyReplicas: number
  latestOperationId?: string
  observedState: JsonValue
  updatedAt: string
}

export interface ComposeTemplateInput { name: string, label: string, required: boolean, secret: boolean, default?: string, description?: string }
export interface ComposeTemplate {
  id: string
  name: string
  description: string
  category: string
  version: string
  source: string
  sourceVersion: string
  architecture: string
  minimumResources: { cpu: number, memoryMb: number }
  exposedServices: string[]
  maintenanceNotes: string
  lastVerifiedAt: string
  inputs: ComposeTemplateInput[]
  checksum: string
  builtin: boolean
}
