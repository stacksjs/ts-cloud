import type { ApiTokenPrincipal, AutomationIdentityStore } from '../automation'
import type { AuthorizationCapability, AuthorizationScope, AuthorizationTarget, ControlPlaneOperation, ControlPlaneStore } from '../control-plane'
import type { ApiDeploymentRequest } from './types'
import { createHash } from 'node:crypto'
import { authorizeOrganization, sanitizeControlPlaneValue } from '../control-plane'
import { DurableOperationQueue } from '../queue'

export class ApiServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

function contains(parent: AuthorizationTarget, child: AuthorizationTarget): boolean {
  if (parent.organizationId !== child.organizationId) return false
  if (parent.projectId && parent.projectId !== child.projectId) return false
  if (parent.environmentId && parent.environmentId !== child.environmentId) return false
  if (parent.resourceId && parent.resourceId !== child.resourceId) return false
  return true
}

export function requestHash(method: string, pathname: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${pathname}\n${JSON.stringify(body)}`)
    .digest('hex')
}

export class AutomationApiService {
  private readonly queue: DurableOperationQueue
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    private readonly identities: AutomationIdentityStore,
  ) {
    this.queue = new DurableOperationQueue(controlPlane)
  }

  target(principal: ApiTokenPrincipal, requested: AuthorizationScope): AuthorizationTarget {
    const target = this.controlPlane.resolveAuthorizationTarget(principal.serviceAccount.organizationId, requested)
    const tokenTarget = this.controlPlane.resolveAuthorizationTarget(
      principal.serviceAccount.organizationId,
      principal.token.scope,
    )
    if (!target || !tokenTarget || !contains(tokenTarget, target))
      throw new ApiServiceError('forbidden', 'The token does not grant access to this resource.', 403)
    return target
  }

  authorize(
    principal: ApiTokenPrincipal,
    capability: AuthorizationCapability,
    requested: AuthorizationScope,
  ): AuthorizationTarget {
    if (!principal.token.capabilities.includes(capability))
      throw new ApiServiceError('forbidden', `The token is missing the ${capability} capability.`, 403)
    const target = this.controlPlane.resolveAuthorizationTarget(principal.serviceAccount.organizationId, requested)
    const tokenTarget = this.controlPlane.resolveAuthorizationTarget(
      principal.serviceAccount.organizationId,
      principal.token.scope,
    )
    const ancestorMetadata = capability === 'project:read' && !!target && !!tokenTarget && contains(target, tokenTarget)
    if (!target || !tokenTarget || (!contains(tokenTarget, target) && !ancestorMetadata))
      throw new ApiServiceError('forbidden', 'The token does not grant access to this resource.', 403)
    const authorizationTarget = ancestorMetadata ? tokenTarget : target
    if (
      !authorizeOrganization({
        membership: principal.membership,
        grants: this.controlPlane.listGrants(principal.membership.id),
        capability,
        target: authorizationTarget,
      }).allowed
    )
      throw new ApiServiceError('forbidden', 'The service account does not have access to this resource.', 403)
    return target
  }

  listProjects(principal: ApiTokenPrincipal): Array<Record<string, unknown>> {
    return this.controlPlane
      .listProjects()
      .filter((project) => project.organizationId === principal.serviceAccount.organizationId)
      .filter((project) => {
        try {
          this.authorize(principal, 'project:read', { type: 'project', id: project.id })
          return true
        } catch {
          return false
        }
      })
      .map((project) => ({
        id: project.id,
        slug: project.slug,
        name: project.name,
        description: project.description,
        version: project.version,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }))
  }

  listEnvironments(principal: ApiTokenPrincipal, projectId: string): Array<Record<string, unknown>> {
    const project = this.controlPlane.getProject(projectId)
    if (!project || project.organizationId !== principal.serviceAccount.organizationId)
      throw new ApiServiceError('not_found', 'Project was not found.', 404)
    return this.controlPlane
      .listEnvironments(projectId)
      .filter((environment) => {
        try {
          this.authorize(principal, 'project:read', { type: 'environment', id: environment.id })
          return true
        } catch {
          return false
        }
      })
      .map((environment) => ({
        id: environment.id,
        projectId: environment.projectId,
        slug: environment.slug,
        name: environment.name,
        kind: environment.kind,
        region: environment.region,
        version: environment.version,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      }))
  }

  listServices(
    principal: ApiTokenPrincipal,
    projectId: string,
    environmentId?: string,
  ): Array<Record<string, unknown>> {
    const environments = new Set(this.listEnvironments(principal, projectId).map((item) => String(item.id)))
    if (environmentId && !environments.has(environmentId))
      throw new ApiServiceError('not_found', 'Environment was not found.', 404)
    return this.controlPlane
      .listResources(projectId, environmentId)
      .filter((resource) => !resource.environmentId || environments.has(resource.environmentId))
      .filter((resource) => {
        try {
          this.authorize(principal, 'project:read', { type: 'resource', id: resource.id })
          return true
        } catch {
          return false
        }
      })
      .map((resource) => ({
        id: resource.id,
        projectId: resource.projectId,
        environmentId: resource.environmentId,
        kind: resource.kind,
        slug: resource.slug,
        name: resource.name,
        provider: resource.provider,
        providerId: resource.providerId,
        metadata: sanitizeControlPlaneValue(resource.metadata),
        version: resource.version,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
      }))
  }

  listOperations(principal: ApiTokenPrincipal, projectId?: string): Array<Record<string, unknown>> {
    const operations = this.controlPlane.listOperations({ projectId, limit: 500 })
    return operations
      .filter((operation) => {
        const requested: AuthorizationScope = operation.resourceId
          ? { type: 'resource', id: operation.resourceId }
          : operation.environmentId
            ? { type: 'environment', id: operation.environmentId }
            : operation.projectId
              ? { type: 'project', id: operation.projectId }
              : { type: 'organization' }
        try {
          this.authorize(principal, 'deployments:read', requested)
          return true
        } catch {
          return false
        }
      })
      .map((operation) => this.operation(operation))
  }

  listEvents(principal: ApiTokenPrincipal, projectId?: string, afterSequence?: number): Array<Record<string, unknown>> {
    if (projectId) this.authorize(principal, 'audit:read', { type: 'project', id: projectId })
    else this.authorize(principal, 'audit:read', principal.token.scope)
    return this.controlPlane
      .listEvents({ organizationId: principal.serviceAccount.organizationId, projectId, afterSequence, limit: 500 })
      .filter((event) => {
        const requested: AuthorizationScope = event.resourceId
          ? { type: 'resource', id: event.resourceId }
          : event.projectId
            ? { type: 'project', id: event.projectId }
            : { type: 'organization' }
        try {
          this.target(principal, requested)
          return true
        } catch {
          return false
        }
      })
      .map((event) => ({
        id: event.id,
        sequence: event.sequence,
        projectId: event.projectId,
        operationId: event.operationId,
        resourceId: event.resourceId,
        correlationId: event.correlationId,
        type: event.type,
        level: event.level,
        payload: sanitizeControlPlaneValue(event.payload),
        createdAt: event.createdAt,
      }))
  }

  createDeployment(
    principal: ApiTokenPrincipal,
    input: ApiDeploymentRequest,
    idempotencyKey: string,
  ): { operation: Record<string, unknown>; replay: boolean } {
    const environment = this.controlPlane
      .listEnvironments(input.projectId)
      .find((candidate) => candidate.id === input.environmentId)
    if (!environment) throw new ApiServiceError('not_found', 'Environment was not found in this project.', 404)
    const requested: AuthorizationScope = input.serviceId
      ? { type: 'resource', id: input.serviceId }
      : { type: 'environment', id: input.environmentId }
    this.authorize(principal, 'deployments:create', requested)
    const bodyHash = requestHash('POST', '/api/v1/deployments', input)
    const existing = this.identities.getIdempotency(principal.token.id, idempotencyKey)
    if (existing) {
      if (existing.requestHash !== bodyHash)
        throw new ApiServiceError('idempotency_conflict', 'Idempotency-Key was already used for another request.', 409)
      const operation = existing.operationId ? this.controlPlane.getOperation(existing.operationId) : undefined
      if (!operation)
        throw new ApiServiceError('idempotency_unavailable', 'The original operation is no longer available.', 409)
      return { operation: this.operation(operation), replay: true }
    }
    if (input.serviceId) {
      const service = this.controlPlane.getResource(input.serviceId)
      if (!service || service.projectId !== input.projectId || service.environmentId !== input.environmentId)
        throw new ApiServiceError('not_found', 'Service was not found in this environment.', 404)
    }
    const resource = input.serviceId ? this.controlPlane.getResource(input.serviceId) : undefined
    const operation = this.queue.enqueue({
      projectId: input.projectId,
      environmentId: input.environmentId,
      resourceId: input.serviceId,
      actorId: principal.actor.id,
      kind: input.action === 'rollback' ? 'deployment.rollback' : 'deployment.create',
      idempotencyKey: `api:${principal.token.id}:${idempotencyKey}`,
      input: sanitizeControlPlaneValue({ action: input.action ?? 'deploy', revision: input.revision ?? null }),
      lockKey: input.serviceId ? `resource:${input.serviceId}` : `environment:${input.environmentId}`,
      providerKey: resource?.provider ?? 'default',
      buildSlot: input.action !== 'rollback',
      maxAttempts: 3,
      retryClasses: ['network', 'provider_throttled', 'provider_unavailable'],
      resumePolicy: 'fail',
      cancellationMode: 'provider_non_cancellable',
      retentionDays: 90,
    }).operation
    this.identities.saveIdempotency({
      tokenId: principal.token.id,
      key: idempotencyKey,
      requestHash: bodyHash,
      operationId: operation.id,
      responseStatus: 202,
      responseBody: { operationId: operation.id },
    })
    return { operation: this.operation(operation), replay: false }
  }

  operation(operation: ControlPlaneOperation): Record<string, unknown> {
    return {
      id: operation.id,
      state: operation.state,
      kind: operation.kind,
      projectId: operation.projectId,
      environmentId: operation.environmentId,
      resourceId: operation.resourceId,
      actorId: operation.actorId,
      correlationId: operation.correlationId,
      input: sanitizeControlPlaneValue(operation.input),
      output: sanitizeControlPlaneValue(operation.output),
      error: operation.error,
      attempt: operation.attempt,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      startedAt: operation.startedAt,
      finishedAt: operation.finishedAt,
    }
  }
}
