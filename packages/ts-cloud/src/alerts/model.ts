import type { JsonValue } from '../control-plane'

export type HealthCheckKind = 'http' | 'tcp' | 'command'
export type HealthStatus = 'healthy' | 'unhealthy' | 'no_data'
export type AlertState = 'pending' | 'firing' | 'resolved' | 'silenced'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type NotificationChannelKind = 'slack' | 'discord' | 'teams' | 'telegram' | 'email' | 'webhook'

export interface HealthCheck {
  id: string; projectId: string; environmentId?: string; resourceId?: string; name: string; kind: HealthCheckKind; target: string
  config: { method?: string, path?: string, port?: number, command?: string[], expectedStatuses?: number[], expectedBody?: string, headers?: Record<string, string> }
  intervalSeconds: number; timeoutSeconds: number; failureThreshold: number; recoveryThreshold: number; regions: string[]; enabled: boolean; version: number; createdAt: string; updatedAt: string
}
export interface HealthResult { id: string; checkId: string; status: HealthStatus; agent: string; region?: string; statusCode?: number; message?: string; timings: { dnsMs?: number, connectMs?: number, tlsMs?: number, ttfbMs?: number, totalMs?: number }; checkedAt: string }
export interface AlertRule {
  id: string; projectId: string; environmentId?: string; resourceId?: string; healthCheckId?: string; name: string; signal: string; operator: 'gt'|'gte'|'lt'|'lte'|'eq'|'unhealthy'; threshold?: number; recoveryThreshold?: number; windowMs: number; consecutive: number; recoveryConsecutive: number; noDataPolicy: 'ignore'|'pending'|'firing'; severity: AlertSeverity; groupBy: string[]; labels: Record<string, JsonValue>; enabled: boolean; version: number; createdAt: string; updatedAt: string
}
export interface Alert {
  id: string; ruleId: string; projectId: string; environmentId?: string; resourceId?: string; dedupKey: string; groupKey: string; state: AlertState; severity: AlertSeverity; title: string; evidence: Record<string, JsonValue>; failureCount: number; recoveryCount: number; occurrenceCount: number; ownerActorId?: string; acknowledgedByActorId?: string; acknowledgedAt?: string; firstSeenAt: string; lastSeenAt: string; firingAt?: string; resolvedAt?: string; silencedUntil?: string; updatedAt: string
}
export interface AlertSample { status?: HealthStatus; value?: number; timestamp: string; group?: Record<string, string>; evidence?: Record<string, unknown> }
export interface NotificationChannel { id: string; organizationId: string; name: string; kind: NotificationChannelKind; config: Record<string, JsonValue>; credentialFingerprint?: string; hasCredential: boolean; status: 'active'|'paused'|'failing'|'disabled'; version: number; lastTestedAt?: string; lastError?: string; createdAt: string; updatedAt: string }
export interface NotificationRoute { id: string; organizationId: string; name: string; priority: number; matcher: { projectIds?: string[], environmentIds?: string[], resourceIds?: string[], severities?: AlertSeverity[], eventTypes?: string[] }; channelIds: string[]; quietHours?: { timezone: string, start: string, end: string, weekdays?: number[] }; groupWaitSeconds: number; reminderSeconds?: number; escalation: Array<{ afterSeconds: number, channelIds: string[] }>; enabled: boolean; version: number; createdAt: string; updatedAt: string }
export interface NotificationDelivery { id: string; alertId?: string; channelId: string; routeId?: string; eventType: string; idempotencyKey: string; state: 'pending'|'delivered'|'retrying'|'failed'|'dead'; attempt: number; maxAttempts: number; nextAttemptAt?: string; responseStatus?: number; error?: string; payload: Record<string, JsonValue>; createdAt: string; updatedAt: string; deliveredAt?: string }
