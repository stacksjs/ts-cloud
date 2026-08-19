/**
 * The cap evaluator: budget + usage in, decision out.
 *
 * Pure and clock-injected, so every rung of the ladder is testable without a
 * database or a real month passing. The store applies the result; this file
 * only decides.
 *
 * Three details are what separate a usable cap from an annoying one:
 *
 *   - **Hysteresis.** A scope parked on the line would otherwise enforce and
 *     release every evaluation cycle, paging someone each time. An action is
 *     only lifted once spend drops a configured margin below its trigger.
 *   - **Grace.** A single spiky minute should not suspend production. A breach
 *     must persist for `graceSeconds` before enforcement runs; notifications
 *     still fire immediately, because a warning has no blast radius.
 *   - **Confidence.** Projection-based rungs are ignored while the forecast is
 *     still noise. Enforcing on ten minutes of extrapolation is how you take a
 *     site down over nothing.
 */
import type {
  Budget,
  BudgetWindow,
  EnforcementAction,
  SpendDecision,
  SpendLevel,
  SpendProjection,
  ThresholdBreach,
} from './model'
import { ENFORCEMENT_SEVERITY } from './model'
import { percentOfLimit, projectSpend } from './projection'

/** Below this confidence a forecast cannot trigger anything but a notification. */
export const MIN_PROJECTION_CONFIDENCE = 0.35

export interface EvaluateInput {
  budget: Budget
  window: BudgetWindow
  /** Spend so far in the window, cents. */
  actualCents: number
  series?: ReadonlyArray<{ bucketStart: string; costCents: number }>
  /** Actions currently in force, so the evaluator can decide what to release. */
  activeActions?: readonly EnforcementAction[]
  /**
   * When the current breach was first observed. Grace is measured from here.
   *
   * Omitting it on a budget with a grace period means "first seen now", so the
   * first cycle of a breach never enforces. That is the safe reading: a caller
   * that is not tracking the clock has no way to know the breach has lasted.
   */
  breachingSince?: string
  now?: Date
}

/**
 * The limit a budget's percentages are measured against.
 *
 * The hard limit governs when there is one, so a ladder written as "100% =
 * block deploys" means the same thing whether or not a soft limit exists.
 */
export function governingLimitCents(budget: Budget): number | undefined {
  return budget.hardLimitCents ?? budget.softLimitCents
}

function levelFor(budget: Budget, usedPercent: number, actions: readonly EnforcementAction[]): SpendLevel {
  const enforcing = actions.some((action) => action !== 'notify')
  if (enforcing) return 'hard_capped'
  const limit = governingLimitCents(budget)
  const soft = budget.softLimitCents
  if (soft != null && limit != null && limit > 0 && usedPercent >= (soft / limit) * 100) return 'soft_capped'
  if (usedPercent >= 50) return 'warning'
  return 'ok'
}

function orderActions(actions: Iterable<EnforcementAction>): EnforcementAction[] {
  return [...new Set(actions)].sort((a, b) => ENFORCEMENT_SEVERITY[a] - ENFORCEMENT_SEVERITY[b])
}

function reasonFor(
  level: SpendLevel,
  budget: Budget,
  usedPercent: number,
  projection: SpendProjection,
  breaches: readonly ThresholdBreach[],
): string {
  if (breaches.length === 0) return `Spend is at ${usedPercent.toFixed(1)}% of the ${budget.period} budget.`
  const top = breaches[breaches.length - 1]
  if (top.projected)
    return `Projected spend for this ${budget.period} window reaches ${top.observedPercent.toFixed(1)}% of the budget (${projection.confidence.toFixed(2)} confidence), crossing the ${top.atPercent}% threshold.`
  return `Spend reached ${usedPercent.toFixed(1)}% of the ${budget.period} budget, crossing the ${top.atPercent}% threshold${level === 'hard_capped' ? ' and triggering enforcement' : ''}.`
}

/**
 * Evaluate one budget.
 *
 * The returned `actions` are what *should* be in force; `releases` are actions
 * currently in force that should not be. A caller that applies both converges
 * on the right state no matter how many cycles it missed.
 */
