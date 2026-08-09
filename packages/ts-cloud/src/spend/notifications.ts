/**
 * Sending spend notifications.
 *
 * These reuse the notification infrastructure that already exists for alerts -
 * channels, routes, quiet hours, escalation, per-route rate limits, and the
 * retrying delivery worker. Building a second notification system for billing
 * would mean operators configure Slack twice, and the two would drift.
 *
 * What is *not* reused is the `Alert` record. Alerts require a project
 * (`alerts.project_id` is NOT NULL), and an organization-wide budget has no
 * project - so forcing spend through an alert row would silently exclude the
 * broadest and most important caps. `notification_deliveries.alert_id` is
 * nullable precisely for this: a delivery can carry its own payload without
 * belonging to an alert.
 */
import type { JsonValue } from '../control-plane'
import type { AlertSeverity, AlertStore, NotificationChannel, NotificationDelivery, NotificationRoute } from '../alerts'
import type { Budget, EnforcementAction, SpendAnomaly, SpendDecision } from './model'
import { isQuietHours } from '../alerts'
import { formatTimeToExhaustion } from './projection'

export type SpendEventType = 'spend.threshold' | 'spend.enforced' | 'spend.released' | 'spend.anomaly'

/**
 * Channel kinds worth waking someone for.
 *
 * A threshold crossing goes everywhere the routes point. Reaching the limit -
 * where enforcement starts - is the one that should also reach a phone, which
 * is why `sms` exists as a channel kind at all.
 */
export const URGENT_SPEND_EVENTS: readonly SpendEventType[] = ['spend.enforced']

function severityFor(decision: SpendDecision): AlertSeverity {
  if (decision.level === 'hard_capped') return 'critical'
  if (decision.level === 'soft_capped') return 'warning'
  return 'info'
}

