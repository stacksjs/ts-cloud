import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue, DurableQueueWorker } from '../queue'
import {
  AwsAuroraDataAdapter,
  AwsElastiCacheDataAdapter,
  DataServiceLifecycle,
  DataServiceStore,
  ServerDataAdapter,
  connectionGuidance,
  createDataServiceQueueHandlers,
  dataServiceCapabilities,
  type DataProviderTransport,
  type SecretBackend,
} from '.'

const controls: ControlPlaneStore[] = []
function fixture() {
  const control = new ControlPlaneStore({ path: ':memory:' })
  controls.push(control)
  const organization = control.createOrganization({
      slug: 'acme',
      name: 'Acme',
    }),
    project = control.createProject({
      organizationId: organization.id,
      slug: 'app',
      name: 'App',
    }),
    environment = control.createEnvironment({
      projectId: project.id,
      slug: 'production',
      name: 'Production',
      kind: 'production',
    }),
    resource = control.createResource({
      projectId: project.id,
      environmentId: environment.id,
      slug: 'api',
      name: 'API',
      kind: 'application',
    }),
    store = new DataServiceStore(control),
    queue = new DurableOperationQueue(control),
    values = new Map<string, string>(),
    secrets: SecretBackend = {
      put: async (k, v) => {
        values.set(k, v)
      },
      resolve: async (k) => {
        const value = values.get(k)
        if (!value) throw new Error('secret unavailable')
        return value
      },
      remove: async (k) => {
        values.delete(k)
      },
    }
  return {
    control,
    organization,
    project,
    environment,
    resource,
    store,
    queue,
    secrets,
    values,
  }
}
afterEach(() => {
  for (const control of controls.splice(0)) control.close()
})

describe('data service capability model', () => {
  it('explains provider and engine differences before mutation', () => {
    expect(
      dataServiceCapabilities('postgres', 'aws_aurora').actions,
    ).toMatchObject({
      backup: { supported: true },
      slow_queries: { supported: false },
      delete: { destructive: true, downtime: 'required' },
    })
    expect(
      dataServiceCapabilities('redis', 'aws_elasticache').actions,
    ).toMatchObject({
      backup: { supported: false },
      users: { supported: false },
      resize: { supported: true },
    })
    expect(
      dataServiceCapabilities('postgres', 'container').actions,
    ).toMatchObject({
      databases: { supported: true },
      logs: { supported: true },
      expose: { supported: false },
      version: { supported: false },
    })
  })
  it('generates secret-free connection guidance', () => {
    const target = fixture(),
      service = target.store.create({
        organizationId: target.organization.id,
        projectId: target.project.id,
        environmentId: target.environment.id,
        name: 'primary-db',
        engine: 'postgres',
        provider: 'aws_aurora',
        placement: 'cluster-1',
        engineVersion: '16',
        plan: 'serverless-v2',
        storageGb: 20,
        highAvailability: true,
        publicExposure: false,
        allowedCidrs: [],
        desiredState: {},
        observedState: {},
        credentialRef: 'secret://db',
        status: 'available',
        origin: 'managed',
        managementEnabled: true,
      })
    expect(
      connectionGuidance(service, [
        {
          type: 'internal',
          host: 'db.internal',
          port: 5432,
          database: 'app',
          tls: true,
        },
      ]),
    ).toEqual([
      {
        type: 'internal',
        command: 'psql "host=db.internal port=5432 dbname=app sslmode=require"',
        secretRef: 'secret://db',
      },
    ])
  })
})

