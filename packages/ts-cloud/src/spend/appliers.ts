/**
 * Turning a decision into a real effect.
 *
 * Every applier does the same two things, in this order:
 *
 *   1. Write the gate (see `gate.ts`). This is what makes the cap true.
 *   2. Ask a transport to make the traffic-facing change, if the action has one.
 *
 * Order matters. Gate first means a transport that times out still leaves the
 * cap in force - the builds and deploys stop even if the edge did not get the
 * message. The reverse order would leave a window where the edge is throttled
 * but the control plane thinks nothing happened, and the next evaluation cycle
 * would try to apply it again.
 *
 * Release runs the same two steps in reverse: restore the traffic path first,
 * then open the gate. A caller that gets its service back before the gate
 * opens is fine; the other way round would admit traffic to an edge still
 * serving a 503.
 */
import type { JsonValue } from '../control-plane'
import type { EnforcementApplier, EnforcementReleaser } from './enforcement'
import type { EnforcementAction } from './model'
import type { SpendGate } from './gate'

/**
 * What a driver must implement for the traffic-affecting actions.
 *
 * Deliberately small and provider-neutral: AWS does these through CloudFront
 * and Lambda concurrency, a Hetzner box through rpx and systemd, and a test
 * through a fake. Each method returns the state needed to undo it, because a
 * cap that cannot be lifted is an outage.
 */
export interface SpendEnforcementTransport {
  /** Apply an edge rate-limit multiplier. Returns the previous configuration. */
  throttleRequests?(input: {
    projectId?: string
    environmentId?: string
    factor: number
  }): Promise<Record<string, JsonValue>> | Record<string, JsonValue>
  restoreRequests?(restore: Record<string, JsonValue>): Promise<void> | void

  /** Stop invoking functions; cached and static responses keep serving. */
  suspendFunctions?(input: {
    projectId?: string
    environmentId?: string
  }): Promise<Record<string, JsonValue>> | Record<string, JsonValue>
  resumeFunctions?(restore: Record<string, JsonValue>): Promise<void> | void

  /** Serve only the last built static output. */
  serveStatic?(input: {
    projectId?: string
    environmentId?: string
  }): Promise<Record<string, JsonValue>> | Record<string, JsonValue>
  restoreDynamic?(restore: Record<string, JsonValue>): Promise<void> | void

  /** Park inbound traffic behind a 503. Never removes data. */
  suspendProject?(input: {
    projectId?: string
    environmentId?: string
  }): Promise<Record<string, JsonValue>> | Record<string, JsonValue>
  resumeProject?(restore: Record<string, JsonValue>): Promise<void> | void
}

/** Called when an action fires, so notifications can go out. */
export type SpendNotifier = (input: {
  action: EnforcementAction
  budgetId: string
  reason: string
  simulated: boolean
  released: boolean
}) => Promise<void> | void

export interface EnforcementHandlerOptions {
  gate: SpendGate
  transport?: SpendEnforcementTransport
  notify?: SpendNotifier
  /**
   * Multiplier applied to rate limits when `throttle_requests` fires.
   * Half by default: enough to stop a runaway, gentle enough that a real user
   * mostly does not notice.
   */
  throttleFactor?: number
}

/** Actions whose only effect is the gate itself. */
const GATE_ONLY: readonly EnforcementAction[] = ['notify', 'block_builds', 'block_deployments']

/**
 * Build the `{ apply, release }` pair that `runEnforcement` expects.
 *
 * Without a transport this still produces a fully working cap for builds,
 * deploys, and notifications - the actions that need no box - and records the
 * traffic-affecting ones in the gate so they are visible and reversible even
 * though nothing at the edge changed. That is the honest degradation: the
 * dashboard says what is in force, and `unsupported: true` in the restore
 * payload says why it had no traffic effect.
 */
