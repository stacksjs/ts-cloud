import { describe, expect, it, mock } from 'bun:test'
import { HetznerClient } from '../../src/drivers/hetzner/client'
import { matchesTsCloudLabels, resolveHetznerServerType } from '../../src/drivers/hetzner/instance-sizes'
import { generateUbuntuAppCloudInit, wrapCloudInitUserData } from '../../src/drivers/hetzner/cloud-init'

describe('resolveHetznerServerType', () => {
  it('maps size shorthands to Hetzner server types', () => {
    expect(resolveHetznerServerType('micro')).toBe('cpx11')
    expect(resolveHetznerServerType('small')).toBe('cx22')
    expect(resolveHetznerServerType('medium')).toBe('cx32')
  })

  it('passes through provider-specific type strings', () => {
    expect(resolveHetznerServerType('cx52')).toBe('cx52')
  })
})

describe('matchesTsCloudLabels', () => {
  it('matches ts-cloud project/environment/role labels', () => {
    expect(matchesTsCloudLabels({
      'ts-cloud/project': 'pantry',
      'ts-cloud/environment': 'production',
      'ts-cloud/role': 'app',
    }, 'pantry', 'production', 'app')).toBe(true)

    expect(matchesTsCloudLabels({
      'ts-cloud/project': 'pantry',
      'ts-cloud/environment': 'staging',
      'ts-cloud/role': 'app',
    }, 'pantry', 'production', 'app')).toBe(false)
  })
})

describe('generateUbuntuAppCloudInit', () => {
  it('installs bun and prepares deploy directories', () => {
    const script = generateUbuntuAppCloudInit({ runtime: 'bun' })
    expect(script).toContain('apt-get install')
    expect(script).toContain('bun.sh/install')
    expect(script).toContain('/var/ts-cloud/staging')
  })

  it('installs caddy when a caddyfile is provided', () => {
    const script = generateUbuntuAppCloudInit({
      runtime: 'bun',
      caddyfile: 'example.com {\n  reverse_proxy localhost:3000\n}',
    })
    expect(script).toContain('/etc/caddy/Caddyfile')
    expect(script).toContain('systemctl enable caddy')
  })
})

describe('wrapCloudInitUserData', () => {
  it('wraps bootstrap script as cloud-config runcmd', () => {
    const wrapped = wrapCloudInitUserData('#!/bin/bash\necho hello')
    expect(wrapped.startsWith('#cloud-config')).toBe(true)
    expect(wrapped).toContain('runcmd:')
    expect(wrapped).toContain('echo hello')
  })
})

describe('HetznerClient', () => {
  it('sends bearer auth and parses list servers response', async () => {
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.hetzner.cloud/v1/servers')
      expect(init?.method).toBe('GET')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
      return new Response(JSON.stringify({
        servers: [{
          id: 42,
          name: 'app-production',
          status: 'running',
          public_net: { ipv4: { ip: '203.0.113.10' } },
          labels: { 'ts-cloud/project': 'app' },
          server_type: { name: 'cx22' },
          datacenter: { name: 'fsn1-dc14', location: { name: 'fsn1' } },
        }],
      }), { status: 200 })
    })

    const client = new HetznerClient({ apiToken: 'test-token', fetchImpl })
    const servers = await client.listServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].id).toBe(42)
    expect(servers[0].public_net.ipv4?.ip).toBe('203.0.113.10')
  })

  it('throws with API error message on failure', async () => {
    const fetchImpl = mock(async () => new Response(JSON.stringify({
      error: { message: 'unauthorized' },
    }), { status: 401 }))

    const client = new HetznerClient({ apiToken: 'bad-token', fetchImpl })
    await expect(client.listServers()).rejects.toThrow('unauthorized')
  })

  it('creates a server with labels and user_data', async () => {
    let capturedBody: any
    const fetchImpl = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
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
      }), { status: 201 })
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
