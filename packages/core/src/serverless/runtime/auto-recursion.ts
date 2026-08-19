/**
 * Making recursion protection automatic.
 *
 * `recursion.ts` can detect a loop given an invocation's headers, but detection
 * only helps if something calls it on every invocation and propagates the chain
 * on every outbound request. Asking application authors to do that by hand
 * means it protects the code that already thought about the problem, which is
 * never the code that loops.
 *
 * So the runtime does both:
 *
 *   - Every inbound invocation is inspected before the handler runs.
 *   - `fetch` is wrapped once, per process, to attach the current invocation's
 *     chain to outbound requests.
 *
 * The chain rides in headers, so protection survives the hop between two
 * separate functions and even between two separate deployments. A request that
 * leaves the platform carries the headers too - they are namespaced and inert
 * to anyone who does not read them.
 *
 * **Coverage, stated plainly.** This covers `fetch`, which is what the platform
 * and modern application code use. A handler that reaches for `node:http`
 * directly, or opens a raw socket, is not covered; the depth header still
 * catches those when the receiving side is one of ours, but the chain does not.
 */
import type { InvocationContext, RecursionLimits, RecursionVerdict } from './recursion'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_RECURSION_LIMITS, propagationHeaders, RecursionGuard } from './recursion'

/**
 * The invocation currently on the stack.
 *
 * `AsyncLocalStorage` rather than a module-level variable: a runtime handling
 * concurrent invocations in one process would otherwise attribute one
 * invocation's outbound calls to another's chain, which is both wrong and
 * exactly the case where a loop is hardest to see.
 */
export const invocationContext: AsyncLocalStorage<RecursionVerdict> = new AsyncLocalStorage<RecursionVerdict>()

export interface RecursionProtectionConfig {
  /** Off entirely. The escape hatch for a workload that genuinely re-enters. */
  enabled?: boolean
  limits?: Partial<RecursionLimits>
  /**
   * Detect and report, but let the invocation run.
   *
   * The way to roll this out over an existing workload: watch what it would
   * have blocked for a week before it blocks anything.
   */
  detectionOnly?: boolean
  /** Identifies this function in the chain. Defaults to the Lambda name. */
  functionId?: string
}

function envFlag(name: string): boolean | undefined {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
  if (raw == null || raw === '') return undefined
  return raw !== '0' && raw.toLowerCase() !== 'false'
}

function defaultFunctionId(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  return env.TS_CLOUD_FUNCTION_ID || env.AWS_LAMBDA_FUNCTION_NAME || env.FUNCTION_NAME || 'function'
}

/**
 * Resolve configuration from options and the environment.
 *
 * The environment wins, because turning protection off is an operational
 * decision made under pressure - during an incident, from the console, without
 * a redeploy. A config value that could not be overridden that way would be a
 * config value someone works around by deleting the function.
 */
export function resolveRecursionConfig(config?: RecursionProtectionConfig | false): {
  enabled: boolean
  detectionOnly: boolean
  limits: RecursionLimits
  functionId: string
} {
  const explicit = config === false ? { enabled: false } : (config ?? {})
  const envEnabled = envFlag('TS_CLOUD_RECURSION_PROTECTION')
  const envDetectionOnly = envFlag('TS_CLOUD_RECURSION_DETECTION_ONLY')
  return {
    // Default-on: a protection that has to be switched on protects nobody who
    // did not already know they needed it.
    enabled: envEnabled ?? explicit.enabled ?? true,
    detectionOnly: envDetectionOnly ?? explicit.detectionOnly ?? false,
    limits: { ...DEFAULT_RECURSION_LIMITS, ...explicit.limits },
    functionId: explicit.functionId ?? defaultFunctionId(),
  }
}

type FetchLike = typeof globalThis.fetch

let installedFetch: FetchLike | undefined
let originalFetch: FetchLike | undefined

/**
 * Wrap `fetch` so outbound calls carry the current chain.
 *
 * Idempotent: a runtime that creates handlers more than once must not stack
 * wrappers, or a chain entry would be appended once per wrapper and a
 * three-hop request would look like a nine-hop loop.
 */
export function installRecursionFetch(): () => void {
  const current = globalThis.fetch
  if (!current || installedFetch === current) return () => {}
  originalFetch = current
  const wrapped = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const verdict = invocationContext.getStore()
    if (!verdict) return originalFetch!(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    for (const [key, value] of Object.entries(propagationHeaders(verdict))) headers.set(key, value)
    if (input instanceof Request) return originalFetch!(new Request(input, { headers }), init)
    return originalFetch!(input, { ...init, headers })
    // Bun's fetch carries extra statics (`preconnect`); copy them across so a
    // caller that reaches for one does not find it missing after wrapping.
  }) as FetchLike
  Object.assign(wrapped, current)
  globalThis.fetch = wrapped
  installedFetch = wrapped
  return () => {
    if (globalThis.fetch === installedFetch && originalFetch) globalThis.fetch = originalFetch
    installedFetch = undefined
  }
}

let sharedGuard: RecursionGuard | undefined
let sharedLimits: RecursionLimits | undefined

/**
 * One guard per process.
 *
 * The trace budget and the circuit breaker only mean anything if successive
 * invocations in the same container share them - a fresh guard per invocation
 * would reset the counters the loop is being counted with.
 */
export function sharedRecursionGuard(limits: RecursionLimits): RecursionGuard {
  if (!sharedGuard || JSON.stringify(sharedLimits) !== JSON.stringify(limits)) {
    sharedGuard = new RecursionGuard(limits)
    sharedLimits = limits
  }
  return sharedGuard
}

/** Reset process state. Tests need it; nothing in production should call it. */
export function resetRecursionRuntime(): void {
  sharedGuard = undefined
  sharedLimits = undefined
  if (installedFetch && originalFetch && globalThis.fetch === installedFetch) globalThis.fetch = originalFetch
  installedFetch = undefined
  originalFetch = undefined
}

export interface RecursionCheck {
  verdict: RecursionVerdict
  /** True when the invocation should be refused. */
  blocked: boolean
  /** True when a loop was detected but detection-only let it through. */
  observed: boolean
}

/**
 * Inspect an invocation and prepare its context.
 *
 * Returns rather than throws, so the caller decides the response shape - a
 * Lambda HTTP handler answers with a 508 payload while a queue handler needs to
 * fail the record instead.
 */
export function checkInvocation(
  headers: Record<string, string | undefined> | Headers,
  config?: RecursionProtectionConfig | false,
): RecursionCheck | undefined {
  const resolved = resolveRecursionConfig(config)
  if (!resolved.enabled) return undefined
  const guard = sharedRecursionGuard(resolved.limits)
  const context: InvocationContext = { functionId: resolved.functionId, headers }
  const verdict = guard.check(context)
  return {
    verdict,
    blocked: !verdict.allowed && !resolved.detectionOnly,
    observed: !verdict.allowed && resolved.detectionOnly,
  }
}

/** Run `work` with the invocation's chain attached to any outbound fetch. */
export function withInvocation<T>(verdict: RecursionVerdict, work: () => Promise<T>): Promise<T> {
  installRecursionFetch()
  return invocationContext.run(verdict, work)
}
