import { afterEach, describe, expect, it } from 'bun:test'
import type { RDSClient } from '../aws/rds'
import { ControlPlaneStore } from '../control-plane'
import { DataServiceStore } from '../data-services'
import { AwsDatabaseBackupSource } from './aws-database-source'
import { BackupStore } from './store'

const controls: ControlPlaneStore[] = []
function fixture(provider: 'aws_rds' | 'aws_aurora') {
  const control = new ControlPlaneStore({ path: ':memory:' })
  controls.push(control)
  const organization = control.createOrganization({ slug: 'acme', name: 'Acme' }), project = control.createProject({ organizationId: organization.id, slug: 'app', name: 'App' }), environment = control.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' }), data = new DataServiceStore(control), service = data.create({ organizationId: organization.id, projectId: project.id, environmentId: environment.id, name: provider === 'aws_rds' ? 'orders-db' : 'orders-aurora', engine: 'postgres', provider, placement: provider === 'aws_rds' ? 'orders-db' : 'orders-aurora', engineVersion: '16.3', plan: provider === 'aws_rds' ? 'db.t4g.small' : 'db.serverless', highAvailability: provider === 'aws_aurora', publicExposure: false, allowedCidrs: [], desiredState: {}, observedState: {}, status: 'available', origin: 'managed', managementEnabled: true }), backups = new BackupStore(control), destination = backups.createDestination({ organizationId: organization.id, projectId: project.id, name: 'aws-backup', provider: 'aws_backup', endpointPolicy: 'public_https', prefix: '', forcePathStyle: false, encryption: 'provider', immutability: {}, status: 'healthy' }), policy = backups.createPolicy({ organizationId: organization.id, projectId: project.id, environmentId: environment.id, dataServiceId: service.id, destinationId: destination.id, name: `${service.name}-daily`, resourceKind: 'managed_database', schedule: 'daily', timezone: 'UTC', retention: { expireAfterDays: 30 }, compression: 'none', encryption: 'destination', includePatterns: [], excludePatterns: [], expectedRpoMinutes: 1440, expectedRtoMinutes: 120, enabled: true })
  return { control, project, data, service, backups, destination, policy }
}
afterEach(() => { for (const control of controls.splice(0)) control.close() })
const context = {} as any

describe('AWS managed database backup source', () => {
  it('creates, verifies, restores, and deletes RDS snapshots through protected targets', async () => {
    const target = fixture('aws_rds'), calls: Array<[string, any]> = [], client = {
      createDBSnapshot: async (input: any) => { calls.push(['snapshot', input]); return {} },
      describeDBSnapshots: async (input: any) => { calls.push(['verify', input]); return { DBSnapshots: [{ DBSnapshotStatus: 'available', Encrypted: true }] } },
      describeDBInstances: async () => ({ DBInstances: [{ DBInstanceStatus: 'available' }] }),
      restoreDBInstanceFromDBSnapshot: async (input: any) => { calls.push(['restore', input]); return {} },
      modifyDBInstance: async (input: any) => { calls.push(['modify', input]); return {} },
      deleteDBInstance: async (input: any) => { calls.push(['delete-target', input]); return {} },
      deleteDBSnapshot: async (id: string) => { calls.push(['delete-snapshot', id]); return {} },
    } as unknown as RDSClient, source = new AwsDatabaseBackupSource(target.data, client), created = await source.create(target.policy, context)
    expect(created).toMatchObject({ mode: 'external', manifest: { provider: 'aws_rds', sourceId: 'orders-db' }, toolVersion: 'aws-rds-api-2014-10-31' })
    expect(created.mode === 'external' ? created.uri : '').toContain('aws-backup:aws_rds:orders-db:')
    const point = target.backups.createRecoveryPoint({ projectId: target.project.id, policyId: target.policy.id, destinationId: target.destination.id, dataServiceId: target.service.id, kind: 'managed_database', pointInTime: new Date().toISOString(), uri: created.mode === 'external' ? created.uri : '', sizeBytes: 0, checksum: created.mode === 'external' ? created.checksum : '', manifest: created.manifest, engineVersion: created.engineVersion, held: false, pinned: false, status: 'available', verificationState: 'unverified' })
    expect(await source.verifyExternal(point, context)).toMatchObject({ status: 'available', encrypted: true })
    expect(await source.restore(point, undefined, { targetId: 'orders-drill' }, context)).toMatchObject({ targetId: 'orders-drill', isolated: true })
    expect(await source.validateHealth({ targetId: 'orders-drill', provider: 'aws_rds' }, context)).toMatchObject({ healthy: true, status: 'available' })
    await source.cleanup({ targetId: 'orders-drill', provider: 'aws_rds' }, context)
    await source.deleteExternal(point, context)
    expect(calls.find(([kind]) => kind === 'restore')?.[1]).toMatchObject({ PubliclyAccessible: false, DeletionProtection: true })
    expect(calls.slice(-3).map(([kind]) => kind)).toEqual(['modify', 'delete-target', 'delete-snapshot'])
  })

  it('restores Aurora snapshots with a private writer and cleans the isolated cluster', async () => {
    const target = fixture('aws_aurora'), calls: Array<[string, any]> = [], client = {
      createDBClusterSnapshot: async (source: string, snapshot: string) => { calls.push(['snapshot', { source, snapshot }]); return {} },
      describeDBClusterSnapshots: async () => ({ DBClusterSnapshots: [{ Status: 'available', StorageEncrypted: true }] }),
      describeDBClusters: async () => ({ DBClusters: [{ Status: 'available' }] }),
      restoreDBClusterFromSnapshot: async (input: any) => { calls.push(['restore', input]); return {} },
      createDBInstance: async (input: any) => { calls.push(['writer', input]); return {} },
      deleteDBInstance: async (input: any) => { calls.push(['delete-writer', input]); return {} },
      modifyDBCluster: async (input: any) => { calls.push(['modify', input]); return {} },
      deleteDBCluster: async (id: string) => { calls.push(['delete-cluster', id]); return {} },
      deleteDBClusterSnapshot: async (id: string) => { calls.push(['delete-snapshot', id]) },
    } as unknown as RDSClient, source = new AwsDatabaseBackupSource(target.data, client), created = await source.create(target.policy, context), point = target.backups.createRecoveryPoint({ projectId: target.project.id, policyId: target.policy.id, destinationId: target.destination.id, dataServiceId: target.service.id, kind: 'managed_database', pointInTime: new Date().toISOString(), uri: created.mode === 'external' ? created.uri : '', sizeBytes: 0, checksum: created.mode === 'external' ? created.checksum : '', manifest: created.manifest, engineVersion: created.engineVersion, held: false, pinned: false, status: 'available', verificationState: 'verified' })
    await source.restore(point, undefined, { targetId: 'aurora-drill' }, context)
    expect(await source.validateHealth({ targetId: 'aurora-drill', provider: 'aws_aurora' }, context)).toMatchObject({ healthy: true, status: 'available' })
    await source.cleanup({ targetId: 'aurora-drill', provider: 'aws_aurora' }, context)
    expect(calls.map(([kind]) => kind)).toEqual(['snapshot', 'restore', 'writer', 'delete-writer', 'modify', 'delete-cluster'])
    expect(calls.find(([kind]) => kind === 'writer')?.[1]).toMatchObject({ PubliclyAccessible: false })
  })
})
