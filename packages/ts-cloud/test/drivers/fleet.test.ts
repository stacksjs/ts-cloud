import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildFleetServicesBoxProvision,
  buildFleetServicesEnv,
  resolveFleetTopology,
} from '../../src/drivers/shared/fleet'

describe('resolveFleetTopology', () => {
  it('single server by default — services co-located, no LB', () => {
    const t = resolveFleetTopology({})
    expect(t.appServers).toBe(1)
    expect(t.loadBalancer).toBe(false)
    expect(t.dedicatedServices).toBe(false)
    expect(t.servicesOnApp).toBe(true)
  })

  it('multi-app fleet gets an LB + dedicated services box', () => {
    const t = resolveFleetTopology({ appServers: 3 })
    expect(t.appServers).toBe(3)
    expect(t.loadBalancer).toBe(true)
    expect(t.dedicatedServices).toBe(true)
    expect(t.servicesOnApp).toBe(false)
  })

  it('a single app server can still opt into a dedicated services box', () => {
    const t = resolveFleetTopology({ appServers: 1, servicesServer: true })
    expect(t.dedicatedServices).toBe(true)
    expect(t.servicesOnApp).toBe(false)
    expect(t.loadBalancer).toBe(false)
  })

  it('respects an explicit loadBalancer on a single app server', () => {
    expect(resolveFleetTopology({ server: { loadBalancer: {} } }).loadBalancer).toBe(true)
  })
})

describe('buildFleetServicesEnv', () => {
  it('points DB/Redis/Meilisearch at the services box private IP', () => {
    const env = buildFleetServicesEnv('10.0.1.5', { engine: 'mysql', name: 'acme', username: 'acme', password: 'pw' })
    expect(env.DB_HOST).toBe('10.0.1.5')
    expect(env.DB_DATABASE).toBe('acme')
    expect(env.REDIS_HOST).toBe('10.0.1.5')
    expect(env.MEILISEARCH_HOST).toBe('http://10.0.1.5:7700')
  })

  it('wires cache/search even without a database', () => {
    const env = buildFleetServicesEnv('10.0.1.9')
    expect(env.REDIS_HOST).toBe('10.0.1.9')
    expect(env.DB_HOST).toBeUndefined()
  })
})

describe('buildFleetServicesBoxProvision', () => {
  function fleetConfig(compute: Record<string, unknown> = {}, notifications?: Record<string, unknown>): CloudConfig {
    return {
      project: { name: 'App', slug: 'app', region: 'fsn1' },
      ...(notifications ? { notifications } : {}),
      infrastructure: {
        appDatabase: { engine: 'mysql', name: 'appdb' },
        compute,
      },
    } as unknown as CloudConfig
  }

  it('installs the default mysql+redis engines and sets up the app database, with no backups by default', () => {
    const script = buildFleetServicesBoxProvision(fleetConfig()).join('\n')
    expect(script).toContain('mysql.com')
    expect(script).toContain('redis.io')
    expect(script).toContain('appdb')
    // Backups are opt-in.
    expect(script).not.toContain('ts-backups')
  })

  it('runs the nightly DB backup on the services box when backups are enabled', () => {
    // The database lives on the services box, so its backup must run here —
    // on an app box the dump would hit an empty local engine (or none at all).
    const script = buildFleetServicesBoxProvision(fleetConfig({ backups: { enabled: true } })).join('\n')
    expect(script).toContain('ts-backups')
    expect(script).toContain('backups.config.ts')
  })

  it('installs the notifier whenever notifications are configured, so monitoring + backups can report', () => {
    const hook = 'https://hooks.example.com/services/tok'
    const script = buildFleetServicesBoxProvision(fleetConfig({}, { webhook: { url: hook } })).join('\n')
    expect(script).toContain(hook)
  })

  it('honors an explicit managedServices set over the mysql+redis default', () => {
    const script = buildFleetServicesBoxProvision(fleetConfig({ managedServices: { postgres: true } })).join('\n')
    expect(script).toContain('postgresql.org')
    expect(script).not.toContain('mysql.com')
    expect(script).not.toContain('redis.io')
  })
})
