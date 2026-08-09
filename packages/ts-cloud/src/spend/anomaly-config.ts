/**
 * Configuring anomaly detection.
 *
 * The detector in `anomaly.ts` is deliberately opinionated, and its defaults
 * are right for cost. They are not right for everything: a checkout route that
 * normally sees three requests an hour and a homepage that sees three thousand
 * need different floors, and an endpoint that legitimately 404s on a crawler
 * sweep should not page anyone at all.
 *
 * So detection becomes configurable in two directions:
 *
 *   - **Configs** decide what is watched and how sensitively.
 *   - **Silences** decide what is ignored entirely - not "detected and hidden",
 *     but skipped before detection runs, so a known-noisy pattern costs nothing
 *     and leaves no dashboard clutter.
 *
 * Sensitivity is stored as low/medium/high rather than a raw z-score. Nobody
 * tuning an alert at 2am wants to reason about median absolute deviations, and
 * a number that means nothing to the person setting it gets set wrong.
 */
import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore } from '../control-plane'
import type { AnomalyOptions } from './anomaly'
import type { AlertSeverity } from '../alerts'
import { anomalyOptionsForSignal } from './anomaly'
import { scopeKey } from './store'

export type AnomalySensitivity = 'low' | 'medium' | 'high'

/**
 * Robust z-score thresholds per sensitivity.
 *
 * High is 2.5 rather than something dramatic: with a MAD-based score, 2.5 is
 * already well outside ordinary variation, and going lower turns the detector
 * into a random number generator on any noisy signal.
 */
export const SENSITIVITY_THRESHOLDS: Readonly<Record<AnomalySensitivity, number>> = {
  low: 6,
  medium: 3.5,
  high: 2.5,
}

export interface AnomalyConfig {
  id: string
  organizationId: string
  projectId?: string
  environmentId?: string
  /** `cost`, a meter key, or a telemetry signal like `http.status.5xx`. */
  signal: string
  enabled: boolean
  sensitivity: AnomalySensitivity
  /** Points per season. 24 for a daily shape, 168 for a weekly one. */
  seasonLength: number
  /** Absolute change below which nothing is reported, in the signal's units. */
  minAbsoluteDelta: number
  detectDrops: boolean
  severity: AlertSeverity
  version: number
  createdAt: string
  updatedAt: string
}

export interface AnomalySilence {
  id: string
  organizationId: string
  projectId?: string
  signal?: string
  /** Glob against the route, e.g. `/webhooks/**`. */
  routePattern?: string
  statusCode?: number
  reason: string
  actorId?: string
  /** Null means indefinite. A silence with no end is a decision, so it is recorded. */
  expiresAt?: string
  createdAt: string
}

type Row = Record<string, unknown>
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

function configRow(row: Row): AnomalyConfig {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: optional(row.project_id),
    environmentId: optional(row.environment_id),
    signal: String(row.signal),
    enabled: Number(row.enabled) === 1,
    sensitivity: String(row.sensitivity) as AnomalySensitivity,
    seasonLength: Number(row.season_length),
    minAbsoluteDelta: Number(row.min_absolute_delta),
    detectDrops: Number(row.detect_drops) === 1,
    severity: String(row.severity) as AlertSeverity,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function silenceRow(row: Row): AnomalySilence {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: optional(row.project_id),
    signal: optional(row.signal),
    routePattern: optional(row.route_pattern),
    statusCode: row.status_code == null ? undefined : Number(row.status_code),
    reason: String(row.reason),
    actorId: optional(row.actor_id),
    expiresAt: optional(row.expires_at),
    createdAt: String(row.created_at),
  }
}

