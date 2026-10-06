import type { R2Config } from '@ts-cloud/core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { R2NotEnabledError } from './provider'
import { managedRuleInSync, reconcileR2Buckets, toApiLifecycleRule } from './reconcile'
import { CloudflareFailure, fakeCloudflare } from './test-fetch'

const ACCOUNT = 'acc123'
const ZONE = 'zone1'
const BASE = `/accounts/${ACCOUNT}/r2/buckets/tiles`
const CACHE_PHASE = `/zones/${ZONE}/rulesets/phases/http_request_cache_settings/entrypoint`
const BUCKET_MISSING = new CloudflareFailure(404, [{ code: 10006, message: 'The specified bucket does not exist.' }])

const r2: R2Config = {
  buckets: {
    tiles: {
      name: 'tiles',
      locationHint: 'wnam',
      customDomains: ['tiles.example.com'],
      cors: [{ allowed: { origins: ['https://example.com'], methods: ['GET', 'HEAD'] }, maxAgeSeconds: 3600 }],
      lifecycle: [{ id: 'expire-tmp', prefix: 'tmp/', expireAfterDays: 7 }],
      cache: { edgeTtl: 86400, browserTtl: 3600 },
    },
  },
}

const config = { infrastructure: { r2 } }

/** The cache rule exactly as ts-cloud writes it for the config above. */
const CACHE_RULE = {
  id: 'rule-1',
  action: 'set_cache_settings',
  description: '[ts-cloud] r2 cache',
  expression: '(http.host eq "tiles.example.com")',
  enabled: true,
  action_parameters: {
    cache: true,
    edge_ttl: { mode: 'override_origin', default: 86400 },
    browser_ttl: { mode: 'override_origin', default: 3600 },
  },
}

/** Zone lookups the CloudflareProvider makes for a configured zone id. */
const ZONE_ROUTES = { [`GET /zones/${ZONE}`]: { id: ZONE, name: 'example.com' } }

/** Every GET answering with state that already matches `config`. */
const IN_SYNC_ROUTES = {
  ...ZONE_ROUTES,
  [`GET ${BASE}`]: { name: 'tiles', location: 'wnam' },
  [`GET ${BASE}/cors`]: { rules: [{ allowed: { origins: ['https://example.com'], methods: ['HEAD', 'GET'] }, maxAgeSeconds: 3600 }] },
  [`GET ${BASE}/lifecycle`]: { rules: [toApiLifecycleRule(r2.buckets.tiles!.lifecycle![0]!)] },
  [`GET ${BASE}/domains/managed`]: { bucketId: 'b', domain: 'pub-1.r2.dev', enabled: false },
  [`GET ${BASE}/domains/custom`]: {
    domains: [{ domain: 'tiles.example.com', enabled: true, minTLS: '1.2', zoneId: ZONE, status: { ownership: 'active', ssl: 'active' } }],
  },
  [`GET ${CACHE_PHASE}`]: { id: 'rs', name: 'default', kind: 'zone', phase: 'http_request_cache_settings', rules: [CACHE_RULE] },
}

// The zone lookups and cache rule go through CloudflareProvider, which uses
// the global fetch, so the fake is installed globally as well as passed in.
const realFetch = globalThis.fetch
let installed: ReturnType<typeof fakeCloudflare>

function install(routes: Record<string, unknown>): ReturnType<typeof fakeCloudflare> {
  installed = fakeCloudflare(routes)
  globalThis.fetch = installed.fetch as typeof fetch
  return installed
}

const creds = { apiToken: 'tok', accountId: ACCOUNT, zoneId: ZONE }

