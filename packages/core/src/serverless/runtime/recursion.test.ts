import { describe, expect, it } from 'bun:test'
import {
  CHAIN_HEADER,
  DEPTH_HEADER,
  DEFAULT_RECURSION_LIMITS,
  functionFingerprint,
  inspectInvocation,
  parseChain,
  propagationHeaders,
  RecursionGuard,
  recursionBlockedResponse,
  TRACE_HEADER,
} from './recursion'

const fnA = 'proj/app/handler-a'
const fnB = 'proj/app/handler-b'

function headersFor(chain: string[], traceId = 'trace-1'): Record<string, string> {
  return { [CHAIN_HEADER]: chain.join('.'), [TRACE_HEADER]: traceId, [DEPTH_HEADER]: String(chain.length) }
}

describe('chain parsing', () => {
  it('accepts well-formed entries and rejects junk', () => {
    expect(parseChain('aabbccdd.11223344')).toEqual(['aabbccdd', '11223344'])
    expect(parseChain('not-a-hash.aabbccdd')).toEqual(['aabbccdd'])
    expect(parseChain('')).toEqual([])
    expect(parseChain(undefined)).toEqual([])
  })

  it('bounds an oversized chain header rather than trusting its length', () => {
    const huge = Array.from({ length: 500 }, () => 'aabbccdd').join('.')
    expect(parseChain(huge)).toHaveLength(64)
  })
})

