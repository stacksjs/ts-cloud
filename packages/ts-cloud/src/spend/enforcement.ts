/**
 * Applying and lifting a cap.
 *
 * The design rule is that **enforcement is always reversible and never
 * destructive**. A budget's job is to stop the meter, not to lose anyone's
 * work. So no action here deletes a resource, drops a database, or discards a
 * build; the strongest rung parks traffic behind a static response and even
 * that records exactly what it changed so the restore is mechanical.
 *
 * A second rule: **an enforcement action is a request, not a fact**. Applying
 * one means talking to a driver, and drivers fail. Every record therefore
 * moves pending -> active -> released with an explicit failed state, and a
 * failure to apply never silently reads as "capped".
 */
import type { JsonValue } from '../control-plane'
import type { Budget, EnforcementAction, EnforcementRecord, SpendDecision } from './model'
import { ENFORCEMENT_SEVERITY } from './model'
import type { SpendStore } from './store'

/** What an action does, in words an operator can act on. */
export const ENFORCEMENT_DESCRIPTIONS: Readonly<Record<EnforcementAction, string>> = {
  notify: 'Send the configured spend notifications.',
  block_builds: 'Refuse new builds. Running builds finish.',
  block_deployments: 'Refuse new deployments. The running release keeps serving.',
  throttle_requests: 'Rate-limit inbound requests at the edge to cap egress and compute.',
  suspend_functions: 'Stop invoking serverless functions; static and cached responses still serve.',
  serve_static: 'Serve the last built static output only; dynamic rendering is off.',
  suspend_project: 'Park all inbound traffic behind a 503. No data is removed.',
}

/**
 * Actions that change what users see.
 *
 * These need an explicit opt-in on a production environment: silently taking a
 * customer's site off the air to save $20 is worse than the bill.
 */
export const USER_VISIBLE_ACTIONS: readonly EnforcementAction[] = [
  'throttle_requests',
  'suspend_functions',
  'serve_static',
  'suspend_project',
]

export interface EnforcementStep {
  action: EnforcementAction
  description: string
  userVisible: boolean
  /** True when policy blocks this step from running automatically. */
  requiresApproval: boolean
  reason: string
}

export interface EnforcementPlan {
  budgetId: string
  simulated: boolean
  /** Steps to apply, least disruptive first. */
  apply: EnforcementStep[]
  /** Steps to lift, most disruptive first, so a scope recovers safely. */
  release: EnforcementStep[]
  /** Steps withheld pending human approval. */
  withheld: EnforcementStep[]
}

export interface EnforcementPolicy {
  /**
   * Environment kinds where user-visible actions need approval rather than
   * running on their own. Production is in this list by default.
   */
  approvalRequiredFor?: readonly string[]
  /** The kind of the environment being enforced, e.g. `production`. */
  environmentKind?: string
  /** Ceiling on automatic disruption; nothing above it applies unattended. */
  maxAutomaticAction?: EnforcementAction
}

const DEFAULT_APPROVAL_KINDS: readonly string[] = ['production']

function step(action: EnforcementAction, reason: string, policy: EnforcementPolicy): EnforcementStep {
  const userVisible = USER_VISIBLE_ACTIONS.includes(action)
  const approvalKinds = policy.approvalRequiredFor ?? DEFAULT_APPROVAL_KINDS
  const kindNeedsApproval = policy.environmentKind != null && approvalKinds.includes(policy.environmentKind)
  const overCeiling =
    policy.maxAutomaticAction != null && ENFORCEMENT_SEVERITY[action] > ENFORCEMENT_SEVERITY[policy.maxAutomaticAction]
  return {
    action,
    description: ENFORCEMENT_DESCRIPTIONS[action],
    userVisible,
    requiresApproval: overCeiling || (userVisible && kindNeedsApproval),
    reason,
  }
}

/**
 * Turn a decision into an ordered, approval-aware plan.
 *
 * Apply runs least-disruptive-first so the cheapest lever gets a chance to
 * work before the expensive one. Release runs most-disruptive-first so a
 * recovering project gets its traffic back before it gets its build queue.
 */
export function planEnforcement(decision: SpendDecision, policy: EnforcementPolicy = {}): EnforcementPlan {
  const applySteps = decision.actions.map((action) => step(action, decision.reason, policy))
  const releaseSteps = [...decision.releases]
    .sort((a, b) => ENFORCEMENT_SEVERITY[b] - ENFORCEMENT_SEVERITY[a])
    .map((action) => step(action, 'Spend fell back below the threshold that armed this action.', policy))
  return {
    budgetId: decision.budgetId,
    simulated: decision.simulated,
    apply: applySteps.filter((item) => !item.requiresApproval),
    // Lifting an action never needs approval - restoring service is always safe.
    release: releaseSteps.map((item) => ({ ...item, requiresApproval: false })),
    withheld: applySteps.filter((item) => item.requiresApproval),
  }
}

