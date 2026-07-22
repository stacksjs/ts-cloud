import { describe, expect, it, mock } from 'bun:test'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { matchesTsCloudLabels, resolveHetznerServerType } from '../../src/drivers/hetzner/instance-sizes'
import { generateUbuntuAppCloudInit, wrapCloudInitUserData } from '../../src/drivers/hetzner/cloud-init'

describe('resolveHetznerServerType', () => {
  it('maps size shorthands to Hetzner server types', () => {
    expect(resolveHetznerServerType('micro')).toBe('cpx11')
    expect(resolveHetznerServerType('small')).toBe('cx23')
    expect(resolveHetznerServerType('medium')).toBe('cx33')
  })

  it('passes through provider-specific type strings', () => {
    expect(resolveHetznerServerType('cx52')).toBe('cx52')
  })
})

describe('matchesTsCloudLabels', () => {
  it('matches ts-cloud project/environment/role labels', () => {
    expect(
      matchesTsCloudLabels(
        {
          'ts-cloud/project': 'pantry',
          'ts-cloud/environment': 'production',
          'ts-cloud/role': 'app',
        },
        'pantry',
        'production',
        'app',
      ),
    ).toBe(true)

    expect(
      matchesTsCloudLabels(
        {
          'ts-cloud/project': 'pantry',
          'ts-cloud/environment': 'staging',
          'ts-cloud/role': 'app',
        },
        'pantry',
        'production',
        'app',
      ),
    ).toBe(false)
  })
})

describe('generateUbuntuAppCloudInit', () => {
  it('installs bun and prepares deploy directories', () => {
    const script = generateUbuntuAppCloudInit({ runtime: 'bun' })
    expect(script).toContain('apt-get install')
    expect(script).toContain('bun.sh/install')
    expect(script).toContain('/var/ts-cloud/staging')
  })

  it('does not install or configure a reverse proxy (operator runs their own)', () => {
    const script = generateUbuntuAppCloudInit({ runtime: 'bun' })
    expect(script).not.toContain('caddy')
    expect(script).not.toContain('/etc/caddy/Caddyfile')
  })
})

describe('wrapCloudInitUserData', () => {
  it('wraps bootstrap script as cloud-config runcmd', () => {
    const wrapped = wrapCloudInitUserData('#!/bin/bash\necho hello')
    expect(wrapped.startsWith('#cloud-config')).toBe(true)
    expect(wrapped).toContain('runcmd:')
    expect(wrapped).toContain('echo hello')
  })

  it('runs the bootstrap via bash so set -o pipefail does not break under dash', () => {
    const wrapped = wrapCloudInitUserData('#!/bin/bash\nset -euo pipefail\necho hi')
    // The script must be written to disk and executed with an explicit bash,
    // not inlined under runcmd (which cloud-init runs with /bin/sh).
    expect(wrapped).toContain('write_files:')
    expect(wrapped).toContain('/var/lib/cloud/ts-cloud-bootstrap.sh')
    expect(wrapped).toContain('[ bash, /var/lib/cloud/ts-cloud-bootstrap.sh ]')
    expect(wrapped).toContain('set -euo pipefail')
  })
})

describe('HetznerClient', () => {
  it('sends bearer auth and parses list servers response', async () => {
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.hetzner.cloud/v1/servers?per_page=50&page=1')
      expect(init?.method).toBe('GET')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
      return new Response(
        JSON.stringify({
          servers: [
            {
              id: 42,
              name: 'app-production',
              status: 'running',
              public_net: { ipv4: { ip: '203.0.113.10' } },
              labels: { 'ts-cloud/project': 'app' },
              server_type: { name: 'cx22' },
              datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
            },
          ],
        }),
        { status: 200 },
      )
    })

    const client = new HetznerClient({ apiToken: 'test-token', fetchImpl })
    const servers = await client.listServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].id).toBe(42)
    expect(servers[0].public_net.ipv4?.ip).toBe('203.0.113.10')
  })

  it('follows meta.pagination until the last page', async () => {
    const urls: string[] = []
    const fetchImpl = mock(async (url: string) => {
      urls.push(url)
      if (url.includes('page=1')) {
        return new Response(
          JSON.stringify({
            servers: [
              {
                id: 1,
                name: 'a',
                status: 'running',
                public_net: {},
                server_type: { name: 'cx22' },
                datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
              },
            ],
            meta: {
              pagination: { page: 1, per_page: 50, previous_page: null, next_page: 2, last_page: 2, total_entries: 2 },
            },
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          servers: [
            {
              id: 2,
              name: 'b',
              status: 'running',
              public_net: {},
              server_type: { name: 'cx22' },
              datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
            },
          ],
          meta: {
            pagination: { page: 2, per_page: 50, previous_page: 1, next_page: null, last_page: 2, total_entries: 2 },
          },
        }),
        { status: 200 },
      )
    })

    const client = new HetznerClient({
      apiToken: 'test-token',
      fetchImpl: fetchImpl as (url: string, init?: RequestInit) => Promise<Response>,
    })
    const servers = await client.listServers()
    expect(servers.map((s) => s.id)).toEqual([1, 2])
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('page=2')
  })

  it('throws with API error message on failure', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'unauthorized', code: 'unauthorized' },
          }),
          { status: 401 },
        ),
    )

    const client = new HetznerClient({ apiToken: 'bad-token', fetchImpl })
    await expect(client.listServers()).rejects.toThrow('unauthorized')
  })

  it('surfaces a non-JSON error body (e.g. gateway HTML) instead of a parse error', async () => {
    const fetchImpl = mock(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    const client = new HetznerClient({ apiToken: 'test-token', fetchImpl })
    await expect(client.listServers()).rejects.toThrow(/502/)
  })

  it('includes the status code and error code in the thrown message', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'rate limit exceeded', code: 'rate_limit_exceeded' },
          }),
          { status: 429 },
        ),
    )
    const client = new HetznerClient({ apiToken: 'test-token', fetchImpl })
    await expect(client.listServers()).rejects.toThrow(/\(429\) \[rate_limit_exceeded\]: rate limit exceeded/)
  })

  it('sets firewall rules in place (idempotent reuse)', async () => {
    let body: any
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/firewalls/55/actions/set_rules')
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ actions: [{ id: 9, status: 'success' }] }), { status: 201 })
    })
    const client = new HetznerClient({ apiToken: 'test-token', fetchImpl })
    const rules = [{ direction: 'in' as const, protocol: 'tcp' as const, port: '443', source_ips: ['0.0.0.0/0'] }]
    const actions = await client.setFirewallRules(55, rules)
    expect(body.rules).toEqual(rules)
    expect(actions[0].id).toBe(9)
  })

  it('creates a server with labels and user_data', async () => {
    let capturedBody: any
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          server: {
            id: 99,
            name: 'my-app-production-app',
            status: 'initializing',
            public_net: { ipv4: { ip: '203.0.113.20' } },
            labels: capturedBody.labels,
            server_type: { name: 'cx22' },
            datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
          },
          action: { id: 1, status: 'running' },
        }),
        { status: 201 },
      )
    })

    const client = new HetznerClient({ apiToken: 'test-token', fetchImpl })
    const { server } = await client.createServer({
      name: 'my-app-production-app',
      serverType: 'cx22',
      image: 'ubuntu-24.04',
      location: 'fsn1',
      userData: '#cloud-config\nruncmd: []',
      labels: { 'ts-cloud/project': 'my-app' },
    })

    expect(capturedBody.server_type).toBe('cx22')
    expect(capturedBody.user_data).toContain('#cloud-config')
    expect(server.id).toBe(99)
  })
})
