/**
 * Auto-deploy of the ts-cloud management dashboard (the `@ts-cloud/ui` stx app)
 * on every server provision/deploy.
 *
 * Resolves the UI directory (the repo's local `packages/ui/`, else the prebuilt
 * UI that ships inside the installed package at `dist/ui`), derives a `dashboard.<apex>`
 * host, and injects it into `config.sites` as a server-static site. It is served
 * SECURE BY DEFAULT: the dashboard is served behind htpasswd on every deploy.
 * The password is resolved as: `TS_CLOUD_UI_PASSWORD` when set, else a strong
 * auto-generated one (persisted to `.ts-cloud/dashboard-credentials.json` so it
 * stays stable across deploys and printed once in the deploy log). Serving the
 * dashboard publicly is an explicit, deliberate opt-in via `TS_CLOUD_UI_PUBLIC`.
 *
 * Env:
 * - `TS_CLOUD_UI_PASSWORD`  htpasswd password (unset ⇒ auto-generated + saved)
 * - `TS_CLOUD_UI_PUBLIC`    set truthy to serve WITHOUT auth (opt-out, insecure)
 * - `TS_CLOUD_UI_USERNAME`  htpasswd user (default `admin`)
 * - `TS_CLOUD_UI_DOMAIN`    explicit dashboard host (else `dashboard.<apex>`)
 * - `TS_CLOUD_UI_REALM`     browser auth realm
 * - `TS_CLOUD_UI_DISABLE`   set truthy to skip auto-deploy
 */

import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasManagementDashboardSite, isManagementDashboardSiteName, resolveManagementDashboardSites } from '@ts-cloud/core'

/** Site key under which the management dashboard is auto-injected. */
export const MANAGEMENT_DASHBOARD_SITE = 'dashboard'

/** Where an auto-generated dashboard password is persisted (per project checkout). */
export const DASHBOARD_CREDENTIALS_FILE: string = join('.ts-cloud', 'dashboard-credentials.json')

/** A URL-safe, shell-safe strong password (base64url, no padding). */
function generatePassword(): string {
  return randomBytes(24).toString('base64url')
}

export interface ResolvedDashboardAuth {
  /** The htpasswd password, or undefined when serving publicly (opt-out). */
  password?: string
  /** How the password was resolved: explicit env, generated+saved, or public. */
  source: 'env' | 'generated' | 'public'
}

/**
 * Resolve the dashboard's Basic-auth password (secure by default):
 *  1. `TS_CLOUD_UI_PASSWORD` when set → use it verbatim.
 *  2. `TS_CLOUD_UI_PUBLIC` truthy → serve with NO auth (deliberate opt-out).
 *  3. Otherwise → reuse a previously-generated password from
 *     `.ts-cloud/dashboard-credentials.json`, or generate + persist a new one.
 *
 * Persisting the generated password keeps htpasswd stable across deploys (so a
 * saved credential keeps working) and lets the operator retrieve it locally.
 */
