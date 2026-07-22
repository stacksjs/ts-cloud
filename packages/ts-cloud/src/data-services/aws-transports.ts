import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext } from '../queue'
import type { DBCluster } from '../aws/rds'
import type { DataAction } from './model'
import type { DataProviderTransport } from './adapters'
import { ElastiCacheClient } from '../aws/elasticache'
import { RDSClient } from '../aws/rds'

type Input = Record<string, JsonValue>

const value = (input: Input, key: string): JsonValue | undefined => {
    const desired = input.desiredState
    return (
      input[key] ??
      (desired && typeof desired === 'object' && !Array.isArray(desired)
        ? desired[key]
        : undefined)
    )
  },
  text = (input: Input, key: string, fallback?: string): string | undefined => {
    const result = value(input, key)
    return result == null ? fallback : String(result)
  },
  number = (input: Input, key: string): number | undefined => {
    const result = value(input, key)
    return result == null ? undefined : Number(result)
  },
  boolean = (input: Input, key: string): boolean | undefined => {
    const result = value(input, key)
    return result == null ? undefined : result === true || result === 'true'
  },
  strings = (input: Input, key: string): string[] => {
    const result = value(input, key)
    return Array.isArray(result) ? result.map(String) : []
  },
  snapshotName = (id: string, input: Input): string =>
    text(input, 'snapshotId') ??
    `${id}-final-${new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)}`

function rdsObservation(
  instance: Awaited<ReturnType<RDSClient['describeDBInstance']>>,
): Input {
  if (!instance) throw new Error('RDS instance was not found.')
  return {
    providerId: instance.DBInstanceIdentifier ?? null,
    status: instance.DBInstanceStatus ?? 'unknown',
    engine: instance.Engine ?? null,
    engineVersion: instance.EngineVersion ?? null,
    plan: instance.DBInstanceClass ?? null,
    storageGb: instance.AllocatedStorage ?? null,
    highAvailability: instance.MultiAZ ?? false,
    publicExposure: instance.PubliclyAccessible ?? false,
    endpoint: instance.Endpoint?.Address ?? null,
    port: instance.Endpoint?.Port ?? null,
    username: instance.MasterUsername ?? null,
    database: instance.DBName ?? null,
    encrypted: instance.StorageEncrypted ?? false,
  }
}

export class AwsRdsTransport implements DataProviderTransport {
  constructor(private readonly client: RDSClient = new RDSClient()) {}
  async observe(id: string): Promise<Input> {
    return rdsObservation(await this.client.describeDBInstance(id))
  }
  async apply(input: Input, credential?: string): Promise<Input> {
    const id = String(input.id),
      result = await this.client.createDBInstance({
        DBInstanceIdentifier: id,
        DBInstanceClass: String(input.plan),
        Engine: String(input.engine),
        MasterUsername: text(input, 'username', 'app'),
        MasterUserPassword: credential,
        DBName: text(input, 'database'),
        AllocatedStorage: number(input, 'storageGb'),
        VpcSecurityGroupIds: strings(input, 'securityGroupIds'),
        DBSubnetGroupName: text(input, 'subnetGroup'),
        BackupRetentionPeriod: number(input, 'backupRetentionDays') ?? 7,
        MultiAZ: boolean(input, 'highAvailability'),
        EngineVersion: text(input, 'engineVersion'),
        PubliclyAccessible: boolean(input, 'publicExposure') ?? false,
        StorageType: text(input, 'storageType', 'gp3') as 'gp3',
        StorageEncrypted: true,
        KmsKeyId: text(input, 'kmsKeyId'),
        DeletionProtection: true,
        Tags: [{ Key: 'managed-by', Value: 'ts-cloud' }],
      })
    return rdsObservation(result.DBInstance)
  }
  async execute(
    id: string,
    action: DataAction,
    input: Input,
    credential?: string,
    _context?: QueueExecutionContext,
  ): Promise<Input> {
    if (action === 'observe') return this.observe(id)
    if (action === 'restart') {
      await this.client.rebootDBInstance({ DBInstanceIdentifier: id })
      return { status: 'rebooting' }
    }
    if (action === 'backup') {
      const snapshotId = snapshotName(id, input)
      await this.client.createDBSnapshot({
        DBInstanceIdentifier: id,
        DBSnapshotIdentifier: snapshotId,
      })
      return { status: 'snapshotting', snapshotId }
    }
    if (action === 'delete') {
      if (input.retention === 'retain') return { status: 'retained' }
      const finalSnapshotId = snapshotName(id, input)
      await this.client.modifyDBInstance({
        DBInstanceIdentifier: id,
        DeletionProtection: false,
        ApplyImmediately: true,
      })
      await this.client.deleteDBInstance({
        DBInstanceIdentifier: id,
        SkipFinalSnapshot: false,
        FinalDBSnapshotIdentifier: finalSnapshotId,
        DeleteAutomatedBackups: false,
      })
      return { status: 'deleting', finalSnapshotId }
    }
    if (['resize', 'version', 'rotate', 'expose'].includes(action)) {
      const result = await this.client.modifyDBInstance({
        DBInstanceIdentifier: id,
        DBInstanceClass: text(input, 'plan'),
        AllocatedStorage: number(input, 'storageGb'),
        MasterUserPassword: action === 'rotate' ? credential : undefined,
        EngineVersion: text(input, 'engineVersion'),
        MultiAZ: boolean(input, 'highAvailability'),
        PubliclyAccessible: boolean(input, 'publicExposure'),
        VpcSecurityGroupIds: strings(input, 'securityGroupIds'),
        ApplyImmediately: boolean(input, 'applyImmediately') ?? true,
      })
      return rdsObservation(result.DBInstance)
    }
    throw new Error(
      `RDS action ${action} requires an engine connection runner.`,
    )
  }
}

