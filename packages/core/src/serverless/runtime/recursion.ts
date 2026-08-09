/**
 * Recursion protection for functions.
 *
 * The failure this exists for is mundane and expensive: a function writes to a
 * bucket, the bucket notifies a function, and the two of them bill an
 * unbounded number of invocations in an afternoon. Nothing is broken - each
 * individual call is correct - so nothing alerts, and the first symptom is the
 * invoice. Variants: a handler that fetches its own URL, an API route that
 * calls itself through the CDN, a queue consumer that re-enqueues on error.
 *
 * Detection works by propagating the call chain in request headers. Each hop
 * appends a short hash of the function it entered, so any cycle is visible as
 * a repeated entry, and depth is visible as chain length. This catches loops a
 * simple depth counter misses (A -> B -> A -> B never exceeds "depth 2" if you
 * only count consecutive self-calls).
 *
 * The headers are advisory - a caller can strip them - so the guard also keeps
 * a short-lived per-trace tally as a backstop, and a circuit breaker on the
 * function itself for the case where the chain is lost entirely.
 */
import { createHash } from 'node:crypto'

/** Depth of the current invocation, as an integer string. */
export const DEPTH_HEADER = 'x-ts-cloud-invoke-depth'
/** Dot-separated short hashes of every function in the chain, oldest first. */
export const CHAIN_HEADER = 'x-ts-cloud-invoke-chain'
/** Correlates every hop of one logical request. */
export const TRACE_HEADER = 'x-ts-cloud-trace-id'

/** Chain entries are 8 hex chars: collision-safe enough for a bounded chain, cheap in a header. */
export function functionFingerprint(functionId: string): string {
  return createHash('sha256').update(functionId).digest('hex').slice(0, 8)
}

export interface RecursionLimits {
  /** Hard ceiling on chain length. Beyond this, block regardless of cycles. */
  maxDepth: number
  /**
   * How many times one function may appear in a single chain.
   *
   * Not 1: legitimate fan-out patterns re-enter the same handler (a recursive
   * directory walk, a paginated crawl). Two repeats is a pattern; five is a loop.
   */
  maxRepeats: number
  /** Ceiling on invocations sharing one trace id, across all functions. */
  maxInvocationsPerTrace: number
  /** How long a trace's tally is remembered. */
  traceWindowMs: number
  /** Consecutive blocks before the breaker opens for a function. */
  breakerThreshold: number
  /** How long the breaker stays open. */
  breakerCooldownMs: number
}

export const DEFAULT_RECURSION_LIMITS: RecursionLimits = {
  maxDepth: 10,
  maxRepeats: 3,
  maxInvocationsPerTrace: 100,
  traceWindowMs: 60_000,
  breakerThreshold: 5,
  breakerCooldownMs: 60_000,
}

export type RecursionReason =
  | 'ok'
  | 'depth_exceeded'
  | 'cycle_detected'
  | 'self_invocation'
  | 'trace_budget_exceeded'
  | 'breaker_open'

export interface InvocationContext {
  functionId: string
  headers: Record<string, string | undefined> | Headers
  /** Overrides the header value. Useful when the caller already has a trace. */
  traceId?: string
}

export interface RecursionVerdict {
  allowed: boolean
  reason: RecursionReason
  depth: number
  /** The chain including this invocation. */
  chain: string[]
  traceId: string
  /** True when the immediate caller was this same function. */
  selfInvocation: boolean
  /** Times this function already appears in the incoming chain. */
  repeats: number
  message?: string
  /** Headers to attach to any call this invocation makes. */
  propagate: Record<string, string>
}

function readHeader(headers: InvocationContext['headers'], name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const record = headers as Record<string, string | undefined>
  return record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()]
}

/** Parse the chain header. Bounded and sanitized: a header is attacker-controllable. */
export function parseChain(value: string | undefined, maxEntries: number = 64): string[] {
  if (!value) return []
  return value
    .split('.')
    .map((entry) => entry.trim())
    .filter((entry) => /^[0-9a-f]{8}$/.test(entry))
    .slice(-maxEntries)
}

/**
 * Inspect an invocation without recording anything.
 *
 * Pure, so a caller can reason about a chain in a test or a dry-run without a
 * guard instance. {@link RecursionGuard.check} adds the stateful backstops.
 */
export function inspectInvocation(
  context: InvocationContext,
  limits: RecursionLimits = DEFAULT_RECURSION_LIMITS,
): Omit<RecursionVerdict, 'allowed' | 'reason' | 'message'> & { reason: RecursionReason } {
  const fingerprint = functionFingerprint(context.functionId)
  const incoming = parseChain(readHeader(context.headers, CHAIN_HEADER))
  const traceId = context.traceId ?? readHeader(context.headers, TRACE_HEADER) ?? crypto.randomUUID()
  const chain = [...incoming, fingerprint]
  const repeats = incoming.filter((entry) => entry === fingerprint).length
  const selfInvocation = incoming[incoming.length - 1] === fingerprint
  // Trust the chain over the depth header: the chain is self-describing, and a
  // truncated or forged depth cannot make a long chain look short.
  const headerDepth = Number.parseInt(readHeader(context.headers, DEPTH_HEADER) ?? '', 10)
  const depth = Math.max(chain.length, Number.isFinite(headerDepth) ? headerDepth + 1 : 0)

  let reason: RecursionReason = 'ok'
  if (depth > limits.maxDepth) reason = 'depth_exceeded'
  else if (repeats >= limits.maxRepeats) reason = 'cycle_detected'
  else if (selfInvocation && limits.maxRepeats <= 1) reason = 'self_invocation'

  return {
    reason,
    depth,
    chain,
    traceId,
    selfInvocation,
    repeats,
    propagate: {
      [DEPTH_HEADER]: String(depth),
      [CHAIN_HEADER]: chain.join('.'),
      [TRACE_HEADER]: traceId,
    },
  }
}

