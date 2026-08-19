/**
 * The spend gate: what "capped" actually means to the rest of the platform.
 *
 * The naive way to apply a cap is for each enforcement action to reach into
 * the subsystem it affects and switch something off. That fails in three ways
 * this design avoids:
 *
 *   1. **It is not crash-safe.** A cap applied by mutating in-memory state
 *      quietly lifts itself the next time the control plane restarts, which is
 *      exactly when a runaway workload is least supervised.
 *   2. **It couples every action to a driver.** `block_builds` would need SSH
 *      to a box to mean anything, so it could not be tested, and a driver
 *      outage would read as "not capped".
 *   3. **It has no single answer.** With state spread across five subsystems,
 *      "is this project capped?" has five answers that drift.
 *
 * Instead, enforcement writes one durable record - the gate - into the control
 * plane, and the subsystems that spend money *read* it before acting. The gate
 * is the source of truth; a driver call is an additional, best-effort effect
 * on top of it. So a driver that fails leaves the cap in force rather than
 * silently open, and lifting a cap is a delete rather than an undo.
 */
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { EnforcementAction } from './model'
import { ENFORCEMENT_SEVERITY } from './model'
import { ENFORCEMENT_DESCRIPTIONS } from './enforcement'

/** Operations the gate can refuse. */
export type GatedOperation = 'build' | 'deploy' | 'function_invoke' | 'request'

/** Control-plane setting key holding every live gate entry. */
export const SPEND_GATE_SETTING = 'spend.gates'

export interface SpendGateEntry {
  budgetId: string
  action: EnforcementAction
  organizationId: string
  projectId?: string
  environmentId?: string
  reason: string
  /** A simulated entry is recorded and reported but never refuses anything. */
  simulated: boolean
  appliedAt: string
}

export interface GateVerdict {
  allowed: boolean
  action?: EnforcementAction
  reason?: string
  budgetId?: string
}

/** Which actions refuse which operations. Anything absent is allowed. */
const BLOCKS: Readonly<Record<GatedOperation, readonly EnforcementAction[]>> = {
  build: ['block_builds', 'suspend_project'],
  deploy: ['block_deployments', 'suspend_project'],
  function_invoke: ['suspend_functions', 'serve_static', 'suspend_project'],
  request: ['suspend_project'],
}

function entryKey(entry: Pick<SpendGateEntry, 'budgetId' | 'action'>): string {
  return `${entry.budgetId}:${entry.action}`
}

type Scope = { organizationId: string; projectId?: string; environmentId?: string }

/**
 * Whether an entry *governs* a scope: is it equal to or broader than it?
 *
 * This is the question `check` asks. An org-wide entry governs every project
 * under it; an entry naming a project governs only that project. Narrower
 * never widens, which is what stops one project's cap blocking another's.
 */
function governs(entry: SpendGateEntry, scope: Scope): boolean {
  if (entry.organizationId !== scope.organizationId) return false
  if (entry.projectId && entry.projectId !== scope.projectId) return false
  if (entry.environmentId && entry.environmentId !== scope.environmentId) return false
  return true
}

/**
 * Whether an entry sits *under* a scope: is it equal to or narrower than it?
 *
 * The dual of {@link governs}, and a genuinely different question. Listing
 * everything under an organization has to include its projects' entries, while
 * checking whether that organization's own deploy is blocked must not. Using
 * one predicate for both is why a reconcile pass can silently find nothing.
 */
function isUnder(entry: SpendGateEntry, scope: Scope): boolean {
  if (entry.organizationId !== scope.organizationId) return false
  if (scope.projectId && entry.projectId !== scope.projectId) return false
  if (scope.environmentId && entry.environmentId !== scope.environmentId) return false
  return true
}

/** Drop undefined fields so a JSON round trip does not turn them into empty strings. */
function compact(entry: SpendGateEntry): SpendGateEntry {
  const output = { ...entry }
  for (const key of ['projectId', 'environmentId'] as const) if (output[key] == null) delete output[key]
  return output
}

