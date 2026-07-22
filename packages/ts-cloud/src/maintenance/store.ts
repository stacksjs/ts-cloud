import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { CleanupCandidate, CleanupPlan, DisasterRecoveryDrill, MaintenanceWindow, PlatformUpdateDocument, PlatformUpdateManifest, TrustedUpdateKey, UpgradeCampaign, UpgradeTarget } from './types'
import { documentDigest, manifestDigest, publicKeyFingerprint, updateCompatibility, verifyUpdateSignature } from './manifest'

type Row = Record<string, unknown>
const parse = <T>(v: unknown, d: T): T => {
    try {
      return JSON.parse(String(v))
    } catch {
      return d
    }
  },
  opt = (v: unknown) => (v == null ? undefined : String(v))
const key = (r: Row): TrustedUpdateKey => ({
  id: String(r.id),
  organizationId: String(r.organization_id),
  name: String(r.name),
  algorithm: 'ed25519',
  publicKeyPem: String(r.public_key_pem),
  fingerprint: String(r.fingerprint),
  revokedAt: opt(r.revoked_at),
  createdAt: String(r.created_at),
})
const manifest = (r: Row): PlatformUpdateManifest => ({
  id: String(r.id),
  organizationId: String(r.organization_id),
  version: String(r.version),
  channel: String(r.channel) as PlatformUpdateManifest['channel'],
  publishedAt: String(r.published_at),
  keyId: String(r.key_id),
  digest: String(r.digest),
  document: parse(r.document, {} as PlatformUpdateDocument),
  signature: String(r.signature),
  verificationStatus: String(r.verification_status) as PlatformUpdateManifest['verificationStatus'],
  compatibility: parse(r.compatibility, { compatible: false, reasons: [] }),
  createdAt: String(r.created_at),
})
const window = (r: Row): MaintenanceWindow => ({
  id: String(r.id),
  projectId: String(r.project_id),
  name: String(r.name),
  schedule: String(r.schedule),
  timezone: String(r.timezone),
  durationMinutes: Number(r.duration_minutes),
  allowedOperations: parse(r.allowed_operations, []),
  requireApproval: Number(r.require_approval) === 1,
  enabled: Number(r.enabled) === 1,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
})
const campaign = (r: Row): UpgradeCampaign => ({
  id: String(r.id),
  projectId: String(r.project_id),
  manifestId: String(r.manifest_id),
  windowId: opt(r.window_id),
  fromVersion: String(r.from_version),
  strategy: String(r.strategy) as UpgradeCampaign['strategy'],
  batchSize: Number(r.batch_size),
  healthGate: parse(r.health_gate, {}),
  status: String(r.status) as UpgradeCampaign['status'],
  currentStage: opt(r.current_stage),
  backupId: opt(r.backup_id),
  approvedBy: opt(r.approved_by),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
})
const target = (r: Row): UpgradeTarget => ({
  id: String(r.id),
  campaignId: String(r.campaign_id),
  serverId: opt(r.server_id),
  target: String(r.target),
  cohort: Number(r.cohort),
  previousVersion: String(r.previous_version),
  status: String(r.status) as UpgradeTarget['status'],
  evidence: parse(r.evidence, {}),
  error: opt(r.error),
  startedAt: opt(r.started_at),
  finishedAt: opt(r.finished_at),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
})
const cleanup = (r: Row): CleanupPlan => ({
  id: String(r.id),
  projectId: String(r.project_id),
  kind: String(r.kind) as CleanupPlan['kind'],
  criteria: parse(r.criteria, {}),
  candidates: parse(r.candidates, []),
  candidateDigest: String(r.candidate_digest),
  estimatedBytes: Number(r.estimated_bytes),
  status: String(r.status) as CleanupPlan['status'],
  confirmation: opt(r.confirmation),
  expiresAt: String(r.expires_at),
  result: parse(r.result, {}),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
})
const drill = (r: Row): DisasterRecoveryDrill => ({
  id: String(r.id),
  projectId: String(r.project_id),
  backupPolicyId: opt(r.backup_policy_id),
  recoveryPointId: opt(r.recovery_point_id),
  topologyId: opt(r.topology_id),
  scenario: String(r.scenario) as DisasterRecoveryDrill['scenario'],
  isolatedTarget: String(r.isolated_target),
  expectedRpoMinutes: Number(r.expected_rpo_minutes),
  expectedRtoMinutes: Number(r.expected_rto_minutes),
  status: String(r.status) as DisasterRecoveryDrill['status'],
  operationId: opt(r.operation_id),
  evidence: parse(r.evidence, {}),
  measuredRpoMinutes: r.measured_rpo_minutes == null ? undefined : Number(r.measured_rpo_minutes),
  measuredRtoMinutes: r.measured_rto_minutes == null ? undefined : Number(r.measured_rto_minutes),
  cleanupVerified: Number(r.cleanup_verified) === 1,
  error: opt(r.error),
  startedAt: opt(r.started_at),
  finishedAt: opt(r.finished_at),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
})
export class MaintenanceStore {
  constructor(
    readonly control: ControlPlaneStore,
    private now: () => Date = () => new Date(),
    private id: () => string = () => crypto.randomUUID(),
  ) {}
  addTrustedKey(input: { organizationId: string; name: string; publicKeyPem: string }): TrustedUpdateKey {
    const id = this.id(),
      at = this.now().toISOString(),
      fingerprint = publicKeyFingerprint(input.publicKeyPem)
    this.control.database.run(
      "INSERT INTO platform_trusted_keys (id,organization_id,name,algorithm,public_key_pem,fingerprint,created_at) VALUES (?,?,?,'ed25519',?,?,?)",
      [id, input.organizationId, input.name, input.publicKeyPem, fingerprint, at],
    )
    return this.key(id)!
  }
  key(id: string): TrustedUpdateKey | undefined {
    const row = this.control.database.query<Row, [string]>('SELECT * FROM platform_trusted_keys WHERE id=?').get(id)
    return row ? key(row) : undefined
  }
  revokeKey(id: string): TrustedUpdateKey {
    this.control.database.run('UPDATE platform_trusted_keys SET revoked_at=? WHERE id=?', [
      this.now().toISOString(),
      id,
    ])
    return this.key(id)!
  }
  importManifest(input: {
    organizationId: string
    keyId: string
    document: PlatformUpdateDocument
    signature: string
    current: { schemaVersion: number; currentVersion: string; platform: string; architecture: string }
  }): PlatformUpdateManifest {
    const trusted = this.key(input.keyId)
    if (!trusted || trusted.organizationId !== input.organizationId)
      throw new Error('Trusted update key was not found.')
    if (trusted.revokedAt) throw new Error('Update signing key is revoked.')
    if (!verifyUpdateSignature(input.document, input.signature, trusted.publicKeyPem))
      throw new Error('Update manifest signature is invalid.')
    const compatibility = updateCompatibility(input.document, input.current),
      digest = manifestDigest(input.document),
      id = this.id(),
      at = this.now().toISOString()
    this.control.database.run(
      "INSERT INTO platform_update_manifests (id,organization_id,version,channel,published_at,key_id,digest,document,signature,verification_status,compatibility,created_at) VALUES (?,?,?,?,?,?,?,?,?,'verified',?,?)",
      [
        id,
        input.organizationId,
        input.document.version,
        input.document.channel,
        new Date(input.document.publishedAt).toISOString(),
        input.keyId,
        digest,
        JSON.stringify(input.document),
        input.signature,
        JSON.stringify(compatibility),
        at,
      ],
    )
    return this.manifest(id)!
  }
  manifest(id: string): PlatformUpdateManifest | undefined {
    const row = this.control.database.query<Row, [string]>('SELECT * FROM platform_update_manifests WHERE id=?').get(id)
    return row ? manifest(row) : undefined
  }
  manifests(organizationId: string): PlatformUpdateManifest[] {
    return this.control.database
      .query<Row, [string]>(
        'SELECT * FROM platform_update_manifests WHERE organization_id=? ORDER BY published_at DESC',
      )
      .all(organizationId)
      .map(manifest)
  }
  createWindow(input: {
    projectId: string
    name: string
    schedule: string
    timezone: string
    durationMinutes: number
    allowedOperations: string[]
    requireApproval?: boolean
  }): MaintenanceWindow {
    const id = this.id(),
      at = this.now().toISOString()
    this.control.database.run(
      'INSERT INTO maintenance_windows (id,project_id,name,schedule,timezone,duration_minutes,allowed_operations,require_approval,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)',
      [
        id,
        input.projectId,
        input.name,
        input.schedule,
        input.timezone,
        input.durationMinutes,
        JSON.stringify(input.allowedOperations),
        input.requireApproval === false ? 0 : 1,
        at,
        at,
      ],
    )
    return this.window(id)!
  }
  window(id: string): MaintenanceWindow | undefined {
    const row = this.control.database.query<Row, [string]>('SELECT * FROM maintenance_windows WHERE id=?').get(id)
    return row ? window(row) : undefined
  }
  windows(projectId: string): MaintenanceWindow[] {
    return this.control.database
      .query<Row, [string]>('SELECT * FROM maintenance_windows WHERE project_id=? ORDER BY name')
      .all(projectId)
      .map(window)
  }
  createCampaign(input: {
    projectId: string
    manifestId: string
    windowId?: string
    fromVersion: string
    strategy: 'canary' | 'rolling'
    batchSize: number
    healthGate: Record<string, JsonValue>
    backupId: string
    approvedBy?: string
    targets: Array<{ serverId?: string; target: string; previousVersion: string }>
  }): UpgradeCampaign {
    return this.control.transaction(() => {
      const manifest = this.manifest(input.manifestId)
      if (!manifest?.compatibility.compatible || manifest.verificationStatus !== 'verified')
        throw new Error('A verified compatible update manifest is required.')
      if (!input.backupId) throw new Error('A verified pre-upgrade backup is required.')
      const id = this.id(),
        at = this.now().toISOString()
      this.control.database.run(
        "INSERT INTO platform_upgrade_campaigns (id,project_id,manifest_id,window_id,from_version,strategy,batch_size,health_gate,status,backup_id,approved_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'planned',?,?,?,?)",
        [
          id,
          input.projectId,
          input.manifestId,
          input.windowId ?? null,
          input.fromVersion,
          input.strategy,
          input.batchSize,
          JSON.stringify(input.healthGate),
          input.backupId,
          input.approvedBy ?? null,
          at,
          at,
        ],
      )
      input.targets.forEach((item, index) =>
        this.control.database.run(
          "INSERT INTO platform_upgrade_targets (id,campaign_id,server_id,target,cohort,previous_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)",
          [
            this.id(),
            id,
            item.serverId ?? null,
            item.target,
            input.strategy === 'canary'
              ? index === 0
                ? 0
                : 1 + Math.floor((index - 1) / input.batchSize)
              : Math.floor(index / input.batchSize),
            item.previousVersion,
            at,
            at,
          ],
        ),
      )
      return this.campaign(id)!
    })
  }
  campaign(id: string): UpgradeCampaign | undefined {
    const row = this.control.database
      .query<Row, [string]>('SELECT * FROM platform_upgrade_campaigns WHERE id=?')
      .get(id)
    return row ? campaign(row) : undefined
  }
  campaigns(projectId: string): UpgradeCampaign[] {
    return this.control.database
      .query<Row, [string]>('SELECT * FROM platform_upgrade_campaigns WHERE project_id=? ORDER BY created_at DESC')
      .all(projectId)
      .map(campaign)
  }
  targets(id: string): UpgradeTarget[] {
    return this.control.database
      .query<Row, [string]>('SELECT * FROM platform_upgrade_targets WHERE campaign_id=? ORDER BY cohort,target')
      .all(id)
      .map(target)
  }
  updateCampaign(id: string, patch: Partial<Pick<UpgradeCampaign, 'status' | 'currentStage'>>): UpgradeCampaign {
    const v = this.campaign(id)
    if (!v) throw new Error('Upgrade campaign was not found.')
    const n = { ...v, ...patch }
    this.control.database.run(
      'UPDATE platform_upgrade_campaigns SET status=?,current_stage=?,updated_at=? WHERE id=?',
      [n.status, n.currentStage ?? null, this.now().toISOString(), id],
    )
    return this.campaign(id)!
  }
  updateTarget(
    id: string,
    patch: Partial<Pick<UpgradeTarget, 'status' | 'evidence' | 'error' | 'startedAt' | 'finishedAt'>>,
  ): UpgradeTarget {
    const row = this.control.database.query<Row, [string]>('SELECT * FROM platform_upgrade_targets WHERE id=?').get(id)
    if (!row) throw new Error('Upgrade target was not found.')
    const n = { ...target(row), ...patch }
    this.control.database.run(
      'UPDATE platform_upgrade_targets SET status=?,evidence=?,error=?,started_at=?,finished_at=?,updated_at=? WHERE id=?',
      [
        n.status,
        JSON.stringify(n.evidence),
        n.error ?? null,
        n.startedAt ?? null,
        n.finishedAt ?? null,
        this.now().toISOString(),
        id,
      ],
    )
    return target(
      this.control.database.query<Row, [string]>('SELECT * FROM platform_upgrade_targets WHERE id=?').get(id)!,
    )
  }
  createCleanup(input: {
    projectId: string
    kind: CleanupPlan['kind']
    criteria: CleanupPlan['criteria']
    candidates: CleanupCandidate[]
    ttlMinutes?: number
  }): CleanupPlan {
    const ordered = [...input.candidates].sort((a, b) => a.id.localeCompare(b.id)),
      digest = documentDigest(ordered),
      id = this.id(),
      at = this.now().toISOString(),
      expires = new Date(this.now().getTime() + (input.ttlMinutes ?? 60) * 60_000).toISOString()
    this.control.database.run(
      "INSERT INTO cleanup_plans (id,project_id,kind,criteria,candidates,candidate_digest,estimated_bytes,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'preview',?,?,?)",
      [
        id,
        input.projectId,
        input.kind,
        JSON.stringify(input.criteria),
        JSON.stringify(ordered),
        digest,
        ordered.reduce((sum, item) => sum + item.bytes, 0),
        expires,
        at,
        at,
      ],
    )
    return this.cleanup(id)!
  }
  cleanup(id: string): CleanupPlan | undefined {
    const row = this.control.database.query<Row, [string]>('SELECT * FROM cleanup_plans WHERE id=?').get(id)
    return row ? cleanup(row) : undefined
  }
  cleanups(projectId: string): CleanupPlan[] {
    return this.control.database
      .query<Row, [string]>('SELECT * FROM cleanup_plans WHERE project_id=? ORDER BY created_at DESC')
      .all(projectId)
      .map(cleanup)
  }
  updateCleanup(id: string, patch: Partial<Pick<CleanupPlan, 'status' | 'confirmation' | 'result'>>): CleanupPlan {
    const v = this.cleanup(id)
    if (!v) throw new Error('Cleanup plan was not found.')
    const n = { ...v, ...patch }
    this.control.database.run('UPDATE cleanup_plans SET status=?,confirmation=?,result=?,updated_at=? WHERE id=?', [
      n.status,
      n.confirmation ?? null,
      JSON.stringify(n.result),
      this.now().toISOString(),
      id,
    ])
    return this.cleanup(id)!
  }
  createDrill(input: {
    projectId: string
    backupPolicyId?: string
    recoveryPointId?: string
    topologyId?: string
    scenario: DisasterRecoveryDrill['scenario']
    isolatedTarget: string
    expectedRpoMinutes: number
    expectedRtoMinutes: number
  }): DisasterRecoveryDrill {
    if (!/^isolated:\/\//.test(input.isolatedTarget)) throw new Error('DR drills require an isolated target.')
    const id = this.id(),
      at = this.now().toISOString()
    this.control.database.run(
      "INSERT INTO disaster_recovery_drills (id,project_id,backup_policy_id,recovery_point_id,topology_id,scenario,isolated_target,expected_rpo_minutes,expected_rto_minutes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'planned',?,?)",
      [
        id,
        input.projectId,
        input.backupPolicyId ?? null,
        input.recoveryPointId ?? null,
        input.topologyId ?? null,
        input.scenario,
        input.isolatedTarget,
        input.expectedRpoMinutes,
        input.expectedRtoMinutes,
        at,
        at,
      ],
    )
    return this.drill(id)!
  }
  drill(id: string): DisasterRecoveryDrill | undefined {
    const row = this.control.database.query<Row, [string]>('SELECT * FROM disaster_recovery_drills WHERE id=?').get(id)
    return row ? drill(row) : undefined
  }
  drills(projectId: string): DisasterRecoveryDrill[] {
    return this.control.database
      .query<Row, [string]>('SELECT * FROM disaster_recovery_drills WHERE project_id=? ORDER BY created_at DESC')
      .all(projectId)
      .map(drill)
  }
  updateDrill(
    id: string,
    patch: Partial<
      Pick<
        DisasterRecoveryDrill,
        | 'status'
        | 'operationId'
        | 'evidence'
        | 'measuredRpoMinutes'
        | 'measuredRtoMinutes'
        | 'cleanupVerified'
        | 'error'
        | 'startedAt'
        | 'finishedAt'
      >
    >,
  ): DisasterRecoveryDrill {
    const v = this.drill(id)
    if (!v) throw new Error('DR drill was not found.')
    const n = { ...v, ...patch }
    this.control.database.run(
      'UPDATE disaster_recovery_drills SET status=?,operation_id=?,evidence=?,measured_rpo_minutes=?,measured_rto_minutes=?,cleanup_verified=?,error=?,started_at=?,finished_at=?,updated_at=? WHERE id=?',
      [
        n.status,
        n.operationId ?? null,
        JSON.stringify(n.evidence),
        n.measuredRpoMinutes ?? null,
        n.measuredRtoMinutes ?? null,
        n.cleanupVerified ? 1 : 0,
        n.error ?? null,
        n.startedAt ?? null,
        n.finishedAt ?? null,
        this.now().toISOString(),
        id,
      ],
    )
    return this.drill(id)!
  }
}
