import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type {
  EvaluateSecurityGateInput,
  RecordSecurityScanInput,
  ReleaseSecurityArtifact,
  SecurityCheckStatus,
  SecurityDeployDecision,
  SecurityPostureFinding,
  SecurityFindingComment,
  SecurityFindingInput,
  SecurityPolicy,
  SecurityPolicyAction,
  SecurityPolicyRule,
  SecurityPostureSummary,
  SecurityScanRun,
  SecuritySeverity,
  SecurityWaiver,
} from './types'
import { createHash } from 'node:crypto'
import { sanitizeControlPlaneValue } from '../control-plane'

type Row = Record<string, unknown>

const SEVERITY_RANK: Record<SecuritySeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }
const ACTION_RANK: Record<SecurityPolicyAction, number> = { record: 0, warn: 1, block: 2 }
const DEGRADED_CHECKS = new Set<SecurityCheckStatus>(['skipped', 'unavailable', 'unsupported', 'stale'])

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T }
  catch { return fallback }
}

function json(value: unknown): string {
  return JSON.stringify(sanitizeControlPlaneValue(value))
}

function safeError(value?: string): string | undefined {
  if (!value)
    return undefined
  return String(sanitizeControlPlaneValue(value, 2_000))
}

function mapScan(row: Row): SecurityScanRun {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: optionalString(row.project_id),
    environmentId: optionalString(row.environment_id), resourceId: optionalString(row.resource_id), releaseId: optionalString(row.release_id),
    scannerId: String(row.scanner_id), scannerVersion: String(row.scanner_version), status: String(row.status) as SecurityCheckStatus,
    error: optionalString(row.error), metadata: parseJson(row.metadata, {}), findingsCount: Number(row.findings_count),
    startedAt: String(row.started_at), completedAt: String(row.completed_at), durationMs: Number(row.duration_ms),
  }
}

function mapFinding(row: Row): SecurityPostureFinding {
  return {
    id: String(row.id), fingerprint: String(row.fingerprint), organizationId: String(row.organization_id),
    projectId: optionalString(row.project_id), environmentId: optionalString(row.environment_id), resourceId: optionalString(row.resource_id),
    releaseId: optionalString(row.release_id), scanRunId: String(row.scan_run_id), scannerId: String(row.scanner_id),
    scannerVersion: String(row.scanner_version), ruleId: String(row.rule_id), severity: String(row.severity) as SecuritySeverity,
    title: String(row.title), description: String(row.description), evidence: parseJson(row.evidence, {}),
    remediation: optionalString(row.remediation), subject: String(row.subject), status: String(row.status) as SecurityPostureFinding['status'],
    ownerActorId: optionalString(row.owner_actor_id), recurrenceCount: Number(row.recurrence_count),
    firstSeenAt: String(row.first_seen_at), lastSeenAt: String(row.last_seen_at), resolvedAt: optionalString(row.resolved_at),
    updatedAt: String(row.updated_at),
  }
}

