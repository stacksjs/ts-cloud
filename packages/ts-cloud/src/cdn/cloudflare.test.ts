import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { CloudflareProvider } from '../dns/cloudflare'
import { edgeCertificateCovers } from './cloudflare'
import { resolveCloudflareCdnPlan, resolveZoneApex } from './cloudflare-plan'
import { buildOriginGuardRule, buildStaticSiteCacheRules, hostCondition } from './cloudflare-rules'
import { STATIC_SITE_ZONE_SETTINGS, toCloudflareZoneSettings } from './cloudflare-settings'

/**
 * A stand-in for the Cloudflare API.
 *
 * Records every request so a test can assert on the exact payload — which is
 * the point for `proxied`, where the bug worth guarding against is a field that
 * is silently absent rather than wrong.
 */
function mockCloudflare(handlers: Record<string, (body: any) => any>) {
  const calls: Array<{ method: string, path: string, body: any }> = []

  const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(url).replace('https://api.cloudflare.com/client/v4', '')
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })

    // Longest key first: `/zones/zone-1` is a prefix of `/zones/zone-1/dns_records`,
    // so a first-match lookup would answer record queries with the zone object.
    const request = `${method} ${path}`
    const key = Object.keys(handlers)
      .sort((a, b) => b.length - a.length)
      .find(k => request.startsWith(k))
    const result = key ? handlers[key](body) : null

    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  return { calls, fetchMock }
}

async function withFetch<T>(fetchMock: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fetchMock as typeof fetch
  try {
    return await run()
  }
  finally {
    globalThis.fetch = original
  }
}

describe('CloudflareProvider proxied records', () => {
  it('sends proxied:true when creating a record through the CDN', async () => {
    const { calls, fetchMock } = mockCloudflare({
      'GET /zones/zone-1': () => ({ id: 'zone-1', name: 'example.com' }),
      'POST /zones/zone-1/dns_records': () => ({ id: 'rec-1' }),
    })

    const provider = new CloudflareProvider('token', { zoneId: 'zone-1' })
    const result = await withFetch(fetchMock as any, () =>
      provider.createRecord('example.com', { name: 'example.com', type: 'A', content: '1.2.3.4', proxied: true }))

    expect(result.success).toBe(true)
    const post = calls.find(c => c.method === 'POST')
    expect(post?.body.proxied).toBe(true)
    // A proxied record is served from the edge, so Cloudflare only accepts the
    // automatic TTL (1) — sending anything else is rejected outright.
    expect(post?.body.ttl).toBe(1)
  })

  it('preserves an existing proxy state when the upsert does not mention it', async () => {
    // This is the regression that matters most: every deploy re-upserts the
    // box's address records, and Cloudflare's record update is a full PUT whose
    // default for `proxied` is false. Losing the flag here silently drops the
    // CDN and exposes the origin IP while the site keeps loading.
    const { calls, fetchMock } = mockCloudflare({
      'GET /zones/zone-1': () => ({ id: 'zone-1', name: 'example.com' }),
      'GET /zones/zone-1/dns_records': () => [
        { id: 'rec-1', name: 'example.com', type: 'A', content: '1.1.1.1', proxied: true, ttl: 1 },
      ],
      'PUT /zones/zone-1/dns_records/rec-1': () => ({ id: 'rec-1' }),
    })

    const provider = new CloudflareProvider('token', { zoneId: 'zone-1' })
    await withFetch(fetchMock as any, () =>
      provider.upsertRecord('example.com', { name: 'example.com', type: 'A', content: '5.6.7.8', ttl: 300 }))

    const put = calls.find(c => c.method === 'PUT')
    expect(put?.body.proxied).toBe(true)
    expect(put?.body.content).toBe('5.6.7.8')
  })

  it('honours an explicit proxied:false over the existing state', async () => {
    const { calls, fetchMock } = mockCloudflare({
      'GET /zones/zone-1': () => ({ id: 'zone-1', name: 'example.com' }),
      'GET /zones/zone-1/dns_records': () => [
        { id: 'rec-1', name: 'example.com', type: 'A', content: '1.1.1.1', proxied: true, ttl: 1 },
      ],
      'PUT /zones/zone-1/dns_records/rec-1': () => ({ id: 'rec-1' }),
    })

    const provider = new CloudflareProvider('token', { zoneId: 'zone-1' })
    await withFetch(fetchMock as any, () =>
      provider.upsertRecord('example.com', { name: 'example.com', type: 'A', content: '1.1.1.1', proxied: false }))

    expect(calls.find(c => c.method === 'PUT')?.body.proxied).toBe(false)
  })

  it('never sends proxied for a record type Cloudflare cannot proxy', async () => {
    const { calls, fetchMock } = mockCloudflare({
      'GET /zones/zone-1': () => ({ id: 'zone-1', name: 'example.com' }),
      'POST /zones/zone-1/dns_records': () => ({ id: 'rec-1' }),
    })

    const provider = new CloudflareProvider('token', { zoneId: 'zone-1' })
    await withFetch(fetchMock as any, () =>
      provider.createRecord('example.com', { name: 'example.com', type: 'TXT', content: 'v=spf1 -all', proxied: true }))

    expect(calls.find(c => c.method === 'POST')?.body).not.toHaveProperty('proxied')
  })

  it('uses the configured zone id instead of listing zones by name', async () => {
    // A token scoped to one zone cannot read the account-level zone listing, so
    // the by-name lookup returns empty and every call fails with "Zone not
    // found". Going straight to the id is what makes a narrow token usable.
    const { calls, fetchMock } = mockCloudflare({
      'GET /zones/zone-1': () => ({ id: 'zone-1', name: 'example.co.uk' }),
      'POST /zones/zone-1/dns_records': () => ({ id: 'rec-1' }),
    })

    const provider = new CloudflareProvider('token', { zoneId: 'zone-1' })
    await withFetch(fetchMock as any, () =>
      provider.createRecord('www.example.co.uk', { name: 'www.example.co.uk', type: 'A', content: '1.2.3.4' }))

    expect(calls.some(c => c.path.startsWith('/zones?name='))).toBe(false)
    // The zone's real name also fixes record naming for a multi-label suffix,
    // which the last-two-labels guess gets wrong.
    expect(calls.find(c => c.method === 'POST')?.body.name).toBe('www.example.co.uk')
  })
})

