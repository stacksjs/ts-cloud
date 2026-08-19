import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import {
  ensureDefaultSecurityPolicies,
  productionChangeReview,
  recordPreDeploySecretScan,
  recordSkippedSecretScan,
  securityScope,
} from './integration'
import { SecurityPostureStore } from './posture-store'

function fixture(kind: 'production' | 'staging' = 'production') {
  const store = new ControlPlaneStore({ path: ':memory:' })
  const organization = store.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = store.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = store.createEnvironment({ projectId: project.id, slug: kind, name: kind, kind })
  const context = { store, organization, project, environments: new Map([[kind, environment]]) }
  return { context, posture: new SecurityPostureStore(store), scope: securityScope(context, kind) }
}

describe('deployment security integration', () => {
  it('fails closed when a production scan is skipped and allows a clean recorded scan', () => {
    const f = fixture('production')
    const [policy] = ensureDefaultSecurityPolicies(f.context)
    expect(policy).toMatchObject({ scannerFailMode: 'closed', requiredScanners: ['source-secrets'] })
    recordSkippedSecretScan(f.posture, f.scope)
    expect(productionChangeReview(f.posture, { scope: f.scope }).decision.outcome).toBe('block')
    recordPreDeploySecretScan(f.posture, f.scope, {
      passed: true,
      findings: [],
      scannedFiles: 42,
      duration: 12,
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
    })
    expect(productionChangeReview(f.posture, { scope: f.scope }).decision.outcome).toBe('allow')
  })

  it('warns rather than silently passing when a non-production scanner is unavailable', () => {
    const f = fixture('staging')
    ensureDefaultSecurityPolicies(f.context)
    recordSkippedSecretScan(f.posture, f.scope)
    const decision = productionChangeReview(f.posture, { scope: f.scope }).decision
    expect(decision.outcome).toBe('warn')
    expect(decision.explanation).toContain('failed open')
  })
})
