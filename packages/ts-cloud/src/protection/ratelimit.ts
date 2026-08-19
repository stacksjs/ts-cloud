/**
 * Layer 7 rate limiting - the application-aware half of DDoS mitigation.
 *
 * L3/L4 filtering (see `ddos.ts`) stops packet floods, but the expensive
 * attacks now are perfectly valid HTTP: a few thousand requests a second to a
 * route that renders a page, hits a database, or invokes a function. Those
 * cost real money per request and no packet filter can tell them from traffic.
 *
 * Two algorithms, because they answer different questions:
 *
 *   - **Token bucket** allows a burst and then a steady rate. Right for
 *     interactive traffic, where a page load legitimately fires twenty
 *     requests at once and then goes quiet.
 *   - **Sliding window** counts precisely over a period. Right for quotas
 *     ("100 signups an hour") where a burst is exactly what you want to stop.
 *
 * Everything is clock-injected and in-memory. A limiter that consults a shared
 * store on every request adds a network hop to the hot path of the thing it is
 * protecting, which is how rate limiting becomes the outage.
 */

export type RateLimitAlgorithm = 'token_bucket' | 'sliding_window'
export type RateLimitAction = 'allow' | 'log' | 'throttle' | 'challenge' | 'deny'

/** Where the identity being limited comes from. */
export type RateLimitKeySource = 'ip' | 'header' | 'cookie' | 'path' | 'host' | 'global'

export interface RateLimitKeySpec {
  source: RateLimitKeySource
  /** Header or cookie name when the source needs one. */
  name?: string
  /**
   * Fall back to the client IP when the named header or cookie is absent.
   *
   * On by default: without it, an attacker omits the header and becomes
   * unlimited, which is worse than no rule at all.
   */
  fallbackToIp?: boolean
}

export interface RateLimitRule {
  id: string
  /** Requests allowed per window (sliding) or refill target (bucket). */
  limit: number
  windowMs: number
  algorithm?: RateLimitAlgorithm
  /** Token-bucket burst ceiling. Defaults to `limit`. */
  burst?: number
  key?: RateLimitKeySpec
  /** Glob against the path, e.g. `/api/*`. Omit to match every path. */
  path?: string
  /** HTTP methods this rule covers. Omit for all. */
  methods?: string[]
  /** Host to match, exact or `*.example.com`. */
  host?: string
  action?: RateLimitAction
  /** Rules are evaluated low-to-high; the first blocking match wins. */
  priority?: number
  enabled?: boolean
}

export interface RequestDescriptor {
  ip: string
  method: string
  path: string
  host?: string
  headers?: Record<string, string | undefined>
  cookies?: Record<string, string | undefined>
}

export interface RateLimitDecision {
  action: RateLimitAction
  allowed: boolean
  ruleId?: string
  limit?: number
  remaining?: number
  /** Milliseconds until the caller may retry. */
  retryAfterMs?: number
  /** When the current window or bucket is fully replenished. */
  resetAt?: number
  key?: string
}

/**
 * Separates the rule id from the identity in a counter key.
 *
 * A NUL rather than a space or a colon: rule ids and header values are both
 * caller-supplied, and any printable separator lets one key be forged into
 * another's bucket.
 */
export const RATE_LIMIT_KEY_SEPARATOR = '\u0000'

/** Stands in for `**` while `*` is being expanded, so the two do not collide. */
const GLOB_PLACEHOLDER = '\u0001'

/**
 * Glob matcher for paths and hosts.
 *
 * Deliberately tiny: `*` within a segment, `**` across segments, and a leading
 * `*.` for host wildcards. A full regex surface in a rule that runs on every
 * request is an invitation to catastrophic backtracking.
 */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, GLOB_PLACEHOLDER)
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return pattern === host
}

export function ruleMatches(rule: RateLimitRule, request: RequestDescriptor): boolean {
  if (rule.enabled === false) return false
  if (rule.methods?.length && !rule.methods.some((method) => method.toUpperCase() === request.method.toUpperCase()))
    return false
  if (rule.path && !globMatches(rule.path, request.path)) return false
  if (rule.host && !hostMatches(rule.host, request.host ?? '')) return false
  return true
}

/** Build the counter key for a request under a rule. */
export function rateLimitKey(rule: RateLimitRule, request: RequestDescriptor): string {
  const spec = rule.key ?? { source: 'ip' }
  const fallback = spec.fallbackToIp !== false
  let identity: string | undefined
  if (spec.source === 'ip') identity = request.ip
  else if (spec.source === 'global') identity = 'global'
  else if (spec.source === 'host') identity = request.host ?? ''
  else if (spec.source === 'path') identity = request.path
  else if (spec.source === 'header') identity = spec.name ? request.headers?.[spec.name.toLowerCase()] : undefined
  else if (spec.source === 'cookie') identity = spec.name ? request.cookies?.[spec.name] : undefined
  if (!identity && spec.source !== 'global') identity = fallback ? request.ip : '__missing__'
  return `${rule.id}${RATE_LIMIT_KEY_SEPARATOR}${identity}`
}

