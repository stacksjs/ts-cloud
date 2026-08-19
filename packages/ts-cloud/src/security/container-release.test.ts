import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlPlaneStore } from '../control-plane'
import { secureContainerRelease } from './container-release'
import { SecurityPostureStore } from './posture-store'

function fixture() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
  const project = controlPlane.createProject({ organizationId: organization.id, slug: 'web', name: 'Web' })
  const environment = controlPlane.createEnvironment({
    projectId: project.id,
    slug: 'production',
    name: 'Production',
    kind: 'production',
  })
  return { controlPlane, posture: new SecurityPostureStore(controlPlane), organization, project, environment }
}

describe('secureContainerRelease', () => {
  it('links image scan, SBOM, vulnerability summary, and digest-bound provenance to a release', async () => {
    const f = fixture()
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-container-release-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
      const scope = { organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id }
      const digest = 'a'.repeat(64)
      const result = await secureContainerRelease(f.posture, {
        scope,
        releaseId: `release@sha256:${digest}`,
        imageRef: 'registry.example/app:v1',
        imageSha256: digest,
        artifactRoot: root,
        invocationId: 'deploy-1',
        startedAt: '2026-07-21T12:00:00.000Z',
        completedAt: '2026-07-21T12:01:00.000Z',
        scanner: {
          id: 'trivy-image',
          version: 'fixture',
          scan: async (context) => ({
            status: 'failed',
            findings: [
              {
                ...context,
                ruleId: 'CVE-2026-0001',
                severity: 'high',
                title: 'Affected package',
                description: 'The package is vulnerable.',
                subject: `${context.imageRef}:libc`,
                remediation: 'Upgrade libc.',
              },
            ],
          }),
        },
        generateImageSbom: async () => ({
          bomFormat: 'CycloneDX',
          specVersion: '1.5',
          serialNumber: 'urn:uuid:test',
          version: 1,
          metadata: {
            timestamp: '2026-07-21T12:00:00.000Z',
            component: { type: 'container', name: 'app', version: 'v1' },
            tools: [],
          },
          components: [],
        }),
      })
      expect(result.scan.run.status).toBe('failed')
      expect(result.sbomSource).toBe('image')
      expect(f.posture.listReleaseArtifacts(`release@sha256:${digest}`)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'sbom' }),
          expect.objectContaining({ kind: 'vulnerability_summary', summary: expect.objectContaining({ high: 1 }) }),
          expect.objectContaining({ kind: 'provenance' }),
        ]),
      )
      const provenance = JSON.parse(
        f.posture.listReleaseArtifacts(`release@sha256:${digest}`, true).find((item) => item.kind === 'provenance')!
          .content!,
      )
      expect(provenance.subject[0].digest.sha256).toBe(digest)
    } finally {
      rmSync(root, { recursive: true, force: true })
      f.controlPlane.close()
    }
  })

  it('records unavailable image inventory and attaches a manifest fallback', async () => {
    const f = fixture()
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-container-release-'))
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'fallback-app', version: '2.0.0', dependencies: { hono: '4.0.0' } }),
      )
      const scope = { organizationId: f.organization.id, projectId: f.project.id, environmentId: f.environment.id }
      const result = await secureContainerRelease(f.posture, {
        scope,
        releaseId: 'fallback-release',
        imageRef: 'local/fallback:v2',
        artifactRoot: root,
        invocationId: 'deploy-2',
        startedAt: '2026-07-21T12:00:00.000Z',
        scanner: {
          id: 'trivy-image',
          version: 'fixture',
          scan: async () => ({ status: 'unsupported', findings: [], error: 'Trivy is not installed' }),
        },
        generateImageSbom: async () => {
          throw new Error('Syft is not installed')
        },
      })
      expect(result.sbomSource).toBe('manifest')
      expect(f.posture.listScanRuns({ ...scope }).find((run) => run.scannerId === 'syft-sbom')).toMatchObject({
        status: 'unsupported',
      })
      expect(f.posture.listReleaseArtifacts('fallback-release')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'sbom', summary: expect.objectContaining({ components: 1 }) }),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
      f.controlPlane.close()
    }
  })
})
