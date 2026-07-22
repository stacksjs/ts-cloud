import { afterEach, describe, expect, it } from 'bun:test'
import type { SecretBackend } from '../data-services'
import { ControlPlaneStore } from '../control-plane'
import { DataServiceStore } from '../data-services'
import { LogicalDatabaseBackupSource } from './logical-database-source'
import { BackupStore } from './store'

const controls: ControlPlaneStore[] = []
afterEach(() => {
  for (const control of controls.splice(0)) control.close()
})

describe('logical database backup source', () => {
  it('uses a referenced credential to restore and validate an isolated service', async () => {
    const control = new ControlPlaneStore({ path: ':memory:' })
    controls.push(control)
    const organization = control.createOrganization({ slug: 'acme', name: 'Acme' }),
      project = control.createProject({ organizationId: organization.id, slug: 'app', name: 'App' }),
      services = new DataServiceStore(control),
      service = services.create({
        organizationId: organization.id,
        projectId: project.id,
        name: 'orders-db',
        engine: 'postgres',
        provider: 'container',
        placement: 'local',
        engineVersion: '17',
        plan: 'small',
        highAvailability: false,
        publicExposure: false,
        allowedCidrs: [],
        desiredState: {},
        observedState: {},
        credentialRef: 'secret://data-services/app/orders-db',
        status: 'available',
        origin: 'managed',
        managementEnabled: true,
      }),
      backups = new BackupStore(control),
      destination = backups.createDestination({
        organizationId: organization.id,
        projectId: project.id,
        name: 'archive',
        provider: 'aws_s3',
        endpointPolicy: 'public_https',
        bucket: 'backups',
        prefix: '',
        forcePathStyle: false,
        encryption: 'provider',
        immutability: {},
        status: 'healthy',
      }),
      policy = backups.createPolicy({
        organizationId: organization.id,
        projectId: project.id,
        dataServiceId: service.id,
        destinationId: destination.id,
        name: 'orders-daily',
        resourceKind: 'logical_database',
        schedule: 'daily',
        timezone: 'UTC',
        retention: { keepLast: 7 },
        compression: 'gzip',
        encryption: 'both',
        includePatterns: [],
        excludePatterns: [],
        expectedRpoMinutes: 1440,
        expectedRtoMinutes: 60,
        enabled: true,
      }),
      calls: Array<Record<string, unknown>> = [],
      transport = {
        exportLogicalBackup: async (id: string) => ({
          body: new TextEncoder().encode('-- dump'),
          engine: 'postgres' as const,
          database: 'orders',
          username: 'app',
          engineVersion: '17',
        }),
        restoreLogicalBackup: async (input: Record<string, unknown>) => {
          calls.push(input)
          return { status: 'available', healthy: true }
        },
        removeRestoredService: async (id: string) => calls.push({ cleanup: id }),
      },
      secrets: SecretBackend = {
        put: async () => {},
        resolve: async () => 'resolved-password',
        remove: async () => {},
      },
      source = new LogicalDatabaseBackupSource(services, secrets, transport as any),
      created = await source.create(policy, {} as any)
    expect(created).toMatchObject({
      mode: 'object',
      manifest: { engine: 'postgres', sourceDataServiceId: service.id },
    })
    await source.restore(
      {
        dataServiceId: service.id,
        manifest: created.manifest,
      } as any,
      created.mode === 'object' ? created.body : undefined,
      { targetId: 'orders-drill' },
      {} as any,
    )
    expect(Buffer.from(calls[0].body as Uint8Array).toString()).toBe('-- dump')
    expect(calls[0]).toMatchObject({
      sourceId: service.id,
      targetId: 'orders-drill',
      credential: 'resolved-password',
      inPlace: false,
    })
    await source.cleanup({ targetId: 'orders-drill' }, {} as any)
    expect(calls[1]).toEqual({ cleanup: 'orders-drill' })
  })
})