export function evaluateBudget(input: EvaluateInput): SpendDecision {
  const { budget, window } = input
  const now = input.now ?? new Date()
  const limit = governingLimitCents(budget)
  const projection = projectSpend({
    window,
    actualCents: input.actualCents,
    series: input.series,
    limitCents: limit,
  })
  const usedPercent = percentOfLimit(input.actualCents, limit)
  const projectedPercent = percentOfLimit(projection.projectedCents, limit)

  const graceMs = budget.graceSeconds * 1000
  const graceSatisfied =
    graceMs === 0 ||
    (input.breachingSince != null && now.getTime() - new Date(input.breachingSince).getTime() >= graceMs)
  const forecastUsable = projection.confidence >= MIN_PROJECTION_CONFIDENCE

  const breaches: ThresholdBreach[] = []
  const wanted = new Set<EnforcementAction>()
  for (const threshold of [...budget.thresholds].sort((a, b) => a.atPercent - b.atPercent)) {
    const projected = threshold.onProjection === true
    const observed = projected ? projectedPercent : usedPercent
    if (!(observed >= threshold.atPercent)) continue
    // A forecast we do not trust may warn, but must never enforce.
    const enforcing = threshold.actions.filter((action) => action !== 'notify')
    if (projected && !forecastUsable && enforcing.length > 0) continue
    breaches.push({ atPercent: threshold.atPercent, actions: threshold.actions, projected, observedPercent: observed })
    for (const action of threshold.actions) {
      if (action !== 'notify' && !graceSatisfied) continue
      wanted.add(action)
    }
  }

  const actions = orderActions(wanted)
  // Hysteresis: an action stays in force until spend falls a margin below the
  // threshold that armed it, so a scope sitting on the line does not flap.
  const releaseCeiling = 100 - budget.hysteresisPercent
  const releases = orderActions(
    (input.activeActions ?? []).filter((active) => {
      if (wanted.has(active)) return false
      const armedAt = budget.thresholds
        .filter((threshold) => threshold.actions.includes(active))
        .reduce<number | undefined>((min, threshold) => (min == null ? threshold.atPercent : Math.min(min, threshold.atPercent)), undefined)
      if (armedAt == null) return true
      const measured = Math.max(usedPercent, forecastUsable ? projectedPercent : 0)
      return measured <= armedAt * (releaseCeiling / 100)
    }),
  )

  const level = levelFor(budget, usedPercent, actions)
  return {
    budgetId: budget.id,
    level,
    window,
    projection,
    usedPercent,
    projectedPercent,
    breaches,
    actions: budget.dryRun ? actions.filter((action) => action === 'notify') : actions,
    releases,
    simulated: budget.dryRun,
    reason: reasonFor(level, budget, usedPercent, projection, breaches),
    evaluatedAt: now.toISOString(),
  }
}

/**
 * Combine decisions for overlapping budgets on one scope.
 *
 * The strictest wins: an org-wide cap must not be loosened by a permissive
 * project budget, and an environment cap must be able to tighten. Releases only
 * survive if no other budget still wants the action.
 */
export function mergeDecisions(decisions: readonly SpendDecision[]): {
  actions: EnforcementAction[]
  releases: EnforcementAction[]
  level: SpendLevel
} {
  const wanted = new Set<EnforcementAction>()
  for (const decision of decisions) for (const action of decision.actions) wanted.add(action)
  const releases = new Set<EnforcementAction>()
  for (const decision of decisions)
    for (const action of decision.releases) if (!wanted.has(action)) releases.add(action)
  const rank: Record<SpendLevel, number> = { ok: 0, warning: 1, soft_capped: 2, hard_capped: 3 }
  const level = decisions.reduce<SpendLevel>(
    (worst, decision) => (rank[decision.level] > rank[worst] ? decision.level : worst),
    'ok',
  )
  return { actions: orderActions(wanted), releases: orderActions(releases), level }
}
