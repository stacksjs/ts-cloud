import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue, DurableQueueWorker } from '../queue'
import type { BackupDestinationAdapter, BackupSourceAdapter } from './service'
import { BackupCoordinator, createBackupQueueHandlers } from './service'
import { BackupStore } from './store'

const controls: ControlPlaneStore[] = []
const sha = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`
function fixture() {
  const control = new ControlPlaneStore({ path: ':memory:' })
  controls.push(control)
  const organization = control.createOrganization({ slug: 'acme', name: 'Acme' }),
    project = control.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' }),
    environment = control.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' }),
    resource = control.createResource({ projectId: project.id, environmentId: environment.id, slug: 'uploads', name: 'Uploads', kind: 'volume' }),
    clock = { now: new Date('2026-07-21T12:00:00.000Z') },
    store = new BackupStore(control, () => clock.now),
    queue = new DurableOperationQueue(control),
    coordinator = new BackupCoordinator(store, queue, () => clock.now),
    destination = store.createDestination({ organizationId: organization.id, projectId: project.id, name: 'archive', provider: 's3_compatible', endpoint: 'https://objects.example.com/', endpointPolicy: 'public_https', bucket: 'backups', prefix: 'prod', region: 'us-east-1', forcePathStyle: true, credentialRef: 'secret://backup', encryption: 'provider', immutability: {}, status: 'healthy' }),
    policy = store.createPolicy({ organizationId: organization.id, projectId: project.id, environmentId: environment.id, resourceId: resource.id, destinationId: destination.id, name: 'uploads-hourly', resourceKind: 'volume', schedule: 'hourly', timezone: 'UTC', retention: { expireAfterDays: 7 }, compression: 'zstd', encryption: 'destination', includePatterns: [], excludePatterns: [], expectedRpoMinutes: 60, expectedRtoMinutes: 30, enabled: true })
  return { control, organization, project, environment, resource, clock, store, queue, coordinator, destination, policy }
}
afterEach(() => { for (const control of controls.splice(0)) control.close() })

class MemoryDestination implements BackupDestinationAdapter {
  objects = new Map<string, Buffer>()
  corrupt = false
  async upload(_destination: any, input: any) {
    const body = Buffer.from(input.body), checksum = sha(body)
    this.objects.set(input.key, body)
    input.checkpoint?.({ key: input.key, bytesUploaded: body.length })
    return { uri: `s3://backups/${input.key}`, key: input.key, sizeBytes: body.length, checksum, manifest: { format: 'ts-cloud-backup-v1' as const, encrypted: false, plaintextChecksum: checksum, storageChecksum: checksum, contentType: input.contentType ?? 'application/octet-stream' } }
  }
  async download(_destination: any, stored: any) {
    const body = Buffer.from(this.objects.get(stored.key)!)
    if (this.corrupt) body[0] ^= 1
    if (sha(body) !== stored.checksum) throw new Error('Backup checksum verification failed; object is corrupt.')
    return body
  }
  async delete(_destination: any, key: string) { this.objects.delete(key) }
}

function adapters(target: ReturnType<typeof fixture>, overrides: Partial<BackupSourceAdapter> = {}) {
  const restored: string[] = [], cleaned: string[] = [], destination = new MemoryDestination(),
    source: BackupSourceAdapter = {
      create: async policy => ({ mode: 'object', key: `${policy.name}/point.tar.zst`, body: Buffer.from('volume archive'), contentType: 'application/zstd', manifest: { files: 4 }, toolVersion: 'tar 1.35' }),
      restore: async (_point, body, restoreTarget) => { restored.push(`${restoreTarget.path}:${Buffer.from(body!).toString()}`); return { path: String(restoreTarget.path), files: 4 } },
      cleanup: async restoreTarget => { cleaned.push(String(restoreTarget.path)) },
      ...overrides,
    },
    handlers = createBackupQueueHandlers({ store: target.store, queue: target.queue, resolveSource: () => source, resolveDestination: () => destination, validateHealth: async () => ({ healthy: true, check: 'archive readable' }), now: () => target.clock.now })
  return { source, destination, handlers, restored, cleaned }
}

