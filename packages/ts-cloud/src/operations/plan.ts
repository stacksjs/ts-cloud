/**
 * Plan-then-apply scaffolding for fleet operations that change live topology.
 *
 * Consolidating servers — moving an app to another box, attaching one as a site,
 * renaming a box — is a routine cleanup that is currently an afternoon of SSH.
 * What makes it an afternoon is not the individual steps, which are small; it is
 * that a half-finished one leaves no way to tell what already happened. So every
 * such operation is expressed the same way here:
 *
 * - **Plan first.** A step says what it would change (`from → to`) before
 *   anything is touched, and prints the same way every run so a plan can be
 *   diffed.
 * - **Idempotent and resumable.** Resumability comes from `satisfied()`, which
 *   asks REALITY whether the step's intent already holds — not from a checkpoint
 *   file, which can disagree with the world after a crash. Re-running an
 *   operation that died halfway continues rather than starting over or
 *   double-applying, and a fully-applied operation re-runs as a clean no-op.
 * - **Typed confirmation for the destructive half.** Irreversible steps are
 *   marked, counted separately, and gated on the operator typing the target's
 *   exact name — separately from the operation itself.
 * - **Non-interactive.** Nothing here reads stdin: a plan is data, the
 *   confirmation is a flag, so the whole sequence is drivable from CI.
 * - **Audited.** Each step reports through {@link ApplyPlanOptions.audit} as it
 *   starts and finishes, so the operation log carries what actually ran.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 */

/** A value a step changes, rendered in the plan as `from → to`. */
export interface StepChange {
  from: string
  to: string
}

export interface OperationStep {
  /** Stable across runs — this is what an audit log and a resumed run key on. */
  id: string
  /** One line, imperative: "Rename the Hetzner server". */
  title: string
  /** What the step changes. Omitted for steps that only verify. */
  change?: StepChange
  /**
   * Irreversible. Marked in the plan and gated on typed confirmation, because
   * "delete the drained source server" and "move an app" deserve different
   * levels of ceremony even inside one operation.
   */
  destructive?: boolean
  /**
   * Does reality ALREADY match this step's intent? This is what makes an
   * operation resumable: a step that is satisfied is skipped, so a run that died
   * halfway picks up where it stopped without the caller tracking progress.
   *
   * Must not mutate anything, and must tolerate a partially-applied world.
   */
  satisfied: () => Promise<boolean>
  /** Perform the change. Only called when `satisfied()` returned false. */
  apply: () => Promise<void>
}

export interface OperationPlan {
  /** Stable operation name, e.g. `server:rename`. */
  operation: string
  /** What is being operated on, and what a destructive step's confirmation must match. */
  target: string
  steps: OperationStep[]
}

/** A step paired with what resolving it against the live world found. */
export interface ResolvedStep {
  step: OperationStep
  /** `satisfied` — nothing to do; `pending` — would run; `unknown` — could not tell. */
  state: 'satisfied' | 'pending' | 'unknown'
  /** Why the state is `unknown`. A step that cannot be checked is never skipped. */
  reason?: string
}

/**
 * Ask every step whether it is already satisfied.
 *
 * A `satisfied()` that THROWS resolves to `unknown` rather than failing the
 * plan: not being able to check is a reason to run the step and to say so, not a
 * reason to refuse to show the operator a plan. Steps are resolved in order,
 * because a later step's check may depend on an earlier one's subject existing.
 */
