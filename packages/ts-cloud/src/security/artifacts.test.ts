import { describe, expect, it } from 'bun:test'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { attachSbomToRelease, createReleaseProvenance, generateCycloneDxSbom, verifyArtifactSignature } from './artifacts'
import { SecurityPostureStore } from './posture-store'

function fixture() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = controlPlane.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
  return { posture: new SecurityPostureStore(controlPlane), organization, project, environment }
}

describe('release security artifacts', () => {
  it('generates a component inventory and links the sensitive SBOM to a release', () => {
    const f = fixture()
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-sbom-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/web', version: '1.2.3', dependencies: { hono: '^4.0.0' }, optionalDependencies: { sharp: '0.33.0' } }))
      const sbom = generateCycloneDxSbom(root, { now: new Date('2026-07-21T12:00:00.000Z'), serial: 'urn:uuid:fixture' })
      expect(sbom.components.map(component => component.name)).toEqual(['hono', 'sharp'])
      const artifact = attachSbomToRelease(f.posture, { organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id, releaseId: 'release-1' }, sbom)
      expect(artifact).toMatchObject({ kind: 'sbom', sensitive: true, summary: { components: 2 } })
      expect(f.posture.listReleaseArtifacts('release-1')[0].content).toBeUndefined()
      expect(f.posture.listReleaseArtifacts('release-1', true)[0].content).toContain('CycloneDX')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates digest-bound provenance and optionally verifies a release signature', () => {
    const artifact = 'immutable-release-bundle'
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const signer = createSign('SHA256')
    signer.update(artifact)
    signer.end()
    const signature = signer.sign(privateKey).toString('base64')
    const digest = new Bun.CryptoHasher('sha256').update(artifact).digest('hex')
    expect(verifyArtifactSignature({ artifact, expectedSha256: digest, signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toEqual({ digestValid: true, signature: 'verified' })
    expect(verifyArtifactSignature({ artifact: `${artifact}-tampered`, expectedSha256: digest, signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toEqual({ digestValid: false, signature: 'invalid' })

    const provenance = createReleaseProvenance({ artifactName: 'release.tar.gz', artifact, invocationId: 'deploy-1', startedAt: '2026-07-21T12:00:00.000Z', completedAt: '2026-07-21T12:01:00.000Z' })
    expect(provenance.subject[0]).toEqual({ name: 'release.tar.gz', digest: { sha256: digest } })
    expect(provenance.predicate.runDetails.builder.id).toContain('ts-cloud.dev')
  })
})
