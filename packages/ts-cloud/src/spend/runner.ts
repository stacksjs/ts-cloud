/**
 * The spend loop: the thing that actually runs on a timer.
 *
 * Everything else in this module is a component - a store, a pure evaluator, a
 * set of handlers. This is the composition, and it is deliberately the only
 * place that knows the order:
 *
 *     ingest -> evaluate -> enforce -> notify -> detect anomalies -> prune
 *
 * Ingest first, because a decision made against last cycle's usage is a
 * decision made a minute late, and a minute is a lot of invocations. Prune
 * last, because pruning is the only step that is safe to skip if the process
 * dies partway through.
 *
 * Cadence matters more than it looks. The loop is designed to run every minute:
 * usage rolls up hourly, so a more frequent cycle re-reads the same numbers,
 * and a less frequent one widens the window in which a runaway loop bills
 * unchecked. One minute is the shortest interval at which every step is cheap.
 */
import type { AlertStore } from '../alerts'
import type { ControlPlaneStore } from '../control-plane'
import type { TelemetryRecord } from '../telemetry'
import type { SpendEnforcementTransport } from './appliers'
import type { EnforcementPolicy } from './enforcement'
import type { EnforcementAction, SpendAnomaly, SpendDecision } from './model'
import type { SpendStore } from './store'
import { createEnforcementHandlers } from './appliers'
import { SpendGate } from './gate'
import { SpendLoopLease } from './lease'
import { SpendNotificationRouter } from './notifications'
import { SpendService } from './service'

export interface SpendRunnerOptions {
  controlPlane: ControlPlaneStore
  store: SpendStore
  /** Reuses the alert channels and routes an operator already configured. */
  alerts?: AlertStore
  transport?: SpendEnforcementTransport
  policy?: EnforcementPolicy
  /** Days of hourly rollups to keep. Default 400, so year-over-year works. */
  retentionDays?: number
  now?: () => Date
}

export interface SpendRunnerScope {
  organizationId: string
  projectId?: string
  environmentId?: string
  environmentKind?: string
}

export interface SpendRunResult {
  scope: SpendRunnerScope
  ingested: { applied: number; duplicates: number; costCents: number; unpricedMeters: string[] }
  decisions: SpendDecision[]
  applied: EnforcementAction[]
  released: EnforcementAction[]
  failed: Array<{ action: EnforcementAction; error: string }>
  withheld: EnforcementAction[]
  anomalies: SpendAnomaly[]
  notificationsSent: number
  ranAt: string
  durationMs: number
  /** Anything that went wrong without stopping the cycle. */
  warnings: string[]
}

const EMPTY_INGEST = { applied: 0, duplicates: 0, costCents: 0, unpricedMeters: [] as string[] }

/**
 * Runs one spend cycle for one scope.
 *
 * Every step is wrapped: a failure in notification must not stop enforcement,
 * and a failure in anomaly detection must not stop either. The alternative -
 * one throw aborting the cycle - means a broken Slack webhook disables the
 * spend cap, which is precisely backwards.
 */
export class SpendRunner {
  readonly gate: SpendGate
  readonly service: SpendService
  private readonly notifications?: SpendNotificationRouter

