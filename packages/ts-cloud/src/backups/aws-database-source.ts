import type { QueueExecutionContext } from '../queue'
import type { BackupPolicy, RecoveryPoint } from './model'
import type { BackupSourceAdapter, BackupSourceResult } from './service'
import type { DataServiceStore } from '../data-services'
import type { JsonValue } from '../control-plane'
import { createHash } from 'node:crypto'
import { RDSClient } from '../aws/rds'

const checksum = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

export class AwsDatabaseBackupSource implements BackupSourceAdapter {
  constructor(
    private readonly dataServices: DataServiceStore,
    private readonly client: RDSClient = new RDSClient(),
  ) {}

  private service(policy: BackupPolicy) {
    const service = policy.dataServiceId
      ? this.dataServices.get(policy.dataServiceId)
      : undefined
    if (!service || !['aws_rds', 'aws_aurora'].includes(service.provider))
      throw new Error(
        'Managed database backup policy requires an RDS or Aurora data service.',
      )
    return service
  }

  async create(
    policy: BackupPolicy,
    _context: QueueExecutionContext,
  ): Promise<BackupSourceResult> {
    const service = this.service(policy),
      snapshotId = `${service.placement}-${new Date()
        .toISOString()
        .replace(/[^0-9]/g, '')
        .slice(0, 14)}`
    if (service.provider === 'aws_aurora')
      await this.client.createDBClusterSnapshot(service.placement, snapshotId)
    else
      await this.client.createDBSnapshot({
        DBInstanceIdentifier: service.placement,
        DBSnapshotIdentifier: snapshotId,
      })
    const identity = `${service.provider}:${service.placement}:${snapshotId}`
    return {
      mode: 'external',
      uri: `aws-backup:${identity}`,
      checksum: checksum(identity),
      sizeBytes: 0,
      manifest: {
        provider: service.provider,
        sourceId: service.placement,
        snapshotId,
        plan: service.plan,
        engine: service.engine,
      },
      engineVersion: service.engineVersion,
      toolVersion: 'aws-rds-api-2014-10-31',
    }
  }

  async verifyExternal(
    point: RecoveryPoint,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const snapshotId = String(point.manifest.snapshotId ?? ''),
      provider = String(point.manifest.provider ?? '')
    if (!snapshotId) throw new Error('Snapshot recovery point has no snapshot ID.')
    const snapshot =
      provider === 'aws_aurora'
        ? (
            await this.client.describeDBClusterSnapshots({
              DBClusterSnapshotIdentifier: snapshotId,
            })
          ).DBClusterSnapshots[0]
        : (
            await this.client.describeDBSnapshots({
              DBSnapshotIdentifier: snapshotId,
            })
          ).DBSnapshots?.[0]
    if (!snapshot) throw new Error('Provider snapshot was not found.')
    const metadata = snapshot as Record<string, any>,
      status = String(metadata.Status ?? metadata.DBSnapshotStatus ?? 'unknown')
    if (status !== 'available')
      throw new Error(`Provider snapshot is ${status}; verification is pending.`)
    return {
      snapshotId,
      status,
      encrypted: metadata.Encrypted ?? metadata.StorageEncrypted ?? true,
    }
  }

  async restore(
    point: RecoveryPoint,
    _body: Uint8Array | undefined,
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<Record<string, JsonValue>> {
    const targetId = String(target.targetId ?? ''),
      snapshotId = String(point.manifest.snapshotId ?? ''),
      provider = String(point.manifest.provider ?? '')
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(targetId))
      throw new Error('Managed restore requires a valid distinct targetId.')
    if (targetId === point.manifest.sourceId)
      throw new Error('Managed restore target must differ from its source.')
    if (provider === 'aws_aurora') {
      const engine =
        point.manifest.engine === 'postgres'
          ? 'aurora-postgresql'
          : 'aurora-mysql'
      await this.client.restoreDBClusterFromSnapshot({
        DBClusterIdentifier: targetId,
        SnapshotIdentifier: snapshotId,
        Engine: engine,
        EngineVersion: point.engineVersion,
        DeletionProtection: true,
        ServerlessV2ScalingConfiguration: {
          MinCapacity: Number(target.minCapacity) || 0.5,
          MaxCapacity: Number(target.maxCapacity) || 4,
        },
      })
      await this.client.createDBInstance({
        DBInstanceIdentifier: `${targetId}-writer-1`,
        DBClusterIdentifier: targetId,
        DBInstanceClass: String(target.plan ?? point.manifest.plan ?? 'db.serverless'),
        Engine: engine,
        PubliclyAccessible: false,
      })
    } else
      await this.client.restoreDBInstanceFromDBSnapshot({
        DBInstanceIdentifier: targetId,
        DBSnapshotIdentifier: snapshotId,
        DBInstanceClass: String(target.plan ?? point.manifest.plan ?? ''),
        PubliclyAccessible: false,
        DeletionProtection: true,
        Tags: [{ Key: 'managed-by', Value: 'ts-cloud-restore' }],
      })
    return { targetId, status: 'creating', isolated: true }
  }

  async cleanup(
    target: Record<string, JsonValue>,
    _context: QueueExecutionContext,
  ): Promise<void> {
    const targetId = String(target.targetId ?? ''),
      provider = String(target.provider ?? '')
    if (!targetId) throw new Error('Restore cleanup target is required.')
    if (provider === 'aws_aurora') {
      await this.client.deleteDBInstance({
        DBInstanceIdentifier: `${targetId}-writer-1`,
        SkipFinalSnapshot: true,
      })
      await this.client.modifyDBCluster({
        DBClusterIdentifier: targetId,
        DeletionProtection: false,
        ApplyImmediately: true,
      })
      await this.client.deleteDBCluster(targetId)
    } else {
      await this.client.modifyDBInstance({
        DBInstanceIdentifier: targetId,
        DeletionProtection: false,
        ApplyImmediately: true,
      })
      await this.client.deleteDBInstance({
        DBInstanceIdentifier: targetId,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      })
    }
  }

  async deleteExternal(
    point: RecoveryPoint,
    _context: QueueExecutionContext,
  ): Promise<void> {
    const snapshotId = String(point.manifest.snapshotId ?? '')
    if (point.manifest.provider === 'aws_aurora')
      await this.client.deleteDBClusterSnapshot(snapshotId)
    else await this.client.deleteDBSnapshot(snapshotId)
  }
}
