import type { ControlPlaneEnvironment, ControlPlaneOrganization, ControlPlaneProject, ControlPlaneStore, JsonValue } from '../control-plane'
import type { ScanResult } from './pre-deploy-scanner'
import type { SecurityDeployDecision, SecurityFindingInput, SecurityPolicy, SecurityPostureFinding, SecurityScanRun, SecurityScope } from './types'
import { SecurityPostureStore } from './posture-store'

export interface SecurityControlPlaneContext {
  store: ControlPlaneStore
  organization: ControlPlaneOrganization
  project: ControlPlaneProject
  environments: Map<string, ControlPlaneEnvironment>
}

export function securityScope(context: SecurityControlPlaneContext, environment: string): SecurityScope & { projectId: string, environmentId: string } {
  const record = context.environments.get(environment)
  if (!record)
    throw new Error(`Security scope for environment '${environment}' was not found`)
  return { organizationId: context.organization.id, projectId: context.project.id, environmentId: record.id }
}

export function ensureDefaultSecurityPolicies(context: SecurityControlPlaneContext, actorId?: string): SecurityPolicy[] {
  const posture = new SecurityPostureStore(context.store)
  const existing = posture.listPolicies(context.organization.id)
  for (const [slug, environment] of context.environments) {
    if (existing.some(policy => policy.environmentId === environment.id))
      continue
    const production = slug === 'production' || environment.kind === 'production'
    existing.push(posture.createPolicy({
      organizationId: context.organization.id,
      environmentId: environment.id,
      name: production ? 'Production baseline' : 'Environment baseline',
      scannerFailMode: production ? 'closed' : 'open',
      requiredScanners: ['source-secrets'],
      rules: production
        ? [
            { minimumSeverity: 'critical', action: 'block' },
            { minimumSeverity: 'high', action: 'block' },
            { minimumSeverity: 'medium', action: 'warn' },
            { minimumSeverity: 'low', action: 'record' },
          ]
        : [
            { minimumSeverity: 'critical', action: 'warn' },
            { minimumSeverity: 'high', action: 'warn' },
            { minimumSeverity: 'low', action: 'record' },
          ],
      actorId,
    }))
  }
  return existing
}

export function recordPreDeploySecretScan(posture: SecurityPostureStore, scope: SecurityScope, result: ScanResult, options: { scannerVersion?: string, skipped?: boolean } = {}): { run: SecurityScanRun, findings: SecurityPostureFinding[] } {
  const findings: SecurityFindingInput[] = result.findings.map(finding => ({
    ...scope,
    ruleId: finding.pattern.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    severity: finding.pattern.severity,
    title: finding.pattern.name,
    description: finding.pattern.description,
    subject: `${finding.file}:${finding.line}`,
    evidence: { file: finding.file, line: finding.line, column: finding.column, match: finding.match, context: finding.context },
    remediation: 'Remove and rotate the credential, then reference it through a managed secret or environment variable.',
  }))
  return posture.recordScan({
    ...scope,
    scannerId: 'source-secrets',
    scannerVersion: options.scannerVersion ?? '1.0.0',
    status: options.skipped ? 'skipped' : result.passed ? 'passed' : 'failed',
    findings: options.skipped ? [] : findings,
    metadata: { scannedFiles: result.scannedFiles, durationMs: result.duration, summary: result.summary },
    durationMs: result.duration,
    error: options.skipped ? 'The operator explicitly skipped source-secret scanning.' : undefined,
  })
}

export function recordSkippedSecretScan(posture: SecurityPostureStore, scope: SecurityScope, reason: string = 'The operator explicitly skipped source-secret scanning.'): { run: SecurityScanRun, findings: SecurityPostureFinding[] } {
  return posture.recordScan({ ...scope, scannerId: 'source-secrets', scannerVersion: '1.0.0', status: 'skipped', findings: [], error: reason })
}

