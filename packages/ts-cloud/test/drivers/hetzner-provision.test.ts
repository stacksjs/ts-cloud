import { describe, expect, it } from 'bun:test'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { ensureFirewall, ensureServer, ensureSshKey, serverPublicIpv4 } from '../../src/drivers/hetzner/provision'
import { buildSshArgs } from '../../src/drivers/shared/remote-exec'

/** A HetznerClient backed by a route table instead of the real API. */
function fakeClient(routes: Record<string, (body: any) => unknown>, calls: string[] = []): HetznerClient {
  return new HetznerClient({
    apiToken: 'test-token',
    fetchImpl: async (url, init) => {
      const method = init?.method ?? 'GET'
      // Strip the pagination query string so routes match the bare path.
      const path = url.replace('https://api.hetzner.cloud/v1', '').split('?')[0]
      const key = `${method} ${path}`
      calls.push(key)
      const handler = routes[key]
      if (!handler) return new Response(JSON.stringify({ error: { message: `no route for ${key}` } }), { status: 404 })
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      return new Response(JSON.stringify(handler(body)), { status: 200 })
    },
  })
}

const ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTBODY chris@laptop'

describe('ensureSshKey', () => {
  it('reuses a registered key with the same body even under a different name/comment', async () => {
    const calls: string[] = []
    const client = fakeClient(
      {
        'GET /ssh_keys': () => ({
          ssh_keys: [
            {
              id: 7,
              name: 'old-name',
              fingerprint: 'ff',
              public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTBODY other@host',
            },
          ],
        }),
      },
      calls,
    )

    const result = await ensureSshKey(client, { name: 'new-name', publicKey: ED25519_KEY })
    expect(result).toEqual({ id: 7, name: 'old-name', created: false })
    expect(calls).toEqual(['GET /ssh_keys'])
  })

  it('registers the key when no body matches', async () => {
    const client = fakeClient({
      'GET /ssh_keys': () => ({ ssh_keys: [] }),
      'POST /ssh_keys': (body) => ({
        ssh_key: { id: 11, name: body.name, fingerprint: 'aa', public_key: body.public_key },
      }),
    })

    const result = await ensureSshKey(client, { name: 'deploy-key', publicKey: ED25519_KEY })
    expect(result).toEqual({ id: 11, name: 'deploy-key', created: true })
  })
})

describe('ensureFirewall', () => {
  const rules = [{ direction: 'in' as const, protocol: 'tcp' as const, port: '22', source_ips: ['0.0.0.0/0'] }]

  it('syncs rules on an existing firewall instead of recreating it', async () => {
    const calls: string[] = []
    const client = fakeClient(
      {
        'GET /firewalls': () => ({ firewalls: [{ id: 3, name: 'my-fw' }] }),
        'POST /firewalls/3/actions/set_rules': () => ({ actions: [] }),
      },
      calls,
    )

    const result = await ensureFirewall(client, { name: 'my-fw', rules })
    expect(result).toEqual({ id: 3, name: 'my-fw', created: false })
    expect(calls).toContain('POST /firewalls/3/actions/set_rules')
  })

  it('creates the firewall when missing', async () => {
    const client = fakeClient({
      'GET /firewalls': () => ({ firewalls: [] }),
      'POST /firewalls': (body) => ({ firewall: { id: 4, name: body.name }, actions: [] }),
    })

    const result = await ensureFirewall(client, { name: 'new-fw', rules })
    expect(result).toEqual({ id: 4, name: 'new-fw', created: true })
  })
})

describe('ensureServer', () => {
  const running = {
    id: 9,
    name: 'box',
    status: 'running',
    public_net: { ipv4: { ip: '203.0.113.5' } },
    server_type: { name: 'cx23' },
    datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
  }

  it('reuses an existing server by name and waits for running', async () => {
    const calls: string[] = []
    const client = fakeClient(
      {
        'GET /servers': () => ({ servers: [{ ...running, status: 'starting' }] }),
        'GET /servers/9': () => ({ server: running }),
      },
      calls,
    )

    const result = await ensureServer(client, { name: 'box', serverType: 'cx23', image: 'ubuntu-24.04' })
    expect(result.created).toBe(false)
    expect(result.server.status).toBe('running')
    expect(calls.filter((c) => c === 'POST /servers')).toEqual([])
  })

  it('creates the server when missing', async () => {
    const client = fakeClient({
      'GET /servers': () => ({ servers: [] }),
      'POST /servers': (body) => ({ server: { ...running, name: body.name }, action: { id: 1, status: 'success' } }),
      'GET /servers/9': () => ({ server: running }),
    })

    const result = await ensureServer(client, { name: 'box', serverType: 'cx23', image: 'ubuntu-24.04' })
    expect(result.created).toBe(true)
    expect(result.server.status).toBe('running')
  })

  it('skips the running wait when waitForRunning is false', async () => {
    const calls: string[] = []
    const client = fakeClient(
      {
        'GET /servers': () => ({ servers: [{ ...running, status: 'initializing' }] }),
      },
      calls,
    )

    const result = await ensureServer(client, {
      name: 'box',
      serverType: 'cx23',
      image: 'ubuntu-24.04',
      waitForRunning: false,
    })
    expect(result.server.status).toBe('initializing')
    expect(calls).toEqual(['GET /servers'])
  })
})

describe('serverPublicIpv4', () => {
  it('returns the public IPv4', () => {
    expect(serverPublicIpv4({ public_net: { ipv4: { ip: '198.51.100.7' } }, id: 1, name: 'a' } as any)).toBe(
      '198.51.100.7',
    )
  })

  it('throws when the server has none', () => {
    expect(() => serverPublicIpv4({ public_net: {}, id: 1, name: 'a' } as any)).toThrow('no public IPv4')
  })
})

describe('buildSshArgs', () => {
  it('disables host key checking and applies the connect timeout', () => {
    const args = buildSshArgs()
    expect(args).toContain('StrictHostKeyChecking=no')
    expect(args).toContain('ConnectTimeout=10')
    expect(args).not.toContain('-i')
  })

  it('passes the identity file and custom timeout', () => {
    const args = buildSshArgs({ identityFile: '/home/u/.ssh/id_ed25519', connectTimeoutSec: 5 })
    expect(args.slice(0, 2)).toEqual(['-i', '/home/u/.ssh/id_ed25519'])
    expect(args).toContain('ConnectTimeout=5')
  })
})
