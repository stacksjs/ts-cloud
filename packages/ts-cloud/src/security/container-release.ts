import type { JsonValue } from '../control-plane'
import type { SecurityScanner } from './scanners'
import type { CycloneDxDocument } from './artifacts'
import type { SecurityPostureStore } from './posture-store'
import type { SecurityScope } from './types'
import { attachProvenanceToRelease, attachSbomToRelease, attachVulnerabilitySummary, createReleaseProvenance, generateCycloneDxSbom, generateImageSbom } from './artifacts'
import { SecurityScannerRunner, TrivyImageScanner } from './scanners'

export interface SecureContainerReleaseInput {
  scope: SecurityScope & { projectId: string, environmentId: string }
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
export async function secureContainerRelease(posture: SecurityPostureStore, input: SecureContainerReleaseInput): Promise<{
  scan: Awaited<ReturnType<SecurityScannerRunner['run']>>
  sbomSource: 'image' | 'manifest' | 'unavailable'
}> {
  const scanner = input.scanner ?? new TrivyImageScanner({ timeoutMs: input.scannerTimeoutMs })
  const runner = new SecurityScannerRunner(posture, { defaultTimeoutMs: input.scannerTimeoutMs ?? 120_000 })
  const scan = await runner.run(scanner, { ...input.scope, releaseId: input.releaseId, imageRef: input.imageRef })

  const artifactScope = { ...input.scope, releaseId: input.releaseId }
  attachVulnerabilitySummary(posture, artifactScope, scan.findings)

  const sbomGenerator = input.generateImageSbom ?? generateImageSbom
  const controller = new AbortController()
  const timeoutMs = Math.max(100, input.sbomTimeoutMs ?? 120_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`syft-sbom exceeded its ${timeoutMs}ms timeout`))
    }, timeoutMs)
  })
  let sbomSource: 'image' | 'manifest' | 'unavailable' = 'unavailable'
  try {
    const sbom = await Promise.race([sbomGenerator(input.imageRef, { signal: controller.signal }), timeout])
    attachSbomToRelease(posture, artifactScope, sbom)
    posture.recordScan({ ...input.scope, releaseId: input.releaseId, scannerId: 'syft-sbom', scannerVersion: 'local', status: 'passed',
      metadata: { imageRef: input.imageRef, format: `cyclonedx-${sbom.specVersion}+json`, components: sbom.components.length, localOnly: true } })
    sbomSource = 'image'
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const fallback = generateCycloneDxSbom(input.artifactRoot)
      attachSbomToRelease(posture, artifactScope, fallback)
      posture.recordScan({ ...input.scope, releaseId: input.releaseId, scannerId: 'syft-sbom', scannerVersion: 'local', status: 'unsupported',
        error: `Image inventory was unavailable; attached a package-manifest SBOM instead. ${message}`, metadata: { imageRef: input.imageRef, fallback: 'package-manifest', components: fallback.components.length, localOnly: true } })
      sbomSource = 'manifest'
    }
    catch (fallbackError) {
      posture.recordScan({ ...input.scope, releaseId: input.releaseId, scannerId: 'syft-sbom', scannerVersion: 'local', status: 'unavailable',
        error: `Image and manifest SBOM generation were unavailable. ${message}; ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        metadata: { imageRef: input.imageRef, localOnly: true } })
    }
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }

  const provenance = createReleaseProvenance({
    artifactName: input.imageRef,
    artifact: input.imageSha256 ? undefined : input.imageRef,
    artifactSha256: input.imageSha256,
    invocationId: input.invocationId,
    startedAt: input.startedAt,
    completedAt: input.completedAt ?? new Date().toISOString(),
    externalParameters: input.externalParameters ?? { imageRef: input.imageRef },
  })
  attachProvenanceToRelease(posture, artifactScope, provenance)
  return { scan, sbomSource }
}
