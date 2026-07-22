import { describe, expect, it } from 'bun:test'
import type { ElastiCacheClient } from '../aws/elasticache'
import type { RDSClient } from '../aws/rds'
import { AwsAuroraTransport, AwsElastiCacheTransport, AwsRdsTransport } from './aws-transports'

describe('AWS data-service transports', () => {
  it('creates encrypted, deletion-protected RDS and deletes through a final snapshot', async () => {
    const calls: Array<[string, unknown]> = [],
      client = {
        createDBInstance: async (input: any) => {
          calls.push(['create', input])
          return {
            DBInstance: {
              DBInstanceIdentifier: input.DBInstanceIdentifier,
              DBInstanceStatus: 'creating',
              Engine: input.Engine,
            },
          }
        },
        modifyDBInstance: async (input: any) => {
          calls.push(['modify', input])
          return {
            DBInstance: { DBInstanceIdentifier: input.DBInstanceIdentifier },
          }
        },
        deleteDBInstance: async (input: any) => {
          calls.push(['delete', input])
          return {}
        },
      } as unknown as RDSClient,
      transport = new AwsRdsTransport(client)
    await transport.apply(
      {
        id: 'orders-db',
        engine: 'postgres',
        plan: 'db.t4g.micro',
        storageGb: 20,
        publicExposure: false,
        desiredState: { subnetGroup: 'private', securityGroupIds: ['sg-db'] },
      },
      'generated-password',
    )
    expect(calls[0]).toEqual([
      'create',
      expect.objectContaining({
        StorageEncrypted: true,
        DeletionProtection: true,
        PubliclyAccessible: false,
        MasterUserPassword: 'generated-password',
      }),
    ])
    await transport.execute('orders-db', 'delete', {
      retention: 'final_backup',
      snapshotId: 'orders-final',
    })
    expect(calls.slice(1)).toEqual([
      ['modify', expect.objectContaining({ DeletionProtection: false })],
      [
        'delete',
        expect.objectContaining({
          SkipFinalSnapshot: false,
          FinalDBSnapshotIdentifier: 'orders-final',
        }),
      ],
    ])
  })

  it('provisions Aurora as a protected cluster followed by a writer', async () => {
    const calls: Array<[string, unknown]> = [],
      client = {
        createDBCluster: async (input: any) => {
          calls.push(['cluster', input])
          return { DBCluster: {} }
        },
        createDBInstance: async (input: any) => {
          calls.push(['instance', input])
          return { DBInstance: {} }
        },
      } as unknown as RDSClient
    await new AwsAuroraTransport(client).apply(
      {
        id: 'app-aurora',
        engine: 'postgres',
        plan: 'db.serverless',
        desiredState: { minCapacity: 0.5, maxCapacity: 8 },
      },
      'generated-password',
    )
    expect(calls).toEqual([
      [
        'cluster',
        expect.objectContaining({
          Engine: 'aurora-postgresql',
          StorageEncrypted: true,
          DeletionProtection: true,
          ServerlessV2ScalingConfiguration: {
            MinCapacity: 0.5,
            MaxCapacity: 8,
          },
        }),
      ],
      [
        'instance',
        expect.objectContaining({
          DBClusterIdentifier: 'app-aurora',
          DBInstanceIdentifier: 'app-aurora-writer-1',
        }),
      ],
    ])
  })

  it('restores RDS and Aurora snapshots only into new private protected targets', async () => {
    const rdsCalls: any[] = [],
      rds = {
        restoreDBInstanceFromDBSnapshot: async (input: any) => {
          rdsCalls.push(input)
          return {
            DBInstance: {
              DBInstanceIdentifier: input.DBInstanceIdentifier,
              DBInstanceStatus: 'creating',
            },
          }
        },
      } as unknown as RDSClient
    expect(
      await new AwsRdsTransport(rds).execute('orders', 'restore', {
        backupId: 'orders-snapshot',
        targetId: 'orders-restored',
        plan: 'db.t4g.small',
      }),
    ).toMatchObject({
      providerId: 'orders-restored',
      restoreTargetId: 'orders-restored',
      sourceId: 'orders',
    })
    expect(rdsCalls[0]).toMatchObject({
      DBInstanceIdentifier: 'orders-restored',
      DBSnapshotIdentifier: 'orders-snapshot',
      PubliclyAccessible: false,
      DeletionProtection: true,
    })

    const auroraCalls: Array<[string, any]> = [],
      aurora = {
        restoreDBClusterFromSnapshot: async (input: any) => {
          auroraCalls.push(['restore', input])
          return {
            DBCluster: {
              DBClusterIdentifier: input.DBClusterIdentifier,
              Status: 'creating',
            },
          }
        },
        createDBInstance: async (input: any) => {
          auroraCalls.push(['writer', input])
          return { DBInstance: {} }
        },
      } as unknown as RDSClient
    expect(
      await new AwsAuroraTransport(aurora).execute('primary', 'restore', {
        backupId: 'primary-snapshot',
        targetId: 'primary-restored',
        engine: 'postgres',
        plan: 'db.serverless',
      }),
    ).toMatchObject({
      providerId: 'primary-restored',
      restoreTargetId: 'primary-restored',
      sourceId: 'primary',
    })
    expect(auroraCalls).toEqual([
      [
        'restore',
        expect.objectContaining({
          DBClusterIdentifier: 'primary-restored',
          SnapshotIdentifier: 'primary-snapshot',
          Engine: 'aurora-postgresql',
          DeletionProtection: true,
        }),
      ],
      [
        'writer',
        expect.objectContaining({
          DBClusterIdentifier: 'primary-restored',
          PubliclyAccessible: false,
        }),
      ],
    ])
  })

  it('keeps ElastiCache private and retains it without a provider mutation', async () => {
    let creates = 0,
      deletes = 0
    const client = {
      createCacheCluster: async (input: any) => {
        creates++
        expect(input.securityGroupIds).toEqual(['sg-cache'])
        return {
          CacheCluster: {
            CacheClusterId: input.cacheClusterId,
            CacheClusterStatus: 'creating',
          },
        }
      },
      deleteCacheCluster: async () => {
        deletes++
      },
    } as unknown as ElastiCacheClient
    const transport = new AwsElastiCacheTransport(client)
    expect(
      await transport.apply({
        id: 'sessions',
        plan: 'cache.t4g.micro',
        desiredState: { securityGroupIds: ['sg-cache'] },
      }),
    ).toMatchObject({ status: 'creating' })
    expect(await transport.execute('sessions', 'delete', { retention: 'retain' })).toEqual({ status: 'retained' })
    expect({ creates, deletes }).toEqual({ creates: 1, deletes: 0 })
  })
})
