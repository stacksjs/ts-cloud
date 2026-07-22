import type { ControlPlaneOperation, ControlPlaneStore, JsonValue } from '../control-plane'
import type { SourceConnectionStore } from './store'
import type { SourceBinding, SourceConnection, SourceProvider, SourceWebhook } from './types'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { PreviewEnvironmentStore } from '../preview'
import { DurableOperationQueue } from '../queue'

export interface NormalizedSourceEvent {
  event: 'push' | 'pull_request'
  action?: string
  repository: string
  ref?: string
  branch?: string
  tag?: string
  commitSha: string
  changedPaths: string[]
  pullRequestNumber?: number
  fork?: boolean
  deleted?: boolean
}

export interface ProcessSourceWebhookResult {
  accepted: boolean
  duplicate: boolean
  status: 'rejected' | 'ignored' | 'enqueued' | 'duplicate'
  operations: ControlPlaneOperation[]
  message: string
}

function header(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return found?.[1]
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function hmac(secret: string, body: Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function verifySignature(
  provider: SourceProvider,
  secret: string,
  headers: Headers | Record<string, string | undefined>,
  body: Uint8Array,
  now: Date,
): boolean {
  if (provider === 'gitlab') return equal(header(headers, 'x-gitlab-token') ?? '', secret)
  const supplied =
    provider === 'github'
      ? header(headers, 'x-hub-signature-256')
      : provider === 'gitea'
        ? header(headers, 'x-gitea-signature')
        : (header(headers, 'x-hub-signature') ?? header(headers, 'x-ts-cloud-signature'))
  if (!supplied) return false
  if (provider === 'generic_https' || provider === 'generic_ssh') {
    const timestamp = Number(header(headers, 'x-ts-cloud-timestamp'))
    if (!Number.isFinite(timestamp) || Math.abs(now.getTime() - timestamp * 1000) > 5 * 60 * 1000) return false
  }
  return equal(supplied.replace(/^sha256=/, ''), hmac(secret, body))
}

function deliveryId(
  provider: SourceProvider,
  headers: Headers | Record<string, string | undefined>,
): string | undefined {
  const names: Record<SourceProvider, string[]> = {
    github: ['x-github-delivery'],
    gitlab: ['x-gitlab-event-uuid', 'x-request-id'],
    bitbucket: ['x-request-uuid'],
    gitea: ['x-gitea-delivery'],
    generic_https: ['x-ts-cloud-delivery'],
    generic_ssh: ['x-ts-cloud-delivery'],
  }
  return names[provider].map((name) => header(headers, name)?.trim()).find(Boolean)
}

function repositoryName(value: unknown): string {
  const name = String(value ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ? name : ''
}

function paths(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => {
          if (!value || typeof value !== 'object') return []
          const item = value as Record<string, any>
          return [...(item.added ?? []), ...(item.modified ?? []), ...(item.removed ?? [])].map(String)
        })
        .filter((value) => value && !value.includes('\0'))
        .slice(0, 500),
    ),
  ]
}

