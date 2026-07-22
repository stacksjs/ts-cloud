/**
 * Packages a Node/Bun serverless application into a single Lambda deployment
 * artifact (a ZIP holding one bundled handler file). The same artifact backs all
 * three functions (http/queue/cli); they differ only by handler export.
 *
 * Flow: run build hooks → write a generated bootstrap that wires the user's
 * entry to the runtime adapter → bundle with `Bun.build` (target node) → ZIP →
 * content-hash. The hash is the artifact identity used for skip-by-hash uploads,
 * redeploys, and rollbacks.
 */
import type { ServerlessAppConfig } from '../types'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateBootstrap } from './bootstrap'
import { createZip } from './zip'

/** Absolute path to the bundled runtime adapter source shipped with this package. */
function adapterSourcePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime', 'adapter.ts')
}

export interface PackageOptions {
  /** Project root the entry/build hooks resolve against. @default process.cwd() */
  projectRoot?: string
  /** The serverless app manifest. */
  app: ServerlessAppConfig
  /** Skip running `app.build` hooks (already run by the orchestrator). */
  skipBuild?: boolean
  /** Progress callback. */
  onStep?: (message: string) => void
}

export interface PackagedArtifact {
  /** The ZIP bytes ready to upload to S3 / Lambda. */
  zip: Buffer
  /** The raw bundled JS (before zipping) — used for container-image builds. */
  bundle: Buffer
  /** SHA-256 of the ZIP bytes (hex). Stable for identical inputs. */
  sha256: string
  /** Handler file basename inside the artifact (no extension), e.g. `index`. */
  handlerFile: string
  /** Lambda handler strings for each function. */
  handlers: { http: string; queue: string; cli: string }
  /** Size of the bundled JS before zipping. */
  bundleBytes: number
}

/** Run build hooks locally, failing fast on the first non-zero exit. */
export function runBuildHooks(hooks: string[] | undefined, cwd: string, onStep?: (m: string) => void): void {
  for (const hook of hooks ?? []) {
    onStep?.(`build: ${hook}`)
    execSync(hook, { stdio: 'inherit', cwd })
  }
}

/** SHA-256 hex of arbitrary bytes. */
export function sha256(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** S3 key for a deployment artifact, namespaced by project/env and content hash. */
export function artifactKey(slug: string, environment: string, hash: string): string {
  return `deployments/${slug}/${environment}/${hash}.zip`
}

export async function packageServerlessApp(opts: PackageOptions): Promise<PackagedArtifact> {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd())
  const { app } = opts

  if (!opts.skipBuild) runBuildHooks(app.build, projectRoot, opts.onStep)

  const entry = app.entry
  if (!entry) throw new Error('serverless app: `entry` is required to package a Node/Bun application')
  const entryPath = isAbsolute(entry) ? entry : join(projectRoot, entry)

  // Stage a temp build dir: copy the adapter beside a generated bootstrap, then
  // bundle the bootstrap (which imports the user entry by absolute path).
  const stage = mkdtempSync(join(tmpdir(), 'tscloud-pkg-'))
  try {
    cpSync(adapterSourcePath(), join(stage, 'adapter.ts'))
    const bootstrapPath = join(stage, 'bootstrap.ts')
    writeFileSync(bootstrapPath, generateBootstrap({ entryImport: entryPath, adapterImport: './adapter' }))

    opts.onStep?.('bundling application')
    // Bun apps target the Bun runtime (so Bun.* APIs work on the Bun layer);
    // everything else targets node (managed runtime or the Node custom layer).
    const result = await Bun.build({
      entrypoints: [bootstrapPath],
      target: app.kind === 'bun' ? 'bun' : 'node',
      format: 'esm',
      minify: false,
      sourcemap: 'none',
    })
    if (!result.success) {
      const logs = result.logs.map((l) => String(l)).join('\n')
      throw new Error(`serverless app bundle failed:\n${logs}`)
    }

    const output = result.outputs[0]
    const bundle = Buffer.from(await output.arrayBuffer())

    // Lambda detects `.mjs` as ESM; handler base is `index`.
    const handlerFile = 'index'
    const zip = createZip([{ name: `${handlerFile}.mjs`, data: bundle }])

    return {
      zip,
      bundle,
      sha256: sha256(zip),
      handlerFile,
      handlers: {
        http: app.handlers?.http ?? `${handlerFile}.http`,
        queue: app.handlers?.queue ?? `${handlerFile}.queue`,
        cli: app.handlers?.cli ?? `${handlerFile}.cli`,
      },
      bundleBytes: bundle.length,
    }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
