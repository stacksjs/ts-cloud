import type { JsonValue } from '../control-plane'

export type ApplicationSource =
  | { kind: 'git', connectionId: string, repositoryId: string, repositoryFullName: string, ref: string, monorepoRoot?: string, includePaths?: string[], excludePaths?: string[], submodules?: boolean, sparsePaths?: string[] }
  | { kind: 'local', root: string }
  | { kind: 'artifact', artifactId: string, filename: string, sha256: string, size: number }
  | { kind: 'image', image: string, registryConnectionId?: string, digest?: string }

export type BuildStrategy =
  | { kind: 'dockerfile', context: string, dockerfile: string, target?: string, buildArgs?: Record<string, string>, secretNames?: string[] }
  | { kind: 'buildpack', runtime: 'bun' | 'node' | 'php', runtimeVersion?: string, installCommand?: string, buildCommand?: string, startCommand?: string, publishDirectory?: string }
  | { kind: 'static', publishDirectory: string, installCommand?: string, buildCommand?: string }
  | { kind: 'server', runtime: 'bun' | 'node' | 'php', runtimeVersion?: string, installCommand?: string, buildCommand?: string, startCommand: string }
  | { kind: 'serverless', runtime: 'bun' | 'node' | 'php', runtimeVersion?: string, handler?: string, packageRoot?: string }
  | { kind: 'prebuilt_image', image: string, registryConnectionId?: string, digest?: string }

export interface ApplicationRuntime {
  architecture: 'x86_64' | 'arm64'
  port?: number
  healthCheck?: { protocol: 'http' | 'https' | 'tcp', path?: string, intervalSeconds?: number, timeoutSeconds?: number }
  cpu?: number
  memoryMb?: number
  minInstances?: number
  maxInstances?: number
  target: 'server' | 'serverless' | 'container'
}

export interface ApplicationDraftInput {
  schemaVersion: 1
  name: string
  slug: string
  projectId: string
  environmentId: string
  source: ApplicationSource
  build: BuildStrategy
  runtime: ApplicationRuntime
  environment?: Record<string, string | { secretRef: string }>
  requiredSecretNames?: string[]
  domain?: { hostname: string, path?: string, tls?: boolean }
}

export interface DetectionFile { path: string, content?: string, size?: number }
export interface DetectionEvidence { path: string, reason: string, weight: number }
export interface DetectionCandidate {
  framework: 'bun' | 'node' | 'laravel' | 'php' | 'static' | 'dockerfile' | 'unknown'
  strategy: BuildStrategy['kind']
  confidence: number
  evidence: DetectionEvidence[]
  defaults: Partial<Pick<ApplicationDraftInput, 'build' | 'runtime'>>
  description: string
}

export interface ApplicationValidationIssue { path: string, code: string, message: string, alternatives?: string[] }

export interface ApplicationManifestV1 {
  apiVersion: 'ts-cloud.dev/v1'
  kind: 'Application'
  metadata: { name: string, slug: string, projectId: string, environmentId: string }
  spec: {
    source: ApplicationSource
    build: BuildStrategy
    runtime: ApplicationRuntime
    environment: Record<string, string | { secretRef: string }>
    domain?: ApplicationDraftInput['domain']
  }
}

export interface ApplicationPlan {
  valid: boolean
  issues: ApplicationValidationIssue[]
  missingSecrets: string[]
  manifest: ApplicationManifestV1
  configPatch: JsonValue
  capabilityRequirements: string[]
  costDrivers: string[]
  serializedManifest: string
}

export interface ApplicationDraftRecord {
  id: string
  organizationId: string
  projectId: string
  schemaVersion: number
  name: string
  step: 'source' | 'build' | 'runtime' | 'environment' | 'domain' | 'review'
  input: ApplicationDraftInput
  suppliedSecretNames: string[]
  status: 'draft' | 'ready' | 'applied'
  version: number
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}