export class SpendGate {
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    private readonly options: { now?: () => Date } = {},
  ) {}

  private read(): SpendGateEntry[] {
    const raw = this.controlPlane.getSetting(SPEND_GATE_SETTING)
    return Array.isArray(raw) ? (raw as unknown as SpendGateEntry[]) : []
  }

  private write(entries: readonly SpendGateEntry[]): void {
    this.controlPlane.setSetting(SPEND_GATE_SETTING, entries as unknown as JsonValue)
  }

  /** Entries governing a scope - equal or broader. Most disruptive first. */
  list(scope?: Scope): SpendGateEntry[] {
    return this.read()
      .filter((entry) => !scope || governs(entry, scope))
      .sort((a, b) => ENFORCEMENT_SEVERITY[b.action] - ENFORCEMENT_SEVERITY[a.action])
  }

  /**
   * Entries under a scope - equal or narrower.
   *
   * What a dashboard and a reconcile pass want: everything an organization has
   * in force, including its projects' own caps.
   */
  listUnder(scope: Scope): SpendGateEntry[] {
    return this.read()
      .filter((entry) => isUnder(entry, scope))
      .sort((a, b) => ENFORCEMENT_SEVERITY[b.action] - ENFORCEMENT_SEVERITY[a.action])
  }

  /** Record an action as in force. Idempotent on (budget, action). */
  open(entry: Omit<SpendGateEntry, 'appliedAt'> & { appliedAt?: string }): SpendGateEntry {
    const appliedAt = entry.appliedAt ?? (this.options.now?.() ?? new Date()).toISOString()
    const next = compact({ ...entry, appliedAt })
    const entries = this.read().filter((existing) => entryKey(existing) !== entryKey(next))
    entries.push(next)
    this.write(entries)
    return next
  }

  /** Lift an action. Returns false when it was not in force. */
  close(budgetId: string, action: EnforcementAction): boolean {
    const entries = this.read()
    const remaining = entries.filter((entry) => entryKey(entry) !== entryKey({ budgetId, action }))
    if (remaining.length === entries.length) return false
    this.write(remaining)
    return true
  }

  /** Lift every action for a budget. Used when a budget is deleted or disabled. */
  closeBudget(budgetId: string): number {
    const entries = this.read()
    const remaining = entries.filter((entry) => entry.budgetId !== budgetId)
    this.write(remaining)
    return entries.length - remaining.length
  }

  /**
   * The question every spending caller should ask.
   *
   * Fails open for an operation the gate has no rule about: a cap must never
   * block something it was not designed to reason about.
   */
  check(operation: GatedOperation, scope: Scope): GateVerdict {
    const blocking = BLOCKS[operation] ?? []
    for (const entry of this.list(scope)) {
      if (entry.simulated) continue
      if (!blocking.includes(entry.action)) continue
      return {
        allowed: false,
        action: entry.action,
        budgetId: entry.budgetId,
        reason: `${entry.reason} ${ENFORCEMENT_DESCRIPTIONS[entry.action]}`,
      }
    }
    return { allowed: true }
  }

  /** The strongest action in force for a scope, ignoring simulated entries. */
  strongest(scope: Scope): EnforcementAction | undefined {
    return this.list(scope).find((entry) => !entry.simulated)?.action
  }
}

/** Raised when a spend cap refuses an operation. Carries a 402 for the API. */
export class SpendCapError extends Error {
  readonly code = 'spend_cap_exceeded'
  readonly status = 402
  constructor(
    readonly operation: GatedOperation,
    readonly verdict: GateVerdict,
  ) {
    super(verdict.reason ?? `A spend cap is blocking this ${operation}.`)
  }
}

/** Throw unless the gate allows the operation. The one-liner for a call site. */
export function assertSpendAllows(gate: SpendGate, operation: GatedOperation, scope: Scope): void {
  const verdict = gate.check(operation, scope)
  if (!verdict.allowed) throw new SpendCapError(operation, verdict)
}
