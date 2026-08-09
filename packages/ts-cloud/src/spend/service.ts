/**
 * The spend service: one object that runs a full cycle.
 *
 * Everything below it is pure or a plain store, which is what makes the
 * subsystem testable. This is the seam where they meet: ingest usage, evaluate
 * every budget that governs a scope, apply or lift enforcement, and look for
 * anomalies - in that order, because enforcement decisions should be made
 * against the usage we just recorded, not the previous cycle's.
 */
import type { TelemetryRecord } from '../telemetry'
import type { AnomalyOptions } from './anomaly'
import type { EnforcementApplier, EnforcementPolicy, EnforcementReleaser, EnforcementRunResult } from './enforcement'
import type { Budget, EnforcementAction, SpendAnomaly, SpendDecision, UsageDelta } from './model'
import type { IngestResult, SpendStore, UsageSummary } from './store'
import { anomalyOptionsForSignal, detectLatestAnomaly } from './anomaly'
import { AnomalyConfigStore } from './anomaly-config'
import { DETECTABLE_SIGNALS, lookbackHoursForSignal, optionsForSignal, signalDefinition, SignalSource } from './signals'
import { evaluateBudget, governingLimitCents, mergeDecisions } from './evaluator'
import { planEnforcement, runEnforcement, strongestActiveAction } from './enforcement'
import { aggregateDeltas, CounterTracker, meterTelemetry } from './meter'
import { formatTimeToExhaustion } from './projection'
import { budgetWindow, hourBucket } from './window'

export interface SpendCycleOptions {
  organizationId: string
  projectId?: string
  environmentId?: string
  /** Environment kind, so production can require approval for visible actions. */
  environmentKind?: string
  now?: Date
  policy?: EnforcementPolicy
  handlers?: { apply: EnforcementApplier; release: EnforcementReleaser }
}

export interface BudgetStatus {
  budget: Budget
  decision: SpendDecision
  summary: UsageSummary
  /** Enforcement currently in force for this budget. */
  activeActions: EnforcementAction[]
  /** Plain-language time until the cap, e.g. `2d 4h`. Empty when not projected. */
  timeToCap: string
}

export interface SpendCycleResult {
  organizationId: string
  statuses: BudgetStatus[]
  /** Strictest outcome across every governing budget. */
  level: SpendDecision['level']
  actions: EnforcementAction[]
  releases: EnforcementAction[]
  enforcement: EnforcementRunResult[]
  anomalies: SpendAnomaly[]
  evaluatedAt: string
}

/** Tracks when each budget first breached, so grace periods survive across cycles. */
type BreachClock = Map<string, string>

export class SpendService {
  private readonly counters = new CounterTracker()
  private readonly breaching: BreachClock = new Map()
  /** Per-scope detector tuning and silences. Optional: detection works without it. */
  readonly anomalyConfigs: AnomalyConfigStore
  /** Sources every detectable series: usage rollups and request telemetry. */
  readonly signals: SignalSource

  constructor(private readonly store: SpendStore) {
    this.anomalyConfigs = new AnomalyConfigStore(store.controlPlane)
    this.signals = new SignalSource(store.controlPlane, store)
  }

  /** Meter a telemetry batch and fold it into the rollups. */
  ingestTelemetry(organizationId: string, records: readonly TelemetryRecord[], defaultProvider?: string): IngestResult {
    const deltas = meterTelemetry(organizationId, records, { counters: this.counters, defaultProvider })
    return this.store.ingestUsage(deltas)
  }

  /** Fold pre-computed usage in directly. For collectors that already meter. */
  ingestUsage(deltas: readonly UsageDelta[], aggregate: boolean = true): IngestResult {
    return this.store.ingestUsage(aggregate ? aggregateDeltas(deltas) : [...deltas])
  }

  /** Evaluate one budget without touching enforcement. Safe to call anywhere. */
  status(budget: Budget, now: Date = new Date()): BudgetStatus {
    const { window, summary } = this.store.budgetSpendCents(budget, now)
    const active = this.store
      .listEnforcements({ organizationId: budget.organizationId, budgetId: budget.id, activeOnly: true })
      .filter((record) => record.state === 'active')
    const activeActions = active.map((record) => record.action)
    const decision = evaluateBudget({
      budget,
      window,
      actualCents: summary.totalCents,
      series: summary.series,
      activeActions,
      breachingSince: this.breaching.get(budget.id),
      now,
    })
    return {
      budget,
      decision,
      summary,
      activeActions,
      timeToCap: formatTimeToExhaustion(decision.projection.timeToExhaustionMs),
    }
  }