describe('invocation inspection', () => {
  it('starts a chain and mints a trace for a cold entry point', () => {
    const result = inspectInvocation({ functionId: fnA, headers: {} })
    expect(result.depth).toBe(1)
    expect(result.chain).toEqual([functionFingerprint(fnA)])
    expect(result.reason).toBe('ok')
    expect(result.traceId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('appends to an inherited chain and carries the trace', () => {
    const result = inspectInvocation({ functionId: fnB, headers: headersFor([functionFingerprint(fnA)]) })
    expect(result.depth).toBe(2)
    expect(result.traceId).toBe('trace-1')
    expect(result.chain).toEqual([functionFingerprint(fnA), functionFingerprint(fnB)])
  })

  it('detects a direct self-invocation', () => {
    const result = inspectInvocation({ functionId: fnA, headers: headersFor([functionFingerprint(fnA)]) })
    expect(result.selfInvocation).toBe(true)
    expect(result.repeats).toBe(1)
  })

  it('catches an A-B-A-B loop that a consecutive-depth check would miss', () => {
    const a = functionFingerprint(fnA)
    const b = functionFingerprint(fnB)
    // Never two of the same function in a row, and only 7 deep - invisible to
    // both a self-call check and the depth ceiling.
    const result = inspectInvocation({ functionId: fnA, headers: headersFor([a, b, a, b, a, b]) })
    expect(result.selfInvocation).toBe(false)
    expect(result.depth).toBeLessThan(DEFAULT_RECURSION_LIMITS.maxDepth)
    expect(result.repeats).toBe(3)
    expect(result.reason).toBe('cycle_detected')
  })

  it('allows a bounded amount of legitimate re-entry', () => {
    const a = functionFingerprint(fnA)
    expect(inspectInvocation({ functionId: fnA, headers: headersFor([a, 'deadbeef']) }).reason).toBe('ok')
  })

  it('blocks past the depth ceiling', () => {
    const chain = Array.from({ length: 12 }, (_, index) => functionFingerprint(`fn-${index}`))
    expect(inspectInvocation({ functionId: 'fn-12', headers: headersFor(chain) }).reason).toBe('depth_exceeded')
  })

  it('trusts the chain over a forged depth header', () => {
    const chain = Array.from({ length: 12 }, (_, index) => functionFingerprint(`fn-${index}`))
    const forged = { [CHAIN_HEADER]: chain.join('.'), [DEPTH_HEADER]: '0' }
    expect(inspectInvocation({ functionId: 'fn-12', headers: forged }).reason).toBe('depth_exceeded')
  })

  it('still counts depth when the chain header is stripped but the counter survives', () => {
    const result = inspectInvocation({ functionId: fnA, headers: { [DEPTH_HEADER]: '20' } })
    expect(result.depth).toBe(21)
    expect(result.reason).toBe('depth_exceeded')
  })

  it('reads a Headers instance as well as a plain object', () => {
    const headers = new Headers({ [CHAIN_HEADER]: functionFingerprint(fnA), [TRACE_HEADER]: 'trace-9' })
    const result = inspectInvocation({ functionId: fnB, headers })
    expect(result.traceId).toBe('trace-9')
    expect(result.depth).toBe(2)
  })

  it('treats any re-entry as a loop when repeats are limited to one', () => {
    const result = inspectInvocation(
      { functionId: fnA, headers: headersFor([functionFingerprint(fnA)]) },
      { ...DEFAULT_RECURSION_LIMITS, maxRepeats: 1 },
    )
    expect(result.reason).toBe('cycle_detected')
  })
})

describe('guard', () => {
  function guard(overrides: Partial<typeof DEFAULT_RECURSION_LIMITS> = {}) {
    let clock = 0
    const instance = new RecursionGuard({ ...DEFAULT_RECURSION_LIMITS, ...overrides }, () => clock)
    return { instance, advance: (ms: number) => (clock += ms), at: () => clock }
  }

  it('allows an ordinary call and hands back propagation headers', () => {
    const { instance } = guard()
    const verdict = instance.check({ functionId: fnA, headers: {} })
    expect(verdict.allowed).toBe(true)
    const propagated = propagationHeaders(verdict)
    expect(propagated[CHAIN_HEADER]).toBe(functionFingerprint(fnA))
    expect(propagated[DEPTH_HEADER]).toBe('1')
    expect(propagated[TRACE_HEADER]).toBe(verdict.traceId)
  })

  it('enforces a per-trace invocation budget even when no cycle is visible', () => {
    const { instance } = guard({ maxInvocationsPerTrace: 3 })
    const headers = { [TRACE_HEADER]: 'trace-budget' }
    for (let index = 0; index < 3; index++)
      expect(instance.check({ functionId: `fn-${index}`, headers }).allowed).toBe(true)
    const blocked = instance.check({ functionId: 'fn-4', headers })
    expect(blocked).toMatchObject({ allowed: false, reason: 'trace_budget_exceeded' })
  })

  it('forgets a trace once its window passes', () => {
    const { instance, advance } = guard({ maxInvocationsPerTrace: 2, traceWindowMs: 1000 })
    const headers = { [TRACE_HEADER]: 'trace-window' }
    instance.check({ functionId: fnA, headers })
    instance.check({ functionId: fnB, headers })
    expect(instance.check({ functionId: fnA, headers }).allowed).toBe(false)
    advance(1500)
    expect(instance.check({ functionId: fnA, headers }).allowed).toBe(true)
    expect(instance.trackedTraces).toBe(1)
  })

  it('opens a breaker after repeated loop detections and closes it on cooldown', () => {
    const { instance, advance } = guard({ breakerThreshold: 3, breakerCooldownMs: 5000 })
    const looping = headersFor(Array.from({ length: 12 }, (_, index) => functionFingerprint(`fn-${index}`)))
    for (let index = 0; index < 3; index++) instance.check({ functionId: fnA, headers: looping })
    expect(instance.breakerOpen(fnA)).toBe(true)
    // Even a clean call is refused while the breaker is open.
    expect(instance.check({ functionId: fnA, headers: {} })).toMatchObject({ allowed: false, reason: 'breaker_open' })
    advance(6000)
    expect(instance.breakerOpen(fnA)).toBe(false)
    expect(instance.check({ functionId: fnA, headers: {} }).allowed).toBe(true)
  })

  it('keeps breakers per function', () => {
    const { instance } = guard({ breakerThreshold: 2 })
    const looping = headersFor(Array.from({ length: 12 }, (_, index) => functionFingerprint(`fn-${index}`)))
    instance.check({ functionId: fnA, headers: looping })
    instance.check({ functionId: fnA, headers: looping })
    expect(instance.breakerOpen(fnA)).toBe(true)
    expect(instance.breakerOpen(fnB)).toBe(false)
  })

  it('does not count a breaker-open refusal toward the breaker, so it cannot latch forever', () => {
    const { instance, advance } = guard({ breakerThreshold: 2, breakerCooldownMs: 1000 })
    const looping = headersFor(Array.from({ length: 12 }, (_, index) => functionFingerprint(`fn-${index}`)))
    instance.check({ functionId: fnA, headers: looping })
    instance.check({ functionId: fnA, headers: looping })
    for (let index = 0; index < 20; index++) instance.check({ functionId: fnA, headers: {} })
    advance(1200)
    expect(instance.breakerOpen(fnA)).toBe(false)
  })

  it('resets a breaker on request', () => {
    const { instance } = guard({ breakerThreshold: 1 })
    const looping = headersFor(Array.from({ length: 12 }, (_, index) => functionFingerprint(`fn-${index}`)))
    instance.check({ functionId: fnA, headers: looping })
    expect(instance.breakerOpen(fnA)).toBe(true)
    instance.reset(fnA)
    expect(instance.breakerOpen(fnA)).toBe(false)
  })

  it('does not consume trace budget for a call it refused', () => {
    const { instance } = guard({ maxInvocationsPerTrace: 2 })
    const looping = headersFor(Array.from({ length: 12 }, (_, index) => functionFingerprint(`fn-${index}`)), 'trace-x')
    instance.check({ functionId: fnA, headers: looping })
    // The blocked call must not have eaten one of the two allowed slots.
    expect(instance.check({ functionId: fnB, headers: { [TRACE_HEADER]: 'trace-x' } }).allowed).toBe(true)
    expect(instance.check({ functionId: fnB, headers: { [TRACE_HEADER]: 'trace-x' } }).allowed).toBe(true)
    expect(instance.check({ functionId: fnB, headers: { [TRACE_HEADER]: 'trace-x' } }).allowed).toBe(false)
  })
})

describe('blocked response', () => {
  it('returns a 508 with a machine-readable reason', () => {
    const guard = new RecursionGuard({ ...DEFAULT_RECURSION_LIMITS, maxDepth: 1 })
    const verdict = guard.check({ functionId: fnB, headers: headersFor([functionFingerprint(fnA)]) })
    const response = recursionBlockedResponse(verdict)
    expect(response.status).toBe(508)
    expect(response.headers['x-ts-cloud-recursion-blocked']).toBe('depth_exceeded')
    expect(response.body).toMatchObject({ error: 'recursion_blocked', reason: 'depth_exceeded' })
    expect(String(response.body.message)).toContain('loop')
  })
})
