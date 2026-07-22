import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalDashboardServer } from './local-dashboard-server'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue } from '../queue'
import { startLocalDashboardServer } from './local-dashboard-server'

const roots: string[] = []
let running: LocalDashboardServer | undefined
let store: ControlPlaneStore | undefined

afterEach(() => {
  running?.server.stop(true)
  running = undefined
  store?.close()
  store = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dashboard durable queue worker integration', () => {
  it('claims queued deployment work, streams logs, and persists success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-queue-')); roots.push(root)
    const cliEntry = join(root, 'queue-cli.ts')
    writeFileSync(cliEntry, `console.log('build started')\nawait Bun.sleep(20)\nconsole.error('provider progress')\nconsole.log(process.argv.slice(2).join(' '))\n`)
    running = await startLocalDashboardServer({
      cwd: root,
      cliEntry,
      host: '127.0.0.1',
      port: 0,
      queueWorker: true,
      queueParallelism: 2,
      config: {
        project: { name: 'Queue App', slug: 'queue-app', region: 'us-east-1' },
        environments: { production: { type: 'production' } },
        sites: { web: { domain: 'example.com', root: 'dist' } },
      } as any,
    })

    store = new ControlPlaneStore({ cwd: root })
    const project = store.getProjectBySlug('queue-app')!
    const environment = store.getEnvironmentBySlug(project.id, 'production')!
    const resource = store.listResources(project.id, environment.id).find(candidate => candidate.slug === 'web')!
    const queue = new DurableOperationQueue(store)
    const queued = queue.enqueue({ projectId: project.id, environmentId: environment.id, resourceId: resource.id, kind: 'deployment.create', lockKey: `resource:${resource.id}` })

    const deadline = Date.now() + 5_000
    while (!['succeeded', 'failed'].includes(queue.view(queued.operation.id)?.operation.state ?? '') && Date.now() < deadline)
      await Bun.sleep(25)

    expect(queue.view(queued.operation.id)).toMatchObject({ operation: { state: 'succeeded', output: { exitCode: 0, environment: 'production', resource: 'web' } }, job: { currentStep: 'finalize' } })
    const logs = queue.logs(queued.operation.id)
    expect(logs.some(entry => entry.stream === 'stdout' && entry.message.includes('build started'))).toBe(true)
    expect(logs.some(entry => entry.stream === 'stderr' && entry.message.includes('provider progress'))).toBe(true)
    expect(logs.some(entry => entry.message.includes('deploy --env production --yes --site web'))).toBe(true)
  }, 10_000)
})
