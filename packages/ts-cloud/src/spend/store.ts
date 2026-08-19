/**
 * Persistence for budgets, usage, enforcement, and anomalies.
 *
 * Usage is stored as hourly rollups rather than raw records. A busy project
 * emits millions of telemetry rows a day and no cap needs that resolution -
 * an hour is fine for a monthly budget and still tight enough that a runaway
 * loop is caught within one evaluation cycle. Rollups also make the window
 * query a single indexed range scan instead of an aggregate over the firehose.
 *
 * Ingest is idempotent: every applied delta leaves a receipt keyed by the
 * deterministic id the meter computed, so replaying a telemetry batch (a
 * retried collector POST, a resumed backfill) adds nothing the second time.
 */
import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { PriceBook } from './pricing'
import type {
  Budget,
  BudgetPeriod,
  BudgetThreshold,
  EnforcementAction,
  EnforcementRecord,
  EnforcementState,
  MeterKey,
  SpendAnomaly,
  SpendDecision,
  UsageDelta,
  UsageRollup,
} from './model'
import { createHash } from 'node:crypto'
import { sanitizeControlPlaneValue } from '../control-plane'
import { DEFAULT_PRICE_BOOK, priceUsage } from './pricing'
import { budgetWindow, hourBucket, isValidTimeZone } from './window'

type Row = Record<string, unknown>

