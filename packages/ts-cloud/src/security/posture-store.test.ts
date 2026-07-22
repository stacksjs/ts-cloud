import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { SecurityPostureStore } from './posture-store'

function fixture() {
  let now = new Date('2026-07-21T12:00:00.000Z')
  let sequence = 0
  const id = () => `security-id-${++sequence}`
  const controlPlane = new ControlPlaneStore({ path: ':memory:', now: () => now, id })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const actor = controlPlane.createActor({ kind: 'user', externalId: 'security-owner', displayName: 'Security Owner' })
  const posture = new SecurityPostureStore(controlPlane, { now: () => now, id })
  return { controlPlane, posture, organization, project, environment, actor, setNow: (value: string) => { now = new Date(value) } }
}

describe('SecurityPostureStore finding lifecycle', () => {
  it('deduplicates findings, redacts evidence, resolves remediation, and tracks recurrence', () => {
    const f = fixture()
    const scope = { organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id }
    const first = f.posture.recordScan({ ...scope, scannerId: 'fixture', scannerVersion: '1.0.0', status: 'failed', findings: [{
      ...scope, ruleId: 'CVE-2026-0001', severity: 'critical', title: 'Critical package', description: 'A vulnerable package was found.',
      subject: 'image:openssl@1', evidence: { token: 'must-never-persist', installedVersion: '1' }, remediation: 'Upgrade OpenSSL.',
    }] })
    expect(first.findings).toHaveLength(1)
    expect(first.findings[0].evidence).toEqual({ token: '[REDACTED]', installedVersion: '1' })

    f.setNow('2026-07-21T12:05:00.000Z')
    const repeated = f.posture.recordScan({ ...scope, scannerId: 'fixture', scannerVersion: '1.0.1', status: 'failed', findings: [{
      ...scope, ruleId: 'CVE-2026-0001', severity: 'critical', title: 'Critical package', description: 'Still present.', subject: 'image:openssl@1',
    }] })
    expect(repeated.findings[0].id).toBe(first.findings[0].id)
    expect(repeated.findings[0].firstSeenAt).toBe('2026-07-21T12:00:00.000Z')

    f.setNow('2026-07-21T12:10:00.000Z')
    f.posture.recordScan({ ...scope, scannerId: 'fixture', scannerVersion: '1.0.1', status: 'passed', findings: [] })
    expect(f.posture.getFinding(first.findings[0].id)?.status).toBe('resolved')

    f.setNow('2026-07-21T12:15:00.000Z')
    const recurrence = f.posture.recordScan({ ...scope, scannerId: 'fixture', scannerVersion: '1.0.2', status: 'failed', findings: [{
      ...scope, ruleId: 'CVE-2026-0001', severity: 'high', title: 'Package returned', description: 'The issue recurred.', subject: 'image:openssl@1',
    }] })
    expect(recurrence.findings[0]).toMatchObject({ id: first.findings[0].id, status: 'open', recurrenceCount: 1, severity: 'high' })
    expect(f.controlPlane.listEvents({ organizationId: f.organization.id }).map(event => event.type)).toContain('security.finding.resolved')
  })

  it('blocks production, allows a valid waiver, re-blocks on expiry, then allows remediation', () => {
    const f = fixture()
    const scope = { organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id }
    const policy = f.posture.createPolicy({ ...scope, name: 'Production baseline', scannerFailMode: 'closed', actorId: f.actor.id,
      rules: [{ minimumSeverity: 'critical', action: 'block' }, { minimumSeverity: 'medium', action: 'warn' }] })
    const scan = f.posture.recordScan({ ...scope, scannerId: 'container', scannerVersion: '2.4.1', status: 'failed', findings: [{
      ...scope, ruleId: 'CVE-2026-9999', severity: 'critical', title: 'Known exploit', description: 'Exploit is public.', subject: 'release-1:libc', remediation: 'Rebuild on the patched base image.',
    }] })
    const blocked = f.posture.evaluateGate({ ...scope, policyId: policy.id })
    expect(blocked).toMatchObject({ outcome: 'block', policyVersion: 1, scannerVersions: { container: '2.4.1' } })
    expect(blocked.explanation).toContain('blocked by policy')

    const waiver = f.posture.createWaiver({ findingId: scan.findings[0].id, policyId: policy.id, actorId: f.actor.id,
      reason: 'Emergency customer recovery while the patched image builds.', referenceUrl: 'https://tickets.example/SEC-1', expiresAt: '2026-07-21T13:00:00.000Z' })
    expect(f.posture.evaluateGate({ ...scope, policyId: policy.id })).toMatchObject({ outcome: 'allow', waiverIds: [waiver.id] })

    f.setNow('2026-07-21T13:01:00.000Z')
    expect(f.posture.evaluateGate({ ...scope, policyId: policy.id }).outcome).toBe('block')
    expect(f.posture.getFinding(scan.findings[0].id)?.status).toBe('open')

    f.setNow('2026-07-21T13:02:00.000Z')
    f.posture.recordScan({ ...scope, scannerId: 'container', scannerVersion: '2.4.2', status: 'passed', findings: [] })
    expect(f.posture.evaluateGate({ ...scope, policyId: policy.id }).outcome).toBe('allow')
    expect(f.posture.listDecisions(f.environment.id)).toHaveLength(4)
  })

  it('supports ownership, comments, sensitive exports, and degraded scanner states', () => {
    const f = fixture()
    const scope = { organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id }
    const policy = f.posture.createPolicy({ ...scope, name: 'Fail closed', scannerFailMode: 'closed', requiredScanners: ['tls'], rules: [{ minimumSeverity: 'high', action: 'block' }] })
    const scan = f.posture.recordScan({ ...scope, scannerId: 'tls', scannerVersion: '1', status: 'unavailable', error: 'token=not-for-logs' })
    expect(scan.run.error).not.toContain('not-for-logs')
    expect(f.posture.evaluateGate({ ...scope, policyId: policy.id }).outcome).toBe('block')

    const finding = f.posture.recordScan({ ...scope, scannerId: 'host', scannerVersion: '1', status: 'failed', findings: [{
      ...scope, ruleId: 'ssh-password', severity: 'medium', title: 'Password SSH', description: 'Password auth is enabled.', subject: 'sshd',
    }] }).findings[0]
    expect(f.posture.assignFinding(finding.id, f.actor.id, f.actor.id).ownerActorId).toBe(f.actor.id)
    expect(f.posture.acknowledgeFinding(finding.id, f.actor.id).status).toBe('acknowledged')
    expect(f.posture.addComment({ findingId: finding.id, actorId: f.actor.id, body: 'Tracked in the host hardening sprint.', referenceUrl: 'https://tickets.example/SEC-2' }).body).toContain('hardening')
    expect(f.posture.exportPosture(f.organization.id)).toMatchObject({ format: 'ts-cloud-security-posture', version: 1 })
  })

  it('makes a missing required scanner an explicit fail-closed decision', () => {
    const f = fixture()
    const scope = { organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id }
    const policy = f.posture.createPolicy({ ...scope, name: 'Required checks', scannerFailMode: 'closed', requiredScanners: ['source-secrets'], rules: [{ minimumSeverity: 'critical', action: 'block' }] })
    const decision = f.posture.evaluateGate({ ...scope, policyId: policy.id })
    expect(decision).toMatchObject({ outcome: 'block', scannerVersions: { 'source-secrets': 'unavailable' } })
    expect(decision.explanation).toContain('failed closed')
  })
})
