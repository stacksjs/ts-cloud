import type { HetznerAction, HetznerServer, HetznerServerType } from '../../src/drivers/hetzner/client'
import type { HetznerResizeClient, HetznerResizePhase } from '../../src/drivers/hetzner/resize'
import { describe, expect, it } from 'bun:test'
import { HetznerApiError } from '../../src/drivers/hetzner/client'
import { executeHetznerServerResize, planHetznerServerResize } from '../../src/drivers/hetzner/resize'

const cx23: HetznerServerType = {
  name: 'cx23',
  architecture: 'x86',
  cores: 2,
  memory: 4,
  disk: 40,
  locations: [{ id: 1, name: 'fsn1', available: true, recommended: true }],
}
const cx43: HetznerServerType = {
  name: 'cx43',
  architecture: 'x86',
  cores: 8,
  memory: 16,
  disk: 160,
  locations: [{ id: 1, name: 'fsn1', available: true, recommended: true }],
}

function fakeClient(options: { available?: boolean; failChange?: boolean; status?: string } = {}) {
  let server: HetznerServer = {
    id: 42,
    name: 'app-production',
    status: options.status ?? 'running',
    public_net: { ipv4: { ip: '203.0.113.10' }, ipv6: { ip: '2001:db8::1' } },
    server_type: { ...cx23 },
    location: { name: 'fsn1' },
  }
  const calls: string[] = []
  const target = {
    ...cx43,
    locations: [{ id: 1, name: 'fsn1', available: options.available ?? true, recommended: true }],
  }
  const action = (): HetznerAction => ({ id: calls.length, status: 'success' })
  const client: HetznerResizeClient = {
    getServer: async () => structuredClone(server),
    getServerType: async (name) => (name === 'cx43' ? structuredClone(target) : null),
    shutdownServer: async () => {
      calls.push('shutdown')
      server = { ...server, status: 'off' }
      return action()
    },
    powerOnServer: async () => {
      calls.push('poweron')
      server = { ...server, status: 'running' }
      return action()
    },
    changeServerType: async () => {
      calls.push('change_type')
      if (options.failChange)
        throw new HetznerApiError('No fitting host found', 412, 'resource_unavailable')
      server = { ...server, server_type: structuredClone(target) }
      return action()
    },
    waitForAction: async () => action(),
    waitForServerRunning: async () => structuredClone(server),
    waitForServerStatus: async () => structuredClone(server),
  }
  return { client, calls, server: () => server }
}

describe('guarded Hetzner server resize', () => {
  it('does not stop the server when target capacity is unavailable', async () => {
    const { client, calls, server } = fakeClient({ available: false })
    const result = await executeHetznerServerResize({ client, serverId: 42, targetType: 'cx43' })
    expect(result.status).toBe('waiting-capacity')
    expect(calls).toEqual([])
    expect(server().status).toBe('running')
  })

  it('runs preflight, resize, boot, and verification in order', async () => {
    const { client, calls, server } = fakeClient()
    const phases: HetznerResizePhase[] = []
    const result = await executeHetznerServerResize({
      client,
      serverId: 42,
      targetType: 'cx43',
      hooks: {
        preflight: () => ({ routes: 61 }),
        afterBoot: (_server, _target, manifest) => ({
          ok: manifest?.routes === 61,
          checks: { routes: manifest?.routes ?? 0 },
        }),
        onPhase: (phase) => {
          phases.push(phase)
        },
      },
    })
    expect(result.status).toBe('completed')
    expect(calls).toEqual(['shutdown', 'change_type', 'poweron'])
    expect(server().server_type.name).toBe('cx43')
    expect(phases).toEqual([
      'planning',
      'preflight',
      'shutting-down',
      'resizing',
      'powering-on',
      'verifying',
      'complete',
    ])
  })

  it('powers the original server back on after a placement race', async () => {
    const { client, calls, server } = fakeClient({ failChange: true })
    const result = await executeHetznerServerResize({
      client,
      serverId: 42,
      targetType: 'cx43',
      hooks: {
        preflight: () => ({ services: 45 }),
        afterBoot: (_server, _target, manifest, context) => ({
          ok: context.recovered && manifest?.services === 45,
        }),
      },
    })
    expect(result.status).toBe('recovered')
    expect(result.status === 'recovered' && result.retryable).toBe(true)
    expect(calls).toEqual(['shutdown', 'change_type', 'poweron'])
    expect(server().status).toBe('running')
    expect(server().server_type.name).toBe('cx23')
  })

  it('resumes an interrupted resize from the durable manifest while powered off', async () => {
    const { client, calls } = fakeClient({ status: 'off' })
    const result = await executeHetznerServerResize({
      client,
      serverId: 42,
      targetType: 'cx43',
      resumeFromOff: true,
      manifest: { releases: 61 },
      hooks: {
        afterBoot: (_server, _target, manifest) => ({
          ok: manifest?.releases === 61,
        }),
      },
    })
    expect(result.status).toBe('completed')
    expect(calls).toEqual(['change_type', 'poweron'])
  })

  it('refuses an in-place downgrade before taking any action', async () => {
    const { client, calls } = fakeClient()
    const getServerType = client.getServerType
    client.getServerType = async (name) =>
      name === 'cx13'
        ? {
            name: 'cx13',
            architecture: 'x86',
            cores: 1,
            memory: 2,
            disk: 20,
            locations: [{ id: 1, name: 'fsn1', available: true, recommended: true }],
          }
        : getServerType(name)
    await expect(planHetznerServerResize(client, 42, 'cx13')).rejects.toThrow('Refusing an in-place downgrade')
    expect(calls).toEqual([])
  })
})
