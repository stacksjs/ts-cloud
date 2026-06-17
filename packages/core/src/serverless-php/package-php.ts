/**
 * Packages a Laravel/PHP application into a Lambda deployment artifact.
 *
 * Unlike the Node/Bun path (which bundles a single JS file), a PHP app ships its
 * whole source tree (vendor/ + app/ + public/ + bootstrap/ …). The PHP binary,
 * php-fpm, and the runtime loop come from the PHP runtime layer, not the artifact.
 * Build hooks (composer install + artisan caches) run before packaging because
 * the Lambda filesystem is read-only at runtime.
 */

import type { ServerlessAppConfig } from '../types'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createZip, type ZipEntry } from '../serverless/zip'
import { LARAVEL_SERVERLESS_BUILD_STEPS } from './runtime-assets'

/** Paths excluded from the PHP deployment artifact by default. */
export const PHP_DEFAULT_EXCLUDES: string[] = [
  '.git',
  '.github',
  'node_modules',
  'tests',
  'storage/logs',
  'storage/framework/cache',
  'storage/framework/sessions',
  'storage/framework/views',
  '.env',
  '.env.local',
  '.vapor',
  '.ts-cloud',
  'dist-lambda',
]

export interface PackagePhpOptions {
  projectRoot?: string
  app: ServerlessAppConfig
  skipBuild?: boolean
  /** Extra path prefixes (relative to root) to exclude. */
  exclude?: string[]
  onStep?: (message: string) => void
}

export interface PackagedPhpArtifact {
  zip: Buffer
  sha256: string
  handlers: { http: string, queue: string, cli: string }
  fileCount: number
}

function isExcluded(rel: string, excludes: string[]): boolean {
  return excludes.some(ex => rel === ex || rel.startsWith(`${ex}/`))
}

function* walk(dir: string, root: string, excludes: string[]): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = relative(root, full).replace(/\\/g, '/')
    if (isExcluded(rel, excludes)) continue
    if (statSync(full).isDirectory()) yield * walk(full, root, excludes)
    else yield full
  }
}

/**
 * Run the PHP build hooks (composer install + artisan caches) for a project.
 * Defaults to the Laravel serverless caching steps when none are configured.
 */
export function runPhpBuildHooks(opts: PackagePhpOptions): void {
  if (opts.skipBuild) return
  const projectRoot = resolve(opts.projectRoot ?? process.cwd())
  const steps = opts.app.build ?? LARAVEL_SERVERLESS_BUILD_STEPS
  for (const step of steps) {
    opts.onStep?.(`build: ${step}`)
    execSync(step, { stdio: 'inherit', cwd: projectRoot })
  }
}

/**
 * Collect the PHP application file tree (respecting excludes) as zip entries.
 * Shared by {@link packagePhpApp} (zips) and the container-image staging (writes
 * the entries to a build context).
 */
export function collectPhpAppEntries(projectRoot: string, exclude: string[] = []): ZipEntry[] {
  const root = resolve(projectRoot)
  const excludes = [...PHP_DEFAULT_EXCLUDES, ...exclude]
  const entries: ZipEntry[] = []
  for (const file of walk(root, root, excludes)) {
    const rel = relative(root, file).replace(/\\/g, '/')
    const executable = (statSync(file).mode & 0o111) !== 0
    entries.push({ name: rel, data: readFileSync(file), mode: executable ? 0o755 : 0o644 })
  }
  return entries
}

export function packagePhpApp(opts: PackagePhpOptions): PackagedPhpArtifact {
  const projectRoot = resolve(opts.projectRoot ?? process.cwd())

  runPhpBuildHooks(opts)

  opts.onStep?.('packaging application tree')
  const entries = collectPhpAppEntries(projectRoot, opts.exclude)
  if (!entries.length)
    throw new Error(`No files to package under ${projectRoot}`)

  const zip = createZip(entries)

  // Handler is ignored by the custom runtime (the layer's bootstrap is the entry),
  // but Lambda requires a value; point it at the Laravel front controller.
  const handler = opts.app.handlers?.http ?? 'public/index.php'

  return {
    zip,
    sha256: createHash('sha256').update(zip).digest('hex'),
    handlers: {
      http: handler,
      queue: opts.app.handlers?.queue ?? handler,
      cli: opts.app.handlers?.cli ?? handler,
    },
    fileCount: entries.length,
  }
}