describe('managed ruleset writes', () => {
  it('preserves rules it does not own when replacing its own', async () => {
    // Cloudflare only exposes a whole-list PUT for a phase entrypoint, so a
    // naive write deletes every rule a human added in the dashboard.
    const { calls, fetchMock } = mockCloudflare({
      'GET /zones/zone-1': () => ({ id: 'zone-1', name: 'example.com' }),
      'GET /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': () => ({
        id: 'rs-1',
        name: 'entry',
        kind: 'zone',
        phase: 'http_request_cache_settings',
        rules: [
          { id: 'r1', action: 'set_cache_settings', expression: '(http.host eq "other.com")', description: 'hand written' },
          { id: 'r2', action: 'set_cache_settings', expression: '(http.host eq "example.com")', description: '[ts-cloud] cache documents' },
        ],
      }),
      'PUT /zones/zone-1/rulesets/phases/http_request_cache_settings/entrypoint': () => ({ id: 'rs-1' }),
    })

    const provider = new CloudflareProvider('token', { zoneId: 'zone-1' })
    await withFetch(fetchMock as any, () =>
      provider.putManagedPhaseRules('example.com', 'http_request_cache_settings', [
        { action: 'set_cache_settings', expression: '(http.host eq "example.com")', description: 'cache documents' },
      ]))

    const put = calls.find(c => c.method === 'PUT')
    const descriptions = put?.body.rules.map((r: any) => r.description)
    expect(descriptions).toEqual(['hand written', '[ts-cloud] cache documents'])
    // Server-assigned ids must not be echoed back; the PUT defines a fresh list.
    expect(put?.body.rules.every((r: any) => r.id === undefined)).toBe(true)
  })
})

