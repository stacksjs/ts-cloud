import type { ControlPlaneOperation, ControlPlaneStore, JsonValue } from '../control-plane'
import type { QueueExecutionContext, QueueOperationHandler } from './types'
import { ComposeApplicationStore } from '../compose'
import { PreviewEnvironmentStore } from '../preview'
import { completeComposeVolumeDeletion } from '../storage/compose'
import { RetryableOperationError } from './types'

export const DEPLOYMENT_QUEUE_KINDS = [
  'deployment.create',
  'deployment.rollback',
  'application.create',
  'deploy.source',
  'deploy.preview',
  'preview.create',
  'preview.update',
  'preview.destroy',
  'compose.deploy',
  'compose.redeploy',
  'compose.start',
  'compose.stop',
  'compose.delete',
  'compose.scale',
] as const

export interface QueuedDeploymentCommand {
  id: string
  label: string
  description: string
  command: string[]
  mutates: true
  target: { environment: string; resource?: string; previewId?: string; composeId?: string }
}

export interface QueuedDeploymentResult {
  ok: boolean
  exitCode: number
  command?: string
  stderr?: string
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {}
}

export function resolveQueuedDeploymentCommand(
  store: ControlPlaneStore,
  operation: ControlPlaneOperation,
): QueuedDeploymentCommand {
  if (!operation.projectId || !operation.environmentId)
    throw new Error(`Queued ${operation.kind} operation is missing its project or environment scope`)
  const environment = store
    .listEnvironments(operation.projectId)
    .find((candidate) => candidate.id === operation.environmentId)
  if (!environment)
    throw new Error(`Environment ${operation.environmentId} was not found for queued ${operation.kind} operation`)
  const resource = operation.resourceId ? store.getResource(operation.resourceId) : undefined
  if (
    operation.resourceId &&
    (!resource || resource.projectId !== operation.projectId || resource.environmentId !== operation.environmentId)
  )
    throw new Error(`Resource ${operation.resourceId} was not found in the queued deployment scope`)

  const input = record(operation.input)
  if (operation.kind.startsWith('compose.')) {
    const composeId = typeof input.applicationId === 'string' ? input.applicationId : undefined
    const application = composeId
      ? new ComposeApplicationStore(store).get(composeId)
      : operation.resourceId
        ? new ComposeApplicationStore(store).getByResource(operation.resourceId)
        : undefined
    if (
      !application ||
      application.projectId !== operation.projectId ||
      application.environmentId !== operation.environmentId ||
      application.resourceId !== operation.resourceId
    )
      throw new Error('Queued Compose application does not match the operation scope')
    const action = operation.kind.slice('compose.'.length)
    const command = ['compose:apply', application.id, '--action', action, '--env', environment.slug]
    if (typeof input.service === 'string' && input.service) command.push('--service', input.service)
    if (typeof input.replicas === 'number') command.push('--replicas', String(input.replicas))
    if (input.removeVolumes === true) command.push('--remove-volumes')
    return {
      id: `queue:${operation.id}`,
      label: `${action[0]!.toUpperCase()}${action.slice(1)} Compose application`,
      description: `${action} ${application.name}.`,
      command,
      mutates: true,
      target: { environment: environment.slug, resource: resource?.slug, composeId: application.id },
    }
  }
  if (operation.kind.startsWith('preview.')) {
    const previewId = typeof input.previewId === 'string' ? input.previewId : undefined
    const preview = previewId ? new PreviewEnvironmentStore(store).getInstance(previewId) : undefined
    if (!preview) throw new Error(`Preview ${previewId ?? '(missing)'} was not found for queued ${operation.kind}`)
    if (preview.projectId !== operation.projectId || preview.resourceId !== operation.resourceId)
      throw new Error('Queued preview does not match the operation scope')
    if (operation.kind === 'preview.destroy')
      return {
        id: `queue:${operation.id}`,
        label: 'Destroy preview',
        description: `Destroy ${preview.name}.`,
        command: ['stack:delete', preview.stackName, '--yes'],
        mutates: true,
        target: { environment: environment.slug, resource: resource?.slug, previewId: preview.id },
      }
    return {
      id: `queue:${operation.id}`,
      label: operation.kind === 'preview.create' ? 'Create preview' : 'Update preview',
      description: `Deploy ${preview.name} at ${preview.commitSha}.`,
      command: [
        'deploy',
        '--stack',
        preview.stackName,
        '--env',
        environment.slug,
        '--yes',
        '--skip-dns-verification',
        ...(resource ? ['--site', resource.slug] : []),
      ],
      mutates: true,
      target: { environment: environment.slug, resource: resource?.slug, previewId: preview.id },
    }
  }
  if (operation.kind === 'deployment.rollback') {
    const command = ['deploy:rollback']
    if (resource) command.push(resource.slug)
    command.push('--env', environment.slug)
    if (typeof input.revision === 'string' && input.revision) command.push('--to', input.revision)
    return {
      id: `queue:${operation.id}`,
      label: 'Rollback deployment',
      description: `Roll back ${resource?.slug ?? environment.slug}.`,
      command,
      mutates: true,
      target: { environment: environment.slug, resource: resource?.slug },
    }
  }

  const command = ['deploy', '--env', environment.slug, '--yes']
  if (resource) command.push('--site', resource.slug)
  return {
    id: `queue:${operation.id}`,
    label: operation.kind === 'deploy.preview' ? 'Deploy preview' : 'Deploy release',
    description: `Deploy ${resource?.slug ?? environment.slug}.`,
    command,
    mutates: true,
    target: { environment: environment.slug, resource: resource?.slug },
  }
}