describe('durable backup and recovery lifecycle', () => {
  it('turns a due policy into a verified recovery point and enforces retention', async () => {
    const target = fixture(), runtime = adapters(target)
    target.clock.now = new Date(target.policy.nextRunAt!)
    expect(target.coordinator.enqueueDue()).toHaveLength(1)
    const results = await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    expect(results.map(item => item.terminalState)).toEqual(['succeeded', 'succeeded'])
    const [point] = target.store.listRecoveryPoints(target.project.id)
    expect(point).toMatchObject({ status: 'available', verificationState: 'verified', sizeBytes: 14, manifest: { files: 4 } })
    expect(target.store.coverage(target.project.id)).toMatchObject([{ missedRpo: false, unverified: 0 }])
    target.clock.now = new Date(point.expiresAt!)
    expect(target.coordinator.enqueueRetention()).toHaveLength(1)
    await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    expect(target.store.getRecoveryPoint(point.id)?.status).toBe('deleted')
  })

  it('keeps upload success separate from verification and records corruption', async () => {
    const target = fixture(), runtime = adapters(target), job = target.coordinator.enqueueBackup(target.policy)
    const claimed = target.queue.claim(job.operationId!)!
    await runtime.handlers['backup.run']({ operation: claimed.operation, job: claimed.job, signal: new AbortController().signal, log: () => {}, checkpoint: () => {}, heartbeat: () => {}, throwIfCancelled: () => {} } as any)
    const point = target.store.listRecoveryPoints(target.project.id)[0]
    expect(point.verificationState).toBe('unverified')
    runtime.destination.corrupt = true
    const verification = target.store.listJobs(target.project.id).find(item => item.kind === 'verify')!, verifyClaim = target.queue.claim(verification.operationId!)!
    await expect(runtime.handlers['backup.verify']({ operation: verifyClaim.operation, job: verifyClaim.job, signal: new AbortController().signal, log: () => {}, checkpoint: () => {}, heartbeat: () => {}, throwIfCancelled: () => {} } as any)).rejects.toThrow('corrupt')
    expect(target.store.getRecoveryPoint(point.id)?.verificationState).toBe('corrupt')
  })

  it('runs isolated restore drills with health validation and cleanup', async () => {
    const target = fixture(), runtime = adapters(target)
    target.coordinator.enqueueBackup(target.policy)
    await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    const point = target.store.listRecoveryPoints(target.project.id)[0], drill = target.coordinator.enqueueRestore(point, { mode: 'isolated', target: { path: '/restore/drill-1' }, targetName: 'drill-1', drill: true })
    await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    expect(target.store.getJob(drill.id)).toMatchObject({ status: 'succeeded', healthResult: { healthy: true } })
    expect(runtime.restored).toEqual(['/restore/drill-1:volume archive'])
    expect(runtime.cleaned).toEqual(['/restore/drill-1'])
  })

  it('keeps failed drill cleanup visible for operator reconciliation', async () => {
    const target = fixture(), runtime = adapters(target, {
      restore: async () => { throw new Error('restore validation failed') },
      cleanup: async () => { throw new Error('provider cleanup failed') },
    })
    target.coordinator.enqueueBackup(target.policy)
    await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    const point = target.store.listRecoveryPoints(target.project.id)[0], drill = target.coordinator.enqueueRestore(point, { mode: 'isolated', target: { path: '/restore/failed-drill' }, targetName: 'failed-drill', drill: true })
    await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    expect(target.store.getJob(drill.id)).toMatchObject({ status: 'cleanup_required', error: 'restore validation failed' })
  })

  it('requires recent auth, exact confirmation, downtime acknowledgement, and a distinct safety backup for in-place restore', async () => {
    const target = fixture(), runtime = adapters(target)
    target.coordinator.enqueueBackup(target.policy, '2026-07-21T10:00:00.000Z')
    await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    target.coordinator.enqueueBackup(target.policy, '2026-07-21T11:00:00.000Z')
    await new DurableQueueWorker(target.queue, runtime.handlers).drain()
    const [point, safety] = target.store.listRecoveryPoints(target.project.id)
    expect(() => target.coordinator.enqueueRestore(point, { mode: 'in_place', target: { path: '/uploads' }, targetName: 'uploads', confirm: 'uploads', downtimeAcknowledged: true, safetyBackupId: safety.id })).toThrow('recent authentication')
    const restore = target.coordinator.enqueueRestore(point, { mode: 'in_place', target: { path: '/uploads' }, targetName: 'uploads', confirm: 'uploads', recentAuth: true, downtimeAcknowledged: true, safetyBackupId: safety.id })
    expect(restore).toMatchObject({ restoreMode: 'in_place', safetyBackupId: safety.id, status: 'queued' })
  })
})
