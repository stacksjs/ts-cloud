/**
 * Spend management: the shared vocabulary.
 *
 * A cap is only as good as the meter behind it. Cloud bills arrive late (AWS
 * Cost Explorer lags a day and does not exist at all for Hetzner or a local
 * box), so a budget that waits for the provider's number cannot stop a runaway
 * loop - it can only describe one after the money is gone. Everything here is
 * therefore built on *usage we observe ourselves*, priced locally through a
 * price book, with the provider's invoice used later to true the estimate up.
 *
 * Money is integer cents throughout. Floating-point dollars accumulate rounding
 * error across millions of usage records, and a cap that is off by a cent in
 * the wrong direction is a cap that does not fire.
 */
import type { JsonValue } from '../control-plane'

/** The physical unit a meter counts in. */
export type MeterUnit =
  | 'requests'
  | 'invocations'
  | 'gb'
  | 'gb_hours'
  | 'gb_seconds'
  | 'hours'
  | 'minutes'
  | 'count'

/**
 * Provider-neutral usage meters.
 *
 * These are deliberately *not* provider SKUs. `edge.egress_gb` is a gigabyte
 * leaving the edge whether that edge is CloudFront, a Hetzner box's NIC, or
 * nginx on a laptop; the price book is what turns it into money. Keeping the
 * meter neutral is what lets one budget cover a mixed-provider project.
 */
export const METER_KEYS = [
  'edge.requests',
  'edge.egress_gb',
  'function.invocations',
  'function.gb_seconds',
  'build.minutes',
  'compute.instance_hours',
  'storage.gb_hours',
  'object.egress_gb',
  'object.requests',
  'database.gb_hours',
  'database.io_requests',
  'telemetry.ingest_gb',
  'image.transformations',
] as const

export type MeterKey = (typeof METER_KEYS)[number] | (string & {})

export interface MeterDefinition {
  key: MeterKey
  unit: MeterUnit
  label: string
  /** Human-facing precision when rendering a quantity. */
  precision: number
}

export const METERS: Readonly<Record<string, MeterDefinition>> = {
  'edge.requests': { key: 'edge.requests', unit: 'requests', label: 'Edge requests', precision: 0 },
  'edge.egress_gb': { key: 'edge.egress_gb', unit: 'gb', label: 'Edge egress', precision: 3 },
  'function.invocations': { key: 'function.invocations', unit: 'invocations', label: 'Function invocations', precision: 0 },
  'function.gb_seconds': { key: 'function.gb_seconds', unit: 'gb_seconds', label: 'Function compute', precision: 2 },
  'build.minutes': { key: 'build.minutes', unit: 'minutes', label: 'Build minutes', precision: 2 },
  'compute.instance_hours': { key: 'compute.instance_hours', unit: 'hours', label: 'Instance hours', precision: 2 },
  'storage.gb_hours': { key: 'storage.gb_hours', unit: 'gb_hours', label: 'Block storage', precision: 2 },
  'object.egress_gb': { key: 'object.egress_gb', unit: 'gb', label: 'Object storage egress', precision: 3 },
  'object.requests': { key: 'object.requests', unit: 'requests', label: 'Object storage requests', precision: 0 },
  'database.gb_hours': { key: 'database.gb_hours', unit: 'gb_hours', label: 'Database storage', precision: 2 },
  'database.io_requests': { key: 'database.io_requests', unit: 'requests', label: 'Database I/O', precision: 0 },
  'telemetry.ingest_gb': { key: 'telemetry.ingest_gb', unit: 'gb', label: 'Telemetry ingest', precision: 3 },
  'image.transformations': { key: 'image.transformations', unit: 'count', label: 'Image transformations', precision: 0 },
}

/** Where a usage record came from and what it should be billed against. */
export interface UsageScope {
  organizationId: string
  projectId?: string
  environmentId?: string
  resourceId?: string
  provider?: string
  region?: string
}

/** A single observed increment of usage. Deltas, never totals - see the store. */
export interface UsageDelta extends UsageScope {
  meter: MeterKey
  quantity: number
  /** When the usage happened (not when we noticed it). */
  timestamp: string
  /** Free-form provenance, e.g. `{ source: 'edge-collector', host: 'web-1' }`. */
  attributes?: Record<string, JsonValue>
}

/** An hourly usage rollup as persisted. Quantities are additive; costs are derived. */
export interface UsageRollup extends Required<Pick<UsageScope, 'organizationId'>> {
  projectId: string
  environmentId: string
  resourceId: string
  provider: string
  region: string
  meter: MeterKey
  /** Inclusive start of the hour bucket, ISO-8601. */
  bucketStart: string
  quantity: number
  costCents: number
  sampleCount: number
  updatedAt: string
}

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly'

/**
 * What a cap does when it is reached.
 *
 * Ordered from least to most disruptive. Enforcement never destroys data and
 * every action is reversible; `suspend_project` parks traffic, it does not
 * delete a thing.
 */
export const ENFORCEMENT_ACTIONS = [
  'notify',
  'block_builds',
  'block_deployments',
  'throttle_requests',
  'suspend_functions',
  'serve_static',
  'suspend_project',
] as const

export type EnforcementAction = (typeof ENFORCEMENT_ACTIONS)[number]