export async function resolvePlan(plan: OperationPlan): Promise<ResolvedStep[]> {
  const resolved: ResolvedStep[] = []
  for (const step of plan.steps) {
    try {
      resolved.push({ step, state: (await step.satisfied()) ? 'satisfied' : 'pending' })
    } catch (error) {
      resolved.push({ step, state: 'unknown', reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return resolved
}

/** Steps that would actually run — pending, plus the ones that could not be checked. */
export function pendingSteps(resolved: readonly ResolvedStep[]): ResolvedStep[] {
  return resolved.filter(item => item.state !== 'satisfied')
}

/** Do any steps that would run make an irreversible change? */
export function planIsDestructive(resolved: readonly ResolvedStep[]): boolean {
  return pendingSteps(resolved).some(item => item.step.destructive === true)
}

/**
 * The plan as lines, ready to print.
 *
 * Lines rather than printed output so the caller owns the stream and this stays
 * testable, and in declaration order so two runs of an unchanged plan produce an
 * identical diff.
 */
export function formatPlan(plan: OperationPlan, resolved: readonly ResolvedStep[]): string[] {
  const pending = pendingSteps(resolved)
  const lines = [`${plan.operation} ${plan.target}`]

  if (pending.length === 0) {
    lines.push('  Nothing to do — every step is already satisfied.')
    return lines
  }

  for (const { step, state, reason } of resolved) {
    const mark = state === 'satisfied' ? 'ok  ' : state === 'unknown' ? '?   ' : '→   '
    const flags = [
      step.destructive ? 'DESTRUCTIVE' : '',
      state === 'satisfied' ? 'already done' : '',
    ].filter(Boolean)
    lines.push(`  ${mark}${step.title}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`)
    if (step.change) lines.push(`        ${step.change.from} → ${step.change.to}`)
    if (reason) lines.push(`        could not check: ${reason}`)
  }

  const destructive = pending.filter(item => item.step.destructive).length
  lines.push(
    `  ${pending.length} step(s) would run`
    + (destructive > 0 ? `, ${destructive} irreversible — re-run with --confirm ${plan.target}` : ''),
  )
  return lines
}

export interface StepOutcome {
  id: string
  title: string
  /** `applied` — it ran; `skipped` — already satisfied; `failed` — it threw. */
  state: 'applied' | 'skipped' | 'failed'
  error?: string
}

export interface OperationOutcome {
  operation: string
  target: string
  steps: StepOutcome[]
  /** False when any step failed. The steps before it stay applied — see below. */
  success: boolean
}

export interface ApplyPlanOptions {
  /** Progress, one line per step. */
  log?: (message: string) => void
  /**
   * Append to the operation log. Called as each step starts and finishes, so a
   * run that dies mid-step still leaves the start recorded — which is exactly
   * the case an operator is trying to reconstruct afterwards.
   */
  audit?: (event: { operation: string, target: string, step: string, state: 'started' | StepOutcome['state'], error?: string }) => void
  /**
   * Exact target name, required before any irreversible step runs. A plan with
   * no destructive pending step ignores this.
   */
  confirm?: string
}

/**
 * Run the pending steps in order.
 *
 * Stops at the first failure and leaves the earlier steps applied, deliberately:
 * a topology change half-applied and reported is recoverable — re-run it, the
 * satisfied steps skip themselves — while one silently rolled back to a state
 * nobody has verified is not.
 */
export async function applyPlan(
  plan: OperationPlan,
  resolved: readonly ResolvedStep[],
  options: ApplyPlanOptions = {},
): Promise<OperationOutcome> {
  const outcome: OperationOutcome = { operation: plan.operation, target: plan.target, steps: [], success: true }

  if (planIsDestructive(resolved) && options.confirm !== plan.target) {
    throw new Error(
      `${plan.operation} includes an irreversible step. Re-run with --confirm ${plan.target} to authorize it.`,
    )
  }

  for (const { step, state } of resolved) {
    if (state === 'satisfied') {
      outcome.steps.push({ id: step.id, title: step.title, state: 'skipped' })
      options.log?.(`skip  ${step.title} (already done)`)
      continue
    }

    options.audit?.({ operation: plan.operation, target: plan.target, step: step.id, state: 'started' })
    try {
      await step.apply()
      outcome.steps.push({ id: step.id, title: step.title, state: 'applied' })
      options.log?.(`done  ${step.title}`)
      options.audit?.({ operation: plan.operation, target: plan.target, step: step.id, state: 'applied' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome.steps.push({ id: step.id, title: step.title, state: 'failed', error: message })
      outcome.success = false
      options.log?.(`FAIL  ${step.title}: ${message}`)
      options.audit?.({ operation: plan.operation, target: plan.target, step: step.id, state: 'failed', error: message })
      return outcome
    }
  }

  return outcome
}
