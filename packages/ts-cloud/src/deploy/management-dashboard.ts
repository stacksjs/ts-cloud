/**
 * Auto-deploy of the ts-cloud management dashboard on every server
 * provision/deploy, so every box ships with a cockpit.
 *
 * **Live (the default).** The dashboard runs as a service on the box
 * (`cloud dashboard:serve --box`) behind the proxy. It serves live data and the
 * control API, and authenticates itself: a login page, sessions, and per-site
 * collaborator grants. The release is tiny — the project's cloud config plus a
 * `package.json` — and the box installs `@stacksjs/ts-cloud` from npm, which
 * carries both the CLI and the UI it serves.
 *
 * On the first live deploy the box mints an admin and prints the password once
 * into the deploy log. Users and the session key live in the site's shared
 * `.ts-cloud/`, so they survive later deploys.
 *
 * **Static (`TS_CLOUD_UI_STATIC`).** The built UI shipped as files behind
 * htpasswd. One shared password, all data baked in at build time, and therefore
 * no collaborators. Kept for boxes that cannot run the service.
 *
 * Env:
 * - `TS_CLOUD_UI_STATIC`    set truthy for the old static + htpasswd model
 * - `TS_CLOUD_UI_DOMAIN`    explicit dashboard host (else `dashboard.<apex>`)
 * - `TS_CLOUD_UI_PORT`      loopback port for the live service (default 7676)
 * - `TS_CLOUD_UI_VERSION`   ts-cloud version the box installs (default: this one)
 * - `TS_CLOUD_UI_DISABLE`   set truthy to skip auto-deploy
 *
 * Static mode only:
 * - `TS_CLOUD_UI_PASSWORD`  htpasswd password (unset ⇒ auto-generated + saved)
 * - `TS_CLOUD_UI_PUBLIC`    set truthy to serve WITHOUT auth (opt-out, insecure)
 * - `TS_CLOUD_UI_USERNAME`  htpasswd user (default `admin`)
 * - `TS_CLOUD_UI_REALM`     browser auth realm
 */
import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasManagementDashboardSite, isManagementDashboardSiteName, resolveManagementDashboardSites } from '@ts-cloud/core'
import { serializeDashboardConfig } from './dashboard-config-module'