  constructor(private readonly options: SpendRunnerOptions) {
    this.gate = new SpendGate(options.controlPlane, { now: options.now })
    this.service = new SpendService(options.store)
    this.notifications = options.alerts
      ? new SpendNotificationRouter(options.alerts, { now: options.now })
      : undefined
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  /** Meter a telemetry batch. Safe to call from a collector on its own cadence. */
  ingest(organizationId: string, records: readonly TelemetryRecord[], defaultProvider?: string): SpendRunResult['ingested'] {
    if (records.length === 0) return { ...EMPTY_INGEST }
    return this.service.ingestTelemetry(organizationId, records, defaultProvider)
  }

  /**
   * Run one full cycle.
   *
   * `telemetry` is optional: a deployment where collectors POST usage directly
   * to the API has already ingested by the time this runs, and passing an
   * empty batch simply skips step one.
   */
  async run(scope: SpendRunnerScope, telemetry: readonly TelemetryRecord[] = []): Promise<SpendRunResult> {
    const startedAt = this.now()
    const warnings: string[] = []
    const result: SpendRunResult = {
      scope,
      ingested: { ...EMPTY_INGEST },
      decisions: [],
      applied: [],
      released: [],
      failed: [],
      withheld: [],
      anomalies: [],
      notificationsSent: 0,
      ranAt: startedAt.toISOString(),
      durationMs: 0,
      warnings,
    }

    try {
      result.ingested = this.ingest(scope.organizationId, telemetry)
      if (result.ingested.unpricedMeters.length > 0)
        warnings.push(
          `No price entry for ${result.ingested.unpricedMeters.join(', ')}; that usage is metered but counts as zero against every budget.`,
        )
    } catch (error) {
      warnings.push(`Usage ingest failed: ${message(error)}`)
    }

    const handlers = createEnforcementHandlers({ gate: this.gate, transport: this.options.transport })

    let cycle
    try {
      cycle = await this.service.runCycle({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        environmentKind: scope.environmentKind,
        policy: this.options.policy,
        now: startedAt,
        handlers,
      })
    } catch (error) {
      warnings.push(`Spend evaluation failed: ${message(error)}`)
      result.durationMs = this.now().getTime() - startedAt.getTime()
      return result
    }

    result.decisions = cycle.statuses.map((status) => status.decision)
    result.anomalies = cycle.anomalies
    for (const run of cycle.enforcement) {
      result.applied.push(...run.applied.map((record) => record.action))
      result.released.push(...run.released.map((record) => record.action))
      result.failed.push(...run.failed)
      result.withheld.push(...run.withheld.map((step) => step.action))
    }
    for (const failure of result.failed)
      warnings.push(`Enforcement for ${failure.action} did not complete: ${failure.error}`)
    if (result.withheld.length > 0)
      warnings.push(
        `${result.withheld.join(', ')} require approval on this environment and were not applied automatically.`,
      )

    // A gate entry for a budget that no longer exists (deleted, or disabled
    // mid-breach) would keep refusing operations forever, with nothing left in
    // the UI to explain why. Reconcile before notifying.
    try {
      result.released.push(...this.reconcileGate(scope))
    } catch (error) {
      warnings.push(`Gate reconciliation failed: ${message(error)}`)
    }

    if (this.notifications) {
      try {
        for (const status of cycle.statuses) {
          result.notificationsSent += this.notifications.notifyDecision(status.budget, status.decision).deliveries.length
          if (status.decision.releases.length > 0)
            result.notificationsSent += this.notifications.notifyRelease(
              status.budget,
              status.decision,
              status.decision.releases,
            ).deliveries.length
        }
        for (const anomaly of cycle.anomalies)
          result.notificationsSent += this.notifications.notifyAnomaly(
            anomaly,
            this.options.store.priceBook.currency,
          ).deliveries.length
      } catch (error) {
        warnings.push(`Spend notifications failed: ${message(error)}`)
      }
    }

    try {
      this.options.store.pruneUsage(this.options.retentionDays ?? 400, startedAt)
    } catch (error) {
      warnings.push(`Usage pruning failed: ${message(error)}`)
    }

    result.durationMs = this.now().getTime() - startedAt.getTime()
    return result
  }

  /**
   * Drop gate entries whose budget is gone or disabled.
   *
   * This is the failure mode that would otherwise be invisible: a cap applied,
   * then the budget deleted, leaves deployments blocked by a rule nobody can
   * find. Reconciling here makes the gate converge on the budgets that exist.
   */
  reconcileGate(scope: SpendRunnerScope): EnforcementAction[] {
    const live = new Map(
      this.options.store
        .listBudgets({ organizationId: scope.organizationId })
        .filter((budget) => budget.enabled)
        .map((budget) => [budget.id, budget]),
    )
    const orphaned: EnforcementAction[] = []
    for (const entry of this.gate.listUnder({ organizationId: scope.organizationId })) {
      if (live.has(entry.budgetId)) continue
      this.gate.close(entry.budgetId, entry.action)
      orphaned.push(entry.action)
    }
    return orphaned
  }

  /** Run every organization the control plane knows about. The cron entry point. */
  async runAll(telemetry: readonly TelemetryRecord[] = []): Promise<SpendRunResult[]> {
    const results: SpendRunResult[] = []
    for (const organization of this.options.controlPlane.listOrganizations()) {
      results.push(await this.run({ organizationId: organization.id }, telemetry))
      for (const project of this.options.controlPlane
        .listProjects()
        .filter((candidate) => candidate.organizationId === organization.id)) {
        for (const environment of this.options.controlPlane.listEnvironments(project.id)) {
          results.push(
            await this.run({
              organizationId: organization.id,
              projectId: project.id,
              environmentId: environment.id,
              environmentKind: environment.kind,
            }),
          )
        }
      }
    }
    return results
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How often the loop should run, in seconds. See the note at the top of the file. */
export const SPEND_CYCLE_SECONDS = 60

/**
 * Start the loop on an interval.
 *
 * Returns a stop function. Cycles never overlap: a slow cycle delays the next
 * one rather than running two evaluations against the same usage, which would
 * double-apply enforcement and double-notify.
 */
export interface SpendLoopOptions {
  intervalSeconds?: number
  /**
   * Only run when this lease can be held. Pass one whenever the loop might be
   * started in more than one process - a dashboard server and a `spend:work`
   * worker on the same box is the ordinary case.
   */
  lease?: SpendLoopLease
  /** Run one cycle immediately instead of waiting out the first interval. */
  immediate?: boolean
  onResult?: (results: SpendRunResult[]) => void
  /** Called when a cycle was skipped because another process holds the lease. */
  onSkip?: (holder: string) => void
  onError?: (error: unknown) => void
}

export function startSpendLoop(runner: SpendRunner, options: SpendLoopOptions = {}): () => void {
  const intervalMs = Math.max(10, options.intervalSeconds ?? SPEND_CYCLE_SECONDS) * 1000
  let running = false
  let stopped = false
  const tick = async (): Promise<void> => {
    // A cycle already in flight means the last one is slow. Skipping is right:
    // two evaluations against the same usage would double-apply and double-notify.
    if (running || stopped) return
    if (options.lease && !options.lease.acquire()) {
      options.onSkip?.(options.lease.current()?.owner ?? 'another process')
      return
    }
    running = true
    try {
      const results = await runner.runAll()
      options.onResult?.(results)
    } catch (error) {
      options.onError?.(error)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  // Do not hold the process open: a spend loop is a background concern and
  // should never be the reason a CLI command fails to exit.
  timer.unref?.()
  if (options.immediate) void tick()
  return () => {
    stopped = true
    clearInterval(timer)
    // Release rather than let it expire, so the next process can start at once
    // instead of waiting out a TTL for a holder that is already gone.
    options.lease?.release()
  }
}
