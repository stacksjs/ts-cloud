import type { ApplicationArtifactRecord, ApplicationDraftRecord, RegistryConnection } from '../onboarding'
import type { QueueConcurrencyLimits } from '../queue'
import type { ApiApplicationCreateRequest, ApiApplicationCreateResponse, ApiApplicationDetectionRequest, ApiApplicationDetectionResponse, ApiApplicationDraftCreateRequest, ApiApplicationDraftUpdateRequest, ApiApplicationPlanRequest, ApiApplicationPlanResponse, ApiDeploymentRequest, ApiOperationLogsResponse, ApiOperationResponse, ApiPage, ApiQueueOperation, ApiQueueSettingsResponse, ApiRegistryConnectionCreateRequest, ApiRegistryConnectionUpdateRequest } from './types'

export interface TsCloudClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

export class TsCloudApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string) { super(message) }
}

export class TsCloudClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(private readonly options: TsCloudClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetchFn = options.fetch ?? fetch
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers: { accept: 'application/json', authorization: `Bearer ${this.options.token}`, ...init.headers } })
    const body = await response.json().catch(() => ({})) as any
    if (!response.ok)
      throw new TsCloudApiError(response.status, body.error?.code ?? 'api_error', body.error?.message ?? 'API request failed.', body.error?.requestId ?? response.headers.get('x-request-id') ?? undefined)
    return body as T
  }

  listProjects(options: { limit?: number, cursor?: string } = {}): Promise<ApiPage<Record<string, unknown>>> {
    return this.request(`/api/v1/projects?${new URLSearchParams(Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])))}`)
  }

  listEnvironments(projectId: string, options: { limit?: number, cursor?: string } = {}): Promise<ApiPage<Record<string, unknown>>> {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/environments?${new URLSearchParams(Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])))}`)
  }

  listServices(projectId: string, environmentId?: string): Promise<ApiPage<Record<string, unknown>>> {
    return this.request(`/api/v1/services?${new URLSearchParams({ projectId, ...(environmentId ? { environmentId } : {}) })}`)
  }

  listOperations(projectId?: string): Promise<ApiPage<Record<string, unknown>>> {
    return this.request(`/api/v1/operations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)
  }

  createDeployment(input: ApiDeploymentRequest, idempotencyKey: string): Promise<ApiOperationResponse> {
    return this.request('/api/v1/deployments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) })
  }

  detectApplication(input: ApiApplicationDetectionRequest): Promise<ApiApplicationDetectionResponse> {
    return this.request('/api/v1/application-detections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  planApplication(input: ApiApplicationPlanRequest): Promise<ApiApplicationPlanResponse> {
    return this.request('/api/v1/application-plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  listApplicationDrafts(projectId: string): Promise<ApiPage<ApplicationDraftRecord>> {
    return this.request(`/api/v1/application-drafts?projectId=${encodeURIComponent(projectId)}`)
  }

  createApplicationDraft(input: ApiApplicationDraftCreateRequest): Promise<{ draft: ApplicationDraftRecord, requestId: string }> {
    return this.request('/api/v1/application-drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  updateApplicationDraft(input: ApiApplicationDraftUpdateRequest): Promise<{ draft: ApplicationDraftRecord, requestId: string }> {
    return this.request('/api/v1/application-drafts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  createApplication(input: ApiApplicationCreateRequest, idempotencyKey: string): Promise<ApiApplicationCreateResponse> {
    return this.request('/api/v1/applications', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(input) })
  }

  uploadApplicationArtifact(projectId: string, filename: string, body: Blob | ArrayBuffer): Promise<{ artifact: ApplicationArtifactRecord, requestId: string }> {
    return this.request('/api/v1/application-artifacts', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-project-id': projectId, 'x-artifact-filename': filename }, body })
  }

  listRegistryConnections(): Promise<ApiPage<RegistryConnection>> {
    return this.request('/api/v1/registry-connections')
  }

  createRegistryConnection(input: ApiRegistryConnectionCreateRequest): Promise<{ registry: RegistryConnection, requestId: string }> {
    return this.request('/api/v1/registry-connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  updateRegistryConnection(input: ApiRegistryConnectionUpdateRequest): Promise<{ registry: RegistryConnection, requestId: string }> {
    return this.request('/api/v1/registry-connections', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  }

  disconnectRegistryConnection(id: string): Promise<{ registry: RegistryConnection, requestId: string }> {
    return this.request('/api/v1/registry-connections', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
  }

  listQueue(input: { projectId?: string, state?: string, limit?: number, cursor?: string } = {}): Promise<ApiPage<ApiQueueOperation>> {
    const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)] as [string, string]))
    return this.request(`/api/v1/queue?${query}`)
  }

  operationLogs(operationId: string, input: { after?: number, limit?: number } = {}): Promise<ApiOperationLogsResponse> {
    const query = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)] as [string, string]))
    return this.request(`/api/v1/operations/${encodeURIComponent(operationId)}/logs?${query}`)
  }

  streamOperationLogs(operationId: string, after = 0): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}/api/v1/operations/${encodeURIComponent(operationId)}/logs/stream`, { headers: { accept: 'text/event-stream', authorization: `Bearer ${this.options.token}`, 'last-event-id': String(after) } })
  }

  cancelOperation(operationId: string): Promise<{ operation: ApiOperationResponse['operation'], requestId: string }> {
    return this.request(`/api/v1/operations/${encodeURIComponent(operationId)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  }

  retryOperation(operationId: string, errorClass: string, delayMs = 0): Promise<{ operation: ApiOperationResponse['operation'], requestId: string }> {
    return this.request(`/api/v1/operations/${encodeURIComponent(operationId)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ errorClass, delayMs }) })
  }

  queueSettings(): Promise<ApiQueueSettingsResponse> { return this.request('/api/v1/queue/settings') }

  updateQueueSettings(concurrency: Partial<QueueConcurrencyLimits>): Promise<ApiQueueSettingsResponse> {
    return this.request('/api/v1/queue/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'update queue limits', concurrency }) })
  }
}