describe('data service lifecycle', () => {
  it('requires a typed, distinct, explicit restore target', () => {
    const target = fixture(),
      service = target.store.create({
        organizationId: target.organization.id,
        projectId: target.project.id,
        environmentId: target.environment.id,
        name: 'primary-db',
        engine: 'postgres',
        provider: 'aws_rds',
        placement: 'primary-db',
        plan: 'db.t4g.small',
        highAvailability: false,
        publicExposure: false,
        allowedCidrs: [],
        desiredState: {},
        observedState: {},
        status: 'available',
        origin: 'managed',
        managementEnabled: true,
      }),
      lifecycle = new DataServiceLifecycle(
        target.store,
        target.queue,
        target.secrets,
      )
    expect(() =>
      lifecycle.enqueue(service, 'restore', { confirm: 'primary-db' }),
    ).toThrow('backupId and targetId')
    expect(() =>
      lifecycle.enqueue(service, 'restore', {
        confirm: 'primary-db',
        backupId: 'snapshot-1',
        targetId: 'primary-db',
      }),
    ).toThrow('must differ')
    expect(
      lifecycle.enqueue(service, 'restore', {
        confirm: 'primary-db',
        backupId: 'snapshot-1',
        targetId: 'primary-restored',
      }),
    ).toBeString()
  })
  it('runs create, observe, atomic credential rotation, backup, and safe retained deletion', async () => {
    const target = fixture(),
      calls: Array<{ action: string; password?: string }> = [],
      transport: DataProviderTransport = {
        observe: async (id) => ({
          id,
          status: 'available',
          endpoints: [
            { type: 'internal', host: 'db.internal', port: 5432, tls: true },
          ],
        }),
        apply: async (input, password) => {
          calls.push({ action: 'create', password })
          return { ...input, status: 'available' }
        },
        execute: async (_id, action, _input, password) => {
          calls.push({ action, password })
          return {
            status: action === 'delete' ? 'retained' : 'available',
            action,
          }
        },
      },
      adapter = new AwsAuroraDataAdapter(transport),
      lifecycle = new DataServiceLifecycle(
        target.store,
        target.queue,
        target.secrets,
      ),
      created = await lifecycle.create({
        organizationId: target.organization.id,
        projectId: target.project.id,
        environmentId: target.environment.id,
        resourceId: target.resource.id,
        name: 'primary-db',
        engine: 'postgres',
        provider: 'aws_aurora',
        placement: 'cluster-1',
        engineVersion: '16.2',
        plan: 'serverless-v2',
        storageGb: 20,
        highAvailability: true,
        publicExposure: false,
        allowedCidrs: [],
        desiredState: {},
        observedState: {},
        origin: 'managed',
        managementEnabled: true,
        ownerActorId: undefined,
      })
    expect(created.credential?.password).toHaveLength(40)
    expect(JSON.stringify(target.store.get(created.service.id))).not.toContain(
      created.credential!.password,
    )
    const worker = new DurableQueueWorker(
      target.queue,
      createDataServiceQueueHandlers({
        store: target.store,
        secrets: target.secrets,
        resolveAdapter: () => adapter,
      }),
    )
    await worker.drain()
    expect(target.store.get(created.service.id)?.status).toBe('available')
    target.store.addDependency({
      serviceId: created.service.id,
      resourceId: target.resource.id,
      secretRef: created.credential!.secretRef,
      requiresRedeploy: true,
    })
    const current = target.store.get(created.service.id)!
    const rotateId = lifecycle.enqueue(current, 'rotate', {}),
      claimed = target.queue.claim(rotateId)!
    const handler = createDataServiceQueueHandlers({
      store: target.store,
      secrets: target.secrets,
      resolveAdapter: () => adapter,
    })['data_service.action']
    const rotation = (await handler({
      operation: claimed.operation,
      job: claimed.job,
      signal: new AbortController().signal,
      log: () => {},
      checkpoint: () => {},
      heartbeat: () => {},
      throwIfCancelled: () => {},
    } as any)) as any
    expect(rotation).toMatchObject({
      secretRef: expect.stringContaining('/v2'),
      dependencies: [target.resource.id],
    })
    for (const secret of target.values.values())
      expect(JSON.stringify(rotation)).not.toContain(secret)
    target.queue.complete(rotateId, rotation)
    const rotated = target.store.get(created.service.id)!
    lifecycle.enqueue(rotated, 'backup', {})
    await worker.drain()
    expect(() =>
      lifecycle.enqueue(target.store.get(created.service.id)!, 'delete', {
        confirm: 'wrong',
        retention: 'retain',
      }),
    ).toThrow('Type primary-db')
    const service = target.store.get(created.service.id)!
    lifecycle.enqueue(service, 'delete', {
      confirm: 'primary-db',
      retention: 'retain',
    })
    await worker.drain()
    expect(target.store.get(created.service.id)?.status).toBe('retained')
    expect(calls.map((x) => x.action)).toEqual([
      'create',
      'rotate',
      'backup',
      'delete',
    ])
  })
  it('keeps adopted services read-only until an explicit reviewed enablement', () => {
    const target = fixture(),
      service = target.store.create({
        organizationId: target.organization.id,
        projectId: target.project.id,
        environmentId: target.environment.id,
        name: 'adopted-cache',
        engine: 'redis',
        provider: 'aws_elasticache',
        placement: 'cache-1',
        plan: 'cache.t4g.micro',
        highAvailability: false,
        publicExposure: false,
        allowedCidrs: [],
        desiredState: {},
        observedState: { status: 'available' },
        status: 'adopted',
        origin: 'adopted',
        managementEnabled: false,
      })
    const lifecycle = new DataServiceLifecycle(
      target.store,
      target.queue,
      target.secrets,
    )
    expect(() => lifecycle.enqueue(service, 'restart', {})).toThrow('read-only')
    expect(lifecycle.plan(service, 'restart').warnings.join(' ')).toContain(
      'read-only',
    )
  })
  it('supports coherent on-box Postgres/MySQL and Redis adapter contracts', () => {
    const transport = {} as DataProviderTransport
    expect(new ServerDataAdapter(transport).engines).toEqual(
      expect.arrayContaining(['postgres', 'mysql', 'redis']),
    )
    expect(new AwsElastiCacheDataAdapter(transport).engines).toEqual(['redis'])
    expect(
      dataServiceCapabilities('redis', 'aws_elasticache').actions.rotate
        .supported,
    ).toBe(false)
  })
})
