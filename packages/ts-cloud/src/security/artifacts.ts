import type { JsonValue } from '../control-plane'
import type { ReleaseSecurityArtifact, SecurityPostureFinding } from './types'
import type { SecurityPostureStore } from './posture-store'
import { createHash, createVerify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

export interface CycloneDxComponent {
  type: 'application' | 'library' | 'container'
  name: string
  version: string
  purl?: string
  scope?: 'required' | 'optional' | 'excluded'
  hashes?: Array<{ alg: 'SHA-256', content: string }>
}

export interface CycloneDxDocument {
  bomFormat: 'CycloneDX'
  specVersion: '1.5'
  serialNumber: string
  version: 1
  metadata: { timestamp: string, component: CycloneDxComponent, tools: Array<{ vendor: string, name: string, version: string }> }
  components: CycloneDxComponent[]
}

export interface ReleaseProvenance {
  _type: 'https://in-toto.io/Statement/v1'
  subject: Array<{ name: string, digest: { sha256: string } }>
  predicateType: 'https://slsa.dev/provenance/v1'
  predicate: {
    buildDefinition: { buildType: string, externalParameters: JsonValue, internalParameters: JsonValue, resolvedDependencies: JsonValue[] }
    runDetails: { builder: { id: string }, metadata: { invocationId: string, startedOn: string, finishedOn: string } }
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function packageComponents(manifest: Record<string, unknown>): CycloneDxComponent[] {
  const groups: Array<[string, CycloneDxComponent['scope']]> = [
    ['dependencies', 'required'], ['optionalDependencies', 'optional'], ['devDependencies', 'excluded'], ['peerDependencies', 'required'],
  ]
  const found = new Map<string, CycloneDxComponent>()
  for (const [field, scope] of groups) {
    const dependencies = manifest[field]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
      continue
    for (const [name, rawVersion] of Object.entries(dependencies)) {
      const version = String(rawVersion).replace(/^[~^]/, '')
      const key = `${name}@${version}`
      if (!found.has(key))
        found.set(key, { type: 'library', name, version, purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`, scope })
    }
  }
  return [...found.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
}

/** Creates a deterministic local-only CycloneDX document from the release package manifest. */
export function generateCycloneDxSbom(root: string, options: { now?: Date, serial?: string } = {}): CycloneDxDocument {
  const manifestPath = join(resolve(root), 'package.json')
  if (!existsSync(manifestPath))
    throw new Error(`Cannot generate an SBOM: ${manifestPath} was not found`)
  const encoded = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(encoded) as Record<string, unknown>
  const name = String(manifest.name ?? basename(resolve(root)))
  const version = String(manifest.version ?? '0.0.0')
  const digest = sha256(encoded)
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: options.serial ?? `urn:uuid:${crypto.randomUUID()}`, version: 1,
    metadata: {
      timestamp: (options.now ?? new Date()).toISOString(),
      component: { type: 'application', name, version, purl: `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`, hashes: [{ alg: 'SHA-256', content: digest }] },
      tools: [{ vendor: 'ts-cloud', name: 'security-posture', version: '1.0.0' }],
    },
    components: packageComponents(manifest),
  }
}

/** Uses a local Syft binary for full image inventory; no report or source is sent to a service. */
export async function generateImageSbom(imageRef: string, options: { executable?: string, signal?: AbortSignal } = {}): Promise<CycloneDxDocument> {
  const child = Bun.spawn([options.executable ?? 'syft', imageRef, '-o', 'cyclonedx-json'], {
    stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', SYFT_CHECK_FOR_APP_UPDATE: 'false' },
  })
  const abort = () => child.kill()
  options.signal?.addEventListener('abort', abort, { once: true })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  options.signal?.removeEventListener('abort', abort)
  if (exitCode !== 0)
    throw new Error(stderr.slice(0, 2_000) || `Syft exited with ${exitCode}`)
  return JSON.parse(stdout) as CycloneDxDocument
}

export function attachSbomToRelease(posture: SecurityPostureStore, scope: { organizationId: string, projectId: string, environmentId?: string, releaseId: string }, sbom: CycloneDxDocument): ReleaseSecurityArtifact {
  const content = JSON.stringify(sbom)
  return posture.addReleaseArtifact({ ...scope, kind: 'sbom', format: `cyclonedx-${sbom.specVersion}+json`, digest: `sha256:${sha256(content)}`,
    summary: { component: sbom.metadata.component.name, version: sbom.metadata.component.version, components: sbom.components.length }, content, sensitive: true })
}

export function attachVulnerabilitySummary(posture: SecurityPostureStore, scope: { organizationId: string, projectId: string, environmentId?: string, releaseId: string }, findings: SecurityPostureFinding[]): ReleaseSecurityArtifact {
  const summary = { total: findings.length, critical: 0, high: 0, medium: 0, low: 0, info: 0, fixable: 0 }
  for (const finding of findings) {
    summary[finding.severity]++
    const evidence = finding.evidence as Record<string, JsonValue>
    if (typeof evidence.fixedVersion === 'string' && evidence.fixedVersion)
      summary.fixable++
  }
  const content = JSON.stringify({ releaseId: scope.releaseId, generatedAt: new Date().toISOString(), findings: findings.map(finding => ({ id: finding.id, ruleId: finding.ruleId, severity: finding.severity, subject: finding.subject, remediation: finding.remediation })) })
  return posture.addReleaseArtifact({ ...scope, kind: 'vulnerability_summary', format: 'ts-cloud-vulnerability-summary+json', digest: `sha256:${sha256(content)}`, summary, content, sensitive: true })
}

export function createReleaseProvenance(input: { artifactName: string, artifact: string | Uint8Array, invocationId: string, startedAt: string, completedAt: string, externalParameters?: JsonValue, resolvedDependencies?: JsonValue[] }): ReleaseProvenance {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: input.artifactName, digest: { sha256: sha256(input.artifact) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: { buildType: 'https://ts-cloud.dev/build/v1', externalParameters: input.externalParameters ?? {}, internalParameters: {}, resolvedDependencies: input.resolvedDependencies ?? [] },
      runDetails: { builder: { id: 'https://ts-cloud.dev/builders/local/v1' }, metadata: { invocationId: input.invocationId, startedOn: input.startedAt, finishedOn: input.completedAt } },
    },
  }
}

export function verifyArtifactSignature(input: { artifact: string | Uint8Array, expectedSha256: string, signature?: string, publicKey?: string }): { digestValid: boolean, signature: 'verified' | 'invalid' | 'not_configured' } {
  const expected = input.expectedSha256.replace(/^sha256:/, '').toLowerCase()
  const digestValid = sha256(input.artifact) === expected
  if (!input.signature || !input.publicKey)
    return { digestValid, signature: 'not_configured' }
  try {
    const verifier = createVerify('SHA256')
    verifier.update(input.artifact)
    verifier.end()
    return { digestValid, signature: verifier.verify(input.publicKey, Buffer.from(input.signature, 'base64')) ? 'verified' : 'invalid' }
  }
  catch {
    return { digestValid, signature: 'invalid' }
  }
}