interface BucketState {
  tokens: number
  updatedAt: number
}

interface WindowState {
  /** Request timestamps, ascending. Trimmed to the window on every check. */
  hits: number[]
}

/**
 * Rate limiter over a set of rules.
 *
 * `check` is side-effecting - it consumes quota - so a caller that only wants
 * to inspect state should use `peek`.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>()
  private readonly windows = new Map<string, WindowState>()
  private readonly rules: RateLimitRule[]

  constructor(
    rules: readonly RateLimitRule[],
    private readonly clock: () => number = () => Date.now(),
    private readonly maxTrackedKeys: number = 100_000,
  ) {
    this.rules = [...rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  }

  /**
   * Evaluate every matching rule and return the strictest outcome.
   *
   * Two phases, and the order matters. First every matching rule is *tested*;
   * only if they all have room does anything get consumed.
   *
   * Testing first is what keeps overlapping rules honest. Consuming as you go
   * charges a request to the global counter even when a per-IP rule already
   * refused it - so a single hammering client silently burns the budget that
   * protects everyone else, and the global limit fires against innocent
   * traffic. Consuming all rules for a request that is *allowed* is equally
   * necessary: stop at the first match and the lower-priority counters never
   * advance, and those rules quietly stop working.
   */
  check(request: RequestDescriptor): RateLimitDecision {
    const now = this.clock()
    const matching = this.rules.filter((rule) => ruleMatches(rule, request))
    let blocked: RateLimitDecision | undefined
    for (const rule of matching) {
      const test = this.test(rule, request, now)
      if (test.allowed) continue
      if (!blocked || severity(test.action) > severity(blocked.action)) blocked = test
    }
    if (blocked) return blocked

    let tightest: RateLimitDecision = { action: 'allow', allowed: true }
    for (const rule of matching) {
      const decision = this.consume(rule, request, now)
      if (decision.remaining != null && (tightest.remaining ?? Infinity) > decision.remaining) tightest = decision
    }
    return tightest
  }

  /** Non-mutating availability check for one rule. */
  private test(rule: RateLimitRule, request: RequestDescriptor, now: number): RateLimitDecision {
    const key = rateLimitKey(rule, request)
    if ((rule.algorithm ?? 'token_bucket') === 'token_bucket') {
      const capacity = rule.burst ?? rule.limit
      const state = this.buckets.get(key)
      const tokens = state ? Math.min(capacity, state.tokens + this.refill(rule, now - state.updatedAt)) : capacity
      if (tokens >= 1) return { action: 'allow', allowed: true }
      return this.blocked(rule, key, 0, this.msPerToken(rule) * (1 - tokens), now)
    }
    const hits = (this.windows.get(key)?.hits ?? []).filter((at) => at > now - rule.windowMs)
    if (hits.length < rule.limit) return { action: 'allow', allowed: true }
    return this.blocked(rule, key, 0, hits[0] + rule.windowMs - now, now)
  }

  /** Inspect without consuming quota. */
  peek(request: RequestDescriptor): RateLimitDecision {
    const now = this.clock()
    for (const rule of this.rules) {
      if (!ruleMatches(rule, request)) continue
      const decision = this.test(rule, request, now)
      if (!decision.allowed) return decision
    }
    return { action: 'allow', allowed: true }
  }

  private msPerToken(rule: RateLimitRule): number {
    return rule.windowMs / Math.max(1, rule.limit)
  }

  private refill(rule: RateLimitRule, elapsedMs: number): number {
    return Math.max(0, elapsedMs) / this.msPerToken(rule)
  }

  private blocked(
    rule: RateLimitRule,
    key: string,
    remaining: number,
    retryAfterMs: number,
    now: number,
  ): RateLimitDecision {
    const action = rule.action ?? 'deny'
    return {
      action,
      // `log` observes without blocking - the way to trial a rule in production.
      allowed: action === 'allow' || action === 'log',
      ruleId: rule.id,
      limit: rule.limit,
      remaining,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
      resetAt: now + Math.max(0, retryAfterMs),
      key,
    }
  }

  private consume(rule: RateLimitRule, request: RequestDescriptor, now: number): RateLimitDecision {
    const key = rateLimitKey(rule, request)
    const algorithm = rule.algorithm ?? 'token_bucket'
    if (algorithm === 'token_bucket') {
      const capacity = rule.burst ?? rule.limit
      const state = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now }
      const tokens = Math.min(capacity, state.tokens + this.refill(rule, now - state.updatedAt))
      if (tokens < 1) {
        this.buckets.set(key, { tokens, updatedAt: now })
        return this.blocked(rule, key, 0, this.msPerToken(rule) * (1 - tokens), now)
      }
      this.evictIfNeeded(this.buckets)
      this.buckets.set(key, { tokens: tokens - 1, updatedAt: now })
      return {
        action: 'allow',
        allowed: true,
        ruleId: rule.id,
        limit: capacity,
        remaining: Math.floor(tokens - 1),
        resetAt: now + this.msPerToken(rule) * (capacity - (tokens - 1)),
        key,
      }
    }
    const state = this.windows.get(key) ?? { hits: [] }
    const cutoff = now - rule.windowMs
    const hits = state.hits.filter((at) => at > cutoff)
    if (hits.length >= rule.limit) {
      this.windows.set(key, { hits })
      return this.blocked(rule, key, 0, hits[0] + rule.windowMs - now, now)
    }
    hits.push(now)
    this.evictIfNeeded(this.windows)
    this.windows.set(key, { hits })
    return {
      action: 'allow',
      allowed: true,
      ruleId: rule.id,
      limit: rule.limit,
      remaining: rule.limit - hits.length,
      resetAt: hits[0] + rule.windowMs,
      key,
    }
  }

  /**
   * Bound memory under an attack that rotates keys.
   *
   * A source IP per request is exactly what a botnet produces, so an unbounded
   * map turns a rate limiter into an OOM. Dropping the oldest insertion is
   * enough: the entries that matter are the ones seeing repeat traffic.
   */
  private evictIfNeeded(map: Map<string, unknown>): void {
    if (map.size < this.maxTrackedKeys) return
    const excess = map.size - this.maxTrackedKeys + 1
    let removed = 0
    for (const key of map.keys()) {
      map.delete(key)
      if (++removed >= excess) break
    }
  }

  /** Drop state for keys that have gone quiet. Cheap to call on a timer. */
  sweep(): number {
    const now = this.clock()
    let removed = 0
    for (const [key, state] of this.windows) {
      const ruleId = key.split(RATE_LIMIT_KEY_SEPARATOR)[0]
      const rule = this.rules.find((candidate) => candidate.id === ruleId)
      if (!rule) {
        this.windows.delete(key)
        removed++
        continue
      }
      if (state.hits.every((at) => at <= now - rule.windowMs)) {
        this.windows.delete(key)
        removed++
      }
    }
    for (const [key, state] of this.buckets) {
      const ruleId = key.split(RATE_LIMIT_KEY_SEPARATOR)[0]
      const rule = this.rules.find((candidate) => candidate.id === ruleId)
      if (!rule || now - state.updatedAt > rule.windowMs * 2) {
        this.buckets.delete(key)
        removed++
      }
    }
    return removed
  }

  get trackedKeys(): number {
    return this.buckets.size + this.windows.size
  }
}

