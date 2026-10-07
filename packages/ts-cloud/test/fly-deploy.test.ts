import type { CloudConfig } from '@ts-cloud/core'
import type { FlyDeployOptions, FlyMachine } from '../src/fly'
import { describe, expect, it } from 'bun:test'
import { createCloudDriver } from '../src/drivers/factory'
import { deployToFly, FlyApiError, FlyClient, flyDeployOptions, flyIpType, flyMachineConfig } from '../src/fly'

/**
 * Fly.io deploys against a recording fetch. Paths and payloads follow Fly's
 * Machines API reference and fly-go's `flaps` client, which flyctl itself
 * uses; nothing here has run against a live Fly account yet.
 */

interface Sent { method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: any }
type Route = (sent: Sent) => { status?: number, body?: unknown }

function fly(routes: Record<string, Route>) {
  const sent: Sent[] = []
  const fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const entry: Sent = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    sent.push(entry)
    const route = routes[`${entry.method} ${url.pathname}`]
    if (!route)
      return Response.json({ error: `no route for ${entry.method} ${url.pathname}` }, { status: 404 })
    const reply = route(entry)
    return reply.body === undefined ? new Response(null, { status: reply.status ?? 200 }) : Response.json(reply.body, { status: reply.status ?? 200 })
  }) as typeof globalThis.fetch
  return { client: new FlyClient({ token: 'fly-test-token', fetch }), sent }
}

const config: CloudConfig = {
  project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
  environments: { production: { type: 'production' } },
  cloud: { provider: 'fly' },
  fly: { regions: ['iad', 'ams'], internalPort: 3000, healthPath: '/health', volume: { sizeGb: 1, path: '/data' }, hostnames: ['acme.example.com'] },
}

const options = (overrides: Partial<FlyDeployOptions> = {}) => ({
  ...flyDeployOptions(config, { environment: 'production', image: 'registry.fly.io/acme-production:abc123', release: 'abc123', env: { APP_ENV: 'production' }, secrets: { APP_KEY: 's3cret' } }),
  ...overrides,
})

const machine = (id: string, region: string, extra: Partial<FlyMachine['config']> = {}): FlyMachine => ({
  id,
  region,
  state: 'started',
  instance_id: `${id}-v1`,
  config: { image: 'registry.fly.io/acme-production:old', metadata: { 'ts-cloud-role': 'app' }, ...extra },
})

describe('flyDeployOptions', () => {
  it('fills the defaults in from config/cloud.ts', () => {
    const resolved = flyDeployOptions({ ...config, fly: {} }, { environment: 'staging', image: 'img', release: 'r1' })
    expect(resolved).toMatchObject({
      app: 'acme-staging',
      org: 'personal',
      regions: ['iad'],
      count: 1,
      internalPort: 3000,
      healthPath: '/',
      vm: { cpuKind: 'shared', cpus: 1, memoryMb: 512 },
      autoStop: false,
      env: { PORT: '3000' },
      hostnames: [],
    })
    expect(resolved.volume).toBeUndefined()
  })

  it('refuses an app name Fly would reject, and a count below one', () => {
    expect(() => flyDeployOptions({ ...config, fly: { app: 'Acme_App' } }, { environment: 'production', image: 'i', release: 'r' })).toThrow('not a valid Fly app name')
    expect(() => flyDeployOptions({ ...config, fly: { count: 0 } }, { environment: 'production', image: 'i', release: 'r' })).toThrow('fly.count')
  })

  it('serves HTTP and HTTPS on the internal port, health-checked', () => {
    expect(flyMachineConfig(options())).toMatchObject({
      image: 'registry.fly.io/acme-production:abc123',
      env: { APP_ENV: 'production', PORT: '3000' },
      services: [{
        protocol: 'tcp',
        internal_port: 3000,
        ports: [{ port: 80, handlers: ['http'], force_https: true }, { port: 443, handlers: ['tls', 'http'] }],
        autostop: 'off',
        checks: [{ type: 'http', method: 'GET', path: '/health' }],
      }],
      metadata: { 'ts-cloud-role': 'app', 'ts-cloud-release': 'abc123' },
    })
    // Secrets never appear in the Machine config, which anyone with read access can see.
    expect(JSON.stringify(flyMachineConfig(options()))).not.toContain('s3cret')
  })
})

