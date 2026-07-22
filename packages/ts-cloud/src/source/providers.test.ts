import { describe, expect, it } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import type { SourceConnection, SourceProvider, SourceProviderAdapter } from './types'
import type { SourceFetch } from './providers'
import { createSourceAdapter, SourceProviderError } from './providers'

function connection(provider: SourceProvider, host: string, owner = 'acme'): SourceConnection {
  return { id: `connection-${provider}`, organizationId: 'org-1', provider, name: provider, host, owner, authKind: provider === 'github' ? 'app' : 'access_token', credentialConfigured: true,
    grantedScopes: ['repository:read'], capabilities: { repositories: true, branches: true, tags: true, webhooks: true, pullRequests: true, tokenRefresh: true, deployKeys: true }, status: 'healthy', version: 1, createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z' }
}

function response(data: unknown, options: { status?: number, headers?: Record<string, string> } = {}): Response {
  return new Response(options.status === 204 ? null : JSON.stringify(data), { status: options.status ?? 200, headers: { 'Content-Type': 'application/json', ...options.headers } })
}

function hostedFixture(provider: 'github' | 'gitlab' | 'bitbucket' | 'gitea'): { adapter: SourceProviderAdapter, requests: Array<{ url: URL, method: string, headers: Headers, body?: any }> } {
  const requests: Array<{ url: URL, method: string, headers: Headers, body?: any }> = []
  const fetcher: SourceFetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = init.method ?? 'GET'; const headers = new Headers(init.headers); const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url, method, headers, body })
    const path = url.pathname
    if (path.endsWith('/user')) return response(provider === 'gitlab' ? { username: 'chris' } : { login: 'chris', username: 'chris' }, provider === 'github' ? { headers: { 'x-oauth-scopes': 'repo:read, metadata:read' } } : {})
    if (method === 'DELETE') return response(undefined, { status: 204 })
    if (path.includes('/statuses/') || path.includes('/statuses/build/')) return response({ ok: true })
    if (provider === 'github') {
      if (path.endsWith('/user/repos')) return response([{ id: 1, full_name: 'acme/web', clone_url: 'https://github.com/acme/web.git', default_branch: 'main', visibility: 'private' }])
      if (path.endsWith('/branches')) return response([{ name: 'main', commit: { sha: 'a'.repeat(40) }, protected: true }])
      if (path.endsWith('/tags')) return response([{ name: 'v1.0.0', commit: { sha: 'b'.repeat(40) } }])
      if (path.includes('/hooks')) return response(method === 'GET' ? [{ id: 8, active: true, events: ['push'], config: { url: 'https://cloud.example/hooks/source' } }] : { id: 8, active: true, events: body.events, config: { url: body.config.url } })
    }
    if (provider === 'gitlab') {
      if (path.endsWith('/projects')) return response([{ id: 2, path_with_namespace: 'acme/web', http_url_to_repo: 'https://gitlab.example/acme/web.git', default_branch: 'main', visibility: 'private' }], { headers: { 'x-next-page': '2' } })
      if (path.endsWith('/repository/branches')) return response([{ name: 'main', commit: { id: 'a'.repeat(40) }, protected: true }])
      if (path.endsWith('/repository/tags')) return response([{ name: 'v1.0.0', commit: { id: 'b'.repeat(40) } }])
      if (path.includes('/hooks')) return response(method === 'GET' ? [{ id: 8, url: 'https://cloud.example/hooks/source', push_events: true }] : { id: 8, url: body.url, push_events: body.push_events, merge_requests_events: body.merge_requests_events })
    }
    if (provider === 'bitbucket') {
      if (/\/repositories\/acme$/.test(path)) return response({ values: [{ uuid: '{repo-3}', full_name: 'acme/web', links: { clone: [{ name: 'https', href: 'https://bitbucket.org/acme/web.git' }] }, mainbranch: { name: 'main' }, is_private: true }], next: 'https://api.bitbucket.org/2.0/repositories/acme?page=2' })
      if (path.endsWith('/refs/branches')) return response({ values: [{ name: 'main', target: { hash: 'a'.repeat(40) } }] })
      if (path.endsWith('/refs/tags')) return response({ values: [{ name: 'v1.0.0', target: { hash: 'b'.repeat(40) } }] })
      if (path.includes('/hooks')) return response(method === 'GET' ? { values: [{ uuid: '{hook-8}', active: true, events: ['repo:push'], url: 'https://cloud.example/hooks/source' }] } : { uuid: '{hook-8}', active: true, events: body.events, url: body.url })
    }
    if (provider === 'gitea') {
      if (path.endsWith('/user/repos')) return response([{ id: 4, full_name: 'acme/web', clone_url: 'https://gitea.example/acme/web.git', default_branch: 'main', private: true }], { headers: { 'x-hasmore': 'true' } })
      if (path.endsWith('/branches')) return response([{ name: 'main', commit: { id: 'a'.repeat(40) } }])
      if (path.endsWith('/tags')) return response([{ name: 'v1.0.0', commit: { id: 'b'.repeat(40) } }])
      if (path.includes('/hooks')) return response(method === 'GET' ? [{ id: 8, active: true, events: ['push'], config: { url: 'https://cloud.example/hooks/source' } }] : { id: 8, active: true, events: body.events, config: body.config })
    }
    return response({ message: 'fixture route not found' }, { status: 404 })
  }
  const hosts = { github: 'https://github.com', gitlab: 'https://gitlab.example', bitbucket: 'https://bitbucket.org', gitea: 'https://gitea.example' }
  return { adapter: createSourceAdapter(connection(provider, hosts[provider]), { token: `${provider}-fixture-token` }, { fetch: fetcher }), requests }
}

