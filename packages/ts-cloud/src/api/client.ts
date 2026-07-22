import type { ApiDeploymentRequest, ApiOperationResponse, ApiPage } from './types'

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
}