describe('deployToFly', () => {
  it('creates the app, its addresses, a volume and a Machine per region, then asks for the certificate', async () => {
    let created = 0
    const { client, sent } = fly({
      'GET /v1/apps/acme-production': () => ({ status: 404, body: { error: 'app not found' } }),
      'POST /v1/apps': () => ({ status: 201, body: { name: 'acme-production' } }),
      'POST /v1/apps/acme-production/secrets': () => ({ body: { secrets: [], version: 3 } }),
      'GET /v1/apps/acme-production/ip_assignments': () => ({ body: { ips: [] } }),
      'POST /v1/apps/acme-production/ip_assignments': ({ body }) => ({ body: body.type === 'v6' ? { ip: '2a09:8280::1' } : { ip: '66.241.124.10', shared: true } }),
      'GET /v1/apps/acme-production/machines': () => ({ body: [] }),
      'GET /v1/apps/acme-production/volumes': () => ({ body: [] }),
      'POST /v1/apps/acme-production/volumes': ({ body }) => ({ body: { id: `vol_${body.region}`, name: body.name, region: body.region, size_gb: body.size_gb } }),
      'POST /v1/apps/acme-production/machines': ({ body }) => ({ body: { id: `m${++created}`, region: body.region, state: 'created', instance_id: `i${created}`, config: body.config } }),
      'GET /v1/apps/acme-production/machines/m1/wait': () => ({ body: { ok: true } }),
      'GET /v1/apps/acme-production/machines/m2/wait': () => ({ body: { ok: true } }),
      'POST /v1/apps/acme-production/certificates/acme': () => ({ body: { hostname: 'acme.example.com', configured: false, status: 'Awaiting configuration', dns_requirements: { cname: 'acme-production.fly.dev' } } }),
    })

    const result = await deployToFly(client, options())

    expect(sent.find(s => s.path === '/v1/apps')!.body).toEqual({ app_name: 'acme-production', org_slug: 'personal' })
    expect(sent.find(s => s.path.endsWith('/secrets'))!.body).toEqual({ values: { APP_KEY: 's3cret' } })
    expect(sent.filter(s => s.method === 'POST' && s.path.endsWith('/ip_assignments')).map(s => s.body.type)).toEqual(['v6', 'shared_v4'])
    expect(sent.filter(s => s.method === 'POST' && s.path.endsWith('/volumes')).map(s => s.body)).toEqual([
      { name: 'data', region: 'iad', size_gb: 1, encrypted: true },
      { name: 'data', region: 'ams', size_gb: 1, encrypted: true },
    ])
    const creates = sent.filter(s => s.method === 'POST' && s.path.endsWith('/machines'))
    expect(creates.map(s => [s.body.region, s.body.name, s.body.min_secrets_version, s.body.config.mounts])).toEqual([
      ['iad', 'acme-production-iad-1', 3, [{ volume: 'vol_iad', path: '/data' }]],
      ['ams', 'acme-production-ams-1', 3, [{ volume: 'vol_ams', path: '/data' }]],
    ])
    expect(sent.find(s => s.path.endsWith('/m1/wait'))!.query).toEqual({ state: 'started', timeout: '60', instance_id: 'i1' })
    expect(sent.every(s => s.headers.Authorization === 'Bearer fly-test-token')).toBe(true)

    expect(result).toMatchObject({
      app: 'acme-production',
      url: 'https://acme-production.fly.dev',
      createdApp: true,
      created: ['m1', 'm2'],
      updated: [],
      untouched: [],
      certificates: [{ hostname: 'acme.example.com', dns_requirements: { cname: 'acme-production.fly.dev' } }],
    })
    expect(result.ips.map(flyIpType)).toEqual(['v6', 'shared_v4'])
  })

  it('rolls existing Machines one at a time under their lease, keeping their volumes', async () => {
    const { client, sent } = fly({
      'GET /v1/apps/acme-production': () => ({ body: { name: 'acme-production' } }),
      'POST /v1/apps/acme-production/secrets': () => ({ body: { version: 7 } }),
      'GET /v1/apps/acme-production/ip_assignments': () => ({ body: { ips: [{ ip: '2a09:8280::1' }, { ip: '66.241.124.10', shared: true }] } }),
      'GET /v1/apps/acme-production/machines': () => ({
        body: [
          machine('m-iad', 'iad', { mounts: [{ volume: 'vol_iad', path: '/data' }] }),
          machine('m-ams', 'ams', { mounts: [{ volume: 'vol_ams', path: '/data' }] }),
          machine('m-old', 'syd'),
          machine('m-worker', 'iad', { metadata: { fly_process_group: 'worker' } }),
        ],
      }),
      'GET /v1/apps/acme-production/volumes': () => ({ body: [] }),
      'POST /v1/apps/acme-production/machines/m-iad/lease': () => ({ body: { status: 'success', data: { nonce: 'n-iad' } } }),
      'POST /v1/apps/acme-production/machines/m-ams/lease': () => ({ body: { status: 'success', data: { nonce: 'n-ams' } } }),
      'POST /v1/apps/acme-production/machines/m-iad': ({ body }) => ({ body: { id: 'm-iad', region: 'iad', state: 'replacing', instance_id: 'iad-v2', config: body.config } }),
      'POST /v1/apps/acme-production/machines/m-ams': ({ body }) => ({ body: { id: 'm-ams', region: 'ams', state: 'replacing', instance_id: 'ams-v2', config: body.config } }),
      'GET /v1/apps/acme-production/machines/m-iad/wait': () => ({ body: { ok: true } }),
      'GET /v1/apps/acme-production/machines/m-ams/wait': () => ({ body: { ok: true } }),
      'DELETE /v1/apps/acme-production/machines/m-iad/lease': () => ({ body: { status: 'success' } }),
      'DELETE /v1/apps/acme-production/machines/m-ams/lease': () => ({ body: { status: 'success' } }),
      'POST /v1/apps/acme-production/certificates/acme': () => ({ body: { hostname: 'acme.example.com', configured: true, status: 'Ready' } }),
    })

    const result = await deployToFly(client, options())

    // No new addresses: the app already has both.
    expect(sent.some(s => s.method === 'POST' && s.path.endsWith('/ip_assignments'))).toBe(false)
    const update = sent.find(s => s.path === '/v1/apps/acme-production/machines/m-iad' && s.method === 'POST')!
    expect(update.headers['fly-machine-lease-nonce']).toBe('n-iad')
    expect(update.body.config.image).toBe('registry.fly.io/acme-production:abc123')
    expect(update.body.config.mounts).toEqual([{ volume: 'vol_iad', path: '/data' }])
    expect(update.body.min_secrets_version).toBe(7)
    expect(sent.find(s => s.path.endsWith('/m-iad/wait'))!.query.instance_id).toBe('iad-v2')

    // Lease, update, wait and release for one Machine, before the next is touched.
    const order = sent.filter(s => /\/machines\/m-(?:iad|ams)/.test(s.path)).map(s => `${s.method} ${s.path.split('/machines/')[1]}`)
    expect(order).toEqual([
      'POST m-iad/lease', 'POST m-iad', 'GET m-iad/wait', 'DELETE m-iad/lease',
      'POST m-ams/lease', 'POST m-ams', 'GET m-ams/wait', 'DELETE m-ams/lease',
    ])
    expect(sent.find(s => s.method === 'DELETE' && s.path.endsWith('/m-iad/lease'))!.headers['fly-machine-lease-nonce']).toBe('n-iad')

    // A region dropped from config is reported, not destroyed; another process group is not ours.
    expect(result).toMatchObject({ createdApp: false, created: [], updated: ['m-iad', 'm-ams'], untouched: ['m-old'] })
    expect(sent.some(s => s.method === 'DELETE' && s.path.endsWith('/m-old'))).toBe(false)
    expect(sent.some(s => s.path.includes('m-worker'))).toBe(false)
  })

  it('stops a rollout at the Machine that fails, releasing its lease and leaving the rest serving', async () => {
    const { client, sent } = fly({
      'GET /v1/apps/acme-production': () => ({ body: { name: 'acme-production' } }),
      'POST /v1/apps/acme-production/secrets': () => ({ body: { version: 1 } }),
      'GET /v1/apps/acme-production/ip_assignments': () => ({ body: { ips: [{ ip: '2a09::1' }, { ip: '1.2.3.4', shared: true }] } }),
      'GET /v1/apps/acme-production/machines': () => ({ body: [machine('m-iad', 'iad'), machine('m-ams', 'ams')] }),
      'GET /v1/apps/acme-production/volumes': () => ({ body: [] }),
      'POST /v1/apps/acme-production/machines/m-iad/lease': () => ({ body: { data: { nonce: 'n1' } } }),
      'POST /v1/apps/acme-production/machines/m-iad': () => ({ status: 422, body: { error: 'image not found' } }),
      'DELETE /v1/apps/acme-production/machines/m-iad/lease': () => ({ body: { status: 'success' } }),
    })

    const error = await deployToFly(client, options()).catch(e => e)
    expect(error).toBeInstanceOf(FlyApiError)
    expect(error.message).toBe('Fly.io POST /apps/acme-production/machines/m-iad failed (422): image not found')
    expect(sent.some(s => s.method === 'DELETE' && s.path.endsWith('/m-iad/lease'))).toBe(true)
    expect(sent.some(s => s.path.includes('m-ams'))).toBe(false)
  })

  it('takes an unattached volume of the same name before creating one', async () => {
    let created = 0
    const { client, sent } = fly({
      'GET /v1/apps/acme-production': () => ({ body: { name: 'acme-production' } }),
      'POST /v1/apps/acme-production/secrets': () => ({ body: { version: 1 } }),
      'GET /v1/apps/acme-production/ip_assignments': () => ({ body: { ips: [{ ip: '2a09::1' }, { ip: '1.2.3.4', shared: true }] } }),
      'GET /v1/apps/acme-production/machines': () => ({ body: [] }),
      'GET /v1/apps/acme-production/volumes': () => ({ body: [{ id: 'vol_kept', name: 'data', region: 'iad', size_gb: 1, attached_machine_id: null }] }),
      'POST /v1/apps/acme-production/volumes': ({ body }) => ({ body: { id: `vol_new_${body.region}`, name: body.name, region: body.region, size_gb: 1 } }),
      'POST /v1/apps/acme-production/machines': ({ body }) => ({ body: { id: `m${++created}`, region: body.region, state: 'created', instance_id: 'i', config: body.config } }),
      'GET /v1/apps/acme-production/machines/m1/wait': () => ({ body: {} }),
      'GET /v1/apps/acme-production/machines/m2/wait': () => ({ body: {} }),
      'POST /v1/apps/acme-production/certificates/acme': () => ({ body: { hostname: 'acme.example.com' } }),
    })

    await deployToFly(client, options())
    expect(sent.filter(s => s.method === 'POST' && s.path.endsWith('/machines')).map(s => s.body.config.mounts[0].volume)).toEqual(['vol_kept', 'vol_new_ams'])
  })
})

