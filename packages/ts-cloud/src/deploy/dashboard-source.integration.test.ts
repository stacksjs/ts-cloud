import { afterEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('dashboard source connection integration', () => {
  it('connects a generic repository and enqueues one signed push deployment', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-source-'))
    saveUsers(root, [
      {
        username: 'owner',
        passwordHash: hashPassword('correct horse battery staple'),
        role: 'admin',
        sites: {},
        name: 'Owner',
        createdAt: new Date().toISOString(),
      },
    ])
    running = await startLocalDashboardServer({
      cwd: root,
      host: '127.0.0.1',
      port: 0,
      config: {
        project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
        environments: { production: { type: 'production' } },
        sites: { web: { root: 'dist', domain: 'example.test' } },
      } as any,
    })
    const base = running.url.replace(/\/$/, '')
    const dashboardFetch = (path: string, init?: RequestInit): Response | Promise<Response> =>
      running!.server.fetch(new Request(`${base}${path}`, init))
    const login = await dashboardFetch('/api/login', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    })
    const session = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const jsonHeaders = { origin: base, cookie: session, 'content-type': 'application/json' }

    const deployPrivateKey =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nruntime-created-value\n-----END OPENSSH PRIVATE KEY-----'
    const created = (await (
      await dashboardFetch('/api/sources/connections?env=production', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          provider: 'generic_ssh',
          name: 'Private Git',
          host: 'https://git.example',
          authKind: 'deploy_key',
          repositoryFullName: 'acme/web',
          repositoryUrl: 'git@git.example:acme/web.git',
          defaultBranch: 'main',
          deployKeyName: 'Readonly production',
          publicKey: `ssh-ed25519 ${Buffer.from('public-key').toString('base64')}`,
          deployPrivateKey,
          sshHost: 'git.example',
          hostKey: `ssh-ed25519 ${Buffer.from('host-key').toString('base64')}`,
        }),
      })
    ).json()) as any
    expect(created.connection).toMatchObject({ provider: 'generic_ssh', credentialConfigured: false })
    expect(created.deployKey).toMatchObject({ name: 'Readonly production', host: 'git.example' })
    expect(JSON.stringify(created)).not.toContain('runtime-created-value')

    const sources = (await (
      await dashboardFetch('/api/sources?env=production', { headers: { cookie: session } })
    ).json()) as any
    const resource = sources.resources.find((item: any) => item.slug === 'web')
    expect(sources.deployKeys).toMatchObject([
      { id: created.deployKey.id, publicKeyFingerprint: expect.stringContaining('sha256:') },
    ])
    const bound = (await (
      await dashboardFetch('/api/sources/bindings?env=production', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          connectionId: created.connection.id,
          repositoryId: created.repository.id,
          repositoryFullName: 'acme/web',
          resourceId: resource.id,
          defaultBranch: 'main',
          branchRule: 'main',
          monorepoRoot: 'apps/web',
          includePaths: ['apps/web/**'],
          deployKeyId: created.deployKey.id,
        }),
      })
    ).json()) as any
    expect(bound.binding).toMatchObject({
      status: 'active',
      autoDeploy: true,
      monorepoRoot: 'apps/web',
      deployKeyId: created.deployKey.id,
    })

    const webhookSecret = 'runtime-webhook-value'
    const hookResponse = await dashboardFetch('/api/sources/webhooks?env=production', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        connectionId: created.connection.id,
        repositoryId: created.repository.id,
        repositoryFullName: 'acme/web',
        secret: webhookSecret,
        reconcile: false,
      }),
    })
    expect(hookResponse.status).toBe(201)
    const hook = (await hookResponse.json()) as any
    expect(hook).toMatchObject({ endpointRevealOnce: true })
    expect(hook.endpoint).toContain('/api/source/webhooks/')
    expect(JSON.stringify(hook)).not.toContain(webhookSecret)

    const event = JSON.stringify({
      event: 'push',
      repository: 'acme/web',
      branch: 'main',
      commitSha: 'a'.repeat(40),
      changedPaths: ['apps/web/src/index.ts'],
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const deliveryHeaders = {
      'content-type': 'application/json',
      'x-ts-cloud-event': 'push',
      'x-ts-cloud-delivery': 'delivery-dashboard-1',
      'x-ts-cloud-timestamp': timestamp,
      'x-ts-cloud-signature': `sha256=${createHmac('sha256', webhookSecret).update(event).digest('hex')}`,
    }
    const delivered = await running.server.fetch(
      new Request(hook.endpoint, { method: 'POST', headers: deliveryHeaders, body: event }),
    )
    expect(delivered.status).toBe(202)
    expect(await delivered.json()).toMatchObject({ accepted: true, duplicate: false, status: 'enqueued' })
    const replay = await running.server.fetch(
      new Request(hook.endpoint, { method: 'POST', headers: deliveryHeaders, body: event }),
    )
    expect(await replay.json()).toMatchObject({ accepted: true, duplicate: true, status: 'duplicate' })

    const refreshed = (await (
      await dashboardFetch('/api/sources?env=production', { headers: { cookie: session } })
    ).json()) as any
    expect(refreshed.webhooks[0].deliveries).toMatchObject([
      { providerDeliveryId: 'delivery-dashboard-1', status: 'enqueued', signatureStatus: 'verified' },
    ])
    expect(refreshed.webhooks[0].endpointToken).toBeUndefined()

    const preview = (await (
      await dashboardFetch('/api/sources/connections?env=production', {
        method: 'DELETE',
        headers: jsonHeaders,
        body: JSON.stringify({ id: created.connection.id, preview: true }),
      })
    ).json()) as any
    expect(preview.affectedBindings).toHaveLength(1)
    const disconnected = (await (
      await dashboardFetch('/api/sources/connections?env=production', {
        method: 'DELETE',
        headers: jsonHeaders,
        body: JSON.stringify({ id: created.connection.id }),
      })
    ).json()) as any
    expect(disconnected.connection).toMatchObject({ status: 'disconnected', credentialConfigured: false })
  })
})
