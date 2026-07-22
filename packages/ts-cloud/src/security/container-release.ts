import type { JsonValue } from '../control-plane'
import type { CycloneDxDocument } from './artifacts'
import type { SecurityPostureStore } from './posture-store'
import type { SecurityScanner } from './scanners'
import type { SecurityScope } from './types'
import { attachProvenanceToRelease, attachSbomToRelease, attachVulnerabilitySummary, createReleaseProvenance, generateCycloneDxSbom, generateImageSbom } from './artifacts'
import { SecurityScannerRunner, TrivyImageScanner } from './scanners'

export interface SecureContainerReleaseInput {
  scope: SecurityScope & { projectId: string; environmentId: string }
  releaseId: string
  imageRef: string
  imageSha256?: string
  artifactRoot: string
  invocationId: string
  startedAt: string
  completedAt?: string
  externalParameters?: JsonValue
  scanner?: SecurityScanner
  scannerTimeoutMs?: number
  sbomTimeoutMs?: number
  generateImageSbom?: (imageRef: string, options: { signal?: AbortSignal }) => Promise<CycloneDxDocument>
}

/**
 * Produces the security record for a built container without sending image or
 * source data to a hosted service. Optional local tooling may be absent: that
 * state is persisted and a manifest SBOM is used when possible.
 */
export async function secureContainerRelease(
  _posture: SecurityPostureStore,
  _input: SecureContainerReleaseInput,
): Promise<{
  scan: Awaited<ReturnType<SecurityScannerRunner['run']>>
  sbomSource: 'image' | 'manifest' | 'unavailable'
}> {
  const scanner = _input.scanner ?? new TrivyImageScanner({ timeoutMs: _input.scannerTimeoutMs })
  const runner = new SecurityScannerRunner(_posture, { defaultTimeoutMs: _input.scannerTimeoutMs ?? 120_000 })
  const scan = await runner.run(scanner, { ..._input.scope, releaseId: _input.releaseId, imageRef: _input.imageRef })

  const artifactScope = { ..._input.scope, releaseId: _input.releaseId }
  attachVulnerabilitySummary(_posture, artifactScope, scan.findings)

  const sbomGenerator = _input.generateImageSbom ?? generateImageSbom
  const controller = new AbortController()
  const timeoutMs = Math.max(100, _input.sbomTimeoutMs ?? 120_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`syft-sbom exceeded its ${timeoutMs}ms timeout`))
    }, timeoutMs)
  })
  let sbomSource: 'image' | 'manifest' | 'unavailable' = 'unavailable'
  try {
    const sbom = await Promise.race([sbomGenerator(_input.imageRef, { signal: controller.signal }), timeout])
    attachSbomToRelease(_posture, artifactScope, sbom)
    _posture.recordScan({
      ..._input.scope,
      releaseId: _input.releaseId,
      scannerId: 'syft-sbom',
      scannerVersion: 'local',
      status: 'passed',
      metadata: {
        imageRef: _input.imageRef,
        format: `cyclonedx-${sbom.specVersion}+json`,
        components: sbom.components.length,
        localOnly: true,
      },
    })
    sbomSource = 'image'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const fallback = generateCycloneDxSbom(_input.artifactRoot)
      attachSbomToRelease(_posture, artifactScope, fallback)
      _posture.recordScan({
        ..._input.scope,
        releaseId: _input.releaseId,
        scannerId: 'syft-sbom',
        scannerVersion: 'local',
        status: 'unsupported',
        error: `Image inventory was unavailable; attached a package-manifest SBOM instead. ${message}`,
        metadata: {
          imageRef: _input.imageRef,
          fallback: 'package-manifest',
          components: fallback.components.length,
          localOnly: true,
        },
      })
      sbomSource = 'manifest'
    } catch (fallbackError) {
      _posture.recordScan({
        ..._input.scope,
        releaseId: _input.releaseId,
        scannerId: 'syft-sbom',
        scannerVersion: 'local',
        status: 'unavailable',
        error: `Image and manifest SBOM generation were unavailable. ${message}; ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        metadata: { imageRef: _input.imageRef, localOnly: true },
      })
    }
  } finally {
    if (timer) clearTimeout(timer)
  }

  const provenance = createReleaseProvenance({
    artifactName: _input.imageRef,
    artifact: _input.imageSha256 ? undefined : _input.imageRef,
    artifactSha256: _input.imageSha256,
    invocationId: _input.invocationId,
    startedAt: _input.startedAt,
    completedAt: _input.completedAt ?? new Date().toISOString(),
    externalParameters: _input.externalParameters ?? { imageRef: _input.imageRef },
  })
  attachProvenanceToRelease(_posture, artifactScope, provenance)
  return { scan, sbomSource }
}
