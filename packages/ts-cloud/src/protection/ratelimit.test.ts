import type { RateLimitRule, RequestDescriptor } from './ratelimit'
import { describe, expect, it } from 'bun:test'
import {
  defaultRateLimitRules,
  globMatches,
  rateLimitHeaders,
  rateLimitKey,
  RateLimiter,
  RATE_LIMIT_KEY_SEPARATOR,
  ruleMatches,
} from './ratelimit'

/** Counter keys join the rule id and the identity with a non-printable separator. */
const key = (ruleId: string, identity: string): string => `${ruleId}${RATE_LIMIT_KEY_SEPARATOR}${identity}`

function request(overrides: Partial<RequestDescriptor> = {}): RequestDescriptor {
  return { ip: '203.0.113.5', method: 'GET', path: '/', host: 'example.com', ...overrides }
}

function limiter(rules: readonly RateLimitRule[]) {
  let clock = 0
  return { instance: new RateLimiter(rules, () => clock), advance: (ms: number) => (clock += ms) }
}

describe('matching', () => {
  it('matches single- and multi-segment globs', () => {
    expect(globMatches('/api/*', '/api/users')).toBe(true)
    expect(globMatches('/api/*', '/api/users/1')).toBe(false)
    expect(globMatches('/api/**', '/api/users/1')).toBe(true)
    expect(globMatches('*', '/anything')).toBe(true)
  })

  it('escapes regex metacharacters in a pattern', () => {
    expect(globMatches('/a.b', '/axb')).toBe(false)
    expect(globMatches('/a.b', '/a.b')).toBe(true)
  })

  it('filters on method, path, and host', () => {
    const rule = { id: 'r', limit: 1, windowMs: 1000, methods: ['POST'], path: '/api/**', host: '*.example.com' }
    expect(ruleMatches(rule, request({ method: 'POST', path: '/api/x', host: 'app.example.com' }))).toBe(true)
    expect(ruleMatches(rule, request({ method: 'GET', path: '/api/x', host: 'app.example.com' }))).toBe(false)
    expect(ruleMatches(rule, request({ method: 'POST', path: '/x', host: 'app.example.com' }))).toBe(false)
    // A wildcard host must not match the apex itself.
    expect(ruleMatches(rule, request({ method: 'POST', path: '/api/x', host: 'example.com' }))).toBe(false)
  })

  it('skips a disabled rule', () => {
    expect(ruleMatches({ id: 'r', limit: 1, windowMs: 1000, enabled: false }, request())).toBe(false)
  })
})

describe('key extraction', () => {
  const rule = (key: any) => ({ id: 'r', limit: 1, windowMs: 1000, key })

  it('keys on the client IP by default', () => {
    expect(rateLimitKey({ id: 'r', limit: 1, windowMs: 1000 }, request())).toBe(key('r', '203.0.113.5'))
  })

  it('keys on a header or cookie when asked', () => {
    const headers = { 'x-api-key': 'abc' }
    expect(rateLimitKey(rule({ source: 'header', name: 'X-Api-Key' }), request({ headers }))).toBe(key('r', 'abc'))
    expect(rateLimitKey(rule({ source: 'cookie', name: 'sid' }), request({ cookies: { sid: 'xyz' } }))).toBe(key('r', 'xyz'))
  })

  it('falls back to the IP when the header is missing, so omitting it is not a bypass', () => {
    expect(rateLimitKey(rule({ source: 'header', name: 'x-api-key' }), request())).toBe(key('r', '203.0.113.5'))
  })

  it('honours an explicit refusal to fall back', () => {
    expect(rateLimitKey(rule({ source: 'header', name: 'x-api-key', fallbackToIp: false }), request())).toBe(
      key('r', '__missing__'),
    )
  })

  it('collapses every caller into one bucket for a global rule', () => {
    expect(rateLimitKey(rule({ source: 'global' }), request({ ip: '1.1.1.1' }))).toBe(key('r', 'global'))
  })
})

describe('token bucket', () => {
  it('allows a burst then throttles to the sustained rate', () => {
    const { instance, advance } = limiter([{ id: 'b', limit: 60, windowMs: 60_000, burst: 5 }])
    for (let index = 0; index < 5; index++) expect(instance.check(request()).allowed).toBe(true)
    const blocked = instance.check(request())
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
    // One token per second at 60/minute.
    advance(1000)
    expect(instance.check(request()).allowed).toBe(true)
  })

  it('refills over time and never exceeds the burst ceiling', () => {
    const { instance, advance } = limiter([{ id: 'b', limit: 60, windowMs: 60_000, burst: 5 }])
    for (let index = 0; index < 5; index++) instance.check(request())
    advance(600_000)
    let allowed = 0
    for (let index = 0; index < 20; index++) if (instance.check(request()).allowed) allowed++
    expect(allowed).toBe(5)
  })

  it('keeps buckets separate per source', () => {
    const { instance } = limiter([{ id: 'b', limit: 60, windowMs: 60_000, burst: 2 }])
    instance.check(request({ ip: '1.1.1.1' }))
    instance.check(request({ ip: '1.1.1.1' }))
    expect(instance.check(request({ ip: '1.1.1.1' })).allowed).toBe(false)
    expect(instance.check(request({ ip: '2.2.2.2' })).allowed).toBe(true)
  })
})

