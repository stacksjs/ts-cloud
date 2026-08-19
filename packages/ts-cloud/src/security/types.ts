import type { JsonValue } from '../control-plane'

export type SecuritySeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'
export type SecurityCheckStatus = 'passed' | 'failed' | 'skipped' | 'unavailable' | 'unsupported' | 'stale'
export type SecurityFindingStatus = 'open' | 'acknowledged' | 'resolved' | 'waived'
export type SecurityPolicyAction = 'block' | 'warn' | 'record'

export interface SecurityScope {
  organizationId: string
  projectId?: string
  environmentId?: string
  resourceId?: string
  releaseId?: string
}

export interface SecurityFindingInput extends SecurityScope {
  ruleId: string
  severity: SecuritySeverity
  title: string
  description: string
  evidence?: JsonValue
  remediation?: string
  subject: string
  fingerprint?: string
}

export interface SecurityPostureFinding extends SecurityScope {
  id: string
  fingerprint: string
  scanRunId: string
  scannerId: string
  scannerVersion: string
  ruleId: string
  severity: SecuritySeverity
  title: string
  description: string
  evidence: JsonValue
  remediation?: string
  subject: string
  status: SecurityFindingStatus
  ownerActorId?: string
  recurrenceCount: number
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt?: string
  updatedAt: string
}

export interface SecurityScanRun extends SecurityScope {
  id: string
  scannerId: string
  scannerVersion: string
  status: SecurityCheckStatus
  error?: string
  metadata: JsonValue
  findingsCount: number
  startedAt: string
  completedAt: string
  durationMs: number
}

export interface RecordSecurityScanInput extends SecurityScope {
  scannerId: string
  scannerVersion: string
  status: SecurityCheckStatus
  findings?: SecurityFindingInput[]
  error?: string
  metadata?: JsonValue
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

export interface SecurityPolicyRule {
  minimumSeverity: SecuritySeverity
  action: SecurityPolicyAction
  scannerId?: string
}

export interface SecurityPolicy {
  id: string
  organizationId: string
  environmentId?: string
  name: string
  rules: SecurityPolicyRule[]
  requiredScanners: string[]
  scannerFailMode: 'open' | 'closed'
  enabled: boolean
  version: number
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export interface SecurityWaiver {
  id: string
  findingId: string
  policyId?: string
  reason: string
  referenceUrl?: string
  createdByActorId: string
  expiresAt: string
  revokedAt?: string
  state: 'active' | 'expired' | 'revoked'
  createdAt: string
  updatedAt: string
}

export interface SecurityFindingComment {
  id: string
  findingId: string
  actorId: string
  body: string
  referenceUrl?: string
  createdAt: string
}

export interface ReleaseSecurityArtifact {
  id: string
  organizationId: string
  projectId: string
  environmentId?: string
  releaseId: string
  kind: 'sbom' | 'vulnerability_summary' | 'signature' | 'provenance'
  format: string
  digest: string
  summary: JsonValue
  content?: string
  sensitive: boolean
  createdAt: string
}

export interface SecurityDeployDecision {
  id: string
  organizationId: string
  projectId: string
  environmentId: string
  operationId?: string
  policyId: string
  policyVersion: number
  outcome: 'allow' | 'warn' | 'block'
  scannerVersions: Record<string, string>
  findingIds: string[]
  waiverIds: string[]
  explanation: string
  createdAt: string
}

export interface EvaluateSecurityGateInput {
  organizationId: string
  projectId: string
  environmentId: string
  operationId?: string
  policyId?: string
  staleAfterMs?: number
}

export interface SecurityPostureSummary {
  open: Record<SecuritySeverity, number>
  waived: number
  resolved: number
  checks: Record<SecurityCheckStatus, number>
  lastScannedAt?: string
}
