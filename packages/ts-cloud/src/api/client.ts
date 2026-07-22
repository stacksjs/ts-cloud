import type { ApplicationArtifactRecord, ApplicationDraftRecord, RegistryConnection } from '../onboarding'
import type { QueueConcurrencyLimits } from '../queue'
import type { CreatePreviewDefinitionInput, PreviewDefinition, PreviewInstance } from '../preview'
import type { ComposeApplicationRecord, ComposeParseResult, ComposeServiceState, ComposeTemplate } from '../compose'
import type { ReleaseArtifact, ReleaseDeployableKind, ReleaseRecord, ReleaseStrategy, ReleaseStrategyCapability, ReleaseTransition } from '../release'
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

  listComposeTemplates(): Promise<ApiPage<ComposeTemplate>> { return this.request('/api/v1/compose-templates') }
  listComposeApplications(projectId: string, environmentId?: string): Promise<ApiPage<ComposeApplicationRecord & { services: ComposeServiceState[] }>> { return this.request(`/api/v1/compose-applications?${new URLSearchParams({ projectId, ...(environmentId ? { environmentId } : {}) })}`) }
  previewCompose(input: { source: string, name: string, slug?: string, projectId: string, environmentId: string }): Promise<{ result: ComposeParseResult, requestId: string }> { return this.request('/api/v1/compose-applications/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  createComposeApplication(input: { source?: string, templateId?: string, templateVersion?: string, inputs?: Record<string, string>, name: string, slug?: string, projectId: string, environmentId: string }): Promise<{ application: ComposeApplicationRecord, diagnostics: ComposeParseResult['diagnostics'], requestId: string }> { return this.request('/api/v1/compose-applications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  composeServices(applicationId: string): Promise<{ application: ComposeApplicationRecord, services: ComposeServiceState[], requestId: string }> { return this.request(`/api/v1/compose-applications/${encodeURIComponent(applicationId)}/services`) }
  composeAction(applicationId: string, action: 'deploy' | 'redeploy' | 'start' | 'stop' | 'scale' | 'delete', input: { service?: string, replicas?: number, removeVolumes?: boolean, confirm?: string } = {}): Promise<ApiOperationResponse> { return this.request(`/api/v1/compose-applications/${encodeURIComponent(applicationId)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  releaseCapabilities(kind: ReleaseDeployableKind, input: { health?: boolean, replicas?: number } = {}): Promise<{ capabilities: ReleaseStrategyCapability[], requestId: string }> { return this.request(`/api/v1/releases/capabilities?${new URLSearchParams({ kind, health: String(!!input.health), replicas: String(input.replicas ?? 1) })}`) }
  listReleases(projectId: string, input: { environmentId?: string, resourceId?: string } = {}): Promise<ApiPage<ReleaseRecord & { artifact: ReleaseArtifact, transitions: ReleaseTransition[] }>> { return this.request(`/api/v1/releases?${new URLSearchParams({ projectId, ...input })}`) }
  createReleaseArtifact(input: { digest: string, kind: ReleaseDeployableKind, uri: string, size: number, mediaType?: string, provenance?: unknown, attestation?: unknown }): Promise<{ artifact: ReleaseArtifact, requestId: string }> { return this.request('/api/v1/release-artifacts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  createRelease(input: { projectId: string, environmentId: string, resourceId: string, artifactId: string, kind: ReleaseDeployableKind, sourceSha?: string, config?: unknown, manifest?: unknown, strategy: ReleaseStrategy, healthGate?: unknown, approvalRequired?: boolean }): Promise<{ release: ReleaseRecord, requestId: string }> { return this.request('/api/v1/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  releaseAction(releaseId: string, action: 'promote' | 'approve' | 'activate' | 'rollback' | 'health' | 'pin', input: Record<string, unknown> = {}): Promise<Record<string, unknown>> { return this.request(`/api/v1/releases/${encodeURIComponent(releaseId)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }

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

  listPreviews(projectId?: string): Promise<ApiPage<PreviewInstance>> { return this.request(`/api/v1/previews${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`) }
  listPreviewDefinitions(projectId: string): Promise<ApiPage<PreviewDefinition>> { return this.request(`/api/v1/preview-definitions?projectId=${encodeURIComponent(projectId)}`) }
  createPreviewDefinition(input: CreatePreviewDefinitionInput): Promise<{ definition: PreviewDefinition, requestId: string }> { return this.request('/api/v1/preview-definitions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  createPreview(input: { definitionId: string, repository?: string, branch: string, pullRequestNumber?: number, fork?: boolean, commitSha: string }): Promise<{ preview: PreviewInstance, operation: ApiOperationResponse['operation'], requestId: string }> { return this.request('/api/v1/previews', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) }
  destroyPreview(previewId: string, confirm: string): Promise<{ operation: ApiOperationResponse['operation'], requestId: string }> { return this.request(`/api/v1/previews/${encodeURIComponent(previewId)}/destroy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm }) }) }
  extendPreview(previewId: string, hours: number): Promise<{ preview: PreviewInstance, requestId: string }> { return this.request(`/api/v1/previews/${encodeURIComponent(previewId)}/extend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hours }) }) }
  rebuildPreview(previewId: string): Promise<{ operation: ApiOperationResponse['operation'], requestId: string }> { return this.request(`/api/v1/previews/${encodeURIComponent(previewId)}/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) }
}
