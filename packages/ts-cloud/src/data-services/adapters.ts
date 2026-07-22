import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext } from '../queue'
import type { DataAction, DataService } from './model'
import type { DataServiceAdapter } from './service'

export interface DataProviderTransport {
  observe(id: string): Promise<Record<string, JsonValue>>
  apply(input: Record<string, JsonValue>, credential?: string): Promise<Record<string, JsonValue>>
  execute(
    id: string,
    action: DataAction,
    input: Record<string, JsonValue>,
    credential?: string,
    context?: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>>
}
abstract class TransportAdapter implements DataServiceAdapter {
  abstract provider: DataService['provider']
  abstract engines: DataService['engine'][]
  constructor(protected transport: DataProviderTransport) {}
  observe(service: DataService): Promise<Record<string, JsonValue>> {
    return this.transport.observe(service.placement)
  }
  apply(service: DataService, credential?: string): Promise<Record<string, JsonValue>> {
    return this.transport.apply(
      {
        id: service.placement,
        name: service.name,
        engine: service.engine,
        engineVersion: service.engineVersion ?? null,
        plan: service.plan,
        storageGb: service.storageGb ?? null,
        highAvailability: service.highAvailability,
        publicExposure: service.publicExposure,
        allowedCidrs: service.allowedCidrs,
        username: service.desiredState.username ?? 'app',
        desiredState: service.desiredState,
      },
      credential,
    )
  }
  action(
    service: DataService,
    action: DataAction,
    input: Record<string, JsonValue>,
    credential: string | undefined,
    context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    return this.transport.execute(
      service.placement,
      action,
      {
        engine: service.engine,
        engineVersion: service.engineVersion ?? null,
        plan: service.plan,
        desiredState: service.desiredState,
        ...input,
      },
      credential,
      context,
    )
  }
}
export class AwsRdsDataAdapter extends TransportAdapter {
  provider = 'aws_rds' as const
  engines = ['postgres', 'mysql', 'mariadb'] as DataService['engine'][]
}
export class AwsAuroraDataAdapter extends TransportAdapter {
  provider = 'aws_aurora' as const
  engines = ['postgres', 'mysql'] as DataService['engine'][]
}
export class AwsElastiCacheDataAdapter extends TransportAdapter {
  provider = 'aws_elasticache' as const
  engines = ['redis'] as DataService['engine'][]
}
export class ServerDataAdapter extends TransportAdapter {
  provider = 'server' as const
  engines = ['postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'libsql'] as DataService['engine'][]
}
export class ContainerDataAdapter extends TransportAdapter {
  provider = 'container' as const
  engines = ['postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'libsql'] as DataService['engine'][]
}