function hostFindings(scope: SecurityScope, data: Record<string, any>): SecurityFindingInput[] {
  const findings: SecurityFindingInput[] = []
  const security = data.security
  if (security?.firewall && !['active', 'configured', 'ok'].includes(String(security.firewall.status))) {
    findings.push({ ...scope, ruleId: 'host-firewall-disabled', severity: 'high', title: 'Host firewall is not active',
      description: String(security.firewall.summary ?? 'The host firewall did not report an active configuration.'), subject: 'host:firewall',
      evidence: { status: String(security.firewall.status ?? 'unknown'), rules: Array.isArray(security.firewall.rules) ? security.firewall.rules.length : 0 },
      remediation: 'Apply the declarative firewall policy and confirm only required listeners are public.' })
  }
  for (const port of security?.ports ?? []) {
    const value = String(port.listen ?? '')
    const number = Number(value.match(/:(\d+)$/)?.[1])
    if (port.exposure === 'public' && Number.isFinite(number) && ![22, 80, 443].includes(number)) {
      findings.push({ ...scope, ruleId: 'unexpected-public-listener', severity: 'medium', title: `Unexpected public listener on port ${number}`,
        description: `${String(port.processName ?? 'A process')} is listening publicly outside the standard SSH/HTTP/HTTPS ports.`, subject: `host:port:${number}`,
        evidence: { protocol: String(port.proto ?? ''), listen: value, process: String(port.processName ?? '') },
        remediation: 'Bind the service to loopback/private networking or explicitly document and firewall the required public port.' })
    }
  }
  for (const certificate of security?.tlsCertificates ?? []) {
    const days = Number(certificate.daysRemaining)
    if (Number.isFinite(days) && days < 30) {
      findings.push({ ...scope, ruleId: 'tls-certificate-expiry', severity: days < 14 ? 'high' : 'medium', title: `TLS certificate expires in ${days} days`,
        description: `${String(certificate.domain ?? 'A configured domain')} needs renewal.`, subject: `tls:${String(certificate.domain ?? 'unknown')}`,
        evidence: { domain: String(certificate.domain ?? ''), daysRemaining: days, expires: String(certificate.expires ?? '') },
        remediation: 'Renew the certificate and verify automatic renewal can complete before expiry.' })
    }
  }
  for (const check of data.diagnostics ?? []) {
    if (check.status === 'pass' || check.status === 'ok')
      continue
    findings.push({ ...scope, ruleId: `diagnostic-${String(check.name ?? 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      severity: check.status === 'fail' ? 'high' : 'medium', title: String(check.name ?? 'Host security check'),
      description: String(check.detail ?? 'The host security diagnostic did not pass.'), subject: `diagnostic:${String(check.name ?? 'unknown')}`,
      evidence: { status: String(check.status ?? 'unknown') }, remediation: 'Follow the diagnostic guidance, rerun the check, and confirm the finding resolves.' })
  }
  return findings
}

export function recordDashboardHostPosture(posture: SecurityPostureStore, scope: SecurityScope, data: Record<string, any>): { run: SecurityScanRun, findings: SecurityPostureFinding[] } {
  const available = !!data.security || Array.isArray(data.diagnostics)
  const findings = available ? hostFindings(scope, data) : []
  return posture.recordScan({ ...scope, scannerId: 'host-posture', scannerVersion: '1.0.0', status: !available ? 'unavailable' : findings.length ? 'failed' : 'passed', findings,
    metadata: { source: 'dashboard-live-probe', checks: Array.isArray(data.diagnostics) ? data.diagnostics.length : 0 },
    error: available ? undefined : 'Live host posture data was unavailable; source and provider checks remain usable.' })
}

export function productionChangeReview(posture: SecurityPostureStore, input: { scope: SecurityScope & { projectId: string, environmentId: string }, operationId?: string, desiredConfigHash?: string }): { decision: SecurityDeployDecision, summary: JsonValue } {
  const decision = posture.evaluateGate({ ...input.scope, operationId: input.operationId })
  const findings = posture.listFindings({ ...input.scope, limit: 1_000 }).filter(finding => finding.status !== 'resolved')
  return {
    decision,
    summary: {
      desiredConfigHash: input.desiredConfigHash ?? null,
      securityImpact: { critical: findings.filter(item => item.severity === 'critical').length, high: findings.filter(item => item.severity === 'high').length,
        waived: findings.filter(item => item.status === 'waived').length, assigned: findings.filter(item => !!item.ownerActorId).length },
      blockingFindingIds: decision.findingIds,
      policy: { id: decision.policyId, version: decision.policyVersion },
      scannerVersions: decision.scannerVersions,
    },
  }
}
