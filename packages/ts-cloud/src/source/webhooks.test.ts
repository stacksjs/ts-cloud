import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { ControlPlaneStore } from '../control-plane'
import { SourceConnectionStore } from './store'
import { PreviewEnvironmentStore } from '../preview'
import { normalizeSourceEvent, processSourceWebhook, webhookEndpoint } from './webhooks'

function fixture(provider: 'github' | 'generic_https' = 'github') {
  let sequence = 0
  const controlPlane = new ControlPlaneStore({ path: ':memory:', id: () => `control-${++sequence}` })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const resource = controlPlane.createResource({ projectId: project.id, environmentId: environment.id, kind: 'application', slug: 'site', name: 'Site' })
  const sources = new SourceConnectionStore(controlPlane, { encryptionKey: 'fixture-key', id: () => `source-${++sequence}` })
  const connection = sources.createConnection({ organizationId: organization.id, provider, name: `${provider} source`, host: provider === 'github' ? 'https://github.com' : 'https://git.example', authKind: 'access_token', credential: { token: 'fixture' } })
  sources.updateHealth(connection.id, { status: 'healthy', tested: true })
  const binding = sources.createBinding({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, connectionId: connection.id, repositoryFullName: 'acme/web', defaultBranch: 'main', branchRule: 'main', includePaths: ['apps/web/**'], excludePaths: ['**/*.md'], pullRequestPreviews: true })
  const created = sources.createWebhook({ connectionId: connection.id, repositoryFullName: 'acme/web', endpointToken: 'endpoint-fixture', secret: 'webhook-fixture', events: ['push', 'pull_request'] })
  sources.updateWebhookState(created.webhook.id, { providerWebhookId: 'provider-1', status: 'healthy', reconciled: true })
  return { controlPlane, sources, organization, project, environment, resource, connection: sources.getConnection(connection.id)!, binding, webhook: created.webhook, secret: created.secret }
}