export function resolveDashboardAuth(cwd: string, username: string, logger: EnsureDashboardLogger): ResolvedDashboardAuth {
  const explicit = process.env.TS_CLOUD_UI_PASSWORD?.trim()
  if (explicit)
    return { password: explicit, source: 'env' }
  if (truthy(process.env.TS_CLOUD_UI_PUBLIC))
    return { password: undefined, source: 'public' }

  const file = join(cwd, DASHBOARD_CREDENTIALS_FILE)
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { password?: string }
      if (saved?.password)
        return { password: saved.password, source: 'generated' }
    }
  }
  catch { /* unreadable/corrupt credentials file — regenerate below */ }

  const password = generatePassword()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ username, password, generatedAt: new Date().toISOString() }, null, 2)}\n`)
    chmodSync(file, 0o600)
    logger.info(`Management dashboard: generated a password and saved it to ${DASHBOARD_CREDENTIALS_FILE} (user: ${username}, pass: ${password}). Set TS_CLOUD_UI_PASSWORD to pin your own, or TS_CLOUD_UI_PUBLIC=1 to serve without auth.`)
  }
  catch (error: any) {
    logger.warn(`Management dashboard: could not persist the generated password (${error?.message ?? error}). Using it for this deploy only — pass: ${password}`)
  }
  return { password, source: 'generated' }
}

export interface EnsureDashboardLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
}

const noopLogger: EnsureDashboardLogger = { info: () => {}, warn: () => {} }

function truthy(v: string | undefined): boolean {
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/**
 * Resolve the UI source to ship. Prefers the repo's local `packages/ui/` (built
 * on the deploy machine), then the prebuilt UI bundled in the installed package.
 * Returns `{ uiRoot, build }` or null when no UI is available.
 */
export function resolveUiSource(cwd: string): { uiRoot: string, build: string | false } | null {
  // 1. Local checkout (repo dogfooding): build packages/ui → packages/ui/dist on the deploy host.
  if (existsSync(join(cwd, 'packages', 'ui', 'pages')) || existsSync(join(cwd, 'packages', 'ui', 'package.json'))) {
    return { uiRoot: 'packages/ui/dist', build: 'cd packages/ui && bun install && bun run build' }
  }

  // 2. Prebuilt UI shipped inside the installed package (dist/ui). Probe a few
  //    locations relative to this module's compiled location.
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'ui'),
    join(here, '..', 'ui'),
    join(here, '..', '..', 'ui'),
    join(here, '..', 'dist', 'ui'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html')) || existsSync(join(dir, 'serverless.html')))
      return { uiRoot: dir, build: false }
  }

  return null
}

/**
 * Inject the management dashboard into `config.sites` for a server deploy.
 * Mutates and returns `config`. Idempotent and safe to call on every deploy.
 */
export function ensureManagementDashboard(
  config: CloudConfig,
  options: { cwd?: string, logger?: EnsureDashboardLogger } = {},
): CloudConfig {
  const logger = options.logger ?? noopLogger
  const cwd = options.cwd ?? process.cwd()

  if (truthy(process.env.TS_CLOUD_UI_DISABLE)) {
    logger.info('Management dashboard: skipped (TS_CLOUD_UI_DISABLE set).')
    return config
  }
  if (hasManagementDashboardSite(config))
    return config

  const ui = resolveUiSource(cwd)
  if (!ui) {
    logger.info('Management dashboard: UI not found (no local ui/ or packaged dist/ui) — skipping auto-deploy.')
    return config
  }

  const username = process.env.TS_CLOUD_UI_USERNAME?.trim() || 'admin'
  const auth = resolveDashboardAuth(cwd, username, logger)
  const environment = (config.environments && Object.keys(config.environments)[0]) as EnvironmentType | undefined

  const live = truthy(process.env.TS_CLOUD_UI_LIVE)
  const port = Number(process.env.TS_CLOUD_UI_PORT) || undefined
  // One dashboard per distinct apex domain (each site gets its own
  // `dashboard.<apex>` host), all sharing this UI + these credentials.
  const resolved = resolveManagementDashboardSites(config, environment ?? 'production', {
    uiRoot: ui.uiRoot,
    build: ui.build,
    domain: process.env.TS_CLOUD_UI_DOMAIN?.trim() || undefined,
    username,
    password: auth.password,
    realm: process.env.TS_CLOUD_UI_REALM?.trim() || undefined,
    live,
    port,
  })

  if (resolved.length === 0) {
    logger.info('Management dashboard: no domain resolved (set TS_CLOUD_UI_DOMAIN or configure a site domain) — skipping.')
    return config
  }

  const authNote = auth.source === 'public'
    ? 'NO AUTH — TS_CLOUD_UI_PUBLIC is set (dashboard is publicly reachable)'
    : auth.source === 'env'
      ? 'htpasswd-protected (TS_CLOUD_UI_PASSWORD)'
      : `htpasswd-protected (auto-generated — see ${DASHBOARD_CREDENTIALS_FILE})`
  const sites = { ...(config.sites ?? {}) }
  for (const { name, site } of resolved) {
    sites[name] = site
    logger.info(`Management dashboard → https://${site.domain} (${authNote})`)
  }
  config.sites = sites
  return config
}

/** Names of the management-dashboard sites currently present in `config`. */
export function managementDashboardSiteNames(config: CloudConfig): string[] {
  return Object.keys(config.sites ?? {}).filter(isManagementDashboardSiteName)
}

export interface BuildDashboardArtifactOptions {
  cwd?: string
  slug: string
  sha: string
  logger?: EnsureDashboardLogger
}

/**
 * Build the management-dashboard release tarball from its injected site config:
 * run the UI `build` (when not already built), then package `site.root`. Returns
 * the tarball path, or null when the UI cannot be built/found.
 *
 * Best-effort: the dashboard is auxiliary, so any failure logs and returns null
 * rather than throwing — the surrounding app deploy must never be blocked by it.
 */
export function buildManagementDashboardArtifact(
  site: { root?: string, build?: string | false } | undefined,
  options: BuildDashboardArtifactOptions,
): string | null {
  if (!site?.root)
    return null
  const cwd = options.cwd ?? process.cwd()
  const logger = options.logger ?? noopLogger
  try {
    if (typeof site.build === 'string' && site.build.trim()) {
      logger.info(`Management dashboard: building UI (${site.build})`)
      execSync(site.build, { cwd, stdio: 'inherit' })
    }
    const root = isAbsolute(site.root) ? site.root : join(cwd, site.root)
    if (!existsSync(root)) {
      logger.warn(`Management dashboard: build output not found at ${root} — skipping dashboard artifact.`)
      return null
    }
    const tarball = join(tmpdir(), `${options.slug}-${MANAGEMENT_DASHBOARD_SITE}-${options.sha}.tar.gz`)
    execSync(`tar czf "${tarball}" -C "${root}" .`, { stdio: 'inherit' })
    return tarball
  }
  catch (error: any) {
    logger.warn(`Management dashboard: failed to build artifact — ${error?.message ?? error}. Skipping dashboard deploy.`)
    return null
  }
}