interface TraceTally {
  count: number
  firstAt: number
}

interface BreakerState {
  consecutiveBlocks: number
  openUntil?: number
}

const MESSAGES: Readonly<Record<RecursionReason, string>> = {
  ok: '',
  depth_exceeded: 'Invocation chain is deeper than the configured limit; the call was refused to stop a runaway loop.',
  cycle_detected: 'This function already appears in the invocation chain; the call was refused as a recursion loop.',
  self_invocation: 'This function invoked itself directly; the call was refused.',
  trace_budget_exceeded: 'This request has already made more invocations than its budget allows.',
  breaker_open: 'Recursion protection is open for this function after repeated loop detections.',
}

/**
 * Stateful recursion guard.
 *
 * In-memory on purpose. A loop runs in seconds, so the state that matters is
 * seconds old; paying a database round trip per invocation to protect against
 * a cost problem would be its own cost problem. Each instance protects the
 * process it runs in, and the header chain carries protection across processes.
 */
export class RecursionGuard {
  private readonly traces = new Map<string, TraceTally>()
  private readonly breakers = new Map<string, BreakerState>()

  constructor(
    private readonly limits: RecursionLimits = DEFAULT_RECURSION_LIMITS,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Decide whether an invocation may proceed, and record it if so. */
  check(context: InvocationContext): RecursionVerdict {
    const now = this.clock()
    this.expireTraces(now)
    const inspected = inspectInvocation(context, this.limits)
    const breaker = this.breakers.get(context.functionId)

    if (breaker?.openUntil != null && breaker.openUntil > now)
      return this.deny(context.functionId, inspected, 'breaker_open', now, false)

    if (inspected.reason !== 'ok') return this.deny(context.functionId, inspected, inspected.reason, now, true)

    const tally = this.traces.get(inspected.traceId) ?? { count: 0, firstAt: now }
    if (tally.count >= this.limits.maxInvocationsPerTrace) {
      this.traces.set(inspected.traceId, tally)
      return this.deny(context.functionId, inspected, 'trace_budget_exceeded', now, true)
    }
    this.traces.set(inspected.traceId, { count: tally.count + 1, firstAt: tally.firstAt })

    // A clean invocation closes the breaker: the loop is over.
    if (breaker) this.breakers.set(context.functionId, { consecutiveBlocks: 0 })
    return { ...inspected, allowed: true, reason: 'ok', propagate: inspected.propagate }
  }

  private deny(
    functionId: string,
    inspected: ReturnType<typeof inspectInvocation>,
    reason: RecursionReason,
    now: number,
    countTowardBreaker: boolean,
  ): RecursionVerdict {
    if (countTowardBreaker) {
      const state = this.breakers.get(functionId) ?? { consecutiveBlocks: 0 }
      const consecutiveBlocks = state.consecutiveBlocks + 1
      this.breakers.set(functionId, {
        consecutiveBlocks,
        openUntil:
          consecutiveBlocks >= this.limits.breakerThreshold ? now + this.limits.breakerCooldownMs : state.openUntil,
      })
    }
    return { ...inspected, allowed: false, reason, message: MESSAGES[reason] }
  }

  /** Whether the breaker is currently open for a function. */
  breakerOpen(functionId: string): boolean {
    const state = this.breakers.get(functionId)
    return state?.openUntil != null && state.openUntil > this.clock()
  }

  /** Close a breaker manually, e.g. after an operator fixes the loop. */
  reset(functionId?: string): void {
    if (functionId) {
      this.breakers.delete(functionId)
      return
    }
    this.breakers.clear()
    this.traces.clear()
  }

  private expireTraces(now: number): void {
    if (this.traces.size === 0) return
    for (const [traceId, tally] of this.traces)
      if (now - tally.firstAt > this.limits.traceWindowMs) this.traces.delete(traceId)
  }

  get trackedTraces(): number {
    return this.traces.size
  }
}

/**
 * Headers for an outbound call made from inside a function.
 *
 * Every HTTP client used by platform code should merge these in. Without
 * propagation the chain resets at each hop and the loop becomes invisible.
 */
export function propagationHeaders(verdict: RecursionVerdict): Record<string, string> {
  return { ...verdict.propagate }
}

/** The response a blocked invocation should return: a 508, as the RFC intends. */
export function recursionBlockedResponse(verdict: RecursionVerdict): {
  status: number
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  return {
    status: 508,
    headers: { 'content-type': 'application/json', 'x-ts-cloud-recursion-blocked': verdict.reason },
    body: {
      error: 'recursion_blocked',
      reason: verdict.reason,
      message: verdict.message ?? MESSAGES[verdict.reason],
      depth: verdict.depth,
      traceId: verdict.traceId,
    },
  }
}