const json = (value: unknown): any => {
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const bool = (value: unknown): boolean => Number(value) === 1
const nullable = (value: unknown): number | undefined => (value == null ? undefined : Number(value))

function budgetRow(row: Row): Budget {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: optional(row.project_id),
    environmentId: optional(row.environment_id),
    name: String(row.name),
    period: String(row.period) as BudgetPeriod,
    timezone: String(row.timezone),
    currency: String(row.currency),
    softLimitCents: nullable(row.soft_limit_cents),
    hardLimitCents: nullable(row.hard_limit_cents),
    thresholds: json(row.thresholds),
    meters: json(row.meters),
    graceSeconds: Number(row.grace_seconds),
    hysteresisPercent: Number(row.hysteresis_percent),
    dryRun: bool(row.dry_run),
    enabled: bool(row.enabled),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function enforcementRow(row: Row): EnforcementRecord {
  return {
    id: String(row.id),
    budgetId: String(row.budget_id),
    organizationId: String(row.organization_id),
    projectId: optional(row.project_id),
    environmentId: optional(row.environment_id),
    action: String(row.action) as EnforcementAction,
    state: String(row.state) as EnforcementState,
    reason: String(row.reason),
    restore: json(row.restore),
    triggeredAtPercent: Number(row.triggered_at_percent),
    simulated: bool(row.simulated),
    appliedAt: optional(row.applied_at),
    releasedAt: optional(row.released_at),
    error: optional(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function anomalyRow(row: Row): SpendAnomaly {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: optional(row.project_id),
    environmentId: optional(row.environment_id),
    signal: String(row.signal),
    direction: String(row.direction) as SpendAnomaly['direction'],
    observed: Number(row.observed),
    expected: Number(row.expected),
    score: Number(row.score),
    deltaPercent: Number(row.delta_percent),
    severity: String(row.severity) as SpendAnomaly['severity'],
    bucketStart: String(row.bucket_start),
    evidence: json(row.evidence),
    acknowledgedAt: optional(row.acknowledged_at),
    createdAt: String(row.created_at),
  }
}

function rollupRow(row: Row): UsageRollup {
  return {
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    environmentId: String(row.environment_id),
    resourceId: String(row.resource_id),
    provider: String(row.provider),
    region: String(row.region),
    meter: String(row.meter),
    bucketStart: String(row.bucket_start),
    quantity: Number(row.quantity),
    costCents: Number(row.cost_cents),
    sampleCount: Number(row.sample_count),
    updatedAt: String(row.updated_at),
  }
}

/** Collapse a nullable scope into a non-empty string for uniqueness purposes. */
export function scopeKey(organizationId: string, projectId?: string, environmentId?: string): string {
  return [organizationId, projectId ?? '', environmentId ?? ''].join('/')
}

export interface CreateBudgetInput {
  organizationId: string
  projectId?: string
  environmentId?: string
  name: string
  period: BudgetPeriod
  timezone?: string
  currency?: string
  softLimitCents?: number
  hardLimitCents?: number
  thresholds?: BudgetThreshold[]
  meters?: MeterKey[]
  graceSeconds?: number
  hysteresisPercent?: number
  dryRun?: boolean
  enabled?: boolean
}

export interface UsageQuery {
  organizationId: string
  projectId?: string
  environmentId?: string
  resourceId?: string
  meters?: MeterKey[]
  providers?: string[]
  from: string
  to: string
}

export interface UsageTotal {
  meter: MeterKey
  provider: string
  quantity: number
  costCents: number
  sampleCount: number
}

export interface UsageSummary {
  from: string
  to: string
  totalCents: number
  byMeter: UsageTotal[]
  /** Hourly cost series across the window, ascending. Drives projection and anomalies. */
  series: Array<{ bucketStart: string; costCents: number; quantity: number }>
}

export interface IngestResult {
  applied: number
  duplicates: number
  costCents: number
  unpricedMeters: string[]
}

/**
 * The default ladder, used when a budget declares no thresholds of its own.
 *
 * The shape is deliberate: warn early and twice, act only at the limit, and
 * make the projection rung fire before the actual one. A project that is on
 * track to blow its cap in three days is far cheaper to fix than one that
 * already has.
 */
export const DEFAULT_THRESHOLDS: readonly BudgetThreshold[] = [
  { atPercent: 50, actions: ['notify'] },
  { atPercent: 80, actions: ['notify'] },
  { atPercent: 100, actions: ['notify'], onProjection: true },
  { atPercent: 100, actions: ['notify', 'block_builds', 'block_deployments'] },
  { atPercent: 115, actions: ['notify', 'block_builds', 'block_deployments', 'throttle_requests'] },
]

export class SpendStore {
  constructor(
    readonly controlPlane: ControlPlaneStore,
    private readonly options: { now?: () => Date; priceBook?: PriceBook } = {},
  ) {}

  now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  get priceBook(): PriceBook {
    return this.options.priceBook ?? DEFAULT_PRICE_BOOK
  }

  private query(sql: string, bindings: SQLQueryBindings[] = []): Row[] {
    return this.controlPlane.database.query(sql).all(...bindings) as Row[]
  }

  // ---------------------------------------------------------------- budgets

  createBudget(input: CreateBudgetInput): Budget {
    const name = input.name.trim()
    if (!name) throw new Error('Budgets require a name.')
    if (input.softLimitCents == null && input.hardLimitCents == null)
      throw new Error('A budget needs a soft limit, a hard limit, or both.')
    if (input.softLimitCents != null && input.hardLimitCents != null && input.softLimitCents > input.hardLimitCents)
      throw new Error('The soft limit must not exceed the hard limit.')
    const timezone = input.timezone ?? 'UTC'
    if (!isValidTimeZone(timezone)) throw new Error(`Unknown timezone: ${timezone}`)
    const thresholds = (input.thresholds ?? [...DEFAULT_THRESHOLDS]).filter(
      (threshold) => Number.isFinite(threshold.atPercent) && threshold.atPercent >= 0,
    )
    if (input.environmentId && !input.projectId)
      throw new Error('An environment-scoped budget must also name its project.')
    const id = crypto.randomUUID()
    const now = this.now()
    this.controlPlane.database.run(
      'INSERT INTO spend_budgets (id,organization_id,project_id,environment_id,name,period,timezone,currency,soft_limit_cents,hard_limit_cents,thresholds,meters,grace_seconds,hysteresis_percent,dry_run,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
      [
        id,
        input.organizationId,
        input.projectId ?? null,
        input.environmentId ?? null,
        name,
        input.period,
        timezone,
        input.currency ?? 'USD',
        input.softLimitCents ?? null,
        input.hardLimitCents ?? null,
        JSON.stringify(thresholds),
        JSON.stringify(input.meters ?? []),
        Math.max(0, Math.floor(input.graceSeconds ?? 0)),
        Math.max(0, input.hysteresisPercent ?? 5),
        input.dryRun ? 1 : 0,
        input.enabled === false ? 0 : 1,
        now,
        now,
      ],
    )
    return this.getBudget(id)!
  }

  getBudget(id: string): Budget | undefined {
    const row = this.query('SELECT * FROM spend_budgets WHERE id = ?', [id])[0]
    return row ? budgetRow(row) : undefined
  }

  listBudgets(filter: { organizationId: string; projectId?: string; enabledOnly?: boolean } ): Budget[] {
    const clauses = ['organization_id = ?']
    const bindings: SQLQueryBindings[] = [filter.organizationId]
    if (filter.projectId) {
      // An org-wide budget governs every project in it, so it belongs in a
      // project's list too - otherwise a project looks uncapped when it is not.
      clauses.push('(project_id IS NULL OR project_id = ?)')
      bindings.push(filter.projectId)
    }
    if (filter.enabledOnly) clauses.push('enabled = 1')
    return this.query(`SELECT * FROM spend_budgets WHERE ${clauses.join(' AND ')} ORDER BY created_at`, bindings).map(budgetRow)
  }

  /**
   * Every budget that governs a scope, most specific last.
   *
   * Order matters to callers that apply the strictest cap: an environment
   * budget should be able to tighten, never loosen, the project's.
   */
  budgetsForScope(organizationId: string, projectId?: string, environmentId?: string): Budget[] {
    return this.listBudgets({ organizationId, enabledOnly: true })
      .filter((budget) => {
        if (budget.projectId && budget.projectId !== projectId) return false
        if (budget.environmentId && budget.environmentId !== environmentId) return false
        return true
      })
      .sort((a, b) => Number(!!a.projectId) - Number(!!b.projectId) || Number(!!a.environmentId) - Number(!!b.environmentId))
  }

  updateBudget(id: string, patch: Partial<CreateBudgetInput>, expectedVersion?: number): Budget {
    const current = this.getBudget(id)
    if (!current) throw new Error('Budget was not found.')
    if (expectedVersion != null && expectedVersion !== current.version)
      throw new Error(`Budget was modified concurrently (expected version ${expectedVersion}, found ${current.version}).`)
    const next = { ...current, ...patch }
    if (next.softLimitCents == null && next.hardLimitCents == null)
      throw new Error('A budget needs a soft limit, a hard limit, or both.')
    if (next.softLimitCents != null && next.hardLimitCents != null && next.softLimitCents > next.hardLimitCents)
      throw new Error('The soft limit must not exceed the hard limit.')
    if (patch.timezone && !isValidTimeZone(patch.timezone)) throw new Error(`Unknown timezone: ${patch.timezone}`)
    this.controlPlane.database.run(
      'UPDATE spend_budgets SET name=?,period=?,timezone=?,currency=?,soft_limit_cents=?,hard_limit_cents=?,thresholds=?,meters=?,grace_seconds=?,hysteresis_percent=?,dry_run=?,enabled=?,version=version+1,updated_at=? WHERE id=?',
      [
        next.name,
        next.period,
        next.timezone,
        next.currency ?? 'USD',
        next.softLimitCents ?? null,
        next.hardLimitCents ?? null,
        JSON.stringify(next.thresholds ?? []),
        JSON.stringify(next.meters ?? []),
        Math.max(0, Math.floor(next.graceSeconds ?? 0)),
        Math.max(0, next.hysteresisPercent ?? 5),
        next.dryRun ? 1 : 0,
        next.enabled === false ? 0 : 1,
        this.now(),
        id,
      ],
    )
    return this.getBudget(id)!
  }

  deleteBudget(id: string): boolean {
    return this.controlPlane.database.run('DELETE FROM spend_budgets WHERE id = ?', [id]).changes > 0
  }

  // ------------------------------------------------------------------ usage

  /**
   * Fold usage deltas into hourly rollups, pricing each as it lands.
   *
   * Costs are computed against the period total already recorded for the same
   * meter, so a tier boundary or a free allowance is crossed exactly once per
   * window regardless of how the deltas were batched.
   */
  ingestUsage(deltas: ReadonlyArray<UsageDelta & { key?: string }>): IngestResult {
    const result: IngestResult = { applied: 0, duplicates: 0, costCents: 0, unpricedMeters: [] }
    const unpriced = new Set<string>()
    const now = this.now()
    const apply = this.controlPlane.database.transaction((batch: ReadonlyArray<UsageDelta & { key?: string }>) => {
      for (const delta of batch) {
        if (!(delta.quantity > 0) || !Number.isFinite(delta.quantity)) continue
        const key = delta.key ?? this.deltaFallbackKey(delta)
        const receipt = this.controlPlane.database.run(
          'INSERT OR IGNORE INTO spend_usage_receipts (key,organization_id,bucket_start,created_at) VALUES (?,?,?,?)',
          [key, delta.organizationId, hourBucket(delta.timestamp), now],
        )
        if (receipt.changes === 0) {
          result.duplicates++
          continue
        }
        const scope = {
          projectId: delta.projectId ?? '',
          environmentId: delta.environmentId ?? '',
          resourceId: delta.resourceId ?? '',
          provider: delta.provider ?? '',
          region: delta.region ?? '',
        }
        const priorQuantity = this.periodQuantity(delta)
        const priced = priceUsage(
          this.priceBook,
          { meter: delta.meter, quantity: delta.quantity, provider: delta.provider, region: delta.region },
          priorQuantity,
        )
        if (priced.unpriced) unpriced.add(String(delta.meter))
        this.controlPlane.database.run(
          `INSERT INTO spend_usage (organization_id,project_id,environment_id,resource_id,provider,region,meter,bucket_start,quantity,cost_cents,sample_count,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,1,?)
          ON CONFLICT(organization_id,project_id,environment_id,resource_id,provider,region,meter,bucket_start) DO UPDATE SET
            quantity = quantity + excluded.quantity,
            cost_cents = cost_cents + excluded.cost_cents,
            sample_count = sample_count + 1,
            updated_at = excluded.updated_at`,
          [
            delta.organizationId,
            scope.projectId,
            scope.environmentId,
            scope.resourceId,
            scope.provider,
            scope.region,
            delta.meter,
            hourBucket(delta.timestamp),
            delta.quantity,
            priced.costCents,
            now,
          ],
        )
        result.applied++
        result.costCents += priced.costCents
      }
    })
    apply(deltas)
    result.unpricedMeters = [...unpriced]
    return result
  }

  private deltaFallbackKey(delta: UsageDelta): string {
    return createHash('sha256')
      .update(
        [
          delta.organizationId,
          delta.projectId ?? '',
          delta.environmentId ?? '',
          delta.resourceId ?? '',
          delta.provider ?? '',
          delta.region ?? '',
          delta.meter,
          delta.timestamp,
          String(delta.quantity),
        ].join('\0'),
      )
      .digest('hex')
      .slice(0, 32)
  }

  /**
   * Quantity already recorded this billing month for a delta's meter.
   *
   * Allowances and tiers are monthly on every provider we price, so the
   * calendar month is the right accumulator regardless of a budget's own
   * period - a weekly budget still sits inside a monthly free tier.
   */
  private periodQuantity(delta: UsageDelta): number {
    const window = budgetWindow('monthly', 'UTC', new Date(delta.timestamp))
    const row = this.query(
      'SELECT COALESCE(SUM(quantity), 0) AS total FROM spend_usage WHERE organization_id = ? AND meter = ? AND provider = ? AND region = ? AND bucket_start >= ? AND bucket_start < ?',
      [delta.organizationId, delta.meter, delta.provider ?? '', delta.region ?? '', window.start, window.end],
    )[0]
    return Number(row?.total ?? 0)
  }

  private usageClauses(query: UsageQuery): { where: string; bindings: SQLQueryBindings[] } {
    const clauses = ['organization_id = ?', 'bucket_start >= ?', 'bucket_start < ?']
    const bindings: SQLQueryBindings[] = [query.organizationId, query.from, query.to]
    if (query.projectId) {
      clauses.push('project_id = ?')
      bindings.push(query.projectId)
    }
    if (query.environmentId) {
      clauses.push('environment_id = ?')
      bindings.push(query.environmentId)
    }
    if (query.resourceId) {
      clauses.push('resource_id = ?')
      bindings.push(query.resourceId)
    }
    if (query.meters?.length) {
      clauses.push(`meter IN (${query.meters.map(() => '?').join(',')})`)
      bindings.push(...query.meters.map(String))
    }
    if (query.providers?.length) {
      clauses.push(`provider IN (${query.providers.map(() => '?').join(',')})`)
      bindings.push(...query.providers)
    }
    return { where: clauses.join(' AND '), bindings }
  }

  /** Totals per meter plus the hourly cost series, for one window. */
  summarizeUsage(query: UsageQuery): UsageSummary {
    const { where, bindings } = this.usageClauses(query)
    const byMeter = this.query(
      `SELECT meter, provider, SUM(quantity) AS quantity, SUM(cost_cents) AS cost_cents, SUM(sample_count) AS sample_count
      FROM spend_usage WHERE ${where} GROUP BY meter, provider ORDER BY SUM(cost_cents) DESC, meter`,
      bindings,
    ).map((row) => ({
      meter: String(row.meter),
      provider: String(row.provider),
      quantity: Number(row.quantity),
      costCents: Number(row.cost_cents),
      sampleCount: Number(row.sample_count),
    }))
    const series = this.query(
      `SELECT bucket_start, SUM(cost_cents) AS cost_cents, SUM(quantity) AS quantity
      FROM spend_usage WHERE ${where} GROUP BY bucket_start ORDER BY bucket_start`,
      bindings,
    ).map((row) => ({
      bucketStart: String(row.bucket_start),
      costCents: Number(row.cost_cents),
      quantity: Number(row.quantity),
    }))
    return {
      from: query.from,
      to: query.to,
      totalCents: byMeter.reduce((sum, item) => sum + item.costCents, 0),
      byMeter,
      series,
    }
  }

  listRollups(query: UsageQuery, limit: number = 1000): UsageRollup[] {
    const { where, bindings } = this.usageClauses(query)
    return this.query(
      `SELECT * FROM spend_usage WHERE ${where} ORDER BY bucket_start DESC LIMIT ?`,
      [...bindings, Math.max(1, Math.min(10_000, limit))],
    ).map(rollupRow)
  }

  /** Spend in a budget's current window, honouring its meter filter. */
  budgetSpendCents(budget: Budget, now: Date = new Date()): { window: ReturnType<typeof budgetWindow>; summary: UsageSummary } {
    const window = budgetWindow(budget.period, budget.timezone, now)
    const summary = this.summarizeUsage({
      organizationId: budget.organizationId,
      projectId: budget.projectId,
      environmentId: budget.environmentId,
      meters: budget.meters.length > 0 ? budget.meters : undefined,
      from: window.start,
      to: window.end,
    })
    return { window, summary }
  }

  /** Drop rollups and receipts older than `days`. Rollups are cheap; receipts are not. */
  pruneUsage(days: number, now: Date = new Date()): { rollups: number; receipts: number } {
    const cutoff = new Date(now.getTime() - Math.max(1, days) * 86_400_000).toISOString()
    const rollups = this.controlPlane.database.run('DELETE FROM spend_usage WHERE bucket_start < ?', [cutoff]).changes
    // Receipts only need to outlive the chance of a replay, which is far
    // shorter than the reporting retention the rollups serve.
    const receiptCutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const receipts = this.controlPlane.database.run('DELETE FROM spend_usage_receipts WHERE created_at < ?', [receiptCutoff]).changes
    return { rollups, receipts }
  }

  // ------------------------------------------------------------ enforcement

  recordDecision(decision: SpendDecision): void {
    this.controlPlane.database.run(
      'INSERT INTO spend_decisions (id,budget_id,level,window_start,window_end,used_percent,projected_percent,actual_cents,projected_cents,actions,simulated,reason,evaluated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        crypto.randomUUID(),
        decision.budgetId,
        decision.level,
        decision.window.start,
        decision.window.end,
        decision.usedPercent,
        decision.projectedPercent,
        decision.projection.actualCents,
        decision.projection.projectedCents,
        JSON.stringify(decision.actions),
        decision.simulated ? 1 : 0,
        decision.reason,
        decision.evaluatedAt,
      ],
    )
  }

  listDecisions(budgetId: string, limit: number = 50): Array<Record<string, unknown>> {
    return this.query('SELECT * FROM spend_decisions WHERE budget_id = ? ORDER BY evaluated_at DESC LIMIT ?', [
      budgetId,
      Math.max(1, Math.min(500, limit)),
    ]).map((row) => ({
      id: row.id,
      budgetId: row.budget_id,
      level: row.level,
      window: { start: row.window_start, end: row.window_end },
      usedPercent: Number(row.used_percent),
      projectedPercent: Number(row.projected_percent),
      actualCents: Number(row.actual_cents),
      projectedCents: Number(row.projected_cents),
      actions: json(row.actions),
      simulated: bool(row.simulated),
      reason: row.reason,
      evaluatedAt: row.evaluated_at,
    }))
  }

  /**
   * Open an enforcement, or return the one already live for this budget+action.
   *
   * Idempotent by construction: the partial unique index makes a second insert
   * for a live action fail, and re-evaluating a budget every minute must not
   * pile up duplicate enforcements.
   */
  openEnforcement(input: {
    budget: Budget
    action: EnforcementAction
    reason: string
    triggeredAtPercent: number
    restore?: Record<string, JsonValue>
    simulated?: boolean
  }): EnforcementRecord {
    const existing = this.activeEnforcement(input.budget.id, input.action)
    if (existing) return existing
    const id = crypto.randomUUID()
    const now = this.now()
    this.controlPlane.database.run(
      'INSERT INTO spend_enforcements (id,budget_id,organization_id,project_id,environment_id,action,state,reason,restore,triggered_at_percent,simulated,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.budget.id,
        input.budget.organizationId,
        input.budget.projectId ?? null,
        input.budget.environmentId ?? null,
        input.action,
        'pending',
        input.reason,
        JSON.stringify(sanitizeControlPlaneValue(input.restore ?? {})),
        input.triggeredAtPercent,
        input.simulated ? 1 : 0,
        now,
        now,
      ],
    )
    return this.getEnforcement(id)!
  }

  getEnforcement(id: string): EnforcementRecord | undefined {
    const row = this.query('SELECT * FROM spend_enforcements WHERE id = ?', [id])[0]
    return row ? enforcementRow(row) : undefined
  }

  activeEnforcement(budgetId: string, action: EnforcementAction): EnforcementRecord | undefined {
    const row = this.query(
      "SELECT * FROM spend_enforcements WHERE budget_id = ? AND action = ? AND state IN ('pending','active','releasing')",
      [budgetId, action],
    )[0]
    return row ? enforcementRow(row) : undefined
  }

  listEnforcements(filter: { organizationId: string; budgetId?: string; activeOnly?: boolean }): EnforcementRecord[] {
    const clauses = ['organization_id = ?']
    const bindings: SQLQueryBindings[] = [filter.organizationId]
    if (filter.budgetId) {
      clauses.push('budget_id = ?')
      bindings.push(filter.budgetId)
    }
    if (filter.activeOnly) clauses.push("state IN ('pending','active','releasing')")
    return this.query(
      `SELECT * FROM spend_enforcements WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
      bindings,
    ).map(enforcementRow)
  }

  transitionEnforcement(
    id: string,
    state: EnforcementState,
    patch: { error?: string; restore?: Record<string, JsonValue> } = {},
  ): EnforcementRecord {
    const current = this.getEnforcement(id)
    if (!current) throw new Error('Enforcement was not found.')
    const now = this.now()
    this.controlPlane.database.run(
      'UPDATE spend_enforcements SET state=?, error=?, restore=?, applied_at=?, released_at=?, updated_at=? WHERE id=?',
      [
        state,
        patch.error ?? null,
        JSON.stringify(sanitizeControlPlaneValue(patch.restore ?? current.restore)),
        state === 'active' ? (current.appliedAt ?? now) : (current.appliedAt ?? null),
        state === 'released' ? now : (current.releasedAt ?? null),
        now,
        id,
      ],
    )
    return this.getEnforcement(id)!
  }

  // -------------------------------------------------------------- anomalies

  /** Record an anomaly, ignoring a repeat for the same signal and bucket. */
  recordAnomaly(input: Omit<SpendAnomaly, 'id' | 'createdAt'>): SpendAnomaly | undefined {
    const id = crypto.randomUUID()
    const changes = this.controlPlane.database.run(
      'INSERT OR IGNORE INTO spend_anomalies (id,organization_id,project_id,environment_id,scope_key,signal,direction,observed,expected,score,delta_percent,severity,bucket_start,evidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId ?? null,
        input.environmentId ?? null,
        scopeKey(input.organizationId, input.projectId, input.environmentId),
        input.signal,
        input.direction,
        input.observed,
        input.expected,
        input.score,
        input.deltaPercent,
        input.severity,
        input.bucketStart,
        JSON.stringify(sanitizeControlPlaneValue(input.evidence ?? {})),
        this.now(),
      ],
    ).changes
    return changes > 0 ? this.getAnomaly(id) : undefined
  }

  getAnomaly(id: string): SpendAnomaly | undefined {
    const row = this.query('SELECT * FROM spend_anomalies WHERE id = ?', [id])[0]
    return row ? anomalyRow(row) : undefined
  }

  listAnomalies(filter: {
    organizationId: string
    projectId?: string
    since?: string
    unacknowledgedOnly?: boolean
    limit?: number
  }): SpendAnomaly[] {
    const clauses = ['organization_id = ?']
    const bindings: SQLQueryBindings[] = [filter.organizationId]
    if (filter.projectId) {
      clauses.push('project_id = ?')
      bindings.push(filter.projectId)
    }
    if (filter.since) {
      clauses.push('bucket_start >= ?')
      bindings.push(filter.since)
    }
    if (filter.unacknowledgedOnly) clauses.push('acknowledged_at IS NULL')
    return this.query(
      `SELECT * FROM spend_anomalies WHERE ${clauses.join(' AND ')} ORDER BY bucket_start DESC LIMIT ?`,
      [...bindings, Math.max(1, Math.min(1000, filter.limit ?? 100))],
    ).map(anomalyRow)
  }

  acknowledgeAnomaly(id: string): boolean {
    return (
      this.controlPlane.database.run('UPDATE spend_anomalies SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL', [
        this.now(),
        id,
      ]).changes > 0
    )
  }
}