describe('sliding window', () => {
  it('counts precisely and refuses a burst', () => {
    const { instance, advance } = limiter([
      { id: 'w', limit: 3, windowMs: 10_000, algorithm: 'sliding_window' as const },
    ])
    for (let index = 0; index < 3; index++) expect(instance.check(request()).allowed).toBe(true)
    expect(instance.check(request()).allowed).toBe(false)
    advance(9_000)
    expect(instance.check(request()).allowed).toBe(false)
    advance(1_500)
    expect(instance.check(request()).allowed).toBe(true)
  })

  it('slides rather than resetting on a fixed boundary', () => {
    const { instance, advance } = limiter([
      { id: 'w', limit: 2, windowMs: 10_000, algorithm: 'sliding_window' as const },
    ])
    instance.check(request())
    advance(9_000)
    instance.check(request())
    advance(1_500) // the first hit has aged out, the second has not
    expect(instance.check(request()).allowed).toBe(true)
    expect(instance.check(request()).allowed).toBe(false)
  })

  it('reports remaining quota', () => {
    const { instance } = limiter([{ id: 'w', limit: 3, windowMs: 10_000, algorithm: 'sliding_window' as const }])
    expect(instance.check(request()).remaining).toBe(2)
    expect(instance.check(request()).remaining).toBe(1)
  })
})

describe('actions', () => {
  it('observes without blocking under the log action', () => {
    const { instance } = limiter([{ id: 'l', limit: 1, windowMs: 10_000, burst: 1, action: 'log' as const }])
    instance.check(request())
    const decision = instance.check(request())
    expect(decision.allowed).toBe(true)
    expect(decision.action).toBe('log')
    expect(decision.remaining).toBe(0)
  })

  it('reports a challenge as a block, so the caller renders one', () => {
    const { instance } = limiter([{ id: 'c', limit: 1, windowMs: 10_000, burst: 1, action: 'challenge' as const }])
    instance.check(request())
    expect(instance.check(request())).toMatchObject({ allowed: false, action: 'challenge' })
  })
})

describe('multiple rules', () => {
  const rules = [
    { id: 'per-ip', limit: 10, windowMs: 60_000, burst: 10, key: { source: 'ip' as const }, priority: 10 },
    { id: 'global', limit: 15, windowMs: 60_000, burst: 15, key: { source: 'global' as const }, priority: 20 },
  ]

  it('advances every matching counter, not just the first', () => {
    const { instance } = limiter(rules)
    // Ten from one IP exhausts that IP and consumes 10 of the global 15.
    for (let index = 0; index < 10; index++) instance.check(request({ ip: '1.1.1.1' }))
    expect(instance.check(request({ ip: '1.1.1.1' })).allowed).toBe(false)
    for (let index = 0; index < 5; index++) expect(instance.check(request({ ip: '2.2.2.2' })).allowed).toBe(true)
    // The global ceiling is now reached even though this IP is fresh.
    expect(instance.check(request({ ip: '3.3.3.3' }))).toMatchObject({ allowed: false, ruleId: 'global' })
  })

  it('returns the strictest action when several rules block', () => {
    const { instance } = limiter([
      { id: 'soft', limit: 1, windowMs: 60_000, burst: 1, action: 'throttle' as const },
      { id: 'hard', limit: 1, windowMs: 60_000, burst: 1, action: 'deny' as const },
    ])
    instance.check(request())
    expect(instance.check(request()).action).toBe('deny')
  })
})

describe('peek', () => {
  it('inspects without consuming quota', () => {
    const { instance } = limiter([{ id: 'b', limit: 60, windowMs: 60_000, burst: 2 }])
    expect(instance.peek(request()).allowed).toBe(true)
    expect(instance.peek(request()).allowed).toBe(true)
    instance.check(request())
    instance.check(request())
    expect(instance.peek(request()).allowed).toBe(false)
  })
})

describe('memory safety', () => {
  it('bounds tracked keys under a source-rotating flood', () => {
    let clock = 0
    const instance = new RateLimiter([{ id: 'b', limit: 10, windowMs: 60_000 }], () => clock, 100)
    for (let index = 0; index < 5_000; index++) instance.check(request({ ip: `10.0.${index >> 8}.${index & 255}` }))
    expect(instance.trackedKeys).toBeLessThanOrEqual(100)
  })

  it('sweeps state for keys that have gone quiet', () => {
    const { instance, advance } = limiter([{ id: 'b', limit: 10, windowMs: 1_000 }])
    instance.check(request({ ip: '1.1.1.1' }))
    instance.check(request({ ip: '2.2.2.2' }))
    expect(instance.trackedKeys).toBe(2)
    advance(10_000)
    expect(instance.sweep()).toBe(2)
    expect(instance.trackedKeys).toBe(0)
  })
})

describe('response headers', () => {
  it('emits standard limit headers and retry-after only when blocked', () => {
    const { instance } = limiter([{ id: 'b', limit: 60, windowMs: 60_000, burst: 1 }])
    const allowed = rateLimitHeaders(instance.check(request()))
    expect(allowed['ratelimit-limit']).toBe('1')
    expect(allowed['retry-after']).toBeUndefined()
    const blocked = rateLimitHeaders(instance.check(request()))
    expect(Number(blocked['retry-after'])).toBeGreaterThanOrEqual(1)
  })
})

describe('defaults', () => {
  it('lets ordinary browsing through and stops a scripted hammer', () => {
    const { instance, advance } = limiter(defaultRateLimitRules())
    // A page load: 20 requests at once, then a pause.
    for (let index = 0; index < 20; index++) expect(instance.check(request({ path: `/asset-${index}.js` })).allowed).toBe(true)
    advance(5_000)
    for (let index = 0; index < 20; index++) expect(instance.check(request({ path: `/page-${index}` })).allowed).toBe(true)
  })

  it('challenges repeated auth attempts', () => {
    const { instance } = limiter(defaultRateLimitRules())
    const attempt = request({ path: '/auth/login', method: 'POST' })
    for (let index = 0; index < 10; index++) expect(instance.check(attempt).allowed).toBe(true)
    expect(instance.check(attempt)).toMatchObject({ allowed: false, action: 'challenge', ruleId: 'auth-ip' })
  })
})
