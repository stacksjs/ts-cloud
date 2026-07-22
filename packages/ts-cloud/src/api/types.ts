import type { ControlPlaneId, JsonValue } from '../control-plane'

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