/** Applies one action against the platform. Returns whatever the release needs. */
export type EnforcementApplier = (
  action: EnforcementAction,
  context: { budget: Budget; decision: SpendDecision; record: EnforcementRecord },
) => Promise<Record<string, JsonValue>> | Record<string, JsonValue>

/** Undoes one action, given the restore payload the applier returned. */
export type EnforcementReleaser = (
  action: EnforcementAction,
  context: { budget: Budget; record: EnforcementRecord; restore: Record<string, JsonValue> },
) => Promise<void> | void

export interface EnforcementRunResult {
  applied: EnforcementRecord[]
  released: EnforcementRecord[]
  failed: Array<{ action: EnforcementAction; error: string }>
  withheld: EnforcementStep[]
  simulated: boolean
}

/**
 * Run a plan against the store, calling out to the driver for each step.
 *
 * A dry-run budget records everything and calls nothing, which is the point:
 * an operator can watch a cap for a month before letting it touch anything.
 * A step whose applier throws lands in `failed` and its record in `failed`
 * state - the caller can retry next cycle, and nothing pretends the cap is on.
 */
export async function runEnforcement(
  store: SpendStore,
  budget: Budget,
  decision: SpendDecision,
  plan: EnforcementPlan,
  handlers: { apply: EnforcementApplier; release: EnforcementReleaser },
): Promise<EnforcementRunResult> {
  const result: EnforcementRunResult = {
    applied: [],
    released: [],
    failed: [],
    withheld: plan.withheld,
    simulated: plan.simulated,
  }

  for (const item of plan.apply) {
    const record = store.openEnforcement({
      budget,
      action: item.action,
      reason: item.reason,
      triggeredAtPercent: decision.usedPercent,
      simulated: plan.simulated,
    })
    // Already live from an earlier cycle: converged, nothing to do.
    if (record.state === 'active') continue
    if (plan.simulated) {
      result.applied.push(store.transitionEnforcement(record.id, 'active', { restore: { simulated: true } }))
      continue
    }
    try {
      const restore = await handlers.apply(item.action, { budget, decision, record })
      result.applied.push(store.transitionEnforcement(record.id, 'active', { restore }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      store.transitionEnforcement(record.id, 'failed', { error: message })
      result.failed.push({ action: item.action, error: message })
    }
  }

  for (const item of plan.release) {
    const record = store.activeEnforcement(budget.id, item.action)
    if (!record) continue
    if (plan.simulated || record.simulated) {
      result.released.push(store.transitionEnforcement(record.id, 'released'))
      continue
    }
    store.transitionEnforcement(record.id, 'releasing')
    try {
      await handlers.release(item.action, { budget, record, restore: record.restore })
      result.released.push(store.transitionEnforcement(record.id, 'released'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Stay in `releasing`, not `failed`: the action is still in force and the
      // next cycle must try again. Marking it failed would read as "lifted".
      store.transitionEnforcement(record.id, 'releasing', { error: message })
      result.failed.push({ action: item.action, error: message })
    }
  }

  return result
}

/** The strongest action currently in force for a scope, if any. */
export function strongestActiveAction(records: readonly EnforcementRecord[]): EnforcementAction | undefined {
  return records
    .filter((record) => record.state === 'active')
    .map((record) => record.action)
    .sort((a, b) => ENFORCEMENT_SEVERITY[b] - ENFORCEMENT_SEVERITY[a])[0]
}

/**
 * Whether an operation is allowed right now.
 *
 * The gate every caller should ask before starting work that costs money. It
 * fails *open* on an unknown operation: a cap should never block something it
 * was not designed to reason about.
 */
export function isOperationAllowed(
  operation: 'build' | 'deploy' | 'function_invoke' | 'request',
  active: readonly EnforcementRecord[],
): { allowed: boolean; blockedBy?: EnforcementAction; reason?: string } {
  const live = new Set(active.filter((record) => record.state === 'active' && !record.simulated).map((record) => record.action))
  const blockers: Record<typeof operation, EnforcementAction[]> = {
    build: ['block_builds', 'suspend_project'],
    deploy: ['block_deployments', 'suspend_project'],
    function_invoke: ['suspend_functions', 'serve_static', 'suspend_project'],
    request: ['suspend_project'],
  }
  for (const action of blockers[operation] ?? []) {
    if (live.has(action))
      return { allowed: false, blockedBy: action, reason: ENFORCEMENT_DESCRIPTIONS[action] }
  }
  return { allowed: true }
}