/** Glob matcher, same tiny dialect the rate limiter uses. */
export function routeMatches(pattern: string, route: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${escaped}$`).test(route)
}

export interface AnomalyCandidate {
  signal: string
  route?: string
  statusCode?: number
}

export interface CreateAnomalyConfigInput {
  organizationId: string
  projectId?: string
  environmentId?: string
  signal: string
  enabled?: boolean
  sensitivity?: AnomalySensitivity
  seasonLength?: number
  minAbsoluteDelta?: number
  detectDrops?: boolean
  severity?: AlertSeverity
}

export class AnomalyConfigStore {
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    private readonly options: { now?: () => Date } = {},
  ) {}

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private query(sql: string, bindings: SQLQueryBindings[] = []): Row[] {
    return this.controlPlane.database.query(sql).all(...bindings) as Row[]
  }

  /** Create or replace the config for a scope and signal. */
  upsert(input: CreateAnomalyConfigInput): AnomalyConfig {
    const signal = input.signal.trim()
    if (!signal) throw new Error('An anomaly config needs a signal.')
    if (input.seasonLength != null && (!Number.isInteger(input.seasonLength) || input.seasonLength < 1))
      throw new Error('seasonLength must be a positive integer.')
    const key = scopeKey(input.organizationId, input.projectId, input.environmentId)
    const now = this.now()
    const existing = this.query('SELECT * FROM anomaly_configs WHERE scope_key = ? AND signal = ?', [key, signal])[0]
    const defaults = anomalyOptionsForSignal(signal)
    if (existing) {
      this.controlPlane.database.run(
        'UPDATE anomaly_configs SET enabled=?,sensitivity=?,season_length=?,min_absolute_delta=?,detect_drops=?,severity=?,version=version+1,updated_at=? WHERE id=?',
        [
          input.enabled === false ? 0 : 1,
          input.sensitivity ?? String(existing.sensitivity),
          input.seasonLength ?? Number(existing.season_length),
          input.minAbsoluteDelta ?? Number(existing.min_absolute_delta),
          input.detectDrops == null ? Number(existing.detect_drops) : input.detectDrops ? 1 : 0,
          input.severity ?? String(existing.severity),
          now,
          String(existing.id),
        ],
      )
      return this.get(String(existing.id))!
    }
    const id = crypto.randomUUID()
    this.controlPlane.database.run(
      'INSERT INTO anomaly_configs (id,organization_id,project_id,environment_id,scope_key,signal,enabled,sensitivity,season_length,min_absolute_delta,detect_drops,severity,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
      [
        id,
        input.organizationId,
        input.projectId ?? null,
        input.environmentId ?? null,
        key,
        signal,
        input.enabled === false ? 0 : 1,
        input.sensitivity ?? 'medium',
        input.seasonLength ?? defaults.seasonLength ?? 24,
        input.minAbsoluteDelta ?? defaults.minAbsoluteDelta ?? 0,
        input.detectDrops ? 1 : 0,
        input.severity ?? 'warning',
        now,
        now,
      ],
    )
    return this.get(id)!
  }

  get(id: string): AnomalyConfig | undefined {
    const row = this.query('SELECT * FROM anomaly_configs WHERE id = ?', [id])[0]
    return row ? configRow(row) : undefined
  }

  list(filter: { organizationId: string; projectId?: string }): AnomalyConfig[] {
    const clauses = ['organization_id = ?']
    const bindings: SQLQueryBindings[] = [filter.organizationId]
    if (filter.projectId) {
      clauses.push('(project_id IS NULL OR project_id = ?)')
      bindings.push(filter.projectId)
    }
    return this.query(`SELECT * FROM anomaly_configs WHERE ${clauses.join(' AND ')} ORDER BY signal`, bindings).map(
      configRow,
    )
  }

  delete(id: string): boolean {
    return this.controlPlane.database.run('DELETE FROM anomaly_configs WHERE id = ?', [id]).changes > 0
  }

  /**
   * The detector options for a signal, honouring the most specific config.
   *
   * Falls back to the shipped preset when nothing is configured, so detection
   * works out of the box and configuration is a refinement rather than a
   * prerequisite.
   */
  optionsFor(
    scope: { organizationId: string; projectId?: string; environmentId?: string },
    signal: string,
  ): { options: AnomalyOptions; config?: AnomalyConfig; enabled: boolean } {
    const keys = [
      scopeKey(scope.organizationId, scope.projectId, scope.environmentId),
      scopeKey(scope.organizationId, scope.projectId),
      scopeKey(scope.organizationId),
    ]
    for (const key of keys) {
      const row = this.query('SELECT * FROM anomaly_configs WHERE scope_key = ? AND signal = ?', [key, signal])[0]
      if (!row) continue
      const config = configRow(row)
      return {
        config,
        enabled: config.enabled,
        options: {
          ...anomalyOptionsForSignal(signal),
          threshold: SENSITIVITY_THRESHOLDS[config.sensitivity],
          seasonLength: config.seasonLength,
          minAbsoluteDelta: config.minAbsoluteDelta,
          detectDrops: config.detectDrops,
        },
      }
    }
    return { options: anomalyOptionsForSignal(signal), enabled: true }
  }

  // -------------------------------------------------------------- silences

  /**
   * Silence a pattern.
   *
   * An empty matcher is refused. "Silence everything" is what disabling the
   * config is for, and a silence that matches everything is indistinguishable
   * from a broken detector when someone later asks why nothing fires.
   */
  silence(input: {
    organizationId: string
    projectId?: string
    signal?: string
    routePattern?: string
    statusCode?: number
    reason: string
    actorId?: string
    expiresAt?: string
  }): AnomalySilence {
    const reason = input.reason.trim()
    if (!reason) throw new Error('A silence needs a reason: someone will ask why this stopped alerting.')
    if (!input.signal && !input.routePattern && input.statusCode == null)
      throw new Error('A silence needs at least one of signal, routePattern, or statusCode.')
    const id = crypto.randomUUID()
    this.controlPlane.database.run(
      'INSERT INTO anomaly_silences (id,organization_id,project_id,scope_key,signal,route_pattern,status_code,reason,actor_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.projectId ?? null,
        scopeKey(input.organizationId, input.projectId),
        input.signal ?? null,
        input.routePattern ?? null,
        input.statusCode ?? null,
        reason,
        input.actorId ?? null,
        input.expiresAt ?? null,
        this.now(),
      ],
    )
    return this.listSilences({ organizationId: input.organizationId }).find((item) => item.id === id)!
  }

  listSilences(filter: { organizationId: string; projectId?: string; includeExpired?: boolean }): AnomalySilence[] {
    const clauses = ['organization_id = ?']
    const bindings: SQLQueryBindings[] = [filter.organizationId]
    if (filter.projectId) {
      clauses.push('(project_id IS NULL OR project_id = ?)')
      bindings.push(filter.projectId)
    }
    if (!filter.includeExpired) {
      clauses.push('(expires_at IS NULL OR expires_at > ?)')
      bindings.push(this.now())
    }
    return this.query(`SELECT * FROM anomaly_silences WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, bindings).map(
      silenceRow,
    )
  }

  removeSilence(id: string): boolean {
    return this.controlPlane.database.run('DELETE FROM anomaly_silences WHERE id = ?', [id]).changes > 0
  }

  /**
   * Whether a candidate is silenced.
   *
   * Checked *before* detection runs, not after, so a silenced pattern costs no
   * computation and never reaches the dashboard.
   */
  isSilenced(
    scope: { organizationId: string; projectId?: string },
    candidate: AnomalyCandidate,
  ): AnomalySilence | undefined {
    return this.listSilences(scope).find((silence) => {
      if (silence.signal && silence.signal !== candidate.signal) return false
      if (silence.statusCode != null && silence.statusCode !== candidate.statusCode) return false
      if (silence.routePattern) {
        if (!candidate.route) return false
        if (!routeMatches(silence.routePattern, candidate.route)) return false
      }
      return true
    })
  }
}
