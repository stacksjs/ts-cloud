import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext, QueueOperationHandler } from '../queue'
import type {
  DataAction,
  DataEndpoint,
  DataService,
  DataServicePlan,
} from './model'
import { DurableOperationQueue, RetryableOperationError } from '../queue'
import { DataServiceStore } from './store'

export interface SecretBackend {
  put(reference: string, value: string): Promise<void>
  resolve(reference: string): Promise<string>
  remove(reference: string): Promise<void>
}
export interface DataServiceAdapter {
  provider: DataService['provider']
  engines: DataService['engine'][]
  observe(service: DataService): Promise<Record<string, JsonValue>>
  apply(
    service: DataService,
    credential?: string,
    context?: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>>
  action(
    service: DataService,
    action: DataAction,
    input: Record<string, JsonValue>,
    credential: string | undefined,
    context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>>
}
export interface OneTimeCredential {
  username: string
  password: string
  secretRef: string
}
function password(): string {
  const chars =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+='
  const bytes = crypto.getRandomValues(new Uint8Array(40))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}
export function connectionGuidance(
  service: DataService,
  endpoints: DataEndpoint[],
): Array<{ type: string; command: string; secretRef?: string }> {
  return endpoints.map((endpoint) => {
    const host = endpoint.type === 'tunnel' ? '127.0.0.1' : endpoint.host
    const command =
      service.engine === 'redis'
        ? `redis-cli -h ${host} -p ${endpoint.port} --tls`
        : service.engine === 'postgres'
          ? `psql "host=${host} port=${endpoint.port} dbname=${endpoint.database ?? 'postgres'} sslmode=${endpoint.tls ? 'require' : 'prefer'}"`
          : `mysql --host=${host} --port=${endpoint.port} --database=${endpoint.database ?? 'mysql'} --ssl-mode=${endpoint.tls ? 'REQUIRED' : 'PREFERRED'}`
    return { type: endpoint.type, command, secretRef: service.credentialRef }
  })
}
export class DataServiceLifecycle {
  constructor(
    readonly store: DataServiceStore,
    readonly queue: DurableOperationQueue,
    readonly secrets: SecretBackend,
  ) {}
  async create(
    input: Omit<
      DataService,
      | 'id'
      | 'capabilities'
      | 'credentialRef'
      | 'version'
      | 'createdAt'
      | 'updatedAt'
      | 'status'
    > & { username?: string },
  ): Promise<{
    service: DataService
    credential?: OneTimeCredential
    operationId: string
  }> {
    let credential: OneTimeCredential | undefined,
      credentialRef: string | undefined
    if (input.engine !== 'redis') {
      const username = input.username ?? 'app',
        value = password()
      credentialRef = `secret://data-services/${input.projectId}/${input.name}/${username}`
      await this.secrets.put(credentialRef, value)
      credential = { username, password: value, secretRef: credentialRef }
    }
    try {
      const service = this.store.create({
        ...input,
        credentialRef,
        status: 'planning',
      })
      if (credential)
        this.store.saveCredential(
          service.id,
          credential.username,
          credential.secretRef,
        )
      const operation = this.enqueue(service, 'create', {})
      return { service, credential, operationId: operation }
    } catch (error) {
      if (credentialRef) await this.secrets.remove(credentialRef)
      throw error
    }
  }
  plan(
    service: DataService,
    action: DataAction,
    changes: Record<string, JsonValue> = {},
  ): DataServicePlan {
    const capability = service.capabilities.actions[action]
    const major =
      action === 'version' &&
      String(changes.engineVersion ?? '').split('.')[0] !==
        String(service.engineVersion ?? '').split('.')[0]
    return {
      service,
      action,
      capability,
      changes,
      preflight: {
        backupRequired: ['delete', 'restore'].includes(action) || major,
        compatibilityRequired: major,
        typedConfirmation: capability.destructive ? service.name : undefined,
        retentionChoiceRequired: action === 'delete',
      },
      warnings: [
        ...(capability.downtime !== 'none'
          ? [`Downtime is ${capability.downtime}.`]
          : []),
        ...(service.origin === 'adopted' && !service.managementEnabled
          ? [
              'Adopted resource is read-only until management is explicitly enabled.',
            ]
          : []),
      ],
    }
  }
  enqueue(
    service: DataService,
    action: DataAction,
    input: Record<string, JsonValue>,
    actorId?: string,
  ): string {
    const plan = this.plan(service, action, input)
    if (!plan.capability.supported) throw new Error(plan.capability.explanation)
    if (
      service.origin === 'adopted' &&
      !service.managementEnabled &&
      action !== 'observe'
    )
      throw new Error(
        'Adopted resources remain read-only until management is explicitly enabled.',
      )
    if (
      plan.preflight.typedConfirmation &&
      input.confirm !== plan.preflight.typedConfirmation
    )
      throw new Error(
        `Type ${plan.preflight.typedConfirmation} to confirm ${action}.`,
      )
    if (
      plan.preflight.retentionChoiceRequired &&
      !['final_backup', 'retain'].includes(String(input.retention ?? ''))
    )
      throw new Error('Deletion requires retention final_backup or retain.')
    if (
      plan.preflight.compatibilityRequired &&
      (input.compatibilityReviewed !== true || !input.backupId)
    )
      throw new Error(
        'Major version changes require compatibilityReviewed=true and a backupId.',
      )
    return this.queue.enqueue({
      projectId: service.projectId,
      environmentId: service.environmentId,
      resourceId: service.resourceId,
      actorId,
      kind: 'data_service.action',
      input: { serviceId: service.id, action, ...input },
      lockKey: `data-service:${service.id}`,
      providerKey: service.provider,
      maxAttempts: 3,
      timeoutSeconds: 7200,
      retryClasses: ['provider_transient'],
      resumePolicy: 'requeue',
    }).operation.id
  }
  async rotate(
    service: DataService,
    adapter: DataServiceAdapter,
    context: QueueExecutionContext,
  ): Promise<{ credential: OneTimeCredential; dependencies: string[] }> {
    const current = this.store.credential(service.id)
    if (!current)
      throw new Error('Data service credential metadata was not found.')
    const value = password()
    const nextRef = `${current.secretRef}/v${current.version + 1}`
    await this.secrets.put(nextRef, value)
    try {
      await adapter.action(
        service,
        'rotate',
        { username: current.username, secretRef: nextRef },
        value,
        context,
      )
      this.store.saveCredential(service.id, current.username, nextRef)
      this.store.update(service.id, service.version, { credentialRef: nextRef })
      return {
        credential: {
          username: current.username,
          password: value,
          secretRef: nextRef,
        },
        dependencies: this.store
          .dependencies(service.id)
          .filter((item) => item.requiresRedeploy)
          .map((item) => item.resourceId),
      }
    } catch (error) {
      await this.secrets.remove(nextRef)
      throw error
    }
  }
}
export function createDataServiceQueueHandlers(input: {
  store: DataServiceStore
  secrets: SecretBackend
  resolveAdapter: (service: DataService) => DataServiceAdapter | undefined
}): Record<string, QueueOperationHandler> {
  return {
    'data_service.action': async (
      context,
    ): Promise<Record<string, JsonValue>> => {
      const body = context.operation.input as Record<string, JsonValue>,
        service = input.store.get(String(body.serviceId ?? '')),
        action = String(body.action ?? '') as DataAction
      if (!service) throw new Error('Data service was not found.')
      const adapter = input.resolveAdapter(service)
      if (
        !adapter ||
        adapter.provider !== service.provider ||
        !adapter.engines.includes(service.engine)
      )
        throw new Error(
          `No ${service.provider}/${service.engine} adapter is configured.`,
        )
      if (action === 'rotate') {
        const rotated = await new DataServiceLifecycle(
          input.store,
          new DurableOperationQueue(input.store.controlPlane),
          input.secrets,
        ).rotate(service, adapter, context)
        return {
          serviceId: service.id,
          action,
          username: rotated.credential.username,
          secretRef: rotated.credential.secretRef,
          dependencies: rotated.dependencies,
        }
      }
      const credential = service.credentialRef
        ? await input.secrets.resolve(service.credentialRef)
        : undefined
      try {
        const observed =
          action === 'observe'
            ? await adapter.observe(service)
            : action === 'create'
              ? await adapter.apply(service, credential, context)
              : await adapter.action(service, action, body, credential, context)
        const latest = input.store.get(service.id)!
        input.store.update(service.id, latest.version, {
          observedState: observed,
          status:
            action === 'delete'
              ? body.retention === 'retain'
                ? 'retained'
                : 'deleting'
              : 'available',
        })
        return { serviceId: service.id, action, observed }
      } catch (error) {
        const latest = input.store.get(service.id)!
        input.store.update(service.id, latest.version, {
          status: 'failed',
          observedState: {
            ...latest.observedState,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        if (
          /temporar|timeout|unavailable|throttl/i.test(
            error instanceof Error ? error.message : String(error),
          )
        )
          throw new RetryableOperationError(
            error instanceof Error ? error.message : String(error),
            'provider_transient',
          )
        throw error
      }
    },
  }
}