describe('cache rules', () => {
  it('emits bypass, asset and document rules', () => {
    const rules = buildStaticSiteCacheRules(['example.com'], { bypassPaths: ['/api'] })
    expect(rules.map(r => r.description)).toEqual([
      'bypass cache',
      'cache fingerprinted assets',
      'cache documents',
    ])
  })

  it('bypasses requests that ask the same url for a different body', () => {
    // An SPA router fetches the url the browser would navigate to and asks for
    // a fragment of it with a header. The edge keys on the url alone and ignores
    // `Vary` on anything but `Accept-Encoding`, so caching this stores whichever
    // representation arrives first and serves it to everyone — and a stored
    // fragment is a headless, unstyled page for every visitor until it expires.
    const rules = buildStaticSiteCacheRules(['example.com'])
    const bypass = rules.find(r => r.description === 'bypass cache')!

    expect(bypass.expression).toContain('any(http.request.headers["x-stx-router"][*] == "true")')
    expect(bypass.action_parameters).toEqual({ cache: false })
  })

  it('keeps those requests out of the caching rules as well', () => {
    // The rules are mutually exclusive by construction, not by order: a document
    // rule that still matched the fragment request would re-cache it.
    const rules = buildStaticSiteCacheRules(['example.com'])
    for (const description of ['cache fingerprinted assets', 'cache documents']) {
      const rule = rules.find(r => r.description === description)!
      expect(rule.expression).toContain('not (any(http.request.headers["x-stx-router"][*] == "true"))')
    }
  })

  it('emits the bypass rule even with no bypassPaths', () => {
    // The renegotiating headers are reason enough on their own.
    const rules = buildStaticSiteCacheRules(['example.com'])
    expect(rules.map(r => r.description)).toEqual([
      'bypass cache',
      'cache fingerprinted assets',
      'cache documents',
    ])
  })

  it('matches a bare header by presence when no value is named', () => {
    const rules = buildStaticSiteCacheRules(['example.com'], {
      negotiatedRequestHeaders: [{ name: 'X-Custom-Fragment' }],
    })
    const bypass = rules.find(r => r.description === 'bypass cache')!

    expect(bypass.expression).toContain('len(http.request.headers["x-custom-fragment"]) > 0')
  })

  it('lets a site with no client router opt out entirely', () => {
    const rules = buildStaticSiteCacheRules(['example.com'], { negotiatedRequestHeaders: [] })
    expect(rules.map(r => r.description)).toEqual([
      'cache fingerprinted assets',
      'cache documents',
    ])
  })

  it('keeps the document rule from matching assets', () => {
    // Cloudflare applies EVERY matching rule in this phase and lets a later one
    // override an earlier one, so a bare `http.host eq …` catch-all silently
    // re-caches `.js`/`.css` with the HTML browser TTL and undoes the asset
    // rule. The rules must therefore be mutually exclusive by construction.
    const rules = buildStaticSiteCacheRules(['example.com'])
    const documents = rules.find(r => r.description === 'cache documents')!
    expect(documents.expression).toContain('not lower(http.request.uri.path.extension) in')
  })

  it('excludes bypassed paths from both caching rules', () => {
    // The negation carries every bypass reason — paths and renegotiating
    // headers alike — so assert the path is inside it rather than that it is
    // the whole of it.
    const rules = buildStaticSiteCacheRules(['example.com'], { bypassPaths: ['/api'] })
    for (const description of ['cache fingerprinted assets', 'cache documents']) {
      const rule = rules.find(r => r.description === description)!
      expect(rule.expression).toContain('and not (starts_with(http.request.uri.path, "/api")')
    }
  })

  it('excludes bypassed paths from both caching rules when they are the only reason', () => {
    const rules = buildStaticSiteCacheRules(['example.com'], {
      bypassPaths: ['/api'],
      negotiatedRequestHeaders: [],
    })
    for (const description of ['cache fingerprinted assets', 'cache documents']) {
      const rule = rules.find(r => r.description === description)!
      expect(rule.expression).toContain('not (starts_with(http.request.uri.path, "/api"))')
    }
  })

  it('scopes every rule to the fronted hosts', () => {
    // A zone can serve names that have nothing to do with this deploy; an
    // unscoped catch-all would start caching someone else's dynamic responses.
    const rules = buildStaticSiteCacheRules(['example.com', 'www.example.com'])
    expect(rules.every(r => r.expression.includes('http.host in {"example.com" "www.example.com"}'))).toBe(true)
  })

  it('caches documents for less time than fingerprinted assets', () => {
    const rules = buildStaticSiteCacheRules(['example.com'])
    const assets = rules.find(r => r.description === 'cache fingerprinted assets')
    const documents = rules.find(r => r.description === 'cache documents')
    const edgeTtl = (rule: any) => rule.action_parameters.edge_ttl.default
    expect(edgeTtl(assets)).toBeGreaterThan(edgeTtl(documents))
  })

  it('produces nothing when disabled', () => {
    expect(buildStaticSiteCacheRules(['example.com'], { enabled: false })).toEqual([])
  })

  it('quotes a single host with eq rather than a set', () => {
    expect(hostCondition(['example.com'])).toBe('http.host eq "example.com"')
  })
})