function clusterObservation(cluster: DBCluster | undefined): Input {
  if (!cluster) throw new Error('Aurora cluster was not found.')
  return {
    providerId: cluster.DBClusterIdentifier ?? null,
    status: cluster.Status ?? 'unknown',
    engine: cluster.Engine ?? null,
    engineVersion: cluster.EngineVersion ?? null,
    endpoint: cluster.Endpoint ?? null,
    readerEndpoint: cluster.ReaderEndpoint ?? null,
    port: cluster.Port ?? null,
    username: cluster.MasterUsername ?? null,
    database: cluster.DatabaseName ?? null,
    encrypted: cluster.StorageEncrypted ?? false,
    highAvailability: cluster.MultiAZ ?? true,
  }
}

export class AwsAuroraTransport implements DataProviderTransport {
  constructor(private readonly client: RDSClient = new RDSClient()) {}
  async observe(id: string): Promise<Input> {
    const result = await this.client.describeDBClusters({
      DBClusterIdentifier: id,
    })
    return clusterObservation(result.DBClusters?.[0])
  }
  async apply(input: Input, credential?: string): Promise<Input> {
    const id = String(input.id),
      engine =
        String(input.engine) === 'postgres'
          ? 'aurora-postgresql'
          : 'aurora-mysql'
    await this.client.createDBCluster({
      DBClusterIdentifier: id,
      Engine: engine,
      EngineVersion: text(input, 'engineVersion'),
      MasterUsername: text(input, 'username', 'app'),
      MasterUserPassword: credential,
      DatabaseName: text(input, 'database'),
      DBSubnetGroupName: text(input, 'subnetGroup'),
      VpcSecurityGroupIds: strings(input, 'securityGroupIds'),
      BackupRetentionPeriod: number(input, 'backupRetentionDays') ?? 7,
      StorageEncrypted: true,
      KmsKeyId: text(input, 'kmsKeyId'),
      DeletionProtection: true,
      ServerlessV2ScalingConfiguration: {
        MinCapacity: number(input, 'minCapacity') ?? 0.5,
        MaxCapacity: number(input, 'maxCapacity') ?? 4,
      },
    })
    await this.client.createDBInstance({
      DBInstanceIdentifier: `${id}-writer-1`,
      DBClusterIdentifier: id,
      DBInstanceClass: String(input.plan || 'db.serverless'),
      Engine: engine,
      PubliclyAccessible: boolean(input, 'publicExposure') ?? false,
    })
    return { status: 'creating', providerId: id }
  }
  async execute(
    id: string,
    action: DataAction,
    input: Input,
    credential?: string,
  ): Promise<Input> {
    if (action === 'observe') return this.observe(id)
    if (action === 'restart') {
      await this.client.rebootDBCluster(id)
      return { status: 'rebooting' }
    }
    if (action === 'backup') {
      const snapshotId = snapshotName(id, input)
      await this.client.createDBClusterSnapshot(id, snapshotId)
      return { status: 'snapshotting', snapshotId }
    }
    if (action === 'delete') {
      if (input.retention === 'retain') return { status: 'retained' }
      const finalSnapshotId = snapshotName(id, input)
      await this.client.modifyDBCluster({
        DBClusterIdentifier: id,
        DeletionProtection: false,
        ApplyImmediately: true,
      })
      await this.client.deleteDBCluster(id, finalSnapshotId)
      return { status: 'deleting', finalSnapshotId }
    }
    if (['resize', 'version', 'rotate'].includes(action)) {
      const result = await this.client.modifyDBCluster({
        DBClusterIdentifier: id,
        ServerlessV2ScalingConfiguration:
          number(input, 'minCapacity') == null &&
          number(input, 'maxCapacity') == null
            ? undefined
            : {
                MinCapacity: number(input, 'minCapacity') ?? 0.5,
                MaxCapacity: number(input, 'maxCapacity') ?? 4,
              },
        EngineVersion: text(input, 'engineVersion'),
        MasterUserPassword: action === 'rotate' ? credential : undefined,
        ApplyImmediately: boolean(input, 'applyImmediately') ?? true,
      })
      return clusterObservation(result.DBCluster)
    }
    throw new Error(
      `Aurora action ${action} requires an engine connection runner.`,
    )
  }
}