/**
 * Legacy site key for the management dashboard. Auto-injected dashboards are
 * now keyed per domain (`dashboard-<apex-dashed>`, see
 * `managementDashboardSiteName` in `@ts-cloud/core`) so tenants sharing a box
 * via `attachTo` never collide on `/var/www/dashboard`. This bare key remains
 * only for hand-configured dashboards and pre-0.8 deploys.
 */
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
export function resolveDashboardAuth(
  cwd: string,
  username: string,
  logger: EnsureDashboardLogger,
): ResolvedDashboardAuth {
  const explicit = process.env.TS_CLOUD_UI_PASSWORD?.trim()
  if (explicit) return { password: explicit, source: 'env' }
  if (truthy(process.env.TS_CLOUD_UI_PUBLIC)) return { password: undefined, source: 'public' }

  const file = join(cwd, DASHBOARD_CREDENTIALS_FILE)
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { password?: string }
      if (saved?.password) return { password: saved.password, source: 'generated' }
    }
  } catch {
    /* unreadable/corrupt credentials file — regenerate below */
  }

  const password = generatePassword()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ username, password, generatedAt: new Date().toISOString() }, null, 2)}\n`)
    chmodSync(file, 0o600)
    // Deliberately NOT logging the password: deploy output lands in CI logs,
    // terminal scrollback and the systemd journal, all of which outlive the
    // deploy and are readable by more people than the 0600 file is.
    logger.info(
      `Management dashboard: generated a password for '${username}' and saved it to ${DASHBOARD_CREDENTIALS_FILE} (read it there — it is not printed). Set TS_CLOUD_UI_PASSWORD to pin your own, or TS_CLOUD_UI_PUBLIC=1 to serve without auth.`,
    )
  } catch (error: any) {
    // Only place the password is still printed: persisting failed, so this log
    // line is the operator's single copy. Say plainly that it is now in the log
    // so they can rotate it once the underlying write problem is fixed.
    logger.warn(
      `Management dashboard: could not persist the generated password (${error?.message ?? error}). Using it for this deploy only — pass: ${password}\nThis password is now in your deploy log. Set TS_CLOUD_UI_PASSWORD to a value of your own and redeploy once ${DASHBOARD_CREDENTIALS_FILE} is writable.`,
    )
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

/** Where the live dashboard's release is staged, inside the project checkout. */
export const LIVE_STAGE_DIR: string = join('.ts-cloud', 'dashboard-release')

/**
 * The ts-cloud version the box should install. Reads this package's own version
 * so a box runs a dashboard matching the CLI that deployed it, rather than
 * drifting to whatever `latest` happens to be mid-deploy.
 */
export function resolveDashboardVersion(): string {
  const explicit = process.env.TS_CLOUD_UI_VERSION?.trim()
  if (explicit) return explicit

  const here = dirname(fileURLToPath(import.meta.url))
  // Built layout is dist/deploy/, source layout is src/deploy/ — package.json
  // sits two levels up from either.
  for (const candidate of [join(here, '..', '..', 'package.json'), join(here, '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === '@stacksjs/ts-cloud' && pkg.version) return `^${pkg.version}`
    } catch {
      /* not this one — try the next */
    }
  }
  return 'latest'
}

/**
 * Stage the live dashboard's release: the RESOLVED cloud config inlined as a
 * self-contained module, plus a `package.json` whose install pulls the CLI and
 * UI from npm.
 *
 * The config is serialized rather than copied because a real one imports things
 * that do not exist on the box — Stacks' does `import { servers } from
 * '~/cloud/servers'` — and the import would throw, leaving the dashboard with
 * nothing to describe. Credentials are stripped on the way out.
 *
 * Returns the staged directory relative to `cwd`, or null when staging fails.
 */
export function stageLiveDashboardRoot(config: CloudConfig, cwd: string, logger: EnsureDashboardLogger): string | null {
  if (!config?.project?.slug) {
    logger.warn('Management dashboard: the cloud config has no project slug — skipping the live dashboard.')
    return null
  }

  const stage = join(cwd, LIVE_STAGE_DIR)
  try {
    mkdirSync(stage, { recursive: true })
    writeFileSync(join(stage, 'cloud.config.ts'), serializeDashboardConfig(config))

    const pkg = {
      name: 'ts-cloud-dashboard',
      private: true,
      type: 'module',
      dependencies: { '@stacksjs/ts-cloud': resolveDashboardVersion() },
    }
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    return LIVE_STAGE_DIR
  } catch (error: any) {
    logger.warn(`Management dashboard: could not stage the live release (${error?.message ?? error}) — skipping.`)
    return null
  }
}

/**
 * Resolve the UI source to ship (STATIC mode only — the live dashboard gets its
 * UI from the npm package it installs on the box). Prefers the repo's local
 * `packages/ui/` (built on the deploy machine), then the prebuilt UI bundled in
 * the installed package. Returns `{ uiRoot, build }` or null when unavailable.
 */
export function resolveUiSource(cwd: string): { uiRoot: string; build: string | false } | null {
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
  options: { cwd?: string; logger?: EnsureDashboardLogger } = {},
): CloudConfig {
  const logger = options.logger ?? noopLogger
  const cwd = options.cwd ?? process.cwd()

  if (truthy(process.env.TS_CLOUD_UI_DISABLE)) {
    logger.info('Management dashboard: skipped (TS_CLOUD_UI_DISABLE set).')
    return config
  }
  if (hasManagementDashboardSite(config)) return config

  const environment = (config.environments && Object.keys(config.environments)[0]) as EnvironmentType | undefined
  const domain = process.env.TS_CLOUD_UI_DOMAIN?.trim() || undefined
  const port = Number(process.env.TS_CLOUD_UI_PORT) || undefined
  const sites = { ...(config.sites ?? {}) }

  // Live is the default: the dashboard authenticates itself and can scope
  // collaborators to their own sites. Static is an explicit step back.
  if (!truthy(process.env.TS_CLOUD_UI_STATIC)) {
    // Staged before the dashboard site is injected, so the box's config
    // describes the project's sites and not the dashboard itself.
    const uiRoot = stageLiveDashboardRoot(config, cwd, logger)
    if (!uiRoot) return config

    const resolved = resolveManagementDashboardSites(config, environment ?? 'production', {
      uiRoot,
      build: false,
      domain,
      port,
      live: true,
    })
    if (resolved.length === 0) {
      logger.info(
        'Management dashboard: no domain resolved (set TS_CLOUD_UI_DOMAIN or configure a site domain) — skipping.',
      )
      return config
    }

    for (const { name, site } of resolved) {
      sites[name] = site
      logger.info(
        `Management dashboard → https://${site.domain} (sign in with your ts-cloud account; the first deploy prints an admin password once)`,
      )
    }
    config.sites = sites
    return config
  }

  // --- Static + htpasswd (opt-in) ---------------------------------------
  const ui = resolveUiSource(cwd)
  if (!ui) {
    logger.info('Management dashboard: UI not found (no local ui/ or packaged dist/ui) — skipping auto-deploy.')
    return config
  }

  const username = process.env.TS_CLOUD_UI_USERNAME?.trim() || 'admin'
  const auth = resolveDashboardAuth(cwd, username, logger)
  const resolved = resolveManagementDashboardSites(config, environment ?? 'production', {
    uiRoot: ui.uiRoot,
    build: ui.build,
    domain,
    username,
    password: auth.password,
    realm: process.env.TS_CLOUD_UI_REALM?.trim() || undefined,
    live: false,
    port,
  })

  if (resolved.length === 0) {
    logger.info(
      'Management dashboard: no domain resolved (set TS_CLOUD_UI_DOMAIN or configure a site domain) — skipping.',
    )
    return config
  }

  const authNote =
    auth.source === 'public'
      ? 'NO AUTH — TS_CLOUD_UI_PUBLIC is set (dashboard is publicly reachable)'
      : auth.source === 'env'
        ? 'htpasswd-protected (TS_CLOUD_UI_PASSWORD)'
        : `htpasswd-protected (auto-generated — see ${DASHBOARD_CREDENTIALS_FILE})`
  logger.warn(
    'Management dashboard: static mode — one shared password, and no per-site collaborators. Unset TS_CLOUD_UI_STATIC for the live dashboard.',
  )
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
  /** Site key the tarball is staged under. @default MANAGEMENT_DASHBOARD_SITE */
  siteName?: string
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
  site: { root?: string; build?: string | false } | undefined,
  options: BuildDashboardArtifactOptions,
): string | null {
  if (!site?.root) return null
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
    const tarball = join(
      tmpdir(),
      `${options.slug}-${options.siteName ?? MANAGEMENT_DASHBOARD_SITE}-${options.sha}.tar.gz`,
    )
    execSync(`tar czf "${tarball}" -C "${root}" .`, { stdio: 'inherit' })
    return tarball
  } catch (error: any) {
    logger.warn(
      `Management dashboard: failed to build artifact — ${error?.message ?? error}. Skipping dashboard deploy.`,
    )
    return null
  }
}