describe('FlyClient', () => {
  it('needs a token, and reads a missing app as null', async () => {
    expect(() => new FlyClient({ token: '' })).toThrow('FLY_API_TOKEN')
    const { client } = fly({ 'GET /v1/apps/nope': () => ({ status: 404, body: { error: 'Could not find App' } }) })
    expect(await client.getApp('nope')).toBeNull()
  })

  it('refuses a lease answer with no nonce, rather than updating unlocked', async () => {
    const { client } = fly({ 'POST /v1/apps/a/machines/m/lease': () => ({ body: { status: 'success' } }) })
    await expect(client.acquireLease('a', 'm')).rejects.toThrow('no lease nonce')
  })

  it('reads address kinds the way fly-go does', () => {
    expect(flyIpType({ ip: 'fdaa:0:1::3' })).toBe('private_v6')
    expect(flyIpType({ ip: '2a09:8280::1' })).toBe('v6')
    expect(flyIpType({ ip: '66.241.124.10', shared: true })).toBe('shared_v4')
    expect(flyIpType({ ip: '137.66.1.1' })).toBe('v4')
  })
})

describe('the CloudDriver factory', () => {
  it('sends a Fly config to deployToFly, since it has no box to drive', () => {
    expect(() => createCloudDriver({ config })).toThrow('deployToFly()')
  })
})
