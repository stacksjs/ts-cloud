/**
 * Recursion protection lives in `@ts-cloud/core` because the function runtime
 * has to run it, and the runtime cannot depend on this package. Re-exported
 * here so `ts-cloud/protection` stays the one place to find edge protection.
 */
export {
  CHAIN_HEADER,
  DEFAULT_RECURSION_LIMITS,
  DEPTH_HEADER,
  functionFingerprint,
  inspectInvocation,
  parseChain,
  propagationHeaders,
  RecursionGuard,
  recursionBlockedResponse,
  TRACE_HEADER,
} from '@ts-cloud/core'
export type {
  InvocationContext,
  RecursionLimits,
  RecursionReason,
  RecursionVerdict,
} from '@ts-cloud/core'
export * from './ratelimit'
export * from './ddos'
export * from './controls'
export * from './waf'
