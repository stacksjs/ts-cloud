import type { SourceCapabilities, SourceConnection, SourceConnectionTest, SourceCredential, SourceProvider, SourceProviderAdapter, SourceRefPage, SourceRepositoryPage, SourceWebhookRegistration } from './types'
import { createSign } from 'node:crypto'

export class SourceProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message)
    this.name = 'SourceProviderError'
  }
}

export interface SourceAdapterOptions {
  fetch?: SourceFetch
  timeoutMs?: number
  now?: () => Date
}

export type SourceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const HOSTED_CAPABILITIES: SourceCapabilities = { repositories: true, branches: true, tags: true, webhooks: true, pullRequests: true, tokenRefresh: true, deployKeys: true }

function integerCursor(value: string | undefined): number {
  const page = Number(value ?? '1')
  return Number.isInteger(page) && page > 0 ? page : 1
}

function limit(value: number | undefined): number {
  return Math.max(1, Math.min(100, value ?? 50))
}

function repositoryName(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized))
    throw new Error('Repository must use owner/name format')
  return normalized
}

function webhookUrl(value: string): string {
  const parsed = new URL(value)
  if (parsed.username || parsed.password || parsed.protocol !== 'https:')
    throw new Error('Webhook endpoint must be credential-free HTTPS')
  return parsed.href
}

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function githubAppJwt(credential: SourceCredential, now: Date): string {
  if (!credential.appId || !credential.privateKey)
    throw new Error('GitHub App credentials require appId and privateKey')
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const issuedAt = Math.floor(now.getTime() / 1000) - 30
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: credential.appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  signer.end()
  return `${header}.${payload}.${signer.sign(credential.privateKey).toString('base64url')}`
}

abstract class HostedSourceAdapter implements SourceProviderAdapter {
  abstract readonly provider: SourceProvider
  readonly capabilities: SourceCapabilities = HOSTED_CAPABILITIES
  protected readonly fetchFn: SourceFetch
  protected readonly timeoutMs: number
  protected readonly nowFn: () => Date