export class AwsElastiCacheTransport implements DataProviderTransport {
  constructor(
    private readonly client: ElastiCacheClient = new ElastiCacheClient(),
  ) {}
  async observe(id: string): Promise<Input> {
    const cluster = (await this.client.describeCacheClusters(id))
      .CacheClusters[0]
    if (!cluster) throw new Error('ElastiCache cluster was not found.')
    const endpoint = cluster.CacheNodes?.[0]?.Endpoint
    return {
      providerId: cluster.CacheClusterId,
      status: cluster.CacheClusterStatus,
      engine: cluster.Engine,
      engineVersion: cluster.EngineVersion,
      plan: cluster.CacheNodeType,
      nodes: cluster.NumCacheNodes,
      endpoint: endpoint?.Address ?? null,
      port: endpoint?.Port ?? null,
    }
  }
  async apply(input: Input): Promise<Input> {
    const result = await this.client.createCacheCluster({
      cacheClusterId: String(input.id),
      engine: 'redis',
      cacheNodeType: String(input.plan),
      numCacheNodes: number(input, 'nodes') ?? 1,
      engineVersion: text(input, 'engineVersion'),
      port: number(input, 'port'),
      securityGroupIds: strings(input, 'securityGroupIds'),
      subnetGroupName: text(input, 'subnetGroup'),
      tags: [{ Key: 'managed-by', Value: 'ts-cloud' }],
    })
    return {
      providerId: result.CacheCluster.CacheClusterId,
      status: result.CacheCluster.CacheClusterStatus,
    }
  }
  async execute(id: string, action: DataAction, input: Input): Promise<Input> {
    if (action === 'observe') return this.observe(id)
    if (action === 'restart') {
      const cluster = (await this.client.describeCacheClusters(id))
        .CacheClusters[0]
      await this.client.rebootCacheCluster(
        id,
        cluster?.CacheNodes?.map((node) => node.CacheNodeId) ?? ['0001'],
      )
      return { status: 'rebooting' }
    }
    if (action === 'delete') {
      if (input.retention === 'retain') return { status: 'retained' }
      await this.client.deleteCacheCluster(id)
      return { status: 'deleting' }
    }
    throw new Error(
      `ElastiCache action ${action} is not supported by this cluster mode.`,
    )
  }
}
