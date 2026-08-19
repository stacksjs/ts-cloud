import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { Alert, AlertRule, HealthCheck, HealthResult, NotificationChannel, NotificationDelivery, NotificationRoute } from './model'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

type Row = Record<string, unknown>
const json = (value: unknown): any => {
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
const optional = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const bool = (value: unknown): boolean => Number(value) === 1
const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

function health(row: Row): HealthCheck {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    environmentId: optional(row.environment_id),
    resourceId: optional(row.resource_id),
    name: String(row.name),
    kind: String(row.kind) as HealthCheck['kind'],
    target: String(row.target),
    config: json(row.config),
    intervalSeconds: Number(row.interval_seconds),
    timeoutSeconds: Number(row.timeout_seconds),
    failureThreshold: Number(row.failure_threshold),
    recoveryThreshold: Number(row.recovery_threshold),
    regions: json(row.regions),
    enabled: bool(row.enabled),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
function result(row: Row): HealthResult {
  return {
    id: String(row.id),
    checkId: String(row.check_id),
    status: String(row.status) as HealthResult['status'],
    agent: String(row.agent),
    region: optional(row.region),
    statusCode: row.status_code == null ? undefined : Number(row.status_code),
    message: optional(row.message),
    timings: json(row.timings),
    checkedAt: String(row.checked_at),
  }
}
function rule(row: Row): AlertRule {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    environmentId: optional(row.environment_id),
    resourceId: optional(row.resource_id),
    healthCheckId: optional(row.health_check_id),
    name: String(row.name),
    signal: String(row.signal),
    operator: String(row.operator) as AlertRule['operator'],
    threshold: row.threshold == null ? undefined : Number(row.threshold),
    recoveryThreshold: row.recovery_threshold == null ? undefined : Number(row.recovery_threshold),
    windowMs: Number(row.window_ms),
    consecutive: Number(row.consecutive),
    recoveryConsecutive: Number(row.recovery_consecutive),
    noDataPolicy: String(row.no_data_policy) as AlertRule['noDataPolicy'],
    severity: String(row.severity) as AlertRule['severity'],
    groupBy: json(row.group_by),
    labels: json(row.labels),
    enabled: bool(row.enabled),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
function alert(row: Row): Alert {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    projectId: String(row.project_id),
    environmentId: optional(row.environment_id),
    resourceId: optional(row.resource_id),
    dedupKey: String(row.dedup_key),
    groupKey: String(row.group_key),
    state: String(row.state) as Alert['state'],
    severity: String(row.severity) as Alert['severity'],
    title: String(row.title),
    evidence: json(row.evidence),
    failureCount: Number(row.failure_count),
    recoveryCount: Number(row.recovery_count),
    occurrenceCount: Number(row.occurrence_count),
    ownerActorId: optional(row.owner_actor_id),
    acknowledgedByActorId: optional(row.acknowledged_by_actor_id),
    acknowledgedAt: optional(row.acknowledged_at),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    firingAt: optional(row.firing_at),
    resolvedAt: optional(row.resolved_at),
    silencedUntil: optional(row.silenced_until),
    updatedAt: String(row.updated_at),
  }
}
function channel(row: Row): NotificationChannel {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    kind: String(row.kind) as NotificationChannel['kind'],
    config: json(row.config),
    credentialFingerprint: optional(row.credential_fingerprint),
    hasCredential: !!row.credential_ciphertext,
    status: String(row.status) as NotificationChannel['status'],
    version: Number(row.version),
    lastTestedAt: optional(row.last_tested_at),
    lastError: optional(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
function route(row: Row): NotificationRoute {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    priority: Number(row.priority),
    matcher: json(row.matcher),
    channelIds: json(row.channel_ids),
    quietHours: row.quiet_hours ? json(row.quiet_hours) : undefined,
    groupWaitSeconds: Number(row.group_wait_seconds),
    reminderSeconds: row.reminder_seconds == null ? undefined : Number(row.reminder_seconds),
    escalation: json(row.escalation),
    template: optional(row.template),
    rateLimitPerMinute: Number(row.rate_limit_per_minute),
    enabled: bool(row.enabled),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
function delivery(row: Row): NotificationDelivery {
  return {
    id: String(row.id),
    alertId: optional(row.alert_id),
    channelId: String(row.channel_id),
    routeId: optional(row.route_id),
    eventType: String(row.event_type),
    idempotencyKey: String(row.idempotency_key),
    state: String(row.state) as NotificationDelivery['state'],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: optional(row.next_attempt_at),
    responseStatus: row.response_status == null ? undefined : Number(row.response_status),
    error: optional(row.error),
    payload: json(row.payload),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deliveredAt: optional(row.delivered_at),
  }
}

export class AlertStore {
  private readonly key: Buffer
  constructor(
    readonly controlPlane: ControlPlaneStore,
    private readonly options: { now?: () => Date; encryptionKey: string },
  ) {
    this.key = createHash('sha256').update(options.encryptionKey).digest()
  }
  now(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`
  }
  private decrypt(value: string): string {
    const [, iv, tag, data] = value.split('.')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  }

  createHealthCheck(input: Omit<HealthCheck, 'id' | 'version' | 'createdAt' | 'updatedAt'>): HealthCheck {
    if (!input.name.trim()) throw new Error('Health checks require a name.')
    if (!['http', 'tcp', 'command'].includes(input.kind)) throw new Error('Unsupported health check kind.')
    if (
      (input.kind === 'http' && !/^https?:\/\//.test(input.target)) ||
      (input.kind === 'tcp' && !/^[a-zA-Z0-9.-]+$/.test(input.target)) ||
      (input.kind === 'command' && !input.config.command?.length)
    )
      throw new Error('Health check target is invalid.')
    const id = crypto.randomUUID(),
      now = this.now()
    this.controlPlane.database.run(
      'INSERT INTO health_checks (id,project_id,environment_id,resource_id,name,kind,target,config,interval_seconds,timeout_seconds,failure_threshold,recovery_threshold,regions,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.projectId,
        input.environmentId ?? null,
        input.resourceId ?? null,
        input.name.trim().slice(0, 100),
        input.kind,
        input.target,
        JSON.stringify(input.config),
        clamp(input.intervalSeconds, 60, 10, 86400),
        clamp(input.timeoutSeconds, 10, 1, 300),
        clamp(input.failureThreshold, 3, 1, 100),
        clamp(input.recoveryThreshold, 2, 1, 100),
        JSON.stringify(input.regions.slice(0, 20)),
        input.enabled ? 1 : 0,
        1,
        now,
        now,
      ],
    )
    return this.getHealthCheck(id)!
  }
  getHealthCheck(id: string): HealthCheck | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM health_checks WHERE id=?').get(id)
    return row ? health(row) : undefined
  }
  listHealthChecks(projectId: string, environmentId?: string): HealthCheck[] {
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM health_checks WHERE project_id=?${environmentId ? ' AND environment_id=?' : ''} ORDER BY updated_at DESC`,
      )
      .all(projectId, ...(environmentId ? [environmentId] : []))
      .map(health)
  }
  setHealthCheckEnabled(id: string, enabled: boolean): HealthCheck {
    this.controlPlane.database.run('UPDATE health_checks SET enabled=?,version=version+1,updated_at=? WHERE id=?', [
      enabled ? 1 : 0,
      this.now(),
      id,
    ])
    const value = this.getHealthCheck(id)
    if (!value) throw new Error('Health check was not found.')
    return value
  }
  appendHealthResult(input: Omit<HealthResult, 'id'>): HealthResult {
    const id = crypto.randomUUID()
    this.controlPlane.database.run(
      'INSERT INTO health_results (id,check_id,status,agent,region,status_code,message,timings,checked_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.checkId,
        input.status,
        input.agent.slice(0, 100),
        input.region ?? null,
        input.statusCode ?? null,
        input.message?.slice(0, 1000) ?? null,
        JSON.stringify(input.timings),
        input.checkedAt,
      ],
    )
    return result(this.controlPlane.database.query<Row, [string]>('SELECT * FROM health_results WHERE id=?').get(id)!)
  }
  listHealthResults(checkId: string, limit = 100): HealthResult[] {
    return this.controlPlane.database
      .query<Row, [string, number]>('SELECT * FROM health_results WHERE check_id=? ORDER BY checked_at DESC LIMIT ?')
      .all(checkId, Math.min(1000, Math.max(1, limit)))
      .map(result)
  }

  createRule(input: Omit<AlertRule, 'id' | 'version' | 'createdAt' | 'updatedAt'>): AlertRule {
    if (!input.name.trim()) throw new Error('Alert rules require a name.')
    if (input.operator !== 'unhealthy' && input.threshold == null)
      throw new Error('Metric alert rules require a threshold.')
    const id = crypto.randomUUID(),
      now = this.now()
    this.controlPlane.database.run(
      'INSERT INTO alert_rules (id,project_id,environment_id,resource_id,health_check_id,name,signal,operator,threshold,recovery_threshold,window_ms,consecutive,recovery_consecutive,no_data_policy,severity,group_by,labels,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.projectId,
        input.environmentId ?? null,
        input.resourceId ?? null,
        input.healthCheckId ?? null,
        input.name.trim().slice(0, 120),
        input.signal,
        input.operator,
        input.threshold ?? null,
        input.recoveryThreshold ?? null,
        clamp(input.windowMs, 300000, 10000, 2678400000),
        clamp(input.consecutive, 3, 1, 100),
        clamp(input.recoveryConsecutive, 2, 1, 100),
        input.noDataPolicy,
        input.severity,
        JSON.stringify(input.groupBy.slice(0, 20)),
        JSON.stringify(input.labels),
        input.enabled ? 1 : 0,
        1,
        now,
        now,
      ],
    )
    return this.getRule(id)!
  }
  getRule(id: string): AlertRule | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM alert_rules WHERE id=?').get(id)
    return row ? rule(row) : undefined
  }
  listRules(projectId: string, environmentId?: string): AlertRule[] {
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM alert_rules WHERE project_id=?${environmentId ? ' AND environment_id=?' : ''} ORDER BY updated_at DESC`,
      )
      .all(projectId, ...(environmentId ? [environmentId] : []))
      .map(rule)
  }
  setRuleEnabled(id: string, enabled: boolean): AlertRule {
    this.controlPlane.database.run('UPDATE alert_rules SET enabled=?,version=version+1,updated_at=? WHERE id=?', [
      enabled ? 1 : 0,
      this.now(),
      id,
    ])
    const value = this.getRule(id)
    if (!value) throw new Error('Alert rule was not found.')
    return value
  }
  getAlertByDedup(dedupKey: string): Alert | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM alerts WHERE dedup_key=?').get(dedupKey)
    return row ? alert(row) : undefined
  }
  getAlert(id: string): Alert | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM alerts WHERE id=?').get(id)
    return row ? alert(row) : undefined
  }
  listAlerts(projectId: string, input: { environmentId?: string; states?: string[]; limit?: number } = {}): Alert[] {
    const clauses = ['project_id=?']
    const bindings: SQLQueryBindings[] = [projectId]
    if (input.environmentId) {
      clauses.push('environment_id=?')
      bindings.push(input.environmentId)
    }
    if (input.states?.length) {
      clauses.push(`state IN (${input.states.map(() => '?').join(',')})`)
      bindings.push(...input.states)
    }
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM alerts WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...bindings, Math.min(1000, input.limit ?? 200))
      .map(alert)
  }
  saveAlert(value: Alert, eventType: string, actorId?: string): Alert {
    this.controlPlane.database.run(
      `INSERT INTO alerts (id,rule_id,project_id,environment_id,resource_id,dedup_key,group_key,state,severity,title,evidence,failure_count,recovery_count,occurrence_count,owner_actor_id,acknowledged_by_actor_id,acknowledged_at,first_seen_at,last_seen_at,firing_at,resolved_at,silenced_until,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,severity=excluded.severity,title=excluded.title,evidence=excluded.evidence,failure_count=excluded.failure_count,recovery_count=excluded.recovery_count,occurrence_count=excluded.occurrence_count,owner_actor_id=excluded.owner_actor_id,acknowledged_by_actor_id=excluded.acknowledged_by_actor_id,acknowledged_at=excluded.acknowledged_at,last_seen_at=excluded.last_seen_at,firing_at=excluded.firing_at,resolved_at=excluded.resolved_at,silenced_until=excluded.silenced_until,updated_at=excluded.updated_at`,
      [
        value.id,
        value.ruleId,
        value.projectId,
        value.environmentId ?? null,
        value.resourceId ?? null,
        value.dedupKey,
        value.groupKey,
        value.state,
        value.severity,
        value.title,
        JSON.stringify(value.evidence),
        value.failureCount,
        value.recoveryCount,
        value.occurrenceCount,
        value.ownerActorId ?? null,
        value.acknowledgedByActorId ?? null,
        value.acknowledgedAt ?? null,
        value.firstSeenAt,
        value.lastSeenAt,
        value.firingAt ?? null,
        value.resolvedAt ?? null,
        value.silencedUntil ?? null,
        value.updatedAt,
      ],
    )
    this.controlPlane.database.run(
      'INSERT INTO alert_events (id,alert_id,type,actor_id,payload,created_at) VALUES (?,?,?,?,?,?)',
      [
        crypto.randomUUID(),
        value.id,
        eventType,
        actorId ?? null,
        JSON.stringify({ state: value.state, severity: value.severity, evidence: value.evidence }),
        value.updatedAt,
      ],
    )
    return this.getAlert(value.id)!
  }
  acknowledge(id: string, actorId: string): Alert {
    const current = this.getAlert(id)
    if (!current) throw new Error('Alert was not found.')
    const now = this.now()
    return this.saveAlert(
      { ...current, acknowledgedByActorId: actorId, acknowledgedAt: now, updatedAt: now },
      'acknowledged',
      actorId,
    )
  }
  assign(id: string, ownerActorId: string | undefined, actorId?: string): Alert {
    const current = this.getAlert(id)
    if (!current) throw new Error('Alert was not found.')
    const now = this.now()
    return this.saveAlert({ ...current, ownerActorId, updatedAt: now }, 'assigned', actorId)
  }
  silenceAlert(id: string, until: string, actorId?: string): Alert {
    const current = this.getAlert(id)
    if (!current) throw new Error('Alert was not found.')
    const end = new Date(until)
    if (!Number.isFinite(end.getTime()) || end <= new Date()) throw new Error('Silence end must be in the future.')
    const now = this.now()
    return this.saveAlert(
      { ...current, state: 'silenced', silencedUntil: end.toISOString(), updatedAt: now },
      'silenced',
      actorId,
    )
  }
  createSilence(input: {
    projectId: string
    environmentId?: string
    resourceId?: string
    matcher?: Record<string, unknown>
    reason: string
    startsAt: string
    endsAt: string
    timezone: string
    actorId?: string
  }): string {
    const start = new Date(input.startsAt),
      end = new Date(input.endsAt)
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end)
      throw new Error('Silence window is invalid.')
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(start)
    } catch {
      throw new Error('Silence timezone is invalid.')
    }
    const id = crypto.randomUUID()
    this.controlPlane.database.run(
      'INSERT INTO alert_silences (id,project_id,environment_id,resource_id,matcher,reason,starts_at,ends_at,timezone,created_by_actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.projectId,
        input.environmentId ?? null,
        input.resourceId ?? null,
        JSON.stringify(input.matcher ?? {}),
        input.reason.slice(0, 500),
        start.toISOString(),
        end.toISOString(),
        input.timezone,
        input.actorId ?? null,
        this.now(),
      ],
    )
    return id
  }
  isSilenced(rule: AlertRule, group: Record<string, string>, at: string): boolean {
    const rows = this.controlPlane.database
      .query<Row, [string, string, string]>(
        'SELECT * FROM alert_silences WHERE project_id=? AND starts_at<=? AND ends_at>?',
      )
      .all(rule.projectId, at, at)
    return rows.some((row) => {
      if (row.environment_id && row.environment_id !== rule.environmentId) return false
      if (row.resource_id && row.resource_id !== rule.resourceId) return false
      const matcher = json(row.matcher)
      return Object.entries(matcher).every(([key, value]) => group[key] === value)
    })
  }

  createChannel(input: {
    organizationId: string
    name: string
    kind: NotificationChannel['kind']
    config?: Record<string, unknown>
    credential?: string
    actorId?: string
  }): NotificationChannel {
    if (!input.name.trim()) throw new Error('Notification channels require a name.')
    const id = crypto.randomUUID(),
      now = this.now(),
      credential = input.credential?.trim()
    this.controlPlane.database.run(
      'INSERT INTO notification_channels (id,organization_id,name,kind,config,credential_ciphertext,credential_fingerprint,status,version,created_by_actor_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.name.trim().slice(0, 100),
        input.kind,
        JSON.stringify(input.config ?? {}),
        credential ? this.encrypt(credential) : null,
        credential ? fingerprint(credential) : null,
        'active',
        1,
        input.actorId ?? null,
        now,
        now,
      ],
    )
    return this.getChannel(id)!
  }
  getChannel(id: string): NotificationChannel | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM notification_channels WHERE id=?')
      .get(id)
    return row ? channel(row) : undefined
  }
  channelCredential(id: string): string | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT credential_ciphertext FROM notification_channels WHERE id=?')
      .get(id)
    return row?.credential_ciphertext ? this.decrypt(String(row.credential_ciphertext)) : undefined
  }
  listChannels(organizationId: string): NotificationChannel[] {
    return this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM notification_channels WHERE organization_id=? ORDER BY updated_at DESC')
      .all(organizationId)
      .map(channel)
  }
  rotateChannel(id: string, credential: string): NotificationChannel {
    const now = this.now()
    this.controlPlane.database.run(
      "UPDATE notification_channels SET credential_ciphertext=?,credential_fingerprint=?,status='active',last_error=NULL,version=version+1,updated_at=? WHERE id=?",
      [this.encrypt(credential), fingerprint(credential), now, id],
    )
    const value = this.getChannel(id)
    if (!value) throw new Error('Notification channel was not found.')
    return value
  }
  setChannelStatus(id: string, status: NotificationChannel['status'], error?: string): NotificationChannel {
    this.controlPlane.database.run('UPDATE notification_channels SET status=?,last_error=?,updated_at=? WHERE id=?', [
      status,
      error?.slice(0, 1000) ?? null,
      this.now(),
      id,
    ])
    const value = this.getChannel(id)
    if (!value) throw new Error('Notification channel was not found.')
    return value
  }
  markChannelTest(id: string, ok: boolean, error?: string): NotificationChannel {
    const now = this.now()
    this.controlPlane.database.run(
      'UPDATE notification_channels SET status=?,last_tested_at=?,last_error=?,updated_at=? WHERE id=?',
      [ok ? 'active' : 'failing', now, error?.slice(0, 1000) ?? null, now, id],
    )
    return this.getChannel(id)!
  }
  createRoute(input: Omit<NotificationRoute, 'id' | 'version' | 'createdAt' | 'updatedAt'>): NotificationRoute {
    const id = crypto.randomUUID(),
      now = this.now()
    this.controlPlane.database.run(
      'INSERT INTO notification_routes (id,organization_id,name,priority,matcher,channel_ids,quiet_hours,group_wait_seconds,reminder_seconds,escalation,template,rate_limit_per_minute,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.organizationId,
        input.name.trim().slice(0, 100),
        input.priority,
        JSON.stringify(input.matcher),
        JSON.stringify(input.channelIds),
        input.quietHours ? JSON.stringify(input.quietHours) : null,
        clamp(input.groupWaitSeconds, 30, 0, 86400),
        input.reminderSeconds ?? null,
        JSON.stringify(input.escalation),
        input.template?.trim().slice(0, 2000) ?? null,
        clamp(input.rateLimitPerMinute, 60, 1, 10000),
        input.enabled ? 1 : 0,
        1,
        now,
        now,
      ],
    )
    return this.getRoute(id)!
  }
  getRoute(id: string): NotificationRoute | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM notification_routes WHERE id=?').get(id)
    return row ? route(row) : undefined
  }
  listRoutes(organizationId: string): NotificationRoute[] {
    return this.controlPlane.database
      .query<Row, [string]>(
        'SELECT * FROM notification_routes WHERE organization_id=? ORDER BY priority DESC,created_at ASC',
      )
      .all(organizationId)
      .map(route)
  }
  countRouteDeliveries(routeId: string, since: string): number {
    return Number(
      this.controlPlane.database
        .query<{ count: number }, [string, string]>(
          'SELECT COUNT(*) count FROM notification_deliveries WHERE route_id=? AND created_at>=?',
        )
        .get(routeId, since)?.count ?? 0,
    )
  }
  setRouteEnabled(id: string, enabled: boolean): NotificationRoute {
    this.controlPlane.database.run(
      'UPDATE notification_routes SET enabled=?,version=version+1,updated_at=? WHERE id=?',
      [enabled ? 1 : 0, this.now(), id],
    )
    const value = this.getRoute(id)
    if (!value) throw new Error('Notification route was not found.')
    return value
  }
  createDelivery(input: {
    alertId?: string
    channelId: string
    routeId?: string
    eventType: string
    idempotencyKey: string
    payload: Record<string, JsonValue>
    maxAttempts?: number
    nextAttemptAt?: string
  }): NotificationDelivery {
    const existing = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM notification_deliveries WHERE idempotency_key=?')
      .get(input.idempotencyKey)
    if (existing) return delivery(existing)
    const id = crypto.randomUUID(),
      now = this.now()
    this.controlPlane.database.run(
      'INSERT INTO notification_deliveries (id,alert_id,channel_id,route_id,event_type,idempotency_key,state,attempt,max_attempts,next_attempt_at,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.alertId ?? null,
        input.channelId,
        input.routeId ?? null,
        input.eventType,
        input.idempotencyKey,
        'pending',
        0,
        clamp(input.maxAttempts, 3, 1, 10),
        input.nextAttemptAt ?? null,
        JSON.stringify(input.payload),
        now,
        now,
      ],
    )
    return this.getDelivery(id)!
  }
  getDelivery(id: string): NotificationDelivery | undefined {
    const row = this.controlPlane.database
      .query<Row, [string]>('SELECT * FROM notification_deliveries WHERE id=?')
      .get(id)
    return row ? delivery(row) : undefined
  }
  listDeliveries(input: { alertId?: string; states?: string[]; limit?: number } = {}): NotificationDelivery[] {
    const clauses: string[] = []
    const bindings: SQLQueryBindings[] = []
    if (input.alertId) {
      clauses.push('alert_id=?')
      bindings.push(input.alertId)
    }
    if (input.states?.length) {
      clauses.push(`state IN (${input.states.map(() => '?').join(',')})`)
      bindings.push(...input.states)
    }
    return this.controlPlane.database
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM notification_deliveries${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...bindings, Math.min(1000, input.limit ?? 200))
      .map(delivery)
  }
  updateDelivery(
    id: string,
    input: {
      state: NotificationDelivery['state']
      attempt: number
      nextAttemptAt?: string
      responseStatus?: number
      error?: string
      deliveredAt?: string
    },
  ): NotificationDelivery {
    this.controlPlane.database.run(
      'UPDATE notification_deliveries SET state=?,attempt=?,next_attempt_at=?,response_status=?,error=?,delivered_at=?,updated_at=? WHERE id=?',
      [
        input.state,
        input.attempt,
        input.nextAttemptAt ?? null,
        input.responseStatus ?? null,
        input.error?.slice(0, 1000) ?? null,
        input.deliveredAt ?? null,
        this.now(),
        id,
      ],
    )
    return this.getDelivery(id)!
  }
}