  /**
   * Run a full cycle for a scope.
   *
   * Without `handlers` this evaluates and records but applies nothing - the
   * read-only mode a dashboard or a `--dry-run` CLI wants.
   */
  async runCycle(options: SpendCycleOptions): Promise<SpendCycleResult> {
    const now = options.now ?? new Date()
    const budgets = this.store.budgetsForScope(options.organizationId, options.projectId, options.environmentId)
    const statuses: BudgetStatus[] = []
    const enforcement: EnforcementRunResult[] = []

    for (const budget of budgets) {
      const status = this.status(budget, now)
      this.trackBreach(budget, status.decision, now)
      this.store.recordDecision(status.decision)
      statuses.push(status)
    }

    const merged = mergeDecisions(statuses.map((status) => status.decision))

    if (options.handlers) {
      const policy: EnforcementPolicy = { environmentKind: options.environmentKind, ...options.policy }
      for (const status of statuses) {
        const plan = planEnforcement(status.decision, policy)
        if (plan.apply.length === 0 && plan.release.length === 0 && plan.withheld.length === 0) continue
        enforcement.push(await runEnforcement(this.store, status.budget, status.decision, plan, options.handlers))
      }
    }

    return {
      organizationId: options.organizationId,
      statuses,
      level: merged.level,
      actions: merged.actions,
      releases: merged.releases,
      enforcement,
      anomalies: this.detectAnomalies(options, now),
      evaluatedAt: now.toISOString(),
    }
  }

  /**
   * Grace-period bookkeeping.
   *
   * The clock starts when a budget first wants a non-notify action and is
   * cleared the moment it stops. Keeping it here rather than in the database
   * is deliberate: a grace period that survives a control-plane restart would
   * let a long-resolved blip enforce hours later.
   */
  private trackBreach(budget: Budget, decision: SpendDecision, now: Date): void {
    const wantsEnforcement = decision.breaches.some((breach) => breach.actions.some((action) => action !== 'notify'))
    if (!wantsEnforcement) {
      this.breaching.delete(budget.id)
      return
    }
    if (!this.breaching.has(budget.id)) this.breaching.set(budget.id, now.toISOString())
  }

  /**
   * Look for an anomalous hour in the trailing cost series.
   *
   * Runs over a fixed 14-day lookback rather than the budget window: a monthly
   * budget on day 2 has no history to speak of, and the seasonal baseline needs
   * several same-phase observations before it means anything.
   */
  /**
   * Look for anomalies across every detectable signal.
   *
   * Runs over a fixed 14-day lookback rather than the budget window: a monthly
   * budget on day 2 has no history to speak of, and a seasonal baseline needs
   * several same-phase observations before it means anything. Only complete
   * hours are judged, since a partial hour always reads low.
   *
   * Per-route detection is opt-in through `routes`, and bounded to the busiest
   * few. A long tail of one-hit routes produces noise rather than insight, and
   * the routes that matter are the ones with enough traffic for a baseline.
   */
  detectAnomalies(
    options: SpendCycleOptions & { signals?: string[]; routes?: boolean },
    now: Date = new Date(),
    overrides: AnomalyOptions = {},
  ): SpendAnomaly[] {
    const to = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000).toISOString()
    const scope = {
      organizationId: options.organizationId,
      projectId: options.projectId,
      environmentId: options.environmentId,
    }
    const wanted = options.signals ?? DETECTABLE_SIGNALS.map((signal) => signal.key)
    const found: SpendAnomaly[] = []
    // Resolved once, not once per signal: it is the same query every time, and
    // the route set does not depend on which signal is being evaluated.
    let routes: string[] | undefined