describe('origin guard rule', () => {
  it('sets the secret header for the fronted hosts', () => {
    const [rule] = buildOriginGuardRule(['example.com'], 'X-Origin-Verify', 's3cret')
    expect(rule.action).toBe('rewrite')
    expect((rule.action_parameters as any).headers['X-Origin-Verify']).toEqual({ operation: 'set', value: 's3cret' })
  })

  it('produces nothing without a secret', () => {
    expect(buildOriginGuardRule(['example.com'], 'X-Origin-Verify', '')).toEqual([])
  })
})

describe('zone settings mapping', () => {
  it('translates booleans to Cloudflare on/off and nests HSTS', () => {
    const mapped = toCloudflareZoneSettings({
      ssl: 'strict',
      alwaysUseHttps: true,
      brotli: false,
      hsts: { enabled: true, maxAge: 60 },
    })

    expect(mapped.ssl).toBe('strict')
    expect(mapped.always_use_https).toBe('on')
    expect(mapped.brotli).toBe('off')
    expect(mapped.security_header).toEqual({
      strict_transport_security: {
        enabled: true,
        max_age: 60,
        include_subdomains: false,
        preload: false,
        nosniff: true,
      },
    })
  })

  it('omits every setting the config does not name', () => {
    // A reconcile must not reset settings the zone holds for other reasons.
    expect(Object.keys(toCloudflareZoneSettings({ brotli: true }))).toEqual(['brotli'])
  })

  it('defaults a static site to a verified origin hop', () => {
    // `flexible` sends plaintext to the origin and loops against a gateway that
    // redirects HTTP to HTTPS; `full` accepts any certificate at all.
    expect(STATIC_SITE_ZONE_SETTINGS.ssl).toBe('strict')
  })
})