/** Money as an operator reads it, not as the database stores it. */
export function formatCents(cents: number, currency: string = 'USD'): string {
  const amount = cents / 100
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * A one-line summary an operator can act on from a phone.
 *
 * Deliberately leads with the money and the budget name rather than the
 * percentage: "83% of Production" means nothing without knowing the limit.
 */
export function spendNotificationText(budget: Budget, decision: SpendDecision, event: SpendEventType): string {
  const spent = formatCents(decision.projection.actualCents, budget.currency)
  const limit = budget.hardLimitCents ?? budget.softLimitCents
  const of = limit == null ? '' : ` of ${formatCents(limit, budget.currency)}`
  const simulated = decision.simulated ? ' [dry run]' : ''
  if (event === 'spend.released') return `[RESOLVED] ${budget.name}: spend fell back to ${spent}${of}.${simulated}`
  if (event === 'spend.enforced') {
    const actions = decision.actions.filter((action) => action !== 'notify').join(', ')
    return `[CAP] ${budget.name}: ${spent}${of} (${decision.usedPercent.toFixed(0)}%). Enforcing ${actions || 'notifications only'}.${simulated}`
  }
  const eta = formatTimeToExhaustion(decision.projection.timeToExhaustionMs)
  const forecast = eta
    ? ` Projected to reach the limit in ${eta}.`
    : ` Projected ${formatCents(decision.projection.projectedCents, budget.currency)} by period end.`
  return `[SPEND] ${budget.name}: ${spent}${of} (${decision.usedPercent.toFixed(0)}%).${forecast}${simulated}`
}

function decisionPayload(budget: Budget, decision: SpendDecision, event: SpendEventType): Record<string, JsonValue> {
  return {
    schemaVersion: 1,
    event,
    notificationText: spendNotificationText(budget, decision, event),
    spend: {
      budgetId: budget.id,
      budgetName: budget.name,
      organizationId: budget.organizationId,
      projectId: budget.projectId ?? null,
      environmentId: budget.environmentId ?? null,
      period: budget.period,
      currency: budget.currency,
      level: decision.level,
      simulated: decision.simulated,
      usedPercent: Math.round(decision.usedPercent * 10) / 10,
      projectedPercent: Math.round(decision.projectedPercent * 10) / 10,
      actualCents: Math.round(decision.projection.actualCents),
      projectedCents: Math.round(decision.projection.projectedCents),
      projectionConfidence: decision.projection.confidence,
      softLimitCents: budget.softLimitCents ?? null,
      hardLimitCents: budget.hardLimitCents ?? null,
      timeToCap: formatTimeToExhaustion(decision.projection.timeToExhaustionMs),
      actions: decision.actions,
      window: { start: decision.window.start, end: decision.window.end, label: decision.window.label },
      reason: decision.reason,
    },
  }
}

function anomalyPayload(anomaly: SpendAnomaly, currency: string): Record<string, JsonValue> {
  const delta = Number.isFinite(anomaly.deltaPercent) ? `${anomaly.deltaPercent > 0 ? '+' : ''}${anomaly.deltaPercent.toFixed(0)}%` : 'new'
  return {
    schemaVersion: 1,
    event: 'spend.anomaly',
    notificationText: `[ANOMALY] Hourly spend ${delta} vs the usual ${formatCents(anomaly.expected, currency)} for this hour (observed ${formatCents(anomaly.observed, currency)}).`,
    spend: {
      anomalyId: anomaly.id,
      organizationId: anomaly.organizationId,
      projectId: anomaly.projectId ?? null,
      environmentId: anomaly.environmentId ?? null,
      signal: anomaly.signal,
      direction: anomaly.direction,
      severity: anomaly.severity,
      observedCents: Math.round(anomaly.observed),
      expectedCents: Math.round(anomaly.expected),
      score: Math.round(anomaly.score * 10) / 10,
      bucketStart: anomaly.bucketStart,
    },
  }
}

/** Does a route want this event, for this scope, at this severity? */
function routeMatches(
  route: NotificationRoute,
  scope: { projectId?: string; environmentId?: string },
  severity: AlertSeverity,
  event: SpendEventType,
): boolean {
  const matcher = route.matcher
  if (matcher.projectIds?.length && (!scope.projectId || !matcher.projectIds.includes(scope.projectId))) return false
  if (matcher.environmentIds?.length && (!scope.environmentId || !matcher.environmentIds.includes(scope.environmentId)))
    return false
  if (matcher.severities?.length && !matcher.severities.includes(severity)) return false
  if (matcher.eventTypes?.length && !matcher.eventTypes.includes(event)) return false
  return true
}

export interface SpendNotificationResult {
  deliveries: NotificationDelivery[]
  /** Routes that matched but were inside quiet hours. */
  suppressed: string[]
}

/**
 * Routes spend events to notification channels.
 *
 * Two rules borrowed from the alert router, for the same reasons:
 *
 *   - **Quiet hours never suppress a release.** Waking someone to say a cap
 *     lifted is unnecessary; leaving them to think a cap is still on is worse.
 *   - **Per-route rate limits apply.** A budget re-evaluated every minute must
 *     not become a per-minute page, and the idempotency key does most of that
 *     work already by collapsing repeats within a window.
 */
export class SpendNotificationRouter {
  constructor(
    private readonly store: AlertStore,
    private readonly options: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private channelsFor(
    organizationId: string,
    scope: { projectId?: string; environmentId?: string },
    severity: AlertSeverity,
    event: SpendEventType,
  ): Array<{ route: NotificationRoute; channels: NotificationChannel[]; quiet: boolean }> {
    const matched: Array<{ route: NotificationRoute; channels: NotificationChannel[]; quiet: boolean }> = []
    for (const route of this.store.listRoutes(organizationId)) {
      if (!route.enabled || !routeMatches(route, scope, severity, event)) continue
      const channels = route.channelIds
        .map((id) => this.store.getChannel(id))
        .filter((channel): channel is NotificationChannel => channel?.status === 'active')
      matched.push({ route, channels, quiet: isQuietHours(route, this.now()) })
    }
    return matched
  }

  private dispatch(
    organizationId: string,
    scope: { projectId?: string; environmentId?: string },
    severity: AlertSeverity,
    event: SpendEventType,
    payload: Record<string, JsonValue>,
    idempotencySuffix: string,
  ): SpendNotificationResult {
    const deliveries: NotificationDelivery[] = []
    const suppressed: string[] = []
    for (const match of this.channelsFor(organizationId, scope, severity, event)) {
      if (match.quiet && event !== 'spend.released') {
        suppressed.push(match.route.id)
        continue
      }
      const used = this.store.countRouteDeliveries(
        match.route.id,
        new Date(this.now().getTime() - 60_000).toISOString(),
      )
      let remaining = Math.max(0, match.route.rateLimitPerMinute - used)
      for (const channel of match.channels) {
        if (remaining <= 0) break
        deliveries.push(
          this.store.createDelivery({
            channelId: channel.id,
            routeId: match.route.id,
            eventType: event,
            idempotencyKey: `spend:${event}:${idempotencySuffix}:${channel.id}`,
            payload,
            nextAttemptAt:
              match.route.groupWaitSeconds === 0
                ? undefined
                : new Date(this.now().getTime() + match.route.groupWaitSeconds * 1000).toISOString(),
          }),
        )
        remaining--
      }
    }
    return { deliveries, suppressed }
  }

  /**
   * Notify about a budget decision.
   *
   * The idempotency key includes the window and the crossed threshold, so the
   * same breach re-evaluated every minute produces one delivery per threshold
   * per window - not one per cycle.
   */
  notifyDecision(budget: Budget, decision: SpendDecision): SpendNotificationResult {
    if (decision.breaches.length === 0) return { deliveries: [], suppressed: [] }
    const enforcing = decision.actions.some((action) => action !== 'notify')
    const event: SpendEventType = enforcing ? 'spend.enforced' : 'spend.threshold'
    const highest = decision.breaches[decision.breaches.length - 1].atPercent
    return this.dispatch(
      budget.organizationId,
      { projectId: budget.projectId, environmentId: budget.environmentId },
      severityFor(decision),
      event,
      decisionPayload(budget, decision, event),
      `${budget.id}:${decision.window.start}:${highest}`,
    )
  }

  /** Notify that enforcement was lifted. */
  notifyRelease(budget: Budget, decision: SpendDecision, released: readonly EnforcementAction[]): SpendNotificationResult {
    if (released.length === 0) return { deliveries: [], suppressed: [] }
    return this.dispatch(
      budget.organizationId,
      { projectId: budget.projectId, environmentId: budget.environmentId },
      'info',
      'spend.released',
      {
        ...decisionPayload(budget, decision, 'spend.released'),
        released: [...released] as unknown as JsonValue,
      },
      `${budget.id}:${decision.window.start}:${[...released].sort().join('+')}`,
    )
  }

  /** Notify about a detected anomaly. One delivery per anomaly, ever. */
  notifyAnomaly(anomaly: SpendAnomaly, currency: string = 'USD'): SpendNotificationResult {
    return this.dispatch(
      anomaly.organizationId,
      { projectId: anomaly.projectId, environmentId: anomaly.environmentId },
      anomaly.severity,
      'spend.anomaly',
      anomalyPayload(anomaly, currency),
      anomaly.id,
    )
  }
}