function mapPolicy(row: Row): SecurityPolicy {
  return {
    id: String(row.id), organizationId: String(row.organization_id), environmentId: optionalString(row.environment_id),
    name: String(row.name), rules: parseJson(row.rules, []), requiredScanners: parseJson(row.required_scanners, []), scannerFailMode: String(row.scanner_fail_mode) as 'open' | 'closed',
    enabled: Number(row.enabled) === 1, version: Number(row.version), createdByActorId: optionalString(row.created_by_actor_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapWaiver(row: Row, now: string): SecurityWaiver {
  const revokedAt = optionalString(row.revoked_at)
  const expiresAt = String(row.expires_at)
  return {
    id: String(row.id), findingId: String(row.finding_id), policyId: optionalString(row.policy_id), reason: String(row.reason),
    referenceUrl: optionalString(row.reference_url), createdByActorId: String(row.created_by_actor_id), expiresAt, revokedAt,
    state: revokedAt ? 'revoked' : expiresAt <= now ? 'expired' : 'active', createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapArtifact(row: Row): ReleaseSecurityArtifact {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    environmentId: optionalString(row.environment_id), releaseId: String(row.release_id), kind: String(row.kind) as ReleaseSecurityArtifact['kind'],
    format: String(row.format), digest: String(row.digest), summary: parseJson(row.summary, {}), content: optionalString(row.content),
    sensitive: Number(row.sensitive) === 1, createdAt: String(row.created_at),
  }
}

function mapDecision(row: Row): SecurityDeployDecision {
  return {
    id: String(row.id), organizationId: String(row.organization_id), projectId: String(row.project_id),
    environmentId: String(row.environment_id), operationId: optionalString(row.operation_id), policyId: String(row.policy_id),
    policyVersion: Number(row.policy_version), outcome: String(row.outcome) as SecurityDeployDecision['outcome'],
    scannerVersions: parseJson(row.scanner_versions, {}), findingIds: parseJson(row.finding_ids, []), waiverIds: parseJson(row.waiver_ids, []),
    explanation: String(row.explanation), createdAt: String(row.created_at),
  }
}

function normalizedFingerprint(scannerId: string, finding: SecurityFindingInput): string {
  const identity = [
    scannerId.trim().toLowerCase(), finding.ruleId.trim().toLowerCase(), finding.organizationId,
    finding.projectId ?? '', finding.environmentId ?? '', finding.resourceId ?? '', finding.releaseId ?? '',
    finding.subject.trim().toLowerCase(),
  ].join('\0')
  return createHash('sha256').update(identity).digest('hex')
}

function validateUrl(value?: string): string | undefined {
  if (!value)
    return undefined
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Security references must use HTTP or HTTPS')
  return url.toString()
}

function validateRules(rules: SecurityPolicyRule[]): SecurityPolicyRule[] {
  if (!rules.length)
    throw new Error('A security policy needs at least one rule')
  return rules.map(rule => {
    if (!(rule.minimumSeverity in SEVERITY_RANK))
      throw new Error(`Unknown security severity: ${rule.minimumSeverity}`)
    if (!(rule.action in ACTION_RANK))
      throw new Error(`Unknown security policy action: ${rule.action}`)
    return { minimumSeverity: rule.minimumSeverity, action: rule.action, ...(rule.scannerId ? { scannerId: rule.scannerId.trim() } : {}) }
  })
}

export class SecurityPostureStore {
  private readonly nowFn: () => Date
  private readonly idFn: () => string

  constructor(private readonly controlPlane: ControlPlaneStore, options: { now?: () => Date, id?: () => string } = {}) {
    this.nowFn = options.now ?? (() => new Date())
    this.idFn = options.id ?? (() => crypto.randomUUID())
  }

  private now(): string { return this.nowFn().toISOString() }

  private run(sql: string, bindings: SQLQueryBindings[]): void {
    this.controlPlane.database.run(sql, bindings)
  }

  recordScan(input: RecordSecurityScanInput): { run: SecurityScanRun, findings: SecurityPostureFinding[] } {
    if (!input.organizationId || !input.scannerId.trim() || !input.scannerVersion.trim())
      throw new Error('Organization, scanner id, and scanner version are required')
    const completedAt = input.completedAt ?? this.now()
    const startedAt = input.startedAt ?? completedAt
    const durationMs = input.durationMs ?? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
    const sourceFindings = input.findings ?? []
    const runId = this.idFn()
    const observed = new Set<string>()
    const updated: SecurityPostureFinding[] = []

    this.controlPlane.transaction(() => {
      this.run(
        `INSERT INTO security_scan_runs
        (id, organization_id, project_id, environment_id, resource_id, release_id, scanner_id, scanner_version, status, error, metadata, findings_count, started_at, completed_at, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, input.organizationId, input.projectId ?? null, input.environmentId ?? null, input.resourceId ?? null, input.releaseId ?? null,
          input.scannerId.trim(), input.scannerVersion.trim(), input.status, safeError(input.error) ?? null, json(input.metadata ?? {}), sourceFindings.length,
          startedAt, completedAt, Math.max(0, Math.floor(durationMs))],
      )

      for (const raw of sourceFindings) {
        const finding: SecurityFindingInput = {
          ...raw,
          organizationId: input.organizationId,
          projectId: raw.projectId ?? input.projectId,
          environmentId: raw.environmentId ?? input.environmentId,
          resourceId: raw.resourceId ?? input.resourceId,
          releaseId: raw.releaseId ?? input.releaseId,
        }
        const fingerprint = finding.fingerprint?.trim() || normalizedFingerprint(input.scannerId, finding)
        observed.add(fingerprint)
        const existingRow = this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_findings WHERE fingerprint = ?').get(fingerprint)
        const activeWaiver = existingRow
          ? this.controlPlane.database.query<Row, [string, string]>(`SELECT * FROM security_waivers WHERE finding_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`).get(String(existingRow.id), completedAt)
          : undefined
        if (existingRow) {
          const recurrence = String(existingRow.status) === 'resolved' ? Number(existingRow.recurrence_count) + 1 : Number(existingRow.recurrence_count)
          const nextStatus = activeWaiver ? 'waived' : String(existingRow.status) === 'acknowledged' ? 'acknowledged' : 'open'
          this.run(
            `UPDATE security_findings SET scan_run_id = ?, scanner_version = ?, severity = ?, title = ?, description = ?, evidence = ?, remediation = ?,
            status = ?, recurrence_count = ?, last_seen_at = ?, resolved_at = NULL, updated_at = ? WHERE id = ?`,
            [runId, input.scannerVersion, finding.severity, finding.title.trim(), finding.description.trim(), json(finding.evidence ?? {}), finding.remediation?.trim() || null,
              nextStatus, recurrence, completedAt, completedAt, String(existingRow.id)],
          )
          updated.push(this.getFinding(String(existingRow.id))!)
        }
        else {
          const id = this.idFn()
          this.run(
            `INSERT INTO security_findings
            (id, fingerprint, organization_id, project_id, environment_id, resource_id, release_id, scan_run_id, scanner_id, scanner_version, rule_id,
            severity, title, description, evidence, remediation, subject, status, first_seen_at, last_seen_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
            [id, fingerprint, finding.organizationId, finding.projectId ?? null, finding.environmentId ?? null, finding.resourceId ?? null,
              finding.releaseId ?? null, runId, input.scannerId, input.scannerVersion, finding.ruleId.trim(), finding.severity, finding.title.trim(),
              finding.description.trim(), json(finding.evidence ?? {}), finding.remediation?.trim() || null, finding.subject.trim(), completedAt, completedAt, completedAt],
          )
          updated.push(this.getFinding(id)!)
        }
      }

      if (input.status === 'passed' || input.status === 'failed') {
        const candidates = this.controlPlane.database.query<Row, [string, string, string | null, string | null, string | null, string | null]>(
          `SELECT * FROM security_findings WHERE organization_id = ? AND scanner_id = ?
          AND project_id IS ? AND environment_id IS ? AND resource_id IS ? AND release_id IS ? AND status != 'resolved'`,
        ).all(input.organizationId, input.scannerId, input.projectId ?? null, input.environmentId ?? null, input.resourceId ?? null, input.releaseId ?? null)
        for (const candidate of candidates) {
          if (observed.has(String(candidate.fingerprint)))
            continue
          this.run(`UPDATE security_findings SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, [completedAt, completedAt, String(candidate.id)])
          this.controlPlane.appendEvent({ organizationId: input.organizationId, projectId: input.projectId, resourceId: input.resourceId,
            type: 'security.finding.resolved', payload: { findingId: String(candidate.id), scannerId: input.scannerId, reason: 'not-observed' } })
        }
      }

      this.controlPlane.appendEvent({ organizationId: input.organizationId, projectId: input.projectId, resourceId: input.resourceId,
        type: 'security.scan.completed', level: input.status === 'failed' || DEGRADED_CHECKS.has(input.status) ? 'warning' : 'info',
        payload: { scanRunId: runId, scannerId: input.scannerId, scannerVersion: input.scannerVersion, status: input.status, findingsCount: sourceFindings.length, durationMs } })
    })

    return { run: this.getScanRun(runId)!, findings: updated.map(item => this.getFinding(item.id)!) }
  }

  getScanRun(id: string): SecurityScanRun | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_scan_runs WHERE id = ?').get(id)
    return row ? mapScan(row) : undefined
  }

  listScanRuns(scope: { organizationId: string, projectId?: string, environmentId?: string, limit?: number }): SecurityScanRun[] {
    return this.controlPlane.database.query<Row, [string, string | null, string | null, number]>(
      `SELECT * FROM security_scan_runs WHERE organization_id = ? AND project_id IS ? AND environment_id IS ? ORDER BY completed_at DESC, id DESC LIMIT ?`,
    ).all(scope.organizationId, scope.projectId ?? null, scope.environmentId ?? null, Math.min(500, Math.max(1, scope.limit ?? 100))).map(mapScan)
  }

  getFinding(id: string): SecurityPostureFinding | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_findings WHERE id = ?').get(id)
    return row ? mapFinding(row) : undefined
  }

  listFindings(options: { organizationId: string, projectId?: string, environmentId?: string, status?: SecurityPostureFinding['status'], severity?: SecuritySeverity, limit?: number }): SecurityPostureFinding[] {
    this.expireWaivers()
    const where = ['organization_id = ?']
    const bindings: SQLQueryBindings[] = [options.organizationId]
    if (options.projectId) { where.push('project_id = ?'); bindings.push(options.projectId) }
    if (options.environmentId) { where.push('environment_id = ?'); bindings.push(options.environmentId) }
    if (options.status) { where.push('status = ?'); bindings.push(options.status) }
    if (options.severity) { where.push('severity = ?'); bindings.push(options.severity) }
    bindings.push(Math.min(1_000, Math.max(1, options.limit ?? 250)))
    return this.controlPlane.database.query<Row, SQLQueryBindings[]>(
      `SELECT * FROM security_findings WHERE ${where.join(' AND ')} ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, last_seen_at DESC LIMIT ?`,
    ).all(...bindings).map(mapFinding)
  }

  assignFinding(findingId: string, ownerActorId: string | undefined, actorId?: string): SecurityPostureFinding {
    const finding = this.getFinding(findingId)
    if (!finding)
      throw new Error('Security finding was not found')
    if (ownerActorId && !this.controlPlane.getActor(ownerActorId))
      throw new Error('Finding owner was not found')
    this.run('UPDATE security_findings SET owner_actor_id = ?, updated_at = ? WHERE id = ?', [ownerActorId ?? null, this.now(), findingId])
    this.controlPlane.appendEvent({ organizationId: finding.organizationId, projectId: finding.projectId, resourceId: finding.resourceId, actorId,
      type: 'security.finding.assigned', payload: { findingId, ownerActorId: ownerActorId ?? null } })
    return this.getFinding(findingId)!
  }

  acknowledgeFinding(findingId: string, actorId?: string): SecurityPostureFinding {
    const finding = this.getFinding(findingId)
    if (!finding)
      throw new Error('Security finding was not found')
    if (finding.status === 'resolved')
      throw new Error('A resolved finding cannot be acknowledged')
    this.run(`UPDATE security_findings SET status = 'acknowledged', updated_at = ? WHERE id = ?`, [this.now(), findingId])
    this.controlPlane.appendEvent({ organizationId: finding.organizationId, projectId: finding.projectId, resourceId: finding.resourceId, actorId,
      type: 'security.finding.acknowledged', payload: { findingId } })
    return this.getFinding(findingId)!
  }

  addComment(input: { findingId: string, actorId: string, body: string, referenceUrl?: string }): SecurityFindingComment {
    const finding = this.getFinding(input.findingId)
    if (!finding)
      throw new Error('Security finding was not found')
    const body = input.body.trim()
    if (body.length < 2 || body.length > 4_000)
      throw new Error('Finding comments must contain 2-4,000 characters')
    const referenceUrl = validateUrl(input.referenceUrl)
    const id = this.idFn()
    const createdAt = this.now()
    this.run('INSERT INTO security_finding_comments (id, finding_id, actor_id, body, reference_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.findingId, input.actorId, body, referenceUrl ?? null, createdAt])
    this.controlPlane.appendEvent({ organizationId: finding.organizationId, projectId: finding.projectId, resourceId: finding.resourceId, actorId: input.actorId,
      type: 'security.finding.commented', payload: { findingId: input.findingId, commentId: id, referenceUrl: referenceUrl ?? null } })
    return { id, findingId: input.findingId, actorId: input.actorId, body, referenceUrl, createdAt }
  }

  listComments(findingId: string): SecurityFindingComment[] {
    return this.controlPlane.database.query<Row, [string]>(
      'SELECT * FROM security_finding_comments WHERE finding_id = ? ORDER BY created_at, id',
    ).all(findingId).map(row => ({ id: String(row.id), findingId: String(row.finding_id), actorId: String(row.actor_id), body: String(row.body), referenceUrl: optionalString(row.reference_url), createdAt: String(row.created_at) }))
  }

  createWaiver(input: { findingId: string, policyId?: string, reason: string, referenceUrl?: string, expiresAt: string, actorId: string }): SecurityWaiver {
    const finding = this.getFinding(input.findingId)
    if (!finding)
      throw new Error('Security finding was not found')
    const reason = input.reason.trim()
    if (reason.length < 8 || reason.length > 1_000)
      throw new Error('A waiver reason must contain 8-1,000 characters')
    const now = this.now()
    const expiry = new Date(input.expiresAt)
    if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() <= now)
      throw new Error('A waiver must have a future expiry')
    if (expiry.getTime() - new Date(now).getTime() > 365 * 24 * 60 * 60 * 1_000)
      throw new Error('A waiver cannot last longer than one year')
    const policy = input.policyId ? this.getPolicy(input.policyId) : undefined
    if (input.policyId && (!policy || policy.organizationId !== finding.organizationId))
      throw new Error('Waiver policy does not match the finding organization')
    const id = this.idFn()
    const referenceUrl = validateUrl(input.referenceUrl)
    this.controlPlane.transaction(() => {
      this.run(`INSERT INTO security_waivers (id, finding_id, policy_id, reason, reference_url, created_by_actor_id, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, finding.id, input.policyId ?? null, reason, referenceUrl ?? null, input.actorId, expiry.toISOString(), now, now])
      this.run(`UPDATE security_findings SET status = 'waived', updated_at = ? WHERE id = ?`, [now, finding.id])
      this.controlPlane.appendEvent({ organizationId: finding.organizationId, projectId: finding.projectId, resourceId: finding.resourceId, actorId: input.actorId,
        type: 'security.waiver.created', level: 'warning', payload: { waiverId: id, findingId: finding.id, policyId: input.policyId ?? null, reason, expiresAt: expiry.toISOString(), referenceUrl: referenceUrl ?? null } })
    })
    return this.getWaiver(id)!
  }

  revokeWaiver(id: string, actorId: string): SecurityWaiver {
    const waiver = this.getWaiver(id)
    if (!waiver)
      throw new Error('Security waiver was not found')
    if (waiver.revokedAt)
      return waiver
    const finding = this.getFinding(waiver.findingId)!
    const now = this.now()
    this.controlPlane.transaction(() => {
      this.run('UPDATE security_waivers SET revoked_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
      this.run(`UPDATE security_findings SET status = 'open', updated_at = ? WHERE id = ? AND status = 'waived'`, [now, waiver.findingId])
      this.controlPlane.appendEvent({ organizationId: finding.organizationId, projectId: finding.projectId, resourceId: finding.resourceId, actorId,
        type: 'security.waiver.revoked', level: 'warning', payload: { waiverId: id, findingId: waiver.findingId } })
    })
    return this.getWaiver(id)!
  }

  getWaiver(id: string): SecurityWaiver | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_waivers WHERE id = ?').get(id)
    return row ? mapWaiver(row, this.now()) : undefined
  }

  listWaivers(findingId?: string): SecurityWaiver[] {
    const rows = findingId
      ? this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_waivers WHERE finding_id = ? ORDER BY created_at DESC').all(findingId)
      : this.controlPlane.database.query<Row, []>('SELECT * FROM security_waivers ORDER BY created_at DESC').all()
    return rows.map(row => mapWaiver(row, this.now()))
  }

  expireWaivers(): number {
    const now = this.now()
    const rows = this.controlPlane.database.query<Row, [string]>(
      `SELECT w.id AS waiver_id, f.* FROM security_waivers w JOIN security_findings f ON f.id = w.finding_id
      WHERE w.revoked_at IS NULL AND w.expires_at <= ? AND f.status = 'waived'`,
    ).all(now)
    for (const row of rows) {
      this.run(`UPDATE security_findings SET status = 'open', updated_at = ? WHERE id = ?`, [now, String(row.id)])
      this.controlPlane.appendEvent({ organizationId: String(row.organization_id), projectId: optionalString(row.project_id), resourceId: optionalString(row.resource_id),
        type: 'security.waiver.expired', level: 'warning', payload: { waiverId: String(row.waiver_id), findingId: String(row.id) } })
    }
    return rows.length
  }

  createPolicy(input: { organizationId: string, environmentId?: string, name: string, rules: SecurityPolicyRule[], requiredScanners?: string[], scannerFailMode: 'open' | 'closed', actorId?: string }): SecurityPolicy {
    const name = input.name.trim()
    if (!name)
      throw new Error('Security policy name is required')
    const rules = validateRules(input.rules)
    const id = this.idFn()
    const now = this.now()
    const requiredScanners = [...new Set((input.requiredScanners ?? []).map(value => value.trim()).filter(Boolean))].sort()
    this.run(`INSERT INTO security_policies (id, organization_id, environment_id, name, rules, required_scanners, scanner_fail_mode, created_by_actor_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, input.organizationId, input.environmentId ?? null, name, json(rules), json(requiredScanners), input.scannerFailMode, input.actorId ?? null, now, now])
    this.controlPlane.appendEvent({ organizationId: input.organizationId, actorId: input.actorId, type: 'security.policy.created',
      payload: { policyId: id, environmentId: input.environmentId ?? null, scannerFailMode: input.scannerFailMode, requiredScanners, rules: sanitizeControlPlaneValue(rules) } })
    return this.getPolicy(id)!
  }

  updatePolicy(id: string, expectedVersion: number, input: { name?: string, rules?: SecurityPolicyRule[], requiredScanners?: string[], scannerFailMode?: 'open' | 'closed', enabled?: boolean, actorId?: string }): SecurityPolicy {
    const policy = this.getPolicy(id)
    if (!policy || policy.version !== expectedVersion)
      throw new Error(`Security policy ${id} changed since version ${expectedVersion}`)
    const rules = input.rules ? validateRules(input.rules) : policy.rules
    const requiredScanners = input.requiredScanners ? [...new Set(input.requiredScanners.map(value => value.trim()).filter(Boolean))].sort() : policy.requiredScanners
    const now = this.now()
    const result = this.controlPlane.database.run(
      `UPDATE security_policies SET name = ?, rules = ?, required_scanners = ?, scanner_fail_mode = ?, enabled = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      [input.name?.trim() || policy.name, json(rules), json(requiredScanners), input.scannerFailMode ?? policy.scannerFailMode, (input.enabled ?? policy.enabled) ? 1 : 0, now, id, expectedVersion],
    )
    if (result.changes !== 1)
      throw new Error(`Security policy ${id} changed since version ${expectedVersion}`)
    this.controlPlane.appendEvent({ organizationId: policy.organizationId, actorId: input.actorId, type: 'security.policy.updated',
      payload: { policyId: id, fromVersion: expectedVersion, toVersion: expectedVersion + 1 } })
    return this.getPolicy(id)!
  }

  getPolicy(id: string): SecurityPolicy | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_policies WHERE id = ?').get(id)
    return row ? mapPolicy(row) : undefined
  }

  listPolicies(organizationId: string): SecurityPolicy[] {
    return this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_policies WHERE organization_id = ? ORDER BY environment_id, name').all(organizationId).map(mapPolicy)
  }

  evaluateGate(input: EvaluateSecurityGateInput): SecurityDeployDecision {
    this.expireWaivers()
    const policy = input.policyId
      ? this.getPolicy(input.policyId)
      : this.controlPlane.database.query<Row, [string, string, string]>(
          `SELECT * FROM security_policies WHERE organization_id = ? AND enabled = 1 AND (environment_id = ? OR environment_id IS NULL)
          ORDER BY CASE WHEN environment_id = ? THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`,
        ).get(input.organizationId, input.environmentId, input.environmentId) as Row | null
    const resolvedPolicy = policy && 'rules' in policy && Array.isArray(policy.rules) ? policy as SecurityPolicy : policy ? mapPolicy(policy as Row) : undefined
    if (!resolvedPolicy || !resolvedPolicy.enabled)
      throw new Error('No enabled security policy applies to this environment')

    const findings = this.listFindings({ organizationId: input.organizationId, projectId: input.projectId, environmentId: input.environmentId, limit: 1_000 })
      .filter(finding => finding.status !== 'resolved')
    const activeWaivers = new Map<string, SecurityWaiver>()
    for (const finding of findings) {
      const waiver = this.listWaivers(finding.id).find(item => item.state === 'active' && (!item.policyId || item.policyId === resolvedPolicy.id))
      if (waiver)
        activeWaivers.set(finding.id, waiver)
    }

    const actionFor = (finding: SecurityPostureFinding): SecurityPolicyAction => resolvedPolicy.rules
      .filter(rule => (!rule.scannerId || rule.scannerId === finding.scannerId) && SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[rule.minimumSeverity])
      .reduce<SecurityPolicyAction>((action, rule) => ACTION_RANK[rule.action] > ACTION_RANK[action] ? rule.action : action, 'record')
    const blockers = findings.filter(finding => !activeWaivers.has(finding.id) && actionFor(finding) === 'block')
    const warnings = findings.filter(finding => !activeWaivers.has(finding.id) && actionFor(finding) === 'warn')

    const latestRows = this.controlPlane.database.query<Row, [string, string, string]>(
      `SELECT run.* FROM security_scan_runs run
      WHERE run.organization_id = ? AND run.project_id = ? AND run.environment_id = ?
      AND run.id = (SELECT candidate.id FROM security_scan_runs candidate
        WHERE candidate.organization_id = run.organization_id AND candidate.project_id = run.project_id
        AND candidate.environment_id = run.environment_id AND candidate.scanner_id = run.scanner_id
        ORDER BY candidate.completed_at DESC, candidate.rowid DESC LIMIT 1)`,
    ).all(input.organizationId, input.projectId, input.environmentId)
    const staleAfterMs = input.staleAfterMs ?? 24 * 60 * 60 * 1_000
    const nowMs = this.nowFn().getTime()
    const latest = latestRows.map(mapScan).map(run => nowMs - new Date(run.completedAt).getTime() > staleAfterMs ? { ...run, status: 'stale' as const } : run)
    const observedScanners = new Set(latest.map(run => run.scannerId))
    const missing = resolvedPolicy.requiredScanners.filter(scannerId => !observedScanners.has(scannerId)).map(scannerId => ({
      id: `missing:${scannerId}`, organizationId: input.organizationId, projectId: input.projectId, environmentId: input.environmentId,
      scannerId, scannerVersion: 'unavailable', status: 'unavailable' as const, metadata: {}, findingsCount: 0,
      startedAt: this.now(), completedAt: this.now(), durationMs: 0,
    }))
    const evaluatedScans = [...latest, ...missing]
    const degraded = evaluatedScans.filter(run => resolvedPolicy.requiredScanners.includes(run.scannerId) && DEGRADED_CHECKS.has(run.status))
    const scannerVersions = Object.fromEntries(evaluatedScans.map(run => [run.scannerId, run.scannerVersion]))
    const unavailableBlocks = resolvedPolicy.scannerFailMode === 'closed' && degraded.length > 0
    const outcome: SecurityDeployDecision['outcome'] = blockers.length || unavailableBlocks ? 'block' : warnings.length || degraded.length ? 'warn' : 'allow'
    const details: string[] = []
    if (blockers.length)
      details.push(`${blockers.length} finding${blockers.length === 1 ? '' : 's'} blocked by policy`)
    if (warnings.length)
      details.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'} require review`)
    if (degraded.length)
      details.push(`${degraded.length} scanner${degraded.length === 1 ? '' : 's'} ${resolvedPolicy.scannerFailMode === 'closed' ? 'failed closed' : 'failed open'}`)
    if (activeWaivers.size)
      details.push(`${activeWaivers.size} active time-limited waiver${activeWaivers.size === 1 ? '' : 's'}`)
    if (!details.length)
      details.push('All recorded checks satisfy policy')

    const id = this.idFn()
    const createdAt = this.now()
    this.run(`INSERT INTO security_deploy_decisions
      (id, organization_id, project_id, environment_id, operation_id, policy_id, policy_version, outcome, scanner_versions, finding_ids, waiver_ids, explanation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.organizationId, input.projectId, input.environmentId, input.operationId ?? null, resolvedPolicy.id, resolvedPolicy.version, outcome,
      json(scannerVersions), json([...blockers, ...warnings].map(item => item.id)), json([...activeWaivers.values()].map(item => item.id)), details.join('; '), createdAt])
    this.controlPlane.appendEvent({ organizationId: input.organizationId, projectId: input.projectId, operationId: input.operationId,
      type: 'security.deploy.decision', level: outcome === 'block' ? 'error' : outcome === 'warn' ? 'warning' : 'info',
      payload: { decisionId: id, outcome, policyId: resolvedPolicy.id, policyVersion: resolvedPolicy.version, scannerVersions, blockerIds: blockers.map(item => item.id), waiverIds: [...activeWaivers.values()].map(item => item.id), explanation: details.join('; ') } })
    return this.getDecision(id)!
  }

  getDecision(id: string): SecurityDeployDecision | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM security_deploy_decisions WHERE id = ?').get(id)
    return row ? mapDecision(row) : undefined
  }

  listDecisions(environmentId: string, limit: number = 100): SecurityDeployDecision[] {
    return this.controlPlane.database.query<Row, [string, number]>('SELECT * FROM security_deploy_decisions WHERE environment_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(environmentId, Math.min(500, Math.max(1, limit))).map(mapDecision)
  }

  addReleaseArtifact(input: Omit<ReleaseSecurityArtifact, 'id' | 'createdAt'>): ReleaseSecurityArtifact {
    const existing = this.controlPlane.database.query<Row, [string, string, string]>('SELECT * FROM release_security_artifacts WHERE release_id = ? AND kind = ? AND digest = ?')
      .get(input.releaseId, input.kind, input.digest)
    if (existing)
      return mapArtifact(existing)
    const id = this.idFn()
    const createdAt = this.now()
    this.run(`INSERT INTO release_security_artifacts
      (id, organization_id, project_id, environment_id, release_id, kind, format, digest, summary, content, sensitive, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.organizationId, input.projectId, input.environmentId ?? null, input.releaseId, input.kind, input.format, input.digest,
      json(input.summary), input.content ?? null, input.sensitive ? 1 : 0, createdAt])
    this.controlPlane.appendEvent({ organizationId: input.organizationId, projectId: input.projectId, type: 'security.release_artifact.created',
      payload: { artifactId: id, releaseId: input.releaseId, kind: input.kind, format: input.format, digest: input.digest, sensitive: input.sensitive } })
    return mapArtifact(this.controlPlane.database.query<Row, [string]>('SELECT * FROM release_security_artifacts WHERE id = ?').get(id)!)
  }

  listReleaseArtifacts(releaseId: string, includeSensitiveContent: boolean = false): ReleaseSecurityArtifact[] {
    return this.controlPlane.database.query<Row, [string]>('SELECT * FROM release_security_artifacts WHERE release_id = ? ORDER BY created_at, kind').all(releaseId)
      .map(mapArtifact).map(artifact => artifact.sensitive && !includeSensitiveContent ? { ...artifact, content: undefined } : artifact)
  }

  summary(organizationId: string, projectId?: string, environmentId?: string): SecurityPostureSummary {
    const findings = this.listFindings({ organizationId, projectId, environmentId, limit: 1_000 })
    const scans = this.listScanRuns({ organizationId, projectId, environmentId, limit: 1_000 })
    const open: Record<SecuritySeverity, number> = { info: 0, low: 0, medium: 0, high: 0, critical: 0 }
    for (const finding of findings) {
      if (finding.status === 'open' || finding.status === 'acknowledged')
        open[finding.severity]++
    }
    const checks: Record<SecurityCheckStatus, number> = { passed: 0, failed: 0, skipped: 0, unavailable: 0, unsupported: 0, stale: 0 }
    for (const scan of scans)
      checks[scan.status]++
    return { open, waived: findings.filter(item => item.status === 'waived').length, resolved: findings.filter(item => item.status === 'resolved').length,
      checks, lastScannedAt: scans[0]?.completedAt }
  }

  exportPosture(organizationId: string): JsonValue {
    const projects = this.controlPlane.listProjects().filter(project => project.organizationId === organizationId)
    return sanitizeControlPlaneValue({
      format: 'ts-cloud-security-posture', version: 1, exportedAt: this.now(), organizationId,
      policies: this.listPolicies(organizationId), findings: this.listFindings({ organizationId, limit: 1_000 }),
      waivers: this.listWaivers().filter(waiver => this.getFinding(waiver.findingId)?.organizationId === organizationId),
      scans: projects.flatMap(project => this.listScanRuns({ organizationId, projectId: project.id, limit: 1_000 })),
      decisions: projects.flatMap(project => this.controlPlane.listEnvironments(project.id).flatMap(environment => this.listDecisions(environment.id, 1_000))),
    })
  }
}