for (const provider of ['github', 'gitlab', 'bitbucket', 'gitea'] as const) {
  describe(`${provider} source adapter contract`, () => {
    it('tests access, paginates repositories/refs, and reconciles webhook lifecycle', async () => {
      const { adapter, requests } = hostedFixture(provider)
      expect(await adapter.testConnection()).toMatchObject({ ok: true, account: 'chris' })
      const repositories = await adapter.listRepositories({ limit: 1 })
      expect(repositories.repositories).toMatchObject([{ fullName: 'acme/web', defaultBranch: 'main', visibility: 'private' }])
      expect(repositories.nextCursor).toBe('2')
      const branches = await adapter.listBranches('acme/web', { limit: 10 })
      expect(branches).toMatchObject({ refs: [{ name: 'main' }] })
      if (provider === 'github' || provider === 'gitlab')
        expect(branches.refs[0]?.protected).toBe(true)
      expect(await adapter.listTags('acme/web', { limit: 10 })).toMatchObject({ refs: [{ name: 'v1.0.0' }] })

      const created = await adapter.createWebhook('acme/web', { url: 'https://cloud.example/hooks/source', secret: 'fixture-webhook-value', events: ['push', 'pull_request'] })
      expect(created).toMatchObject({ active: true })
      expect(await adapter.listWebhooks('acme/web')).toHaveLength(1)
      expect(await adapter.updateWebhook('acme/web', created.providerWebhookId, { url: 'https://cloud.example/hooks/source', secret: 'rotated-webhook-value', events: ['push'] })).toMatchObject({ active: true })
      await adapter.deleteWebhook('acme/web', created.providerWebhookId)
      expect(requests.some(request => request.method === 'DELETE')).toBe(true)
      await adapter.setCommitStatus('acme/web', 'c'.repeat(40), { state: 'success', url: 'https://pr-4.preview.example.com', description: 'Preview deployed at exact commit' })
      const status = requests.at(-1)!
      expect(status.body).toMatchObject(provider === 'bitbucket' ? { state: 'SUCCESSFUL', key: 'ts-cloud-preview' } : { description: expect.stringContaining('exact commit') })
      expect(status.url.pathname).toContain('c'.repeat(40))
      expect(JSON.stringify(requests.map(request => request.url.href))).not.toContain('fixture-token')
    })
  })
}

describe('GitHub App authentication and provider failures', () => {
  it('mints a bounded installation token instead of storing an application bearer token', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const requests: Array<{ path: string, authorization: string }> = []
    const adapter = createSourceAdapter(connection('github', 'https://github.com'), { appId: '42', installationId: '99', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, { now: () => new Date('2026-07-21T12:00:00.000Z'), fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push({ path: url.pathname, authorization: new Headers(init?.headers).get('authorization') ?? '' })
      if (url.pathname.endsWith('/access_tokens')) return response({ token: 'installation-value', expires_at: '2026-07-21T13:00:00.000Z' })
      return response({ repositories: [] })
    } })
    expect(await adapter.testConnection()).toMatchObject({ ok: true, account: 'acme' })
    expect(requests.map(item => item.path)).toEqual(['/app/installations/99/access_tokens', '/installation/repositories'])
    expect(requests[0]?.authorization.split('.')).toHaveLength(3)
    expect(requests[1]?.authorization).toBe('Bearer installation-value')
  })

  it('surfaces rate-limit metadata without returning provider response bodies', async () => {
    const adapter = createSourceAdapter(connection('gitea', 'https://gitea.example'), { token: 'runtime-value' }, { fetch: async () => response({ detail: 'secret provider internals' }, { status: 429, headers: { 'retry-after': '12', 'x-request-id': 'request-7' } }) })
    try {
      await adapter.testConnection()
      throw new Error('Expected provider error')
    }
    catch (error) {
      expect(error).toBeInstanceOf(SourceProviderError)
      expect(error).toMatchObject({ status: 429, retryAfterSeconds: 12 })
      expect(String(error)).toContain('request-7')
      expect(String(error)).not.toContain('provider internals')
    }
  })
})
