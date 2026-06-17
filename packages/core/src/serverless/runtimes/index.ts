/**
 * Unified custom-runtime (`provided.al2023`) layer builders for Node and Bun.
 *
 * Both ship the same shape as the PHP runtime layer — a binary + a `bootstrap`
 * entrypoint + the shared {@link runtime.mjs} Runtime API loop — so newer Node
 * versions (e.g. 24, beyond AWS's managed runtimes) and Bun run on Lambda the
 * same way Laravel/PHP does. Unlike the PHP layer these need no Docker: the
 * official binary is downloaded and zipped directly.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZip, type ZipEntry } from '../zip'

export type RuntimeArch = 'x86_64' | 'arm64'

function assetsDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** The shared Runtime API loop source (bundled into every node/bun layer). */
export function sharedRuntimeLoop(): string {
  return readFileSync(join(assetsDir(), 'runtime.mjs'), 'utf-8')
}

function bootstrap(kind: 'node' | 'bun'): string {
  return readFileSync(join(assetsDir(), `${kind}-bootstrap`), 'utf-8')
}

export interface BuildRuntimeLayerOptions {
  /** Runtime version (Node major like '24', or a Bun release like '1.3.13'). */
  version: string
  /** Target architecture. @default 'x86_64' */
  architecture?: RuntimeArch
  /** Progress callback. */
  onStep?: (message: string) => void
}

export interface RuntimeLayerArtifact {
  zip: Buffer
  architecture: RuntimeArch
  version: string
  fileCount: number
}

/**
 * Build the Node custom-runtime layer (any Node version, incl. those without an
 * AWS managed runtime such as 24). Downloads the official linux build and
 * assembles `bootstrap` + `runtime.mjs` + `bin/node`.
 */
export function buildNodeRuntimeLayerZip(options: BuildRuntimeLayerOptions): RuntimeLayerArtifact {
  const architecture = options.architecture ?? 'x86_64'
  const nodeArch = architecture === 'arm64' ? 'arm64' : 'x64'
  const version = options.version.replace(/^v/, '')
  const step = options.onStep ?? (() => {})

  const stage = mkdtempSync(join(tmpdir(), 'tscloud-node-layer-'))
  try {
    // Resolve the exact version: a bare major (e.g. '24') is expanded to the
    // latest release for that line via the nodejs.org index.
    const exact = version.includes('.') ? version : resolveLatestNode(version)
    const dir = `node-v${exact}-linux-${nodeArch}`
    const url = `https://nodejs.org/dist/v${exact}/${dir}.tar.xz`
    step(`downloading Node ${exact} (${architecture})`)
    const tar = join(stage, 'node.tar.xz')
    fetchToFile(url, tar)

    step('extracting node binary')
    execFileSync('tar', ['-xf', tar, '-C', stage, `${dir}/bin/node`], { stdio: 'inherit' })
    const nodeBin = readFileSync(join(stage, dir, 'bin', 'node'))

    step('packaging layer')
    const entries: ZipEntry[] = [
      { name: 'bootstrap', data: bootstrap('node'), mode: 0o755 },
      { name: 'runtime.mjs', data: sharedRuntimeLoop(), mode: 0o644 },
      { name: 'bin/node', data: nodeBin, mode: 0o755 },
    ]
    return { zip: createZip(entries), architecture, version: exact, fileCount: entries.length }
  }
  finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * Build the Bun custom-runtime layer. Downloads the pinned Bun release and
 * assembles `bootstrap` + `runtime.mjs` + `bin/bun`.
 */
export function buildBunRuntimeLayerZip(options: BuildRuntimeLayerOptions): RuntimeLayerArtifact {
  const architecture = options.architecture ?? 'x86_64'
  const bunArch = architecture === 'arm64' ? 'bun-linux-aarch64' : 'bun-linux-x64'
  const version = options.version === 'latest' ? '' : options.version.replace(/^v/, '')
  const step = options.onStep ?? (() => {})

  const stage = mkdtempSync(join(tmpdir(), 'tscloud-bun-layer-'))
  try {
    // GitHub's "latest" lives at /releases/latest/download/<asset>, whereas a
    // pinned release is at /releases/download/<tag>/<asset>.
    const url = version
      ? `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${bunArch}.zip`
      : `https://github.com/oven-sh/bun/releases/latest/download/${bunArch}.zip`
    step(`downloading Bun ${version || 'latest'} (${architecture})`)
    const zipPath = join(stage, 'bun.zip')
    fetchToFile(url, zipPath)

    step('extracting bun binary')
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', stage], { stdio: 'inherit' })
    const bunBin = readFileSync(join(stage, bunArch, 'bun'))

    step('packaging layer')
    const entries: ZipEntry[] = [
      { name: 'bootstrap', data: bootstrap('bun'), mode: 0o755 },
      { name: 'runtime.mjs', data: sharedRuntimeLoop(), mode: 0o644 },
      { name: 'bin/bun', data: bunBin, mode: 0o755 },
    ]
    return { zip: createZip(entries), architecture, version: version || 'latest', fileCount: entries.length }
  }
  finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Download a URL to a file using curl (following redirects). */
function fetchToFile(url: string, dest: string): void {
  execFileSync('curl', ['-fsSL', '-o', dest, url], { stdio: ['ignore', 'ignore', 'inherit'] })
}

/** Resolve the latest patch release for a Node major line via nodejs.org. */
function resolveLatestNode(major: string): string {
  const indexJson = execFileSync('curl', ['-fsSL', 'https://nodejs.org/dist/index.json'], { encoding: 'utf-8' })
  const releases = JSON.parse(indexJson) as Array<{ version: string }>
  const match = releases.find(r => r.version.startsWith(`v${major}.`))
  if (!match)
    throw new Error(`No Node release found for major version ${major}`)
  return match.version.replace(/^v/, '')
}