describe('reconcileR2Buckets', () => {
  beforeEach(() => {
    install({})
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('does nothing without an r2 block', async () => {
    const lines: string[] = []
    const summary = await reconcileR2Buckets({ infrastructure: {} }, { ...creds, log: line => lines.push(line) })
    expect(summary).toEqual({ buckets: [], warnings: [] })
    expect(installed.calls).toEqual([])
    expect(lines[0]).toContain('no buckets declared')
  })

  it('skips with a warning when credentials are missing', async () => {
    const summary = await reconcileR2Buckets(config, { apiToken: 'tok' })
    expect(summary.buckets).toEqual([])
    expect(summary.warnings[0]).toContain('CLOUDFLARE_ACCOUNT_ID')
    expect(installed.calls).toEqual([])
  })

  it('also reads a top-level r2 block', async () => {
    const fake = install(IN_SYNC_ROUTES)
    const summary = await reconcileR2Buckets({ r2 }, creds)
    expect(summary.buckets[0]!.name).toBe('tiles')
    expect(fake.writes()).toEqual([])
  })

  it('is a no-op when everything is in sync', async () => {
    const fake = install(IN_SYNC_ROUTES)

    const summary = await reconcileR2Buckets(config, creds)

    expect(summary).toEqual({
      buckets: [{ name: 'tiles', changes: [], domains: [{ domain: 'tiles.example.com', status: 'active' }] }],
      warnings: [],
    })
    expect(fake.writes()).toEqual([])
  })

  it('dry run reports a missing bucket and everything on it without writing', async () => {
    const fake = install({
      ...ZONE_ROUTES,
      [`GET ${BASE}`]: BUCKET_MISSING,
      [`GET ${CACHE_PHASE}`]: { rules: [] },
    })

    const summary = await reconcileR2Buckets(config, { ...creds, dryRun: true })

    expect(fake.writes()).toEqual([])
    expect(summary.warnings).toEqual([])
    expect(summary.buckets[0]!.changes).toEqual([
      'would create bucket',
      'would set cors',
      'would update lifecycle',
      'would attach custom domain tiles.example.com',
      'would update cache rule for tiles.example.com',
    ])
    expect(summary.buckets[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'not attached' }])
  })

  it('dry run on an in-sync bucket reports nothing', async () => {
    const fake = install(IN_SYNC_ROUTES)
    const summary = await reconcileR2Buckets(config, { ...creds, dryRun: true })
    expect(summary.buckets[0]!.changes).toEqual([])
    expect(fake.writes()).toEqual([])
  })

  it('creates and configures a new bucket, merging the cache rule into the zone', async () => {
    const dashboardRule = { id: 'human', action: 'set_cache_settings', description: 'made in the dashboard', expression: '(http.host eq "www.example.com")', enabled: true, action_parameters: { cache: false } }
    let created = false
    const fake = install({
      ...ZONE_ROUTES,
      [`GET ${BASE}`]: () => created ? { name: 'tiles' } : BUCKET_MISSING,
      [`POST /accounts/${ACCOUNT}/r2/buckets`]: () => {
        created = true
        return { name: 'tiles', location: 'wnam' }
      },
      [`GET ${BASE}/cors`]: new CloudflareFailure(404, [{ code: 10059, message: 'The CORS configuration does not exist.' }]),
      [`PUT ${BASE}/cors`]: null,
      [`GET ${BASE}/lifecycle`]: { rules: [{ id: 'Default Multipart Abort Rule', enabled: true, conditions: { prefix: '' }, abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } } }] },
      [`PUT ${BASE}/lifecycle`]: null,
      [`GET ${BASE}/domains/managed`]: { bucketId: 'b', domain: 'pub-1.r2.dev', enabled: false },
      [`GET ${BASE}/domains/custom`]: { domains: [] },
      [`POST ${BASE}/domains/custom`]: { domain: 'tiles.example.com', enabled: true, zoneId: ZONE, minTLS: '1.2' },
      [`GET ${CACHE_PHASE}`]: { rules: [dashboardRule] },
      [`PUT ${CACHE_PHASE}`]: { rules: [] },
    })

    const summary = await reconcileR2Buckets(config, creds)

    expect(summary.warnings).toEqual([])
    expect(summary.buckets[0]!.changes).toEqual([
      'created',
      'cors updated',
      'lifecycle updated',
      'custom domain tiles.example.com attached',
      'cache rule updated for tiles.example.com',
    ])
    expect(summary.buckets[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'pending' }])

    const writes = fake.writes()
    const at = (method: string, path: string) => writes.find(call => call.method === method && call.path === path)!

    expect(at('POST', `/accounts/${ACCOUNT}/r2/buckets`).body).toEqual({ name: 'tiles', locationHint: 'wnam' })
    expect(at('PUT', `${BASE}/lifecycle`).body).toEqual({
      rules: [{ id: 'expire-tmp', enabled: true, conditions: { prefix: 'tmp/' }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } } }],
    })
    expect(at('POST', `${BASE}/domains/custom`).body).toEqual({ domain: 'tiles.example.com', zoneId: ZONE, enabled: true, minTLS: '1.2' })

    // The dashboard rule survives; ours is appended, tagged and host-scoped.
    const rules = at('PUT', CACHE_PHASE).body.rules
    expect(rules).toHaveLength(2)
    expect(rules[0]).toEqual({ action: 'set_cache_settings', description: 'made in the dashboard', expression: '(http.host eq "www.example.com")', enabled: true, action_parameters: { cache: false } })
    // eslint-disable-next-line pickier/no-unused-vars
    const { id, ...ours } = CACHE_RULE
    expect(rules[1]).toEqual(ours)
  })

  it('throws the typed error when R2 is not enabled on the account', async () => {
    install({
      ...ZONE_ROUTES,
      [`GET ${BASE}`]: new CloudflareFailure(403, [{ code: 10042, message: 'Please enable R2 through the Cloudflare Dashboard.' }]),
    })
    const error = await reconcileR2Buckets(config, creds).catch(caught => caught)
    expect(error).toBeInstanceOf(R2NotEnabledError)
    expect(error.message).toContain('Enable it once in the Cloudflare dashboard')
  })

  it('turns a domain that will not attach into a warning and carries on', async () => {
    install({
      ...IN_SYNC_ROUTES,
      [`GET ${BASE}/domains/custom`]: { domains: [] },
      [`POST ${BASE}/domains/custom`]: new CloudflareFailure(409, [{ code: 10057, message: 'A DNS record already exists for this hostname' }]),
    })

    const summary = await reconcileR2Buckets(config, creds)

    expect(summary.warnings).toHaveLength(1)
    expect(summary.warnings[0]).toContain('custom domain tiles.example.com')
    expect(summary.warnings[0]).toContain('already exists')
    expect(summary.buckets[0]!.domains).toEqual([{ domain: 'tiles.example.com', status: 'error' }])
  })

  it('rejects an invalid bucket name before calling the API', async () => {
    const summary = await reconcileR2Buckets({ r2: { buckets: { bad: { name: 'Bad_Name' } } } }, creds)
    expect(summary.buckets).toEqual([])
    expect(summary.warnings[0]).toContain('invalid name')
    expect(installed.calls).toEqual([])
  })
})

describe('managedRuleInSync', () => {
  const rule = { action: 'set_cache_settings', description: '[ts-cloud] r2 cache', expression: '(http.host eq "a.com")', enabled: true, action_parameters: { cache: true } }

  it('accepts a merged rule that covers the host alongside others', () => {
    expect(managedRuleInSync([{ ...rule, expression: '(http.host in {"a.com" "b.com"})' }], rule)).toBe(true)
  })

  it('rejects a rule with different parameters', () => {
    expect(managedRuleInSync([{ ...rule, action_parameters: { cache: false } }], rule)).toBe(false)
  })

  it('rejects when another managed rule still claims the host', () => {
    expect(managedRuleInSync([rule, { ...rule, description: '[ts-cloud] other' }], rule)).toBe(false)
  })

  it('ignores unmanaged rules on the same host', () => {
    expect(managedRuleInSync([rule, { ...rule, description: 'human' }], rule)).toBe(true)
  })
})