export function normalizeSourceEvent(
  _provider: SourceProvider,
  _headers: Headers | Record<string, string | undefined>,
  _body: Record<string, any>,
): NormalizedSourceEvent | undefined {
  const provider = _provider
  const headers = _headers
  const body = _body
  if (provider === 'github') {
    const event = header(headers, 'x-github-event')
    const repository = repositoryName(body.repository?.full_name)
    if (event === 'push')
      return {
        event: 'push',
        repository,
        ref: String(body.ref ?? ''),
        branch: String(body.ref ?? '').replace(/^refs\/heads\//, ''),
        tag: String(body.ref ?? '').startsWith('refs/tags/')
          ? String(body.ref).replace(/^refs\/tags\//, '')
          : undefined,
        commitSha: String(body.after ?? body.head_commit?.id ?? ''),
        changedPaths: paths(body.commits ?? []),
        deleted: body.deleted === true || /^0{40,64}$/.test(String(body.after ?? '')),
      }
    if (event === 'pull_request')
      return {
        event: 'pull_request',
        action: String(body.action ?? ''),
        repository,
        branch: String(body.pull_request?.head?.ref ?? ''),
        commitSha: String(body.pull_request?.head?.sha ?? ''),
        changedPaths: [],
        pullRequestNumber: Number(body.number) || undefined,
        fork: repositoryName(body.pull_request?.head?.repo?.full_name) !== repository,
      }
  }
  if (provider === 'gitlab') {
    const kind = String(body.object_kind ?? '').toLowerCase()
    const repository = repositoryName(body.project?.path_with_namespace)
    if (kind === 'push' || kind === 'tag_push')
      return {
        event: 'push',
        repository,
        ref: String(body.ref ?? ''),
        branch: String(body.ref ?? '').replace(/^refs\/heads\//, ''),
        tag: kind === 'tag_push' ? String(body.ref ?? '').replace(/^refs\/tags\//, '') : undefined,
        commitSha: String(body.checkout_sha ?? body.after ?? ''),
        changedPaths: paths(body.commits ?? []),
        deleted: /^0{40,64}$/.test(String(body.after ?? '')),
      }
    if (kind === 'merge_request')
      return {
        event: 'pull_request',
        action: String(body.object_attributes?.action ?? body.object_attributes?.state ?? ''),
        repository,
        branch: String(body.object_attributes?.source_branch ?? ''),
        commitSha: String(body.object_attributes?.last_commit?.id ?? ''),
        changedPaths: [],
        pullRequestNumber: Number(body.object_attributes?.iid) || undefined,
        fork: body.object_attributes?.source_project_id !== body.object_attributes?.target_project_id,
      }
  }
  if (provider === 'bitbucket') {
    const event = header(headers, 'x-event-key') ?? ''
    const repository = repositoryName(body.repository?.full_name)
    if (event === 'repo:push') {
      const change = body.push?.changes?.[0] ?? {}
      const reference = change.new ?? change.old ?? {}
      const target = change.new?.target ?? change.old?.target
      return {
        event: 'push',
        repository,
        ref: String(reference.name ?? ''),
        branch: reference.type === 'branch' ? String(reference.name) : undefined,
        tag: reference.type === 'tag' ? String(reference.name) : undefined,
        commitSha: String(target?.hash ?? ''),
        changedPaths: [],
        deleted: change.closed === true || change.new == null,
      }
    }
    if (event.startsWith('pullrequest:'))
      return {
        event: 'pull_request',
        action: event.replace('pullrequest:', ''),
        repository,
        branch: String(body.pullrequest?.source?.branch?.name ?? ''),
        commitSha: String(body.pullrequest?.source?.commit?.hash ?? ''),
        changedPaths: [],
        pullRequestNumber: Number(body.pullrequest?.id) || undefined,
        fork: repositoryName(body.pullrequest?.source?.repository?.full_name) !== repository,
      }
  }
  if (provider === 'gitea') {
    const event = header(headers, 'x-gitea-event')
    const repository = repositoryName(body.repository?.full_name)
    if (event === 'push')
      return {
        event: 'push',
        repository,
        ref: String(body.ref ?? ''),
        branch: String(body.ref ?? '').replace(/^refs\/heads\//, ''),
        tag: String(body.ref ?? '').startsWith('refs/tags/')
          ? String(body.ref).replace(/^refs\/tags\//, '')
          : undefined,
        commitSha: String(body.after ?? ''),
        changedPaths: paths(body.commits ?? []),
        deleted: body.deleted === true || /^0{40,64}$/.test(String(body.after ?? '')),
      }
    if (event === 'pull_request')
      return {
        event: 'pull_request',
        action: String(body.action ?? ''),
        repository,
        branch: String(body.pull_request?.head?.ref ?? ''),
        commitSha: String(body.pull_request?.head?.sha ?? ''),
        changedPaths: [],
        pullRequestNumber: Number(body.number) || undefined,
        fork: repositoryName(body.pull_request?.head?.repo?.full_name) !== repository,
      }
  }
  if (provider === 'generic_https' || provider === 'generic_ssh') {
    if (body.event !== 'push' && body.event !== 'pull_request') return undefined
    return {
      event: body.event,
      action: typeof body.action === 'string' ? body.action : undefined,
      repository: repositoryName(body.repository),
      ref: typeof body.ref === 'string' ? body.ref : undefined,
      branch: typeof body.branch === 'string' ? body.branch : undefined,
      tag: typeof body.tag === 'string' ? body.tag : undefined,
      commitSha: String(body.commitSha ?? ''),
      changedPaths: Array.isArray(body.changedPaths) ? body.changedPaths.map(String).slice(0, 500) : [],
      pullRequestNumber: Number(body.pullRequestNumber) || undefined,
      fork: body.fork === true,
      deleted: body.deleted === true,
    }
  }
  return undefined
}

function glob(value: string, pattern: string): boolean {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index++
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char!.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${source}$`).test(value)
}

function eventMatches(binding: SourceBinding, event: NormalizedSourceEvent): boolean {
  if (event.event === 'pull_request') return binding.pullRequestPreviews
  if (!binding.autoDeploy) return false
  if (event.tag) return !!binding.tagRule && glob(event.tag, binding.tagRule)
  return glob(event.branch ?? '', binding.branchRule ?? binding.defaultBranch)
}

function pathsMatch(binding: SourceBinding, changedPaths: string[]): boolean {
  if (!changedPaths.length) return true
  const relevant = changedPaths.filter((path) => !binding.excludePaths.some((pattern) => glob(path, pattern)))
  return relevant.some(
    (path) => !binding.includePaths.length || binding.includePaths.some((pattern) => glob(path, pattern)),
  )
}

function eventName(provider: SourceProvider, headers: Headers | Record<string, string | undefined>): string {
  return (
    header(
      headers,
      provider === 'github'
        ? 'x-github-event'
        : provider === 'gitlab'
          ? 'x-gitlab-event'
          : provider === 'bitbucket'
            ? 'x-event-key'
            : provider === 'gitea'
              ? 'x-gitea-event'
              : 'x-ts-cloud-event',
    ) ?? 'unknown'
  )
}

function unavailable(): ProcessSourceWebhookResult {
  return { accepted: false, duplicate: false, status: 'rejected', operations: [], message: 'Webhook unavailable' }
}

export async function processSourceWebhook(input: {
  sources: SourceConnectionStore
  controlPlane: ControlPlaneStore
  endpointToken: string
  headers: Headers | Record<string, string | undefined>
  rawBody: Uint8Array
  now?: Date
}): Promise<ProcessSourceWebhookResult> {
  if (input.rawBody.byteLength > 2 * 1024 * 1024) return unavailable()
  const webhook = input.sources.getWebhookByEndpointToken(input.endpointToken)
  if (!webhook || webhook.status === 'disabled') return unavailable()
  const connection = input.sources.getConnection(webhook.connectionId)
  if (!connection || connection.status === 'disconnected' || connection.status === 'expired') return unavailable()
  const providerDeliveryId = deliveryId(connection.provider, input.headers)
  if (!providerDeliveryId || providerDeliveryId.length > 200) return unavailable()
  const signatureValid = verifySignature(
    connection.provider,
    input.sources.getWebhookSecret(webhook.id),
    input.headers,
    input.rawBody,
    input.now ?? new Date(),
  )
  if (!signatureValid) {
    input.sources.recordDelivery({
      connectionId: connection.id,
      webhookId: webhook.id,
      providerDeliveryId,
      event: eventName(connection.provider, input.headers),
      signatureStatus:
        header(input.headers, 'x-hub-signature-256') ||
        header(input.headers, 'x-gitlab-token') ||
        header(input.headers, 'x-hub-signature') ||
        header(input.headers, 'x-gitea-signature')
          ? 'invalid'
          : 'missing',
      status: 'rejected',
      error: 'Webhook signature verification failed',
    })
    return unavailable()
  }
  let body: Record<string, any>
  try {
    body = JSON.parse(new TextDecoder().decode(input.rawBody)) as Record<string, any>
  } catch {
    return unavailable()
  }
  const event = normalizeSourceEvent(connection.provider, input.headers, body)
  if (!event || !event.repository || !/^[a-f0-9]{7,64}$/i.test(event.commitSha)) {
    input.sources.recordDelivery({
      connectionId: connection.id,
      webhookId: webhook.id,
      providerDeliveryId,
      event: eventName(connection.provider, input.headers),
      signatureStatus: 'verified',
      status: 'rejected',
      error: 'Unsupported or malformed source event',
    })
    return unavailable()
  }
  const recorded = input.sources.recordDelivery({
    connectionId: connection.id,
    webhookId: webhook.id,
    providerDeliveryId,
    event: event.event,
    action: event.action,
    commitSha: event.commitSha,
    signatureStatus: 'verified',
    status: 'accepted',
    payloadSummary: {
      repository: event.repository,
      ref: event.ref ?? null,
      branch: event.branch ?? null,
      tag: event.tag ?? null,
      commitSha: event.commitSha,
      pullRequestNumber: event.pullRequestNumber ?? null,
      changedPathCount: event.changedPaths.length,
    },
  })
  if (recorded.duplicate && recorded.delivery.status !== 'accepted')
    return {
      accepted: true,
      duplicate: true,
      status: 'duplicate',
      operations: [],
      message: 'Delivery already processed',
    }

  const previews = new PreviewEnvironmentStore(input.controlPlane)
  const bindings = input.sources.listBindings({ connectionId: connection.id, status: 'active' }).filter((binding) => {
    if (
      binding.repositoryFullName.toLowerCase() !== event.repository.toLowerCase() ||
      !pathsMatch(binding, event.changedPaths)
    )
      return false
    const previewPolicy = binding.resourceId ? previews.getDefinitionForResource(binding.resourceId) : undefined
    const branchPreview =
      event.event === 'push' &&
      !!previewPolicy?.branchRule &&
      !!event.branch &&
      glob(event.branch, previewPolicy.branchRule)
    return eventMatches(binding, event) || branchPreview
  })
  if (!bindings.length) {
    input.sources.updateDelivery(recorded.delivery.id, { status: 'ignored' })
    return {
      accepted: true,
      duplicate: recorded.duplicate,
      status: 'ignored',
      operations: [],
      message: 'Verified event did not match an active deployment rule',
    }
  }
  const queue = new DurableOperationQueue(input.controlPlane)
  const closeActions = new Set(['closed', 'merged', 'declined'])
  const operations = bindings.flatMap((binding) => {
    if (event.event === 'push' && binding.resourceId && event.branch) {
      const policy = previews.getDefinitionForResource(binding.resourceId)
      if (policy?.branchRule && glob(event.branch, policy.branchRule)) {
        const existing = previews.findForBranch(policy.id, event.repository, event.branch)
        if (event.deleted) {
          if (!policy.cleanupOnClose || !existing || existing.status === 'destroyed') return []
          const operation = queue.enqueue({
            projectId: binding.projectId,
            environmentId: binding.environmentId,
            resourceId: binding.resourceId,
            kind: 'preview.destroy',
            idempotencyKey: `preview:${existing.id}:branch-delete:${providerDeliveryId}`,
            correlationId: `preview:${existing.id}`,
            input: {
              previewId: existing.id,
              reason: 'branch_deleted',
              source: { repository: event.repository, commitSha: event.commitSha, branch: event.branch },
            },
            lockKey: `preview:${existing.id}`,
            providerKey: connection.provider,
            maxAttempts: 3,
            retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
            resumePolicy: 'fail',
            cancellationMode: 'provider_non_cancellable',
            retentionDays: 90,
          }).operation
          previews.transition(existing.id, 'queued', { operationId: operation.id })
          return [operation]
        }
        const persisted = previews.upsert({
          definitionId: policy.id,
          sourceProvider: connection.provider,
          repository: event.repository,
          branch: event.branch,
          commitSha: event.commitSha,
        })
        if (!persisted.changed) return []
        const kind = persisted.created ? 'preview.create' : 'preview.update'
        const operation = queue.enqueue({
          projectId: binding.projectId,
          environmentId: binding.environmentId,
          resourceId: binding.resourceId,
          kind,
          idempotencyKey: `preview:${persisted.preview.id}:${event.commitSha}`,
          correlationId: `preview:${persisted.preview.id}`,
          input: {
            previewId: persisted.preview.id,
            source: {
              connectionId: connection.id,
              bindingId: binding.id,
              repository: event.repository,
              commitSha: event.commitSha,
              branch: event.branch,
              monorepoRoot: binding.monorepoRoot,
              submodules: binding.submodules,
              cloneDepth: binding.cloneDepth ?? null,
            },
          },
          lockKey: `preview:${persisted.preview.id}`,
          providerKey: connection.provider,
          buildSlot: true,
          maxAttempts: 3,
          retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
          resumePolicy: 'fail',
          cancellationMode: 'provider_non_cancellable',
          retentionDays: 90,
        }).operation
        previews.transition(persisted.preview.id, 'queued', { operationId: operation.id })
        return [operation]
      }
    }
    if (event.event === 'pull_request' && binding.resourceId && event.pullRequestNumber) {
      const policy = previews.getDefinitionForResource(binding.resourceId)
      if (policy) {
        const closing = closeActions.has(String(event.action ?? '').toLowerCase())
        const existing = previews.findForPullRequest(policy.id, event.repository, event.pullRequestNumber)
        if (closing) {
          if (!policy.cleanupOnClose || !existing || existing.status === 'destroyed') return []
          const operation = queue.enqueue({
            projectId: binding.projectId,
            environmentId: binding.environmentId,
            resourceId: binding.resourceId,
            kind: 'preview.destroy',
            idempotencyKey: `preview:${existing.id}:destroy:${providerDeliveryId}`,
            correlationId: `preview:${existing.id}`,
            input: {
              previewId: existing.id,
              reason: 'pull_request_closed',
              source: {
                repository: event.repository,
                commitSha: event.commitSha,
                branch: event.branch ?? null,
                pullRequestNumber: event.pullRequestNumber,
              },
            },
            lockKey: `preview:${existing.id}`,
            providerKey: connection.provider,
            maxAttempts: 3,
            retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
            resumePolicy: 'fail',
            cancellationMode: 'provider_non_cancellable',
            retentionDays: 90,
          }).operation
          previews.transition(existing.id, 'queued', { operationId: operation.id })
          return [operation]
        }
        try {
          const persisted = previews.upsert({
            definitionId: policy.id,
            sourceProvider: connection.provider,
            repository: event.repository,
            branch: event.branch ?? `pr-${event.pullRequestNumber}`,
            pullRequestNumber: event.pullRequestNumber,
            fork: event.fork,
            commitSha: event.commitSha,
          })
          if (!persisted.changed) return []
          const kind = persisted.created ? 'preview.create' : 'preview.update'
          const operation = queue.enqueue({
            projectId: binding.projectId,
            environmentId: binding.environmentId,
            resourceId: binding.resourceId,
            kind,
            idempotencyKey: `preview:${persisted.preview.id}:${event.commitSha}`,
            correlationId: `preview:${persisted.preview.id}`,
            input: {
              previewId: persisted.preview.id,
              source: {
                connectionId: connection.id,
                bindingId: binding.id,
                repository: event.repository,
                commitSha: event.commitSha,
                branch: event.branch ?? null,
                pullRequestNumber: event.pullRequestNumber,
                fork: !!event.fork,
                monorepoRoot: binding.monorepoRoot,
                submodules: binding.submodules,
                cloneDepth: binding.cloneDepth ?? null,
              },
              inheritedSecretNames: persisted.inheritedSecrets,
            },
            lockKey: `preview:${persisted.preview.id}`,
            providerKey: connection.provider,
            buildSlot: true,
            maxAttempts: 3,
            retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
            resumePolicy: 'fail',
            cancellationMode: 'provider_non_cancellable',
            retentionDays: 90,
          }).operation
          previews.transition(persisted.preview.id, 'queued', { operationId: operation.id })
          return [operation]
        } catch (error) {
          input.controlPlane.appendEvent({
            projectId: binding.projectId,
            resourceId: binding.resourceId,
            type: 'preview.rejected',
            level: 'warning',
            payload: {
              repository: event.repository,
              pullRequestNumber: event.pullRequestNumber,
              fork: !!event.fork,
              reason: error instanceof Error ? error.message : String(error),
            },
          })
          return []
        }
      }
    }
    const kind = event.event === 'pull_request' ? 'deploy.preview' : 'deploy.source'
    return [
      queue.enqueue({
        projectId: binding.projectId,
        environmentId: binding.environmentId,
        resourceId: binding.resourceId,
        kind,
        idempotencyKey: `source:${connection.id}:${providerDeliveryId}:${binding.id}:${event.commitSha}`,
        correlationId: `source:${providerDeliveryId}`,
        input: {
          source: {
            connectionId: connection.id,
            bindingId: binding.id,
            repository: event.repository,
            commitSha: event.commitSha,
            branch: event.branch ?? null,
            tag: event.tag ?? null,
            monorepoRoot: binding.monorepoRoot,
            submodules: binding.submodules,
            cloneDepth: binding.cloneDepth ?? null,
          },
          preview:
            event.event === 'pull_request'
              ? { number: event.pullRequestNumber ?? null, action: event.action ?? null }
              : null,
        } as JsonValue,
        lockKey: binding.resourceId
          ? `resource:${binding.resourceId}`
          : `environment:${binding.environmentId ?? binding.projectId}`,
        providerKey: connection.provider,
        buildSlot: true,
        maxAttempts: 3,
        retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
        resumePolicy: 'fail',
        cancellationMode: 'provider_non_cancellable',
        retentionDays: event.event === 'pull_request' ? 14 : 90,
      }).operation,
    ]
  })
  if (!operations.length) {
    input.sources.updateDelivery(recorded.delivery.id, { status: 'ignored' })
    return {
      accepted: true,
      duplicate: recorded.duplicate,
      status: 'ignored',
      operations: [],
      message: 'Verified event required no preview lifecycle change',
    }
  }
  input.sources.updateDelivery(recorded.delivery.id, { status: 'enqueued', operationId: operations[0]?.id })
  input.controlPlane.appendEvent({
    organizationId: connection.organizationId,
    projectId: bindings[0]?.projectId,
    operationId: operations[0]?.id,
    type: 'source.webhook.enqueued',
    payload: {
      webhookId: webhook.id,
      deliveryId: recorded.delivery.id,
      repository: event.repository,
      commitSha: event.commitSha,
      operationIds: operations.map((operation) => operation.id),
    },
  })
  return {
    accepted: true,
    duplicate: recorded.duplicate,
    status: 'enqueued',
    operations,
    message: `${operations.length} deployment operation${operations.length === 1 ? '' : 's'} enqueued`,
  }
}

export function webhookEndpoint(baseUrl: string, webhook: SourceWebhook): string {
  if (!webhook.endpointToken) throw new Error('The webhook endpoint token is only available at creation time')
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(base.hostname))
    throw new Error('Webhook base URL must use HTTPS')
  return new URL(`/api/source/webhooks/${encodeURIComponent(webhook.endpointToken)}`, base).href
}
