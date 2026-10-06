import { describe, expect, it } from 'bun:test'
import { R2ApiError, r2Endpoint, R2NotEnabledError, R2Provider, r2S3Credentials } from './provider'
import { CloudflareFailure, fakeCloudflare } from './test-fetch'

const ACCOUNT = 'acc123'
const BASE = `/accounts/${ACCOUNT}/r2`
const NOT_FOUND = new CloudflareFailure(404, [{ code: 10006, message: 'The specified bucket does not exist.' }])
const NOT_ENABLED = new CloudflareFailure(403, [{ code: 10042, message: 'Please enable R2 through the Cloudflare Dashboard.' }])

function provider(routes: Record<string, unknown>) {
  const fake = fakeCloudflare(routes)
  return { r2: new R2Provider({ apiToken: 'tok', accountId: ACCOUNT, fetch: fake.fetch }), ...fake }
}

describe('R2Provider', () => {
  describe('buckets', () => {
    it('creates a missing bucket with its location hint and jurisdiction header', async () => {
      const { r2, calls, writes } = provider({
        [`GET ${BASE}/buckets/media`]: NOT_FOUND,
        [`POST ${BASE}/buckets`]: { name: 'media', location: 'weur', jurisdiction: 'eu' },
      })

      const { bucket, created } = await r2.ensureBucket('media', { locationHint: 'weur', jurisdiction: 'eu' })

      expect(created).toBe(true)
      expect(bucket.name).toBe('media')
      expect(writes()).toHaveLength(1)
      expect(writes()[0]!.body).toEqual({ name: 'media', locationHint: 'weur' })
      for (const call of calls) {
        expect(call.headers.authorization).toBe('Bearer tok')
        expect(call.headers['cf-r2-jurisdiction']).toBe('eu')
      }
    })

    it('leaves an existing bucket alone', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media`]: { name: 'media', location: 'wnam' },
      })

      const { created } = await r2.ensureBucket('media', { locationHint: 'weur' })

      expect(created).toBe(false)
      expect(writes()).toEqual([])
    })

    it('does not send a jurisdiction header for the default jurisdiction', async () => {
      const { r2, calls } = provider({ [`GET ${BASE}/buckets/media`]: { name: 'media' } })
      await r2.getBucket('media', { jurisdiction: 'default' })
      expect(calls[0]!.headers['cf-r2-jurisdiction']).toBeUndefined()
    })

    it('follows the list cursor across pages', async () => {
      let page = 0
      const fake = fakeCloudflare({})
      const r2 = new R2Provider({
        apiToken: 'tok',
        accountId: ACCOUNT,
        fetch: async (input, init) => {
          const url = new URL(input)
          fake.calls.push({ method: 'GET', path: url.pathname, query: url.searchParams, headers: {}, body: undefined })
          page++
          const body = page === 1
            ? { success: true, errors: [], messages: [], result: { buckets: [{ name: 'a' }] }, result_info: { cursor: 'next' } }
            : { success: true, errors: [], messages: [], result: { buckets: [{ name: 'b' }] }, result_info: { cursor: '' } }
          return new Response(JSON.stringify(body), init && { status: 200 })
        },
      })

      const buckets = await r2.listBuckets()

      expect(buckets.map(bucket => bucket.name)).toEqual(['a', 'b'])
      expect(fake.calls[1]!.query.get('cursor')).toBe('next')
    })
  })

  describe('R2 not enabled (10042)', () => {
    it('maps the code to a typed error that says to enable R2 in the dashboard', async () => {
      const { r2 } = provider({ [`GET ${BASE}/buckets/media`]: NOT_ENABLED })

      const error = await r2.ensureBucket('media').catch(caught => caught)

      expect(error).toBeInstanceOf(R2NotEnabledError)
      expect(error).toBeInstanceOf(R2ApiError)
      expect(error.accountId).toBe(ACCOUNT)
      expect(error.message).toContain('Cloudflare dashboard')
      expect(error.message).toContain(ACCOUNT)
    })

    it('is not mistaken for a missing bucket or a missing CORS policy', async () => {
      const { r2 } = provider({
        [`GET ${BASE}/buckets/media`]: NOT_ENABLED,
        [`GET ${BASE}/buckets/media/cors`]: NOT_ENABLED,
      })
      await expect(r2.getBucket('media')).rejects.toBeInstanceOf(R2NotEnabledError)
      await expect(r2.getCors('media')).rejects.toBeInstanceOf(R2NotEnabledError)
    })

    it('keeps other API errors as plain R2ApiError with their codes', async () => {
      const { r2 } = provider({
        [`GET ${BASE}/buckets/bad`]: new CloudflareFailure(400, [{ code: 10005, message: 'Invalid bucket name' }]),
      })
      const error = await r2.getBucket('bad').catch(caught => caught)
      expect(error).toBeInstanceOf(R2ApiError)
      expect(error).not.toBeInstanceOf(R2NotEnabledError)
      expect(error.status).toBe(400)
      expect(error.hasCode(10005)).toBe(true)
      expect(error.message).toContain('10005: Invalid bucket name')
    })
  })

  describe('cors', () => {
    const rules = [{ allowed: { origins: ['https://a.com', 'https://b.com'], methods: ['GET', 'HEAD'] as Array<'GET' | 'HEAD'> }, maxAgeSeconds: 3600 }]

    it('puts rules in the API shape', async () => {
      const { r2, writes } = provider({ [`PUT ${BASE}/buckets/media/cors`]: null })
      await r2.putCors('media', rules)
      expect(writes()[0]!.body).toEqual({ rules })
    })

    it('treats a bucket without a policy as having no rules', async () => {
      const { r2 } = provider({
        [`GET ${BASE}/buckets/media/cors`]: new CloudflareFailure(404, [{ code: 10059, message: 'The CORS configuration does not exist.' }]),
      })
      expect(await r2.getCors('media')).toEqual([])
    })

    it('does not write when the policy already says the same thing in another order', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/cors`]: {
          rules: [{ id: 'server-id', allowed: { origins: ['https://b.com', 'https://a.com'], methods: ['HEAD', 'GET'], headers: [] }, maxAgeSeconds: 3600 }],
        },
      })
      expect(await r2.ensureCors('media', rules)).toBe(false)
      expect(writes()).toEqual([])
    })

    it('writes when the policy differs', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/cors`]: { rules: [{ allowed: { origins: ['https://a.com'], methods: ['GET'] } }] },
        [`PUT ${BASE}/buckets/media/cors`]: null,
      })
      expect(await r2.ensureCors('media', rules)).toBe(true)
      expect(writes()).toHaveLength(1)
    })

    it('deletes the policy for an empty rule list', async () => {
      const { r2, writes } = provider({ [`DELETE ${BASE}/buckets/media/cors`]: null })
      await r2.putCors('media', [])
      expect(writes()[0]!.method).toBe('DELETE')
    })
  })

  describe('lifecycle', () => {
    const rule = {
      id: 'expire-tmp',
      enabled: true,
      conditions: { prefix: 'tmp/' },
      deleteObjectsTransition: { condition: { type: 'Age' as const, maxAge: 604800 } },
    }

    it('puts rules to /lifecycle', async () => {
      const { r2, writes } = provider({ [`PUT ${BASE}/buckets/media/lifecycle`]: null })
      await r2.putLifecycle('media', [rule])
      expect(writes()[0]!.body).toEqual({ rules: [rule] })
    })

    it('does not write when the rules already match', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/lifecycle`]: { rules: [{ ...rule, storageClassTransitions: [] }] },
      })
      expect(await r2.ensureLifecycle('media', [rule])).toBe(false)
      expect(writes()).toEqual([])
    })

    it('writes when they differ', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/lifecycle`]: { rules: [] },
        [`PUT ${BASE}/buckets/media/lifecycle`]: null,
      })
      expect(await r2.ensureLifecycle('media', [rule])).toBe(true)
      expect(writes()).toHaveLength(1)
    })
  })

  describe('custom domains', () => {
    it('attaches a missing domain, enabled, with TLS 1.2 by default', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/domains/custom`]: { domains: [] },
        [`POST ${BASE}/buckets/media/domains/custom`]: { domain: 'cdn.example.com', enabled: true, zoneId: 'zone1', minTLS: '1.2' },
      })

      const { action } = await r2.ensureCustomDomain('media', { domain: 'cdn.example.com', zoneId: 'zone1' })

      expect(action).toBe('attached')
      expect(writes()[0]!.body).toEqual({ domain: 'cdn.example.com', zoneId: 'zone1', enabled: true, minTLS: '1.2' })
    })

    it('leaves a matching domain alone', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/domains/custom`]: {
          domains: [{ domain: 'cdn.example.com', enabled: true, minTLS: '1.2', status: { ownership: 'active', ssl: 'active' } }],
        },
      })
      const { action } = await r2.ensureCustomDomain('media', { domain: 'cdn.example.com', zoneId: 'zone1' })
      expect(action).toBe('unchanged')
      expect(writes()).toEqual([])
    })

    it('updates a disabled domain or one with the wrong minimum TLS, by its escaped name', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/domains/custom`]: { domains: [{ domain: 'cdn.example.com', enabled: false, minTLS: '1.0' }] },
        [`PUT ${BASE}/buckets/media/domains/custom/cdn.example.com`]: { domain: 'cdn.example.com', enabled: true, minTLS: '1.3' },
      })
      const { action } = await r2.ensureCustomDomain('media', { domain: 'cdn.example.com', zoneId: 'zone1', minTLS: '1.3' })
      expect(action).toBe('updated')
      expect(writes()[0]!.body).toEqual({ enabled: true, minTLS: '1.3' })
    })
  })

  describe('managed r2.dev domain', () => {
    it('does not write when already in the requested state', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/domains/managed`]: { bucketId: 'b', domain: 'pub-x.r2.dev', enabled: false },
      })
      const { changed } = await r2.setManagedDomain('media', false)
      expect(changed).toBe(false)
      expect(writes()).toEqual([])
    })

    it('puts { enabled } when it differs', async () => {
      const { r2, writes } = provider({
        [`GET ${BASE}/buckets/media/domains/managed`]: { bucketId: 'b', domain: 'pub-x.r2.dev', enabled: false },
        [`PUT ${BASE}/buckets/media/domains/managed`]: { bucketId: 'b', domain: 'pub-x.r2.dev', enabled: true },
      })
      const { changed, domain } = await r2.setManagedDomain('media', true)
      expect(changed).toBe(true)
      expect(domain.enabled).toBe(true)
      expect(writes()[0]!.body).toEqual({ enabled: true })
    })
  })
})

describe('r2S3Credentials', () => {
  // SHA-256("abc"), the FIPS 180-2 test vector.
  const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

  it('uses the token id as the access key and the hex SHA-256 of the token as the secret', async () => {
    const fake = fakeCloudflare({
      [`GET /accounts/${ACCOUNT}/tokens/verify`]: { id: 'token-id-1', status: 'active' },
    })

    const credentials = await r2S3Credentials({ apiToken: 'abc', accountId: ACCOUNT, fetch: fake.fetch })

    expect(credentials).toEqual({
      accessKeyId: 'token-id-1',
      secretAccessKey: ABC_SHA256,
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      region: 'auto',
    })
    expect(fake.calls[0]!.headers.authorization).toBe('Bearer abc')
  })

  it('verifies against the account endpoint first, since account tokens 401 on /user', async () => {
    const fake = fakeCloudflare({
      [`GET /accounts/${ACCOUNT}/tokens/verify`]: { id: 'account-token' },
      'GET /user/tokens/verify': new CloudflareFailure(401, [{ code: 1000, message: 'Invalid API Token' }]),
    })
    const credentials = await r2S3Credentials({ apiToken: 'abc', accountId: ACCOUNT, fetch: fake.fetch })
    expect(credentials.accessKeyId).toBe('account-token')
    expect(fake.calls).toHaveLength(1)
  })

  it('falls back to the user endpoint for a user-owned token', async () => {
    const fake = fakeCloudflare({
      [`GET /accounts/${ACCOUNT}/tokens/verify`]: new CloudflareFailure(401, [{ code: 1000, message: 'Invalid API Token' }]),
      'GET /user/tokens/verify': { id: 'user-token' },
    })
    const credentials = await r2S3Credentials({ apiToken: 'abc', accountId: ACCOUNT, fetch: fake.fetch })
    expect(credentials.accessKeyId).toBe('user-token')
  })

  it('throws with both answers when neither endpoint accepts the token', async () => {
    const fake = fakeCloudflare({
      [`GET /accounts/${ACCOUNT}/tokens/verify`]: new CloudflareFailure(401, [{ code: 1000, message: 'Invalid API Token' }]),
      'GET /user/tokens/verify': new CloudflareFailure(401, [{ code: 1000, message: 'Invalid API Token' }]),
    })
    await expect(r2S3Credentials({ apiToken: 'abc', accountId: ACCOUNT, fetch: fake.fetch })).rejects.toThrow(/tokens\/verify -> 401/)
  })

  it('r2Endpoint is the account S3 host', () => {
    expect(r2Endpoint('abc')).toBe('https://abc.r2.cloudflarestorage.com')
  })
})
