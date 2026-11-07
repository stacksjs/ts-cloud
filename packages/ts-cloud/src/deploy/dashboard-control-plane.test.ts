import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDashboardControlPlane, trackDashboardOperation } from './dashboard-control-plane'

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function config(): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme', region: 'us-west-2' },
    environments: { production: { type: 'production' }, staging: { type: 'staging' } },
    sites: { web: { domain: 'acme.test', root: '.', start: 'bun server.ts', port: 3000 } },
  } as CloudConfig
}

describe('dashboard control plane', () => {
  for (const conflict of ['resource_lock', 'environment_concurrency'] as const) {
    it(`retires a rejected immediate action under ${conflict} without executing it later`, async () => {
      root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-control-'))
      const configured = config()
      configured.sites!.api = { root: '.', start: 'bun api.ts', port: 3001 }
      const controlPlane = initializeDashboardControlPlane(root, configured)
      const actor = { username: 'chris', passwordHash: 'not-persisted', role: 'admin' as const, sites: {} }
      const started = Promise.withResolvers<void>()
      const complete = Promise.withResolvers<{ ok: boolean }>()
      let rejectedExecutions = 0
      const first = trackDashboardOperation({
        controlPlane, environment: 'production', actor,
        kind: 'dashboard.first', resourceSlug: 'web',
        execute: async () => { started.resolve(); return complete.promise },
      })
      try {
        await started.promise
        const error = await trackDashboardOperation({
          controlPlane, environment: 'production', actor,
          kind: 'dashboard.rejected', resourceSlug: conflict === 'resource_lock' ? 'web' : 'api',
          execute: async () => { rejectedExecutions++; return { ok: true } },
        }).catch((error: Error) => error)
        expect(rejectedExecutions).toBe(0)
        const operations = controlPlane.store.listOperations({ projectId: controlPlane.project.id })
        expect(operations.find(operation => operation.kind === 'dashboard.first')?.state).toBe('running')
        const rejected = operations.find(operation => operation.kind === 'dashboard.rejected')!
        expect(rejected).toMatchObject({ state: 'cancelled', attempt: 0 })
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain(conflict)
        expect((error as Error).message).toContain(rejected.id)
      }
      finally {
        complete.resolve({ ok: true })
        try {
          await first
          expect(controlPlane.store.listOperations({ projectId: controlPlane.project.id, state: 'queued' })).toEqual([])
        }
        finally { controlPlane.store.close() }
      }
    })
  }

  it('synchronizes the project, environment, and application hierarchy idempotently', () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-control-'))
    const first = initializeDashboardControlPlane(root, config())
    expect(first.store.listProjects()).toHaveLength(1)
    expect(first.store.listEnvironments(first.project.id)).toHaveLength(2)
    expect(first.store.listResources(first.project.id)).toHaveLength(2)
    first.store.close()

    const second = initializeDashboardControlPlane(root, config())
    expect(second.store.listProjects()).toHaveLength(1)
    expect(second.store.listEnvironments(second.project.id)).toHaveLength(2)
    expect(second.store.listResources(second.project.id)).toHaveLength(2)
    second.store.close()
  })

  it('indexes configured compute and databases in every environment', () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-control-'))
    const configured = config()
    configured.cloud = { provider: 'aws' }
    configured.infrastructure = {
      compute: { instances: 1, instanceType: 't3.small' },
      databases: { orders: { engine: 'postgres' } },
    } as CloudConfig['infrastructure']

    const controlPlane = initializeDashboardControlPlane(root, configured)
    const resources = controlPlane.store.listResources(controlPlane.project.id)
    expect(resources.filter((resource) => resource.kind === 'server')).toHaveLength(2)
    expect(resources.filter((resource) => resource.kind === 'database')).toHaveLength(2)
    expect(resources.find((resource) => resource.kind === 'server')).toMatchObject({ provider: 'aws', name: 'Acme' })
    controlPlane.store.close()
  })

  it('persists actor attribution and a bounded operation summary', async () => {
    root = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-control-'))
    const controlPlane = initializeDashboardControlPlane(root, config())
    const tracked = await trackDashboardOperation({
      controlPlane,
      environment: 'production',
      actor: { username: 'chris', passwordHash: 'not-persisted', role: 'admin', sites: {}, name: 'Chris' },
      kind: 'dashboard.server.restart',
      resourceSlug: 'web',
      input: { target: 'web' },
      execute: async () => ({ ok: true, stdout: 'streamed queue transcript is persisted' }),
    })

    expect(tracked.operation.state).toBe('succeeded')
    expect(tracked.operation.output).toEqual({ ok: true, stdoutBytes: 38, stderrBytes: 0 })
    expect(JSON.stringify(tracked.operation.output)).not.toContain('streamed queue transcript')
    expect(
      controlPlane.store.database
        .query<Record<string, string>, [string]>(
          "SELECT message FROM operation_logs WHERE operation_id=? AND stream='stdout'",
        )
        .get(tracked.operation.id)?.message,
    ).toBe('streamed queue transcript is persisted')
    expect(
      controlPlane.store.database
        .query<Record<string, string>, [string]>('SELECT lock_key FROM operation_jobs WHERE operation_id=?')
        .get(tracked.operation.id)?.lock_key,
    ).toBe(`resource:${tracked.operation.resourceId}`)
    expect(controlPlane.store.listEvents({ operationId: tracked.operation.id })).toHaveLength(3)
    controlPlane.store.close()
  })
})
