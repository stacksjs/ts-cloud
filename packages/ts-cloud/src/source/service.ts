import type { SourceConnectionStore } from './store'
import type { SourceRefPage, SourceRepository, SourceWebhook } from './types'
import { createSourceAdapter } from './providers'
import { discoverGitRefs } from './git-workspace'
import { webhookEndpoint } from './webhooks'

function hosted(provider: string): boolean {
  return ['github', 'gitlab', 'bitbucket', 'gitea'].includes(provider)
}

export async function testSourceConnection(sources: SourceConnectionStore, connectionId: string, repositoryId?: string): Promise<ReturnType<SourceConnectionStore['updateHealth']>> {
  const connection = sources.getConnection(connectionId)
  if (!connection || ['disconnected', 'expired'].includes(connection.status)) throw new Error('Active source connection was not found')
  try {
    if (hosted(connection.provider)) {
      const result = await createSourceAdapter(connection, sources.getCredential(connection.id)).testConnection()
      return sources.updateHealth(connection.id, { status: result.ok ? 'healthy' : 'degraded', message: result.message, tested: true })
    }
    const repository = repositoryId ? sources.getRepository(repositoryId) : sources.listRepositories(connection.id, undefined, 1)[0]
    if (!repository) return sources.updateHealth(connection.id, { status: 'degraded', message: 'Add a repository URL before testing this generic connection.', tested: true })
    const deployKey = connection.provider === 'generic_ssh'
      ? sources.listBindings({ connectionId: connection.id }).map(item => item.deployKeyId).filter(Boolean).map(id => sources.getDeployKey(id!)).find(Boolean)
      : undefined
    await discoverGitRefs(repository.cloneUrl, { credential: sources.getCredential(connection.id), deployKey: deployKey ? { ...deployKey, privateKey: sources.getDeployPrivateKey(deployKey.id) } : undefined })
    return sources.updateHealth(connection.id, { status: 'healthy', message: 'Git repository access is healthy.', tested: true })
  }
  catch (error) {
    return sources.updateHealth(connection.id, { status: 'degraded', message: error instanceof Error ? error.message : 'Connection test failed', tested: true })
  }
}

export async function syncSourceRepositories(sources: SourceConnectionStore, connectionId: string, input: { search?: string, maxPages?: number } = {}): Promise<SourceRepository[]> {
  const connection = sources.getConnection(connectionId)
  if (!connection || !hosted(connection.provider) || ['disconnected', 'expired'].includes(connection.status)) throw new Error('A hosted active source connection is required for repository discovery')
  const adapter = createSourceAdapter(connection, sources.getCredential(connection.id))
  const synced: SourceRepository[] = []
  let cursor: string | undefined
  for (let page = 0; page < Math.min(20, Math.max(1, input.maxPages ?? 10)); page++) {
    const result = await adapter.listRepositories({ cursor, search: input.search, limit: 100 })
    for (const repository of result.repositories) synced.push(sources.upsertRepository({ connectionId: connection.id, ...repository }))
    cursor = result.nextCursor
    if (!cursor) break
  }
  sources.updateHealth(connection.id, { status: 'healthy', message: `${synced.length} repositories synchronized.`, synced: true })
  return synced
}

export async function listSourceReferences(sources: SourceConnectionStore, input: { connectionId: string, repository: string, repositoryId?: string, type: 'branches' | 'tags', cursor?: string, limit?: number, deployKeyId?: string }): Promise<SourceRefPage> {
  const connection = sources.getConnection(input.connectionId)
  if (!connection || ['disconnected', 'expired'].includes(connection.status)) throw new Error('Active source connection was not found')
  if (hosted(connection.provider)) {
    const adapter = createSourceAdapter(connection, sources.getCredential(connection.id))
    return input.type === 'tags' ? adapter.listTags(input.repository, input) : adapter.listBranches(input.repository, input)
  }
  const repository = input.repositoryId ? sources.getRepository(input.repositoryId) : sources.listRepositories(connection.id).find(item => item.fullName === input.repository)
  if (!repository || repository.connectionId !== connection.id) throw new Error('Generic repository metadata was not found')
  const key = input.deployKeyId ? sources.getDeployKey(input.deployKeyId) : undefined
  if (key && key.connectionId !== connection.id) throw new Error('Deploy key does not belong to this connection')
  const refs = await discoverGitRefs(repository.cloneUrl, { credential: sources.getCredential(connection.id), deployKey: key ? { ...key, privateKey: sources.getDeployPrivateKey(key.id) } : undefined })
  const values = input.type === 'tags' ? refs.tags : refs.branches
  return { refs: values.slice(0, Math.min(500, input.limit ?? 100)) }
}

export async function reconcileSourceWebhook(sources: SourceConnectionStore, webhookId: string, baseUrl: string): Promise<SourceWebhook> {
  const webhook = sources.getWebhook(webhookId)
  const connection = webhook ? sources.getConnection(webhook.connectionId) : undefined
  if (!webhook || !connection || ['disconnected', 'expired'].includes(connection.status)) throw new Error('Active source webhook was not found')
  const endpoint = webhookEndpoint(baseUrl, { ...webhook, endpointToken: sources.getWebhookEndpointToken(webhook.id) })
  if (!hosted(connection.provider)) return sources.updateWebhookState(webhook.id, { status: 'healthy', healthMessage: 'Manual webhook endpoint is ready.', reconciled: true })
  try {
    const adapter = createSourceAdapter(connection, sources.getCredential(connection.id))
    const secret = sources.getWebhookSecret(webhook.id)
    const registered = webhook.providerWebhookId
      ? await adapter.updateWebhook(webhook.repositoryFullName, webhook.providerWebhookId, { url: endpoint, secret, events: webhook.events })
      : await adapter.createWebhook(webhook.repositoryFullName, { url: endpoint, secret, events: webhook.events })
    return sources.updateWebhookState(webhook.id, { providerWebhookId: registered.providerWebhookId, status: registered.active ? 'healthy' : 'degraded', healthMessage: registered.active ? 'Provider webhook is synchronized.' : 'Provider webhook exists but is inactive.', reconciled: true })
  }
  catch (error) {
    return sources.updateWebhookState(webhook.id, { status: 'degraded', healthMessage: error instanceof Error ? error.message : 'Webhook reconciliation failed', reconciled: true })
  }
}

export async function removeSourceWebhook(sources: SourceConnectionStore, webhookId: string): Promise<SourceWebhook> {
  const webhook = sources.getWebhook(webhookId)
  const connection = webhook ? sources.getConnection(webhook.connectionId) : undefined
  if (!webhook || !connection) throw new Error('Source webhook was not found')
  if (hosted(connection.provider) && webhook.providerWebhookId && !['disconnected', 'expired'].includes(connection.status)) {
    await createSourceAdapter(connection, sources.getCredential(connection.id)).deleteWebhook(webhook.repositoryFullName, webhook.providerWebhookId)
  }
  return sources.updateWebhookState(webhook.id, { status: 'disabled', healthMessage: 'Webhook disabled.' })
}
