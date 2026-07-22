import type { ControlPlaneOperation, ControlPlaneStore, JsonValue } from '../control-plane'
import type { QueueExecutionContext, QueueOperationHandler } from './types'
import { RetryableOperationError } from './types'

export const DEPLOYMENT_QUEUE_KINDS = [
  'deployment.create',
  'deployment.rollback',
  'application.create',
  'deploy.source',
  'deploy.preview',
] as const

export interface QueuedDeploymentCommand {
  id: string
  label: string
  description: string
  command: string[]
  mutates: true
  target: { environment: string, resource?: string }
}

export interface QueuedDeploymentResult {
  ok: boolean
  exitCode: number
  command?: string
  stderr?: string
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

export function resolveQueuedDeploymentCommand(store: ControlPlaneStore, operation: ControlPlaneOperation): QueuedDeploymentCommand {
  if (!operation.projectId || !operation.environmentId)
    throw new Error(`Queued ${operation.kind} operation is missing its project or environment scope`)
  const environment = store.listEnvironments(operation.projectId).find(candidate => candidate.id === operation.environmentId)
  if (!environment)
    throw new Error(`Environment ${operation.environmentId} was not found for queued ${operation.kind} operation`)
  const resource = operation.resourceId ? store.getResource(operation.resourceId) : undefined
  if (operation.resourceId && (!resource || resource.projectId !== operation.projectId || resource.environmentId !== operation.environmentId))
    throw new Error(`Resource ${operation.resourceId} was not found in the queued deployment scope`)

  const input = record(operation.input)
  if (operation.kind === 'deployment.rollback') {
    const command = ['deploy:rollback']
    if (resource)
      command.push(resource.slug)
    command.push('--env', environment.slug)
    if (typeof input.revision === 'string' && input.revision)
      command.push('--to', input.revision)
    return { id: `queue:${operation.id}`, label: 'Rollback deployment', description: `Roll back ${resource?.slug ?? environment.slug}.`, command, mutates: true, target: { environment: environment.slug, resource: resource?.slug } }
  }

  const command = ['deploy', '--env', environment.slug, '--yes']
  if (resource)
    command.push('--site', resource.slug)
  return { id: `queue:${operation.id}`, label: operation.kind === 'deploy.preview' ? 'Deploy preview' : 'Deploy release', description: `Deploy ${resource?.slug ?? environment.slug}.`, command, mutates: true, target: { environment: environment.slug, resource: resource?.slug } }
}

function executionError(result: QueuedDeploymentResult): Error {
  const message = result.stderr?.trim() || `Deployment process exited with code ${result.exitCode}`
  if (/\b(429|rate.?limit|throttl)/i.test(message))
    return new RetryableOperationError(message, 'provider_throttled')
  if (/\b(502|503|504|temporar(?:y|ily)|unavailable|provider.?error)/i.test(message))
    return new RetryableOperationError(message, 'provider_unavailable')
  if (/\b(network|econn|enotfound|socket|timed?\s*out|fetch failed|dns)\b/i.test(message))
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
    context.log(`Target: ${command.target.resource ?? 'all resources'} in ${command.target.environment}.`, { stream: 'system' })
    context.throwIfCancellationRequested()
    context.checkpoint('execute', `Running cloud ${command.command.join(' ')}.`)
    const result = await input.execute(command, context)
    if (!result.ok)
      throw executionError(result)
    context.throwIfCancellationRequested()
    context.checkpoint('finalize', 'Deployment command completed; persisting the terminal result.')
    return { command: result.command ?? `cloud ${command.command.join(' ')}`, exitCode: result.exitCode, environment: command.target.environment, resource: command.target.resource ?? null }
  }
  return Object.fromEntries(DEPLOYMENT_QUEUE_KINDS.map(kind => [kind, handler]))
}