/** Disruption ranking, used to order a plan and to pick the strongest active action. */
export const ENFORCEMENT_SEVERITY: Readonly<Record<EnforcementAction, number>> = {
  notify: 0,
  block_builds: 1,
  block_deployments: 2,
  throttle_requests: 3,
  suspend_functions: 4,
  serve_static: 5,
  suspend_project: 6,
}

/**
 * One rung of the ladder: at `atPercent` of the limit, take these actions.
 *
 * Percent is of the *hard* limit when one is set, otherwise of the soft limit,
 * so a single ladder reads consistently however the budget is configured.
 */
export interface BudgetThreshold {
  atPercent: number
  actions: EnforcementAction[]
  /** Fire on the forecast rather than on actual spend. Catches a spike early. */
  onProjection?: boolean
}

export interface Budget {
  id: string
  organizationId: string
  projectId?: string
  environmentId?: string
  name: string
  period: BudgetPeriod
  /** IANA timezone the period boundaries are computed in. */
  timezone: string
  currency: string
  /** Warn-only ceiling. Never enforces on its own; it drives `notify` rungs. */
  softLimitCents?: number
  /** Enforcing ceiling. Reaching it runs the top of the ladder. */
  hardLimitCents?: number
  thresholds: BudgetThreshold[]
  /**
   * Only these meters count toward the budget. Empty means every meter.
   * Lets you cap "egress" without capping the whole project.
   */
  meters: MeterKey[]
  /** Seconds a breach must persist before enforcement runs. Absorbs a blip. */
  graceSeconds: number
  /**
   * Percent below the trigger that spend must fall back to before an action is
   * lifted. Without it, a scope sitting exactly on the line flaps.
   */
  hysteresisPercent: number
  /** Evaluate but never enforce. The way to roll a cap out safely. */
  dryRun: boolean
  enabled: boolean
  version: number
  createdAt: string
  updatedAt: string
}

export type SpendLevel = 'ok' | 'warning' | 'soft_capped' | 'hard_capped'

/** The window a budget is currently being measured over. */
export interface BudgetWindow {
  start: string
  end: string
  elapsedMs: number
  totalMs: number
  label: string
}

/** Forecast for the remainder of the window. */
export interface SpendProjection {
  /** Spend so far this window, cents. */
  actualCents: number
  /** Cents per millisecond, from the observed burn. */
  burnRateCentsPerMs: number
  /** Where the window lands if the current burn holds. */
  projectedCents: number
  /** Fraction of the window elapsed, 0-1. Low values make the forecast noisy. */
  elapsedFraction: number
  /**
   * How much to trust `projectedCents`, 0-1. Grows with elapsed time and with
   * the number of buckets observed; a forecast from 10 minutes of a month is
   * arithmetic, not information.
   */
  confidence: number
  /** ISO timestamp the limit is projected to be hit, if it is hit in-window. */
  exhaustionAt?: string
  /** Milliseconds until `exhaustionAt`. */
  timeToExhaustionMs?: number
}

/** A threshold that has been crossed. */
export interface ThresholdBreach {
  atPercent: number
  actions: EnforcementAction[]
  /** True when the breach is against the forecast rather than actual spend. */
  projected: boolean
  observedPercent: number
}

/** The evaluator's verdict for one budget at one instant. */
export interface SpendDecision {
  budgetId: string
  level: SpendLevel
  window: BudgetWindow
  projection: SpendProjection
  /** Percent of the governing limit actually spent. */
  usedPercent: number
  /** Percent of the governing limit the forecast lands at. */
  projectedPercent: number
  breaches: ThresholdBreach[]
  /** Actions the ladder calls for, deduped and ordered by severity. */
  actions: EnforcementAction[]
  /** Actions currently in force that should now be lifted. */
  releases: EnforcementAction[]
  /** True when `dryRun` suppressed real enforcement. */
  simulated: boolean
  reason: string
  evaluatedAt: string
}

export type EnforcementState = 'pending' | 'active' | 'releasing' | 'released' | 'failed'

/** An enforcement action as applied to a scope, with what it takes to undo it. */
export interface EnforcementRecord {
  id: string
  budgetId: string
  organizationId: string
  projectId?: string
  environmentId?: string
  action: EnforcementAction
  state: EnforcementState
  reason: string
  /** Whatever the applier needs to restore the prior state. Never secrets. */
  restore: Record<string, JsonValue>
  triggeredAtPercent: number
  simulated: boolean
  appliedAt?: string
  releasedAt?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export type AnomalyDirection = 'spike' | 'drop'

/** A point that does not fit its own history. */
export interface SpendAnomaly {
  id: string
  organizationId: string
  projectId?: string
  environmentId?: string
  /** Meter key, or `cost` for the priced aggregate. */
  signal: string
  direction: AnomalyDirection
  observed: number
  /** What the seasonal baseline expected. */
  expected: number
  /** Robust z-score (MAD-based). */
  score: number
  /** Plain-language delta, e.g. `+412%`. */
  deltaPercent: number
  severity: 'info' | 'warning' | 'critical'
  bucketStart: string
  evidence: Record<string, JsonValue>
  acknowledgedAt?: string
  createdAt: string
}