describe('resolveCloudflareCdnPlan', () => {
  const base = (cdn: any): CloudConfig =>
    ({
      project: { name: 'redline', slug: 'redline' },
      infrastructure: { compute: { mode: 'server', proxy: { engine: 'rpx', cdn } }, dns: { domain: 'example.com' } },
      sites: { main: { domain: 'example.com', deploy: 'server', root: 'dist' } },
    }) as unknown as CloudConfig

  const env = (values: Record<string, string>) => (key: string) => values[key]

  it('produces no plan when the CDN is not Cloudflare', () => {
    const { plan, errors } = resolveCloudflareCdnPlan(base({ provider: 'cloudfront', frontedHosts: ['example.com'] }), {
      env: env({ CLOUDFLARE_API_TOKEN: 'token' }),
    })
    expect(plan).toBeNull()
    expect(errors).toEqual([])
  })

  it('defaults fronted hosts to every hostname the gateway answers for', () => {
    const { plan } = resolveCloudflareCdnPlan(base({ provider: 'cloudflare', frontedHosts: [] }), {
      env: env({ CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ZONE_ID: 'zone-1' }),
    })
    expect(plan?.hosts.sort()).toEqual(['example.com', 'www.example.com'])
    expect(plan?.zone).toBe('example.com')
    expect(plan?.zoneId).toBe('zone-1')
    expect(plan?.proxied).toBe(true)
  })

  it('reports a missing token instead of planning a reconcile that cannot run', () => {
    const { plan, errors } = resolveCloudflareCdnPlan(base({ provider: 'cloudflare', frontedHosts: ['example.com'] }), {
      env: env({}),
    })
    expect(plan).toBeNull()
    expect(errors[0]).toContain('CLOUDFLARE_API_TOKEN')
  })

  it('flags an originDomain as meaningless for Cloudflare', () => {
    // CloudFront needs one because a distribution fronting its own alias loops.
    // Cloudflare reads the origin out of the record it proxies, so a separate
    // public origin hostname only offers a way around the edge.
    const { errors } = resolveCloudflareCdnPlan(
      base({ provider: 'cloudflare', frontedHosts: ['example.com'], originDomain: 'origin.example.com' }),
      { env: env({ CLOUDFLARE_API_TOKEN: 'token' }) },
    )
    expect(errors.some(e => e.includes('originDomain'))).toBe(true)
  })

  it('refuses to plan across two zones', () => {
    const { plan, errors } = resolveCloudflareCdnPlan(
      base({ provider: 'cloudflare', frontedHosts: ['example.com', 'other.org'] }),
      { env: env({ CLOUDFLARE_API_TOKEN: 'token' }) },
    )
    expect(plan).toBeNull()
    expect(errors.some(e => e.includes('more than one zone'))).toBe(true)
  })

  it('carries the gateway secret into an origin guard', () => {
    const { plan } = resolveCloudflareCdnPlan(
      base({ provider: 'cloudflare', frontedHosts: ['example.com'], secret: 's3cret' }),
      { env: env({ CLOUDFLARE_API_TOKEN: 'token' }) },
    )
    expect(plan?.originGuard).toEqual({ header: 'X-Origin-Verify', value: 's3cret' })
  })
})

describe('resolveZoneApex', () => {
  it('prefers the configured domain over the last-two-labels guess', () => {
    expect(resolveZoneApex('www.example.co.uk', 'example.co.uk')).toBe('example.co.uk')
    expect(resolveZoneApex('www.example.co.uk')).toBe('co.uk')
  })
})

describe('edgeCertificateCovers', () => {
  it('matches an exact hostname', () => {
    expect(edgeCertificateCovers(['example.com'], 'example.com')).toBe(true)
  })

  it('matches one label under a wildcard', () => {
    expect(edgeCertificateCovers(['*.example.com'], 'www.example.com')).toBe(true)
  })

  it('does NOT match two labels under a wildcard', () => {
    // The rule that takes sites down: Universal SSL issues the apex plus a
    // single wildcard, so a three-label host is never covered by it. Proxying
    // it anyway fails the TLS handshake outright.
    expect(edgeCertificateCovers(['*.example.com'], 'www.app.example.com')).toBe(false)
  })

  it('does not let a wildcard cover the apex it belongs to', () => {
    expect(edgeCertificateCovers(['*.example.com'], 'example.com')).toBe(false)
  })

  it('treats an empty certificate list as covering nothing', () => {
    expect(edgeCertificateCovers([], 'example.com')).toBe(false)
  })

  it('ignores trailing dots and case', () => {
    expect(edgeCertificateCovers(['*.Example.com.'], 'WWW.example.com')).toBe(true)
  })

  it('does not match a different zone that shares a suffix', () => {
    expect(edgeCertificateCovers(['*.example.com'], 'www.notexample.com')).toBe(false)
  })
})

describe('email obfuscation', () => {
  it('is disabled by default, because it rewrites the origin\'s HTML', () => {
    // Cloudflare enables this on new zones. It turns `mailto:` links into
    // script-decoded spans, so a contact link stops working wherever the
    // script does not run — and every check that does not execute JavaScript
    // still reports the page as fine.
    expect(STATIC_SITE_ZONE_SETTINGS.emailObfuscation).toBe(false)
  })

  it('maps to the setting id Cloudflare expects', () => {
    expect(toCloudflareZoneSettings({ emailObfuscation: false }).email_obfuscation).toBe('off')
    expect(toCloudflareZoneSettings({ emailObfuscation: true }).email_obfuscation).toBe('on')
  })

  it('is left alone when not specified', () => {
    expect(toCloudflareZoneSettings({}).email_obfuscation).toBeUndefined()
  })
})