function executionError(result: QueuedDeploymentResult): Error {
  const message = result.stderr?.trim() || `Deployment process exited with code ${result.exitCode}`
  if (/\b(?:429|rate.?limit|throttl)/i.test(message)) return new RetryableOperationError(message, 'provider_throttled')
  if (/\b(?:502|503|504|temporar(?:y|ily)|unavailable|provider.?error)/i.test(message))
    return new RetryableOperationError(message, 'provider_unavailable')
  if (/\b(?:network|econn|enotfound|socket|timed?\s*out|fetch failed|dns)\b/i.test(message))
    return new RetryableOperationError(message, 'network')
  return new Error(message)
}

export function createDeploymentQueueHandlers(input: {
  store: ControlPlaneStore
  execute: (command: QueuedDeploymentCommand, context: QueueExecutionContext) => Promise<QueuedDeploymentResult>
}): Record<string, QueueOperationHandler> {
  const handler: QueueOperationHandler = async (context) => {
    context.checkpoint('prepare', 'Resolving the persisted deployment target.')
    const command = resolveQueuedDeploymentCommand(input.store, context.operation)
    const previews = command.target.previewId ? new PreviewEnvironmentStore(input.store) : undefined
    const compose = command.target.composeId ? new ComposeApplicationStore(input.store) : undefined
    if (previews && command.target.previewId)
      previews.transition(
        command.target.previewId,
        context.operation.kind === 'preview.destroy'
          ? 'destroying'
          : context.operation.kind === 'preview.update'
            ? 'updating'
            : 'deploying',
        { operationId: context.operation.id },
      )
    if (compose && command.target.composeId)
      compose.transition(
        command.target.composeId,
        context.operation.kind === 'compose.delete'
          ? 'deleting'
          : context.operation.kind === 'compose.stop'
            ? 'stopped'
            : 'deploying',
        { operationId: context.operation.id },
      )
    context.log(`Target: ${command.target.resource ?? 'all resources'} in ${command.target.environment}.`, {
      stream: 'system',
    })
    context.throwIfCancellationRequested()
    context.checkpoint('execute', `Running cloud ${command.command.join(' ')}.`)
    const result = await input.execute(command, context)
    if (!result.ok) {
      if (previews && command.target.previewId)
        previews.transition(
          command.target.previewId,
          context.operation.kind === 'preview.destroy' ? 'cleanup_failed' : 'failed',
          {
            operationId: context.operation.id,
            teardownError:
              context.operation.kind === 'preview.destroy'
                ? result.stderr?.trim() || `Process exited with ${result.exitCode}`
                : undefined,
          },
        )
      if (compose && command.target.composeId)
        compose.transition(
          command.target.composeId,
          context.operation.kind === 'compose.delete' ? 'degraded' : 'failed',
          {
            operationId: context.operation.id,
            error: result.stderr?.trim() || `Process exited with ${result.exitCode}`,
          },
        )
      throw executionError(result)
    }
    context.throwIfCancellationRequested()
    if (previews && command.target.previewId) {
      const preview = previews.getInstance(command.target.previewId)!
      if (context.operation.kind === 'preview.destroy') {
        previews.markResourcesDeleted(preview.id)
        previews.transition(preview.id, 'destroyed', {
          operationId: context.operation.id,
          observedState: {
            reconciledResourceIds: previews.listResources(preview.id).map((item) => item.providerResourceId),
            exactCommitSha: preview.commitSha,
          },
        })
      } else {
        const provider = input.store.getResource(preview.resourceId)?.provider ?? 'default'
        previews.recordResource({
          previewId: preview.id,
          provider,
          providerResourceId: preview.stackName,
          kind: 'stack',
          tags: {
            'ts-cloud:preview': preview.id,
            'ts-cloud:project': preview.projectId,
            'ts-cloud:expires-at': preview.expiresAt,
          },
          observedState: { command: result.command ?? null, exactCommitSha: preview.commitSha },
        })
        previews.transition(preview.id, 'active', {
          operationId: context.operation.id,
          observedState: {
            url: preview.url ?? null,
            stackName: preview.stackName,
            exactCommitSha: preview.commitSha,
            providerStatus: 'deployed',
          },
        })
      }
    }
    if (compose && command.target.composeId) {
      const application = compose.get(command.target.composeId)!
      const selected =
        typeof record(context.operation.input).service === 'string'
          ? String(record(context.operation.input).service)
          : undefined
      const status =
        context.operation.kind === 'compose.delete'
          ? 'deleted'
          : context.operation.kind === 'compose.stop'
            ? 'stopped'
            : 'running'
      const completed = compose.transition(application.id, status, {
        operationId: context.operation.id,
        services: Object.values(application.manifest.spec.services)
          .filter((service) => !selected || service.name === selected)
          .map((service) => ({
            name: service.name,
            status: status === 'stopped' || status === 'deleted' ? 'stopped' : 'running',
            replicas: status === 'deleted' ? 0 : service.replicas,
            healthyReplicas: status === 'running' ? service.replicas : 0,
            observedState: { command: result.command ?? null, healthGatePassed: status === 'running' },
          })),
      })
      if (status === 'deleted')
        completeComposeVolumeDeletion(input.store, completed, record(context.operation.input).removeVolumes === true)
    }
    context.checkpoint('finalize', 'Deployment command completed; persisting the terminal result.')
    return {
      command: result.command ?? `cloud ${command.command.join(' ')}`,
      exitCode: result.exitCode,
      environment: command.target.environment,
      resource: command.target.resource ?? null,
    }
  }
  return Object.fromEntries(DEPLOYMENT_QUEUE_KINDS.map((kind) => [kind, handler]))
}