function raw(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function signature(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

describe('source webhook ingestion', () => {
  it('verifies the raw GitHub body and enqueues each matching binding exactly once', async () => {
    const f = fixture()
    const body = raw({ ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { full_name: 'acme/web' }, commits: [{ added: ['apps/web/src/index.ts'], modified: [], removed: [] }] })
    const headers = { 'x-github-event': 'push', 'x-github-delivery': 'delivery-1', 'x-hub-signature-256': signature(f.secret, body) }
    const first = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers, rawBody: body })
    expect(first).toMatchObject({ accepted: true, duplicate: false, status: 'enqueued' })
    expect(first.operations).toHaveLength(1)
    expect(first.operations[0]).toMatchObject({ kind: 'deploy.source', state: 'queued', input: { source: { repository: 'acme/web', commitSha: 'a'.repeat(40), monorepoRoot: '.' } } })

    const replay = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers, rawBody: body })
    expect(replay).toMatchObject({ accepted: true, duplicate: true, status: 'duplicate', operations: [] })
    expect(f.controlPlane.listOperations({ projectId: f.project.id })).toHaveLength(1)
    expect(f.sources.listDeliveries(f.webhook.id)).toMatchObject([{ providerDeliveryId: 'delivery-1', signatureStatus: 'verified', status: 'enqueued', operationId: first.operations[0]?.id,
      payloadSummary: { repository: 'acme/web', changedPathCount: 1 } }])
  })

  it('rejects invalid signatures without parsing payload details or leaking connection state', async () => {
    const f = fixture()
    const body = raw({ repository: { full_name: 'unauthorized/private' }, after: 'b'.repeat(40), credential: 'must-not-persist' })
    const result = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { 'x-github-event': 'push', 'x-github-delivery': 'delivery-invalid', 'x-hub-signature-256': 'sha256=invalid' }, rawBody: body })
    expect(result).toMatchObject({ accepted: false, status: 'rejected', message: 'Webhook unavailable' })
    const delivery = f.sources.listDeliveries(f.webhook.id)[0]!
    expect(delivery).toMatchObject({ signatureStatus: 'invalid', status: 'rejected' })
    expect(JSON.stringify(delivery)).not.toContain('must-not-persist')

    const unknown = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'not-a-real-endpoint', headers: {}, rawBody: body })
    expect(unknown.message).toBe(result.message)
  })

  it('honors branch/path rules and safely disables ingestion after disconnect', async () => {
    const f = fixture()
    const docsOnly = raw({ ref: 'refs/heads/main', after: 'c'.repeat(40), repository: { full_name: 'acme/web' }, commits: [{ modified: ['apps/web/readme.md'] }] })
    const ignored = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { 'x-github-event': 'push', 'x-github-delivery': 'delivery-docs', 'x-hub-signature-256': signature(f.secret, docsOnly) }, rawBody: docsOnly })
    expect(ignored).toMatchObject({ accepted: true, status: 'ignored', operations: [] })

    f.sources.disconnectConnection(f.connection.id)
    const afterDisconnect = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { 'x-github-event': 'push', 'x-github-delivery': 'delivery-after', 'x-hub-signature-256': signature(f.secret, docsOnly) }, rawBody: docsOnly })
    expect(afterDisconnect).toMatchObject({ accepted: false, message: 'Webhook unavailable' })
    expect(f.sources.getBinding(f.binding.id)?.status).toBe('disabled')
  })

  it('requires a fresh timestamp for generic events and enqueues pull-request previews', async () => {
    const f = fixture('generic_https')
    const now = new Date('2026-07-21T12:00:00.000Z')
    const body = raw({ event: 'pull_request', action: 'opened', repository: 'acme/web', branch: 'feature/source', commitSha: 'd'.repeat(40), pullRequestNumber: 17 })
    const baseHeaders = { 'x-ts-cloud-event': 'pull_request', 'x-ts-cloud-delivery': 'generic-1', 'x-ts-cloud-signature': signature(f.secret, body) }
    const stale = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { ...baseHeaders, 'x-ts-cloud-timestamp': String(now.getTime() / 1000 - 301) }, rawBody: body, now })
    expect(stale.accepted).toBe(false)

    const accepted = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { ...baseHeaders, 'x-ts-cloud-delivery': 'generic-2', 'x-ts-cloud-timestamp': String(now.getTime() / 1000) }, rawBody: body, now })
    expect(accepted).toMatchObject({ accepted: true, status: 'enqueued', operations: [{ kind: 'deploy.preview', input: { preview: { number: 17, action: 'opened' } } }] })
  })

  it('creates, updates, and destroys one persistent preview across the PR lifecycle', async () => {
    const f = fixture('generic_https')
    const previews = new PreviewEnvironmentStore(f.controlPlane)
    const policy = previews.createDefinition({ projectId: f.project.id, resourceId: f.resource.id, baseEnvironmentId: f.environment.id, domainPattern: 'https://{name}.preview.example.com', inheritedSecrets: ['PREVIEW_KEY'] })
    const now = new Date('2026-07-21T12:00:00.000Z')
    const deliver = async (delivery: string, action: string, sha: string, fork = false) => {
      const body = raw({ event: 'pull_request', action, repository: 'acme/web', branch: 'feature/preview', commitSha: sha, pullRequestNumber: 23, fork })
      return processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { 'x-ts-cloud-event': 'pull_request', 'x-ts-cloud-delivery': delivery, 'x-ts-cloud-signature': signature(f.secret, body), 'x-ts-cloud-timestamp': String(now.getTime() / 1000) }, rawBody: body, now })
    }

    const opened = await deliver('preview-open', 'opened', 'a'.repeat(40))
    expect(opened).toMatchObject({ status: 'enqueued', operations: [{ kind: 'preview.create' }] })
    const created = previews.findForPullRequest(policy.id, 'acme/web', 23)!
    expect(created).toMatchObject({ status: 'queued', commitSha: 'a'.repeat(40), latestOperationId: opened.operations[0]?.id })

    const synchronized = await deliver('preview-sync', 'synchronize', 'b'.repeat(40))
    expect(synchronized).toMatchObject({ status: 'enqueued', operations: [{ kind: 'preview.update', input: { previewId: created.id } }] })
    expect(previews.getInstance(created.id)?.commitSha).toBe('b'.repeat(40))

    const closed = await deliver('preview-close', 'closed', 'b'.repeat(40))
    expect(closed).toMatchObject({ status: 'enqueued', operations: [{ kind: 'preview.destroy', input: { previewId: created.id, reason: 'pull_request_closed' } }] })
    expect(previews.listInstances({ definitionId: policy.id })).toHaveLength(1)
  })

  it('rejects untrusted fork previews before credentials enter a durable job', async () => {
    const f = fixture('generic_https')
    const previews = new PreviewEnvironmentStore(f.controlPlane)
    const policy = previews.createDefinition({ projectId: f.project.id, resourceId: f.resource.id, baseEnvironmentId: f.environment.id, domainPattern: 'https://{name}.preview.example.com', inheritedSecrets: ['PREVIEW_KEY'] })
    const now = new Date('2026-07-21T12:00:00.000Z')
    const body = raw({ event: 'pull_request', action: 'opened', repository: 'acme/web', branch: 'fork/patch', commitSha: 'f'.repeat(40), pullRequestNumber: 31, fork: true })
    const result = await processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { 'x-ts-cloud-event': 'pull_request', 'x-ts-cloud-delivery': 'fork-open', 'x-ts-cloud-signature': signature(f.secret, body), 'x-ts-cloud-timestamp': String(now.getTime() / 1000) }, rawBody: body, now })
    expect(result).toMatchObject({ accepted: true, status: 'ignored', operations: [] })
    expect(previews.listInstances({ definitionId: policy.id })).toEqual([])
    expect(f.controlPlane.listEvents({ projectId: f.project.id }).some(event => event.type === 'preview.rejected' && JSON.stringify(event.payload).includes('fork'))).toBe(true)
  })

  it('creates branch previews outside the production branch rule and tears them down on deletion', async () => {
    const f = fixture('generic_https'); const previews = new PreviewEnvironmentStore(f.controlPlane)
    const policy = previews.createDefinition({ projectId: f.project.id, resourceId: f.resource.id, baseEnvironmentId: f.environment.id, domainPattern: 'https://{name}.preview.example.com', branchRule: 'preview/**' })
    const now = new Date('2026-07-21T12:00:00.000Z')
    const deliver = async (delivery: string, sha: string, deleted = false) => { const body = raw({ event: 'push', repository: 'acme/web', branch: 'preview/search', commitSha: sha, changedPaths: ['apps/web/src.ts'], deleted }); return processSourceWebhook({ sources: f.sources, controlPlane: f.controlPlane, endpointToken: 'endpoint-fixture', headers: { 'x-ts-cloud-event': 'push', 'x-ts-cloud-delivery': delivery, 'x-ts-cloud-signature': signature(f.secret, body), 'x-ts-cloud-timestamp': String(now.getTime() / 1000) }, rawBody: body, now }) }
    expect(await deliver('branch-open', 'a'.repeat(40))).toMatchObject({ operations: [{ kind: 'preview.create' }] })
    const preview = previews.findForBranch(policy.id, 'acme/web', 'preview/search')!
    expect(await deliver('branch-update', 'b'.repeat(40))).toMatchObject({ operations: [{ kind: 'preview.update' }] })
    expect(previews.getInstance(preview.id)?.commitSha).toBe('b'.repeat(40))
    expect(await deliver('branch-delete', '0'.repeat(40), true)).toMatchObject({ operations: [{ kind: 'preview.destroy', input: { reason: 'branch_deleted' } }] })
  })

  it('normalizes hosted provider push and pull-request fixtures', () => {
    expect(normalizeSourceEvent('gitlab', { 'x-gitlab-event': 'Push Hook' }, { object_kind: 'push', ref: 'refs/heads/main', checkout_sha: 'a'.repeat(40), project: { path_with_namespace: 'acme/web' }, commits: [] })).toMatchObject({ event: 'push', repository: 'acme/web', branch: 'main' })
    expect(normalizeSourceEvent('bitbucket', { 'x-event-key': 'pullrequest:created' }, { repository: { full_name: 'acme/web' }, pullrequest: { id: 9, source: { branch: { name: 'feature' }, commit: { hash: 'b'.repeat(40) } } } })).toMatchObject({ event: 'pull_request', action: 'created', pullRequestNumber: 9 })
    expect(normalizeSourceEvent('gitea', { 'x-gitea-event': 'push' }, { ref: 'refs/tags/v2', after: 'c'.repeat(40), repository: { full_name: 'acme/web' }, commits: [] })).toMatchObject({ event: 'push', tag: 'v2' })
    expect(normalizeSourceEvent('gitlab', { 'x-gitlab-event': 'Push Hook' }, { object_kind: 'push', ref: 'refs/heads/preview/old', after: '0'.repeat(40), project: { path_with_namespace: 'acme/web' }, commits: [] })).toMatchObject({ branch: 'preview/old', deleted: true })
    expect(normalizeSourceEvent('bitbucket', { 'x-event-key': 'repo:push' }, { repository: { full_name: 'acme/web' }, push: { changes: [{ closed: true, new: null, old: { type: 'branch', name: 'preview/old', target: { hash: 'd'.repeat(40) } } }] } })).toMatchObject({ branch: 'preview/old', deleted: true })
    expect(normalizeSourceEvent('gitea', { 'x-gitea-event': 'push' }, { ref: 'refs/heads/preview/old', after: '0'.repeat(40), repository: { full_name: 'acme/web' }, commits: [] })).toMatchObject({ branch: 'preview/old', deleted: true })
  })

  it('only reveals endpoint tokens at creation time and requires secure public endpoints', () => {
    const f = fixture()
    expect(webhookEndpoint('https://cloud.example', f.webhook)).toBe('https://cloud.example/api/source/webhooks/endpoint-fixture')
    expect(f.sources.getWebhook(f.webhook.id)?.endpointToken).toBeUndefined()
    expect(() => webhookEndpoint('http://cloud.example', f.webhook)).toThrow('HTTPS')
  })
})
