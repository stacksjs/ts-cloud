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

describe('dashboard jobs integration', () => {
  it('previews, creates, operates, and audits schedules without executing previews', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-jobs-'))
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
      queueWorker: false,
      config: {
        project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
        environments: { production: { type: 'production' } },
        sites: { web: { domain: 'example.com', root: 'dist', scheduler: true } },
      } as any,
    })
    store = new ControlPlaneStore({ cwd: root })

    const base = running.url.replace(/\/$/, '')
    const call = (path: string, init?: RequestInit) => running!.server.fetch(new Request(`${base}${path}`, init))
    const login = await call('/api/login', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    })
    const session = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const headers = { origin: base, cookie: session, 'content-type': 'application/json' }

    const preview = (await (
      await call('/api/jobs/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expression: '30 2 * * *',
          timezone: 'America/Los_Angeles',
          from: '2026-03-08T08:00:00Z',
        }),
      })
    ).json()) as any
    expect(preview).toMatchObject({ ok: true, productionExecutionCreated: false })
    expect(preview.preview.nextRuns[0]).toBe('2026-03-09T09:30:00.000Z')

    const initial = (await (await call('/api/jobs', { headers: { cookie: session } })).json()) as any
    expect(initial.jobs).toHaveLength(1)
    expect(initial.jobs[0]).toMatchObject({ name: 'web scheduler', origin: 'config', capability: { supported: true } })

    const invalidPayload = await call('/api/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Unsafe',
        provider: 'server',
        expression: '0 * * * *',
        operationId: 'scheduler:run:web',
        payloadRefs: { token: 'inline-secret' },
      }),
    })
    expect(invalidPayload.status).toBe(422)
    const destructiveTarget = await call('/api/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Recurring deployment',
        provider: 'server',
        expression: '0 * * * *',
        operationId: 'deploy:web',
      }),
    })
    expect(destructiveTarget.status).toBe(422)
    const unsupportedRate = await call('/api/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Server rate',
        provider: 'server',
        expression: 'rate(5 minutes)',
        operationId: 'scheduler:run:web',
      }),
    })
    expect(unsupportedRate.status).toBe(422)

    const createdResponse = await call('/api/jobs', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Quarter-hour scheduler',
        provider: 'server',
        expression: '*/15 * * * *',
        timezone: 'UTC',
        operationId: 'scheduler:run:web',
        overlapPolicy: 'replace',
        missedRunPolicy: 'catch_up',
        payloadRefs: { token: 'secret://jobs/token' },
      }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as any
    expect(created).toMatchObject({
      ok: true,
      job: { provider: 'server', overlapPolicy: 'replace', missedRunPolicy: 'catch_up' },
    })

    const runResponse = await call('/api/jobs/action', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: created.job.id, action: 'run' }),
    })
    expect(runResponse.status).toBe(202)
    const run = (await runResponse.json()) as any
    expect(run.execution).toMatchObject({ jobId: created.job.id, trigger: 'manual', status: 'queued' })

    const history = (await (
      await call(`/api/jobs/history?jobId=${created.job.id}`, { headers: { cookie: session } })
    ).json()) as any
    expect(history.executions[0]).toMatchObject({
      id: run.execution.id,
      logs: [{ stream: 'system', message: 'Queued for durable execution.' }],
    })

    const unconfirmed = await call('/api/jobs/action', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: created.job.id, action: 'disable' }),
    })
    expect(unconfirmed.status).toBe(409)
    const disabled = (await (
      await call('/api/jobs/action', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: created.job.id, action: 'disable', confirm: 'disable' }),
      })
    ).json()) as any
    expect(disabled.job.enabled).toBe(false)

    const configDelete = await call('/api/jobs/action', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: initial.jobs[0].id, action: 'delete', confirm: 'delete' }),
    })
    expect(configDelete.status).toBe(409)

    const project = store.getProjectBySlug('acme')!
    expect(store.listEvents({ projectId: project.id }).map((event) => event.type)).toEqual(
      expect.arrayContaining(['job.created', 'job.run_queued', 'job.disabled']),
    )
  }, 10_000)
})