  constructor(protected readonly connection: SourceConnection, protected readonly credential: SourceCredential | undefined, options: SourceAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 20_000)
    this.nowFn = options.now ?? (() => new Date())
  }

  protected abstract apiRoot(): string
  protected abstract authorization(): Promise<Record<string, string>>

  protected async request<T>(path: string, init: RequestInit = {}): Promise<{ data: T, headers: Headers }> {
    const root = new URL(`${this.apiRoot().replace(/\/$/, '')}/`)
    const url = new URL(path.replace(/^\//, ''), root)
    if (url.origin !== root.origin)
      throw new Error('Provider pagination cannot leave the configured host')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchFn(url, { ...init, redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'ts-cloud-source/1', ...(await this.authorization()), ...init.headers } })
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '')
        const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-github-request-id')
        throw new SourceProviderError(`Source provider request failed (${response.status})${requestId ? ` [request ${requestId}]` : ''}`, response.status, Number.isFinite(retryAfter) ? retryAfter : undefined)
      }
      if (response.status === 204)
        return { data: undefined as T, headers: response.headers }
      return { data: await response.json() as T, headers: response.headers }
    }
    catch (error) {
      if (error instanceof SourceProviderError) throw error
      if (controller.signal.aborted) throw new SourceProviderError(`Source provider request exceeded ${this.timeoutMs}ms`)
      throw new SourceProviderError(error instanceof Error ? error.message.replace(/(?:token|password|secret)=[^\s&]+/gi, '$1=[REDACTED]') : 'Source provider request failed')
    }
    finally { clearTimeout(timer) }
  }

  abstract testConnection(): Promise<SourceConnectionTest>
  abstract listRepositories(input?: { cursor?: string, search?: string, limit?: number }): Promise<SourceRepositoryPage>
  abstract listBranches(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage>
  abstract listTags(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage>
  abstract createWebhook(repository: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration>
  abstract listWebhooks(repository: string): Promise<SourceWebhookRegistration[]>
  abstract updateWebhook(repository: string, webhookId: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration>
  async deleteWebhook(repository: string, webhookId: string): Promise<void> { await this.request(this.webhookPath(repository, webhookId), { method: 'DELETE' }) }
  protected abstract webhookPath(repository: string, webhookId?: string): string
}

interface GithubRepo { id: number, full_name: string, clone_url: string, default_branch: string, visibility?: string, private?: boolean, archived?: boolean }
interface GithubRef { name: string, commit: { sha: string }, protected?: boolean }
interface GithubHook { id: number, active: boolean, events: string[], config: { url?: string } }

export class GithubSourceAdapter extends HostedSourceAdapter {
  readonly provider = 'github' as const
  private installationToken?: { value: string, expiresAt: number }
  protected apiRoot(): string { return this.connection.host === 'https://github.com' ? 'https://api.github.com' : `${this.connection.host}/api/v3` }
  protected async authorization(): Promise<Record<string, string>> {
    if (this.credential?.token) return { Authorization: `Bearer ${this.credential.token}`, 'X-GitHub-Api-Version': '2022-11-28' }
    if (!this.credential?.installationId) return {}
    if (!this.installationToken || this.installationToken.expiresAt < this.nowFn().getTime() + 60_000) {
      const jwt = githubAppJwt(this.credential, this.nowFn())
      const root = this.apiRoot().replace(/\/$/, '')
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchFn(`${root}/app/installations/${encodeURIComponent(this.credential.installationId)}/access_tokens`, { method: 'POST', signal: controller.signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ts-cloud-source/1' } })
        if (!response.ok) throw new SourceProviderError(`GitHub App token refresh failed (${response.status})`, response.status)
        const token = await response.json() as { token: string, expires_at: string }
        this.installationToken = { value: token.token, expiresAt: new Date(token.expires_at).getTime() }
      }
      finally { clearTimeout(timer) }
    }
    return { Authorization: `Bearer ${this.installationToken.value}`, 'X-GitHub-Api-Version': '2022-11-28' }
  }
  async testConnection(): Promise<SourceConnectionTest> {
    const endpoint = this.credential?.installationId ? '/installation/repositories?per_page=1' : '/user'
    const { data, headers } = await this.request<any>(endpoint)
    return { ok: true, account: data.login ?? this.connection.owner, scopes: (headers.get('x-oauth-scopes') ?? this.connection.grantedScopes.join(',')).split(',').map(value => value.trim()).filter(Boolean), message: 'GitHub connection is healthy' }
  }
  async listRepositories(input: { cursor?: string, search?: string, limit?: number } = {}): Promise<SourceRepositoryPage> {
    const perPage = limit(input.limit); const page = integerCursor(input.cursor)
    const path = this.credential?.installationId ? `/installation/repositories?per_page=${perPage}&page=${page}` : `/user/repos?per_page=${perPage}&page=${page}&sort=updated`
    const { data } = await this.request<GithubRepo[] | { repositories: GithubRepo[] }>(path)
    const repos = Array.isArray(data) ? data : data.repositories
    const filtered = input.search ? repos.filter(repo => repo.full_name.toLowerCase().includes(input.search!.toLowerCase())) : repos
    return { repositories: filtered.map(repo => ({ providerRepositoryId: String(repo.id), fullName: repo.full_name, cloneUrl: repo.clone_url, defaultBranch: repo.default_branch || 'main', visibility: (repo.visibility ?? (repo.private ? 'private' : 'public')) as any, archived: !!repo.archived, metadata: {} })), nextCursor: repos.length === perPage ? String(page + 1) : undefined }
  }
  private async refs(repository: string, kind: 'branches' | 'tags', input: { cursor?: string, limit?: number } = {}): Promise<SourceRefPage> {
    const perPage = limit(input.limit); const page = integerCursor(input.cursor)
    const { data } = await this.request<GithubRef[]>(`/repos/${repositoryName(repository)}/${kind}?per_page=${perPage}&page=${page}`)
    return { refs: data.map(ref => ({ name: ref.name, commitSha: ref.commit.sha, protected: ref.protected })), nextCursor: data.length === perPage ? String(page + 1) : undefined }
  }
  listBranches(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'branches', input) }
  listTags(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'tags', input) }
  protected webhookPath(repository: string, webhookId?: string): string { return `/repos/${repositoryName(repository)}/hooks${webhookId ? `/${encodeURIComponent(webhookId)}` : ''}` }
  private hook(value: GithubHook): SourceWebhookRegistration { return { providerWebhookId: String(value.id), active: value.active, events: value.events, url: value.config.url ?? '' } }
  async createWebhook(repository: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<GithubHook>(this.webhookPath(repository), { method: 'POST', body: JSON.stringify({ name: 'web', active: true, events: input.events, config: { url: webhookUrl(input.url), content_type: 'json', secret: input.secret, insecure_ssl: '0' } }), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
  async listWebhooks(repository: string): Promise<SourceWebhookRegistration[]> { const { data } = await this.request<GithubHook[]>(this.webhookPath(repository)); return data.map(value => this.hook(value)) }
  async updateWebhook(repository: string, webhookId: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<GithubHook>(this.webhookPath(repository, webhookId), { method: 'PATCH', body: JSON.stringify({ active: true, events: input.events, config: { url: webhookUrl(input.url), content_type: 'json', secret: input.secret, insecure_ssl: '0' } }), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
}

interface GitlabRepo { id: number, path_with_namespace: string, http_url_to_repo: string, default_branch?: string, visibility?: string, archived?: boolean }
interface GitlabRef { name: string, commit: { id: string }, protected?: boolean }
interface GitlabHook { id: number, url: string, push_events?: boolean, merge_requests_events?: boolean }

export class GitlabSourceAdapter extends HostedSourceAdapter {
  readonly provider = 'gitlab' as const
  protected apiRoot(): string { return `${this.connection.host}/api/v4` }
  protected async authorization(): Promise<Record<string, string>> { return this.credential?.token ? { 'PRIVATE-TOKEN': this.credential.token } : {} }
  async testConnection(): Promise<SourceConnectionTest> { const { data } = await this.request<{ username?: string }>('/user'); return { ok: true, account: data.username, scopes: this.connection.grantedScopes, message: 'GitLab connection is healthy' } }
  async listRepositories(input: { cursor?: string, search?: string, limit?: number } = {}): Promise<SourceRepositoryPage> { const perPage = limit(input.limit); const page = integerCursor(input.cursor); const search = input.search ? `&search=${encodeURIComponent(input.search)}` : ''; const { data, headers } = await this.request<GitlabRepo[]>(`/projects?membership=true&simple=true&order_by=last_activity_at&per_page=${perPage}&page=${page}${search}`); return { repositories: data.map(repo => ({ providerRepositoryId: String(repo.id), fullName: repo.path_with_namespace, cloneUrl: repo.http_url_to_repo, defaultBranch: repo.default_branch ?? 'main', visibility: (repo.visibility ?? 'unknown') as any, archived: !!repo.archived, metadata: {} })), nextCursor: headers.get('x-next-page') || undefined } }
  private async refs(repository: string, kind: 'branches' | 'tags', input: { cursor?: string, limit?: number } = {}): Promise<SourceRefPage> { const perPage = limit(input.limit); const page = integerCursor(input.cursor); const { data, headers } = await this.request<GitlabRef[]>(`/projects/${encodeURIComponent(repositoryName(repository))}/repository/${kind}?per_page=${perPage}&page=${page}`); return { refs: data.map(ref => ({ name: ref.name, commitSha: ref.commit.id, protected: ref.protected })), nextCursor: headers.get('x-next-page') || undefined } }
  listBranches(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'branches', input) }
  listTags(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'tags', input) }
  protected webhookPath(repository: string, webhookId?: string): string { return `/projects/${encodeURIComponent(repositoryName(repository))}/hooks${webhookId ? `/${encodeURIComponent(webhookId)}` : ''}` }
  private hook(value: GitlabHook): SourceWebhookRegistration { return { providerWebhookId: String(value.id), active: true, events: [...(value.push_events ? ['push'] : []), ...(value.merge_requests_events ? ['pull_request'] : [])], url: value.url } }
  private body(input: { url: string, secret: string, events: string[] }): string { return JSON.stringify({ url: webhookUrl(input.url), token: input.secret, enable_ssl_verification: true, push_events: input.events.includes('push'), merge_requests_events: input.events.includes('pull_request') }) }
  async createWebhook(repository: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<GitlabHook>(this.webhookPath(repository), { method: 'POST', body: this.body(input), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
  async listWebhooks(repository: string): Promise<SourceWebhookRegistration[]> { const { data } = await this.request<GitlabHook[]>(this.webhookPath(repository)); return data.map(value => this.hook(value)) }
  async updateWebhook(repository: string, webhookId: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<GitlabHook>(this.webhookPath(repository, webhookId), { method: 'PUT', body: this.body(input), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
}

interface BitbucketRepo { uuid: string, full_name: string, links: { clone: Array<{ name: string, href: string }> }, mainbranch?: { name: string }, is_private?: boolean }
interface BitbucketRef { name: string, target: { hash: string } }
interface BitbucketPage<T> { values: T[], next?: string }
interface BitbucketHook { uuid: string, active: boolean, events: string[], url: string }

export class BitbucketSourceAdapter extends HostedSourceAdapter {
  readonly provider = 'bitbucket' as const
  protected apiRoot(): string { return this.connection.host === 'https://bitbucket.org' ? 'https://api.bitbucket.org/2.0' : `${this.connection.host}/2.0` }
  protected async authorization(): Promise<Record<string, string>> { return this.credential?.token ? { Authorization: `Bearer ${this.credential.token}` } : {} }
  async testConnection(): Promise<SourceConnectionTest> { const { data } = await this.request<{ username?: string, display_name?: string }>('/user'); return { ok: true, account: data.username ?? data.display_name, scopes: this.connection.grantedScopes, message: 'Bitbucket connection is healthy' } }
  async listRepositories(input: { cursor?: string, search?: string, limit?: number } = {}): Promise<SourceRepositoryPage> { if (!this.connection.owner) throw new Error('Bitbucket repository discovery requires an owner/workspace'); const page = integerCursor(input.cursor); const perPage = limit(input.limit); const search = input.search ? `&q=name~%22${encodeURIComponent(input.search)}%22` : ''; const { data } = await this.request<BitbucketPage<BitbucketRepo>>(`/repositories/${encodeURIComponent(this.connection.owner)}?pagelen=${perPage}&page=${page}${search}`); return { repositories: data.values.map(repo => ({ providerRepositoryId: repo.uuid, fullName: repo.full_name, cloneUrl: repo.links.clone.find(link => link.name === 'https')?.href ?? repo.links.clone[0]?.href ?? '', defaultBranch: repo.mainbranch?.name ?? 'main', visibility: repo.is_private ? 'private' : 'public', archived: false, metadata: {} })), nextCursor: data.next ? String(page + 1) : undefined } }
  private async refs(repository: string, kind: 'branches' | 'tags', input: { cursor?: string, limit?: number } = {}): Promise<SourceRefPage> { const page = integerCursor(input.cursor); const perPage = limit(input.limit); const { data } = await this.request<BitbucketPage<BitbucketRef>>(`/repositories/${repositoryName(repository)}/refs/${kind}?pagelen=${perPage}&page=${page}`); return { refs: data.values.map(ref => ({ name: ref.name, commitSha: ref.target.hash })), nextCursor: data.next ? String(page + 1) : undefined } }
  listBranches(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'branches', input) }
  listTags(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'tags', input) }
  protected webhookPath(repository: string, webhookId?: string): string { return `/repositories/${repositoryName(repository)}/hooks${webhookId ? `/${encodeURIComponent(webhookId)}` : ''}` }
  private hook(value: BitbucketHook): SourceWebhookRegistration { return { providerWebhookId: value.uuid, active: value.active, events: value.events.map(event => event.replace('repo:push', 'push').replace('pullrequest:', 'pull_request:')), url: value.url } }
  private body(input: { url: string, events: string[] }): string { return JSON.stringify({ description: 'ts-cloud deploy', url: webhookUrl(input.url), active: true, events: input.events.map(event => event === 'push' ? 'repo:push' : event.replace('pull_request:', 'pullrequest:')) }) }
  async createWebhook(repository: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<BitbucketHook>(this.webhookPath(repository), { method: 'POST', body: this.body(input), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
  async listWebhooks(repository: string): Promise<SourceWebhookRegistration[]> { const { data } = await this.request<BitbucketPage<BitbucketHook>>(this.webhookPath(repository)); return data.values.map(value => this.hook(value)) }
  async updateWebhook(repository: string, webhookId: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<BitbucketHook>(this.webhookPath(repository, webhookId), { method: 'PUT', body: this.body(input), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
}

interface GiteaRepo { id: number, full_name: string, clone_url: string, default_branch?: string, private?: boolean, archived?: boolean }
interface GiteaRef { name: string, commit: { id: string } }
interface GiteaHook { id: number, active: boolean, events?: string[], config: { url?: string } }

export class GiteaSourceAdapter extends HostedSourceAdapter {
  readonly provider = 'gitea' as const
  readonly capabilities: SourceCapabilities = { ...HOSTED_CAPABILITIES, tokenRefresh: false }
  protected apiRoot(): string { return `${this.connection.host}/api/v1` }
  protected async authorization(): Promise<Record<string, string>> { return this.credential?.token ? { Authorization: `token ${this.credential.token}` } : {} }
  async testConnection(): Promise<SourceConnectionTest> { const { data } = await this.request<{ login?: string }>('/user'); return { ok: true, account: data.login, scopes: this.connection.grantedScopes, message: 'Gitea connection is healthy' } }
  async listRepositories(input: { cursor?: string, search?: string, limit?: number } = {}): Promise<SourceRepositoryPage> { const page = integerCursor(input.cursor); const perPage = limit(input.limit); const path = input.search ? `/repos/search?q=${encodeURIComponent(input.search)}&limit=${perPage}&page=${page}` : `/user/repos?limit=${perPage}&page=${page}`; const { data, headers } = await this.request<GiteaRepo[] | { data: GiteaRepo[] }>(path); const repos = Array.isArray(data) ? data : data.data; return { repositories: repos.map(repo => ({ providerRepositoryId: String(repo.id), fullName: repo.full_name, cloneUrl: repo.clone_url, defaultBranch: repo.default_branch ?? 'main', visibility: repo.private ? 'private' : 'public', archived: !!repo.archived, metadata: {} })), nextCursor: headers.get('x-hasmore') === 'true' || repos.length === perPage ? String(page + 1) : undefined } }
  private async refs(repository: string, kind: 'branches' | 'tags', input: { cursor?: string, limit?: number } = {}): Promise<SourceRefPage> { const page = integerCursor(input.cursor); const perPage = limit(input.limit); const { data } = await this.request<GiteaRef[]>(`/repos/${repositoryName(repository)}/${kind}?limit=${perPage}&page=${page}`); return { refs: data.map(ref => ({ name: ref.name, commitSha: ref.commit.id })), nextCursor: data.length === perPage ? String(page + 1) : undefined } }
  listBranches(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'branches', input) }
  listTags(repository: string, input?: { cursor?: string, limit?: number }): Promise<SourceRefPage> { return this.refs(repository, 'tags', input) }
  protected webhookPath(repository: string, webhookId?: string): string { return `/repos/${repositoryName(repository)}/hooks${webhookId ? `/${encodeURIComponent(webhookId)}` : ''}` }
  private hook(value: GiteaHook): SourceWebhookRegistration { return { providerWebhookId: String(value.id), active: value.active, events: value.events ?? [], url: value.config.url ?? '' } }
  private body(input: { url: string, secret: string, events: string[] }): string { return JSON.stringify({ type: 'gitea', active: true, events: input.events, config: { url: webhookUrl(input.url), content_type: 'json', secret: input.secret, insecure_ssl: '0' } }) }
  async createWebhook(repository: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<GiteaHook>(this.webhookPath(repository), { method: 'POST', body: this.body(input), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
  async listWebhooks(repository: string): Promise<SourceWebhookRegistration[]> { const { data } = await this.request<GiteaHook[]>(this.webhookPath(repository)); return data.map(value => this.hook(value)) }
  async updateWebhook(repository: string, webhookId: string, input: { url: string, secret: string, events: string[] }): Promise<SourceWebhookRegistration> { const { data } = await this.request<GiteaHook>(this.webhookPath(repository, webhookId), { method: 'PATCH', body: this.body(input), headers: { 'Content-Type': 'application/json' } }); return this.hook(data) }
}

export function createSourceAdapter(connection: SourceConnection, credential?: SourceCredential, options: SourceAdapterOptions = {}): SourceProviderAdapter {
  switch (connection.provider) {
    case 'github': return new GithubSourceAdapter(connection, credential, options)
    case 'gitlab': return new GitlabSourceAdapter(connection, credential, options)
    case 'bitbucket': return new BitbucketSourceAdapter(connection, credential, options)
    case 'gitea': return new GiteaSourceAdapter(connection, credential, options)
    default: throw new Error(`${connection.provider} uses bounded Git discovery instead of a hosted provider API`)
  }
}
