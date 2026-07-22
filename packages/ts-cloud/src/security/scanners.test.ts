import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { SecurityPostureStore } from './posture-store'
import { AwsIamCapabilityScanner, SecurityScannerRunner } from './scanners'

function fixture() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  const posture = new SecurityPostureStore(controlPlane)
  return { controlPlane, posture, organization, project, environment }
}

describe('SecurityScannerRunner', () => {
  it('bounds scanner runtime and persists an explicit unavailable result', async () => {
    const f = fixture()
    const runner = new SecurityScannerRunner(f.posture, { defaultTimeoutMs: 100 })
    const result = await runner.run({ id: 'hung-scanner', version: '7', timeoutMs: 100, scan: () => new Promise(() => {}) }, {
      organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id,
    })
    expect(result.run).toMatchObject({ scannerId: 'hung-scanner', scannerVersion: '7', status: 'unavailable' })
    expect(result.run.error).toContain('timeout')
  })

  it('turns real IAM simulation decisions into normalized least-privilege findings', async () => {
    const f = fixture()
    const scanner = new AwsIamCapabilityScanner(['cloudformation:CreateStack', 's3:GetObject'], { client: {
      getCallerIdentity: async () => ({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:role/deployer' }),
      simulatePrincipalPolicy: async () => ({ EvaluationResults: [
        { EvalActionName: 'cloudformation:CreateStack', EvalDecision: 'allowed' },
        { EvalActionName: 's3:GetObject', EvalDecision: 'implicitDeny' },
      ] }),
    } })
    const result = await new SecurityScannerRunner(f.posture).run(scanner, {
      organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id,
    })
    expect(result.run.status).toBe('failed')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({ severity: 'high', title: 'Missing AWS capability: s3:GetObject' })
    expect(result.findings[0].evidence).toMatchObject({ decision: 'implicitDeny', principalArn: 'arn:aws:iam::123456789012:role/deployer' })
  })
})
