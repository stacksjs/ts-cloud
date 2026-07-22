import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackupStore } from '../backups'
import { ControlPlaneStore } from '../control-plane'
import { hashPassword } from './dashboard-auth'
import { startLocalDashboardServer } from './local-dashboard-server'
import { saveUsers } from './dashboard-users'

let root: string | undefined
let running: Awaited<ReturnType<typeof startLocalDashboardServer>> | undefined

afterEach(() => {
  running?.server.stop(true)
  running = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('dashboard recovery integration', () => {
  it('creates scoped destinations and policies, queues work, and plans guarded restores', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-backups-'))
    saveUsers(root, [{
      username: 'owner',
      passwordHash: hashPassword('correct horse battery staple'),
      role: 'admin',
      sites: {},
      createdAt: new Date().toISOString(),
    }])
    running = await startLocalDashboardServer({
      cwd: root,
      host: '127.0.0.1',
      port: 0,
      queueWorker: false,
      config: {
        project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
        environments: { production: { type: 'production' } },
        sites: { api: { domain: 'api.example.com', root: 'dist' } },
      } as any,
    })
    const base = running.url.replace(/\/$/, ''),
      call = (path: string, init?: RequestInit) => running!.server.fetch(new Request(`${base}${path}`, init)),
      login = await call('/api/login', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
      }),
      session = login.headers.get('set-cookie')?.split(';')[0] ?? '',
      headers = { origin: base, cookie: session, 'content-type': 'application/json' },
      credential = { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
      encryptionKey = 'a-recovery-key-with-at-least-thirty-two-characters',
      destinationResponse = await call('/api/backups/destinations?env=production', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'recovery-archive',
          provider: 's3_compatible',
          endpoint: 'https://objects.example.com',
          bucket: 'recovery',
          forcePathStyle: true,
          encryption: 'both',
          credentials: credential,
          encryptionKey,
        }),
      })
    expect(destinationResponse.status).toBe(201)
    const destination = (await destinationResponse.json() as any).destination
    expect(destination).toMatchObject({
      name: 'recovery-archive',
      credentialsConfigured: true,
      clientEncryptionConfigured: true,
    })
    expect(destination.credentialRef).toBeUndefined()
    expect(destination.encryptionKeyRef).toBeUndefined()

    const scopedControl = new ControlPlaneStore({ cwd: root }),
      project = scopedControl.getProjectBySlug('acme')!,
      production = scopedControl.getEnvironmentBySlug(project.id, 'production')!,
      resource = scopedControl.listResources(project.id, production.id)[0]
    scopedControl.close()

    const policyResponse = await call('/api/backups/policies?env=production', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        destinationId: destination.id,
        name: 'orders-volume-hourly',
        resourceKind: 'volume',
        resourceId: resource.id,
        volumeName: 'orders-data',
        schedule: 'hourly',
        expectedRpoMinutes: 60,
        retention: { keepLast: 24, expireAfterDays: 7 },
      }),
    })
    expect(policyResponse.status).toBe(201)
    const policy = (await policyResponse.json() as any).policy
    const run = await call('/api/backups/run?env=production', {
      method: 'POST',
      headers,
      body: JSON.stringify({ policyId: policy.id }),
    })
    expect(run.status).toBe(202)
    expect(await run.json()).toMatchObject({ ok: true, job: { kind: 'backup', status: 'queued' } })

    const control = new ControlPlaneStore({ cwd: root }),
      backups = new BackupStore(control),
      checksum = `sha256:${createHash('sha256').update('archive').digest('hex')}`,
      point = backups.createRecoveryPoint({
        projectId: policy.projectId,
        policyId: policy.id,
        destinationId: destination.id,
        resourceId: resource.id,
        kind: 'volume',
        pointInTime: new Date().toISOString(),
        uri: 's3://recovery/orders.tar.gz',
        sizeBytes: 7,
        checksum,
        manifest: {
          sourceVolume: 'orders-data',
          storageKey: 'orders.tar.gz',
          encrypted: false,
          plaintextChecksum: checksum,
          storageChecksum: checksum,
          contentType: 'application/gzip',
        },
        held: false,
        pinned: false,
        status: 'available',
        verificationState: 'verified',
      })
    control.close()

    const restore = await call('/api/backups/restore?env=production', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        recoveryPointId: point.id,
        mode: 'isolated',
        targetName: 'orders-drill',
        target: { volumeName: 'orders-drill' },
      }),
    })
    expect(restore.status).toBe(200)
    expect(await restore.json()).toMatchObject({
      ok: true,
      executionCreated: false,
      plan: { mode: 'isolated', target: { volumeName: 'orders-drill' } },
    })

    const unsafe = await call('/api/backups/restore?env=production', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        recoveryPointId: point.id,
        mode: 'in_place',
        targetName: 'orders-data',
        target: { volumeName: 'orders-data' },
        confirm: 'orders-data',
        downtimeAcknowledged: true,
      }),
    })
    expect(unsafe.status).toBe(409)
    expect(await unsafe.json()).toMatchObject({ ok: false, error: expect.stringContaining('safety backup') })

    const hold = await call('/api/backups/recovery-points?env=production', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: point.id, held: true }),
    })
    expect(await hold.json()).toMatchObject({ ok: true, recoveryPoint: { held: true } })
    const inventory = await call('/api/backups?env=production', { headers: { cookie: session } }),
      body = await inventory.json() as any
    expect(body).toMatchObject({
      ok: true,
      destinations: [{ credentialsConfigured: true }],
      policies: [{ id: policy.id }],
      recoveryPoints: [{ id: point.id, held: true }],
    })
    expect(JSON.stringify(body)).not.toContain(credential.secretAccessKey)
    expect(JSON.stringify(body)).not.toContain(encryptionKey)
    const database = new ControlPlaneStore({ cwd: root })
    expect(Buffer.from(database.database.serialize()).toString()).not.toContain(credential.secretAccessKey)
    expect(Buffer.from(database.database.serialize()).toString()).not.toContain(encryptionKey)
    database.close()
  }, 15_000)
})
