import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { hashPassword } from './dashboard-auth'
import { startLocalDashboardServer } from './local-dashboard-server'
import { saveUsers } from './dashboard-users'

let root: string | undefined
let running: Awaited<ReturnType<typeof startLocalDashboardServer>> | undefined
let store: ControlPlaneStore | undefined

afterEach(() => {
  running?.server.stop(true)
  running = undefined
  store?.close()
  store = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('dashboard data-service integration', () => {
  it('previews, creates, scopes, reveals, adopts, and safely plans lifecycle actions', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-data-services-'))
    saveUsers(root, [
      {
        username: 'owner',
        passwordHash: hashPassword('correct horse battery staple'),
        role: 'admin',
        sites: {},
        createdAt: new Date().toISOString(),
      },
    ])
    running = await startLocalDashboardServer({
      cwd: root,
      host: '127.0.0.1',
      port: 0,
      queueWorker: false,
      config: {
        project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
        environments: {
          production: { type: 'production' },
          staging: { type: 'staging' },
        },
        sites: { api: { domain: 'api.example.com', root: 'dist' } },
      } as any,
    })
    const base = running.url.replace(/\/$/, ''),
      call = (path: string, init?: RequestInit) =>
        running!.server.fetch(new Request(`${base}${path}`, init)),
      login = await call('/api/login', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'owner',
          password: 'correct horse battery staple',
        }),
      }),
      session = login.headers.get('set-cookie')?.split(';')[0] ?? '',
      headers = {
        origin: base,
        cookie: session,
        'content-type': 'application/json',
      }

    const preview = (await (
      await call('/api/data-services/preview?env=production', {
        method: 'POST',
        headers,
        body: JSON.stringify({ engine: 'postgres', provider: 'aws_rds' }),
      })
    ).json()) as any
    expect(preview).toMatchObject({
      ok: true,
      productionExecutionCreated: false,
      defaults: { publicExposure: false, deletionProtection: true },
    })

    const broad = await call('/api/data-services?env=production', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'unsafe-db',
        engine: 'postgres',
        provider: 'aws_rds',
        placement: 'unsafe-db',
        publicExposure: true,
        allowedCidrs: ['0.0.0.0/0'],
      }),
    })
    expect(broad.status).toBe(422)

    const createResponse = await call('/api/data-services?env=production', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'orders-db',
        engine: 'postgres',
        provider: 'aws_rds',
        placement: 'orders-db',
        plan: 'db.t4g.micro',
        storageGb: 20,
        desiredState: {
          subnetGroup: 'private',
          securityGroupIds: ['sg-database'],
        },
      }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as any
    expect(created).toMatchObject({
      ok: true,
      service: { name: 'orders-db', publicExposure: false },
      oneTimeCredential: { username: 'app' },
    })
    expect(created.oneTimeCredential.password).toHaveLength(40)

    const listed = (await (
      await call('/api/data-services?env=production', {
        headers: { cookie: session },
      })
    ).json()) as any
    expect(listed.services[0]).toMatchObject({
      id: created.service.id,
      credential: { configured: true, username: 'app', version: 1 },
    })
    expect(JSON.stringify(listed)).not.toContain(
      created.oneTimeCredential.password,
    )
    expect(listed.services[0].credentialRef).toBeUndefined()
    const staging = (await (
      await call('/api/data-services?env=staging', {
        headers: { cookie: session },
      })
    ).json()) as any
    expect(staging.services).toEqual([])

    const revealed = (await (
      await call('/api/data-services/reveal?env=production', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: created.service.id }),
      })
    ).json()) as any
    expect(revealed.credential.password).toBe(
      created.oneTimeCredential.password,
    )

    const deletionPlan = (await (
      await call('/api/data-services/action?env=production', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: created.service.id, action: 'delete' }),
      })
    ).json()) as any
    expect(deletionPlan).toMatchObject({
      ok: true,
      productionExecutionCreated: false,
      plan: {
        preflight: {
          backupRequired: true,
          retentionChoiceRequired: true,
          typedConfirmation: 'orders-db',
        },
      },
    })
    const unsafeDelete = await call(
      '/api/data-services/action?env=production',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: created.service.id,
          action: 'delete',
          execute: true,
          changes: { retention: 'final_backup' },
        }),
      },
    )
    expect(unsafeDelete.status).toBe(409)
    const invalidAction = await call(
      '/api/data-services/action?env=production',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: created.service.id,
          action: 'arbitrary-provider-call',
          execute: true,
        }),
      },
    )
    expect(invalidAction.status).toBe(422)

    const adopted = (await (
      await call('/api/data-services?env=production', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'legacy-db',
          engine: 'mysql',
          provider: 'external',
          placement: 'mysql.internal',
          adopt: true,
        }),
      })
    ).json()) as any
    expect(adopted).toMatchObject({
      readOnly: true,
      service: { status: 'adopted', managementEnabled: false },
    })
    const adoptedMutation = await call(
      '/api/data-services/action?env=production',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: adopted.service.id,
          action: 'restart',
          execute: true,
        }),
      },
    )
    expect(adoptedMutation.status).toBe(409)

    store = new ControlPlaneStore({ cwd: root })
    expect(
      JSON.stringify(
        store.listOperations({ projectId: store.getProjectBySlug('acme')!.id }),
      ),
    ).not.toContain(created.oneTimeCredential.password)
    expect(Buffer.from(store.database.serialize()).toString()).not.toContain(
      created.oneTimeCredential.password,
    )
  }, 15_000)
})