    for (const signal of wanted) {
      // Each signal gets the lookback its own seasonality needs. A shared
      // window would starve the weekly ones of same-phase history.
      const hours = overrides.seasonLength
        ? Math.max(24 * 14, overrides.seasonLength * ((overrides.minHistory ?? 3) + 1))
        : lookbackHoursForSignal(signal)
      const window = { from: new Date(new Date(to).getTime() - hours * 3_600_000).toISOString(), to }
      found.push(...this.detectSignal(signal, scope, window, overrides))
      if (!options.routes) continue
      // Usage rollups are priced per meter, not per path. Narrowing one to a
      // route yields the project-wide series recorded under that route's name,
      // which is a confidently mislabelled anomaly rather than a useful one.
      if (!signalDefinition(signal)?.routeAware) continue
      routes ??= this.signals.busiestRoutes(scope, window)
      // Route-scoped detection uses the same machinery; only the scope narrows.
      // A silence on the route is checked before any work is done.
      for (const route of routes) {
        if (this.anomalyConfigs.isSilenced(scope, { signal, route })) continue
        found.push(...this.detectSignal(signal, { ...scope, route }, window, overrides, route))
      }
    }
    this.signals.resetCache()
    return found
  }

  /** Detect on one signal in one scope. Returns at most one anomaly per call. */
  private detectSignal(
    signal: string,
    scope: { organizationId: string; projectId?: string; environmentId?: string; route?: string },
    window: { from: string; to: string },
    overrides: AnomalyOptions,
    route?: string,
  ): SpendAnomaly[] {
    const tuning = this.anomalyConfigs.optionsFor(scope, signal)
    if (!tuning.enabled) return []
    if (!route && this.anomalyConfigs.isSilenced(scope, { signal })) return []

    const series = this.signals.series(signal, scope, window)
    if (series.points.length === 0) return []
    const anomaly = detectLatestAnomaly(series.points, {
      ...optionsForSignal(signal),
      ...tuning.options,
      ...overrides,
    })
    if (!anomaly) return []
    const recorded = this.store.recordAnomaly({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      // The route rides in the signal so one route's spike cannot dedupe
      // against another's in the same hour bucket.
      signal: route ? `${signal}@${route}` : signal,
      direction: anomaly.direction,
      observed: anomaly.observed,
      expected: anomaly.expected,
      score: anomaly.score,
      deltaPercent: Number.isFinite(anomaly.deltaPercent) ? anomaly.deltaPercent : 0,
      severity: tuning.config?.severity ?? anomaly.severity,
      bucketStart: anomaly.bucketStart,
      evidence: {
        historySize: anomaly.historySize,
        deviation: anomaly.deviation,
        unit: series.unit,
        populatedBuckets: series.populated,
        // Buckets dropped for too little traffic to be meaningful. Surfaced so
        // "why did this not fire" has an answer.
        suppressedBuckets: series.suppressed,
        route: route ?? null,
        lookbackFrom: window.from,
        lookbackTo: window.to,
      },
    })
    return recorded ? [recorded] : []
  }

  /**
   * The payload behind the usage API.
   *
   * Shaped for a caller that has to decide something - an agent asking "can I
   * afford this deploy?" needs the remaining headroom and the projection, not
   * a pile of rollup rows.
   */
  usageReport(options: {
    organizationId: string
    projectId?: string
    environmentId?: string
    period?: Budget['period']
    timezone?: string
    now?: Date
  }): Record<string, unknown> {
    const now = options.now ?? new Date()
    const window = budgetWindow(options.period ?? 'monthly', options.timezone ?? 'UTC', now)
    const summary = this.store.summarizeUsage({
      organizationId: options.organizationId,
      projectId: options.projectId,
      environmentId: options.environmentId,
      from: window.start,
      to: window.end,
    })
    const budgets = this.store
      .budgetsForScope(options.organizationId, options.projectId, options.environmentId)
      .map((budget) => {
        const status = this.status(budget, now)
        const limit = governingLimitCents(budget)
        return {
          id: budget.id,
          name: budget.name,
          period: budget.period,
          limitCents: limit,
          softLimitCents: budget.softLimitCents,
          hardLimitCents: budget.hardLimitCents,
          spentCents: status.decision.projection.actualCents,
          remainingCents: limit == null ? null : Math.max(0, limit - status.decision.projection.actualCents),
          usedPercent: status.decision.usedPercent,
          projectedCents: status.decision.projection.projectedCents,
          projectedPercent: status.decision.projectedPercent,
          projectionConfidence: status.decision.projection.confidence,
          level: status.decision.level,
          timeToCap: status.timeToCap,
          activeActions: status.activeActions,
          dryRun: budget.dryRun,
        }
      })
    const active = this.store.listEnforcements({ organizationId: options.organizationId, activeOnly: true })
    return {
      organizationId: options.organizationId,
      projectId: options.projectId ?? null,
      environmentId: options.environmentId ?? null,
      window: { start: window.start, end: window.end, label: window.label },
      currency: this.store.priceBook.currency,
      totalCents: summary.totalCents,
      byMeter: summary.byMeter,
      series: summary.series,
      budgets,
      enforcement: {
        strongestAction: strongestActiveAction(active) ?? null,
        active: active.map((record) => ({
          id: record.id,
          budgetId: record.budgetId,
          action: record.action,
          state: record.state,
          reason: record.reason,
          simulated: record.simulated,
          appliedAt: record.appliedAt,
        })),
      },
      generatedAt: now.toISOString(),
      /** The hour the numbers are current as of; usage lands on hour boundaries. */
      currentBucket: hourBucket(now),
    }
  }
}

/** Insert zero-cost buckets for hours with no usage, so seasonal phases line up. */
export function zeroFill(
  points: ReadonlyArray<{ bucketStart: string; value: number }>,
  from: string,
  to: string,
  maxBuckets: number = 24 * 60,
): Array<{ bucketStart: string; value: number }> {
  const byBucket = new Map(points.map((point) => [point.bucketStart, point.value]))
  const start = Math.floor(new Date(from).getTime() / 3_600_000) * 3_600_000
  const end = new Date(to).getTime()
  const filled: Array<{ bucketStart: string; value: number }> = []
  for (let ms = start; ms < end && filled.length < maxBuckets; ms += 3_600_000) {
    const bucket = new Date(ms).toISOString()
    filled.push({ bucketStart: bucket, value: byBucket.get(bucket) ?? 0 })
  }
  return filled
}