export function createEnforcementHandlers(options: EnforcementHandlerOptions): {
  apply: EnforcementApplier
  release: EnforcementReleaser
} {
  const throttleFactor = options.throttleFactor ?? 0.5

  const apply: EnforcementApplier = async (action, context) => {
    const { budget, record, decision } = context
    options.gate.open({
      budgetId: budget.id,
      action,
      organizationId: budget.organizationId,
      projectId: budget.projectId,
      environmentId: budget.environmentId,
      reason: decision.reason,
      simulated: record.simulated,
    })

    let restore: Record<string, JsonValue> = { gated: true }
    if (!record.simulated && !GATE_ONLY.includes(action)) {
      const scope = { projectId: budget.projectId, environmentId: budget.environmentId }
      const transport = options.transport
      if (action === 'throttle_requests' && transport?.throttleRequests)
        restore = { ...(await transport.throttleRequests({ ...scope, factor: throttleFactor })), gated: true }
      else if (action === 'suspend_functions' && transport?.suspendFunctions)
        restore = { ...(await transport.suspendFunctions(scope)), gated: true }
      else if (action === 'serve_static' && transport?.serveStatic)
        restore = { ...(await transport.serveStatic(scope)), gated: true }
      else if (action === 'suspend_project' && transport?.suspendProject)
        restore = { ...(await transport.suspendProject(scope)), gated: true }
      // No transport for this action: the gate still holds, but say so rather
      // than letting the dashboard imply traffic was affected.
      else restore = { gated: true, unsupported: true }
    }

    await options.notify?.({
      action,
      budgetId: budget.id,
      reason: decision.reason,
      simulated: record.simulated,
      released: false,
    })
    return restore
  }

  const release: EnforcementReleaser = async (action, context) => {
    const { budget, record, restore } = context
    const transport = options.transport
    if (!record.simulated && !GATE_ONLY.includes(action) && restore.unsupported !== true) {
      if (action === 'throttle_requests' && transport?.restoreRequests) await transport.restoreRequests(restore)
      else if (action === 'suspend_functions' && transport?.resumeFunctions) await transport.resumeFunctions(restore)
      else if (action === 'serve_static' && transport?.restoreDynamic) await transport.restoreDynamic(restore)
      else if (action === 'suspend_project' && transport?.resumeProject) await transport.resumeProject(restore)
    }
    // Only after service is back does the gate open.
    options.gate.close(budget.id, action)
    await options.notify?.({
      action,
      budgetId: budget.id,
      reason: record.reason,
      simulated: record.simulated,
      released: true,
    })
  }

  return { apply, release }
}

/**
 * A transport that records calls instead of making them.
 *
 * Not only for tests: this is what a `--dry-run` cap run uses to show an
 * operator exactly which traffic changes a budget would make, before it is
 * allowed to make them.
 */
export class RecordingSpendTransport implements SpendEnforcementTransport {
  readonly calls: Array<{ method: string; input: unknown }> = []

  private record(method: string, input: unknown): Record<string, JsonValue> {
    this.calls.push({ method, input })
    return { recorded: method }
  }

  throttleRequests(input: { projectId?: string; environmentId?: string; factor: number }): Record<string, JsonValue> {
    return this.record('throttleRequests', input)
  }

  restoreRequests(restore: Record<string, JsonValue>): void {
    this.record('restoreRequests', restore)
  }

  suspendFunctions(input: { projectId?: string; environmentId?: string }): Record<string, JsonValue> {
    return this.record('suspendFunctions', input)
  }

  resumeFunctions(restore: Record<string, JsonValue>): void {
    this.record('resumeFunctions', restore)
  }

  serveStatic(input: { projectId?: string; environmentId?: string }): Record<string, JsonValue> {
    return this.record('serveStatic', input)
  }

  restoreDynamic(restore: Record<string, JsonValue>): void {
    this.record('restoreDynamic', restore)
  }

  suspendProject(input: { projectId?: string; environmentId?: string }): Record<string, JsonValue> {
    return this.record('suspendProject', input)
  }

  resumeProject(restore: Record<string, JsonValue>): void {
    this.record('resumeProject', restore)
  }
}
