/**
 * Builds the ts-cloud PHP runtime layer ZIP.
 *
 * Runs the generated Dockerfile to produce a /opt tree (PHP + php-fpm +
 * extensions for AL2023), extracts it, injects the runtime assets
 * (bootstrap/runtime loops/fpm config), and packages everything as a Lambda
 * layer ZIP. Publishing the ZIP as a layer version is done by the CLI using the
 * ts-cloud Lambda client; this module only produces the artifact.
 *
 * Requires Docker. Intended to run in CI to publish a versioned, ts-cloud-owned
 * layer that user deploys reference (no per-deploy compilation).
 */

import type { ZipEntry } from '../serverless/zip'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createZip } from '../serverless/zip'
import { generatePhpLayerDockerfile, type PhpDockerfileOptions } from './dockerfile'
import { phpRuntimeLayerAssets } from './runtime-assets'

export interface BuildPhpLayerOptions extends PhpDockerfileOptions {
  /** Target architecture. @default 'x86_64' */
  architecture?: 'x86_64' | 'arm64'
  /** Docker platform override (defaults from architecture). */
  platform?: string
  /** Progress callback. */
  onStep?: (message: string) => void
}

export interface PhpLayerArtifact {
  /** The Lambda layer ZIP bytes. */
  zip: Buffer
  /** Compatible architecture. */
  architecture: 'x86_64' | 'arm64'
  /** Number of files in the layer. */
  fileCount: number
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield * walk(full)
    else yield full
  }
}

/**
 * Build the PHP runtime layer ZIP via Docker. Throws if Docker is unavailable.
 */
export function buildPhpRuntimeLayerZip(options: BuildPhpLayerOptions = {}): PhpLayerArtifact {
  const architecture = options.architecture ?? 'x86_64'
  const platform = options.platform ?? (architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64')
  const step = options.onStep ?? (() => {})

  const stage = mkdtempSync(join(tmpdir(), 'tscloud-php-layer-'))
  const imageTag = 'tscloud-php-layer:build'
  try {
    writeFileSync(join(stage, 'Dockerfile'), generatePhpLayerDockerfile(options))

    step('Building PHP runtime image (docker)')
    execFileSync('docker', ['build', '--platform', platform, '-t', imageTag, stage], { stdio: 'inherit' })

    // Extract /opt from the built image.
    step('Extracting /opt from image')
    const cid = execFileSync('docker', ['create', '--platform', platform, imageTag], { encoding: 'utf-8' }).trim()
    const optDir = join(stage, 'opt')
    try {
      execFileSync('docker', ['cp', `${cid}:/opt/.`, optDir], { stdio: 'inherit' })
    }
    finally {
      execFileSync('docker', ['rm', cid], { stdio: 'ignore' })
    }

    if (!existsSync(optDir))
      throw new Error('layer build produced no /opt directory')

    // Collect the built /opt tree.
    const entries: ZipEntry[] = []
    for (const file of walk(optDir)) {
      const rel = relative(optDir, file).replace(/\\/g, '/')
      const mode = (statSync(file).mode & 0o111) ? 0o755 : 0o644
      entries.push({ name: rel, data: readFileSync(file), mode })
    }

    // Inject/overwrite the runtime assets (bootstrap, runtime loops, fpm config).
    step('Injecting runtime assets')
    const assetPaths = new Set(phpRuntimeLayerAssets().map(a => a.path))
    const filtered = entries.filter(e => !assetPaths.has(e.name))
    for (const asset of phpRuntimeLayerAssets()) {
      filtered.push({ name: asset.path, data: asset.contents, mode: asset.mode })
    }

    step('Packaging layer ZIP')
    const zip = createZip(filtered)
    return { zip, architecture, fileCount: filtered.length }
  }
  finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