function severity(action: RateLimitAction): number {
  return { allow: 0, log: 1, throttle: 2, challenge: 3, deny: 4 }[action]
}

/** Standard headers for a decision, so clients can back off intelligently. */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {}
  if (decision.limit != null) headers['ratelimit-limit'] = String(decision.limit)
  if (decision.remaining != null) headers['ratelimit-remaining'] = String(decision.remaining)
  if (decision.resetAt != null) headers['ratelimit-reset'] = String(Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000)))
  if (!decision.allowed && decision.retryAfterMs != null)
    headers['retry-after'] = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)))
  return headers
}

/**
 * Baseline rules every site gets.
 *
 * Chosen to be invisible to a human and expensive for a script: 600 requests a
 * minute per IP is ten a second, far above real browsing and far below what a
 * scraper wants. The per-route rules protect the endpoints that cost the most
 * per call rather than the ones that get the most traffic.
 */
export function defaultRateLimitRules(): RateLimitRule[] {
  return [
    { id: 'global-ip', limit: 600, windowMs: 60_000, burst: 100, key: { source: 'ip' }, action: 'deny', priority: 100 },
    {
      id: 'api-ip',
      limit: 120,
      windowMs: 60_000,
      burst: 30,
      path: '/api/**',
      key: { source: 'ip' },
      action: 'deny',
      priority: 50,
    },
    {
      id: 'auth-ip',
      limit: 10,
      windowMs: 60_000,
      algorithm: 'sliding_window',
      path: '/auth/**',
      methods: ['POST'],
      key: { source: 'ip' },
      action: 'challenge',
      priority: 10,
    },
  ]
}
