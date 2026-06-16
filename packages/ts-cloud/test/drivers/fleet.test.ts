import { describe, expect, it } from 'bun:test'
import { buildFleetServicesEnv, resolveFleetTopology } from '../../src/drivers/shared/fleet'

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
