import type { ControlPlaneId, JsonValue } from '../control-plane'
import type { ApplicationDraftInput, ApplicationDraftRecord, ApplicationPlan, DetectionCandidate, DetectionFile, RegistryConnection } from '../onboarding'
import type { OperationLogEntry, OperationJob, QueueConcurrencyLimits } from '../queue'

export interface ApiErrorEnvelope {
  error: {
    code: string
    message: string
    requestId: string
    details?: JsonValue
  }
}

export interface ApiPage<T> {
  data: T[]
  page: { nextCursor?: string, hasMore: boolean }
  requestId: string
}

export interface ApiDeploymentRequest {
  projectId: ControlPlaneId
  environmentId: ControlPlaneId
  serviceId?: ControlPlaneId
  action?: 'deploy' | 'rollback'
  revision?: string
}

export interface ApiOperationResponse {
  operation: {
    id: ControlPlaneId
    state: string
    kind: string
    projectId?: ControlPlaneId
    environmentId?: ControlPlaneId
    resourceId?: ControlPlaneId
    correlationId: string
    createdAt: string
  }
  idempotentReplay: boolean
  requestId: string
}

export interface ApiApplicationDetectionRequest { files: DetectionFile[] }
export interface ApiApplicationDetectionResponse { candidates: DetectionCandidate[], requestId: string }
export interface ApiApplicationPlanRequest { draft: ApplicationDraftInput, suppliedSecretNames?: string[] }
export interface ApiApplicationPlanResponse { plan: ApplicationPlan, requestId: string }
export interface ApiApplicationDraftCreateRequest { projectId: ControlPlaneId, name?: string, draft: ApplicationDraftInput, step?: ApplicationDraftRecord['step'], suppliedSecretNames?: string[] }
export interface ApiApplicationDraftUpdateRequest { id: ControlPlaneId, version: number, draft: ApplicationDraftInput, step: ApplicationDraftRecord['step'], suppliedSecretNames?: string[] }
export interface ApiApplicationCreateRequest { draftId: ControlPlaneId, version: number, confirmEnvironment: string }
export interface ApiApplicationCreateResponse { resource: Record<string, unknown>, operation: ApiOperationResponse['operation'], plan: ApplicationPlan, idempotentReplay: boolean, requestId: string }
export interface ApiRegistryConnectionCreateRequest { provider: RegistryConnection['provider'], name: string, host: string, username?: string, password?: string, token?: string, credentialExpiresAt?: string }
export type ApiRegistryConnectionUpdateRequest =
  | { id: ControlPlaneId, action: 'test', image?: string }
  | { id: ControlPlaneId, action: 'rotate', username?: string, password?: string, token?: string, expiresAt?: string }

export type ApiQueueOperation = ApiOperationResponse['operation'] & { queue: OperationJob, approximatePosition?: { ahead: number, precision: 'bounded' } }
export interface ApiOperationLogsResponse { data: OperationLogEntry[], cursor: number, hasMore: boolean, requestId: string }
export interface ApiQueueSettingsResponse { concurrency: QueueConcurrencyLimits, requestId: string }
