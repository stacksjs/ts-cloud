/**
 * Auto-deploy of the ts-cloud management dashboard (the `@ts-cloud/ui` stx app)
 * on every server provision/deploy.
 *
 * Resolves the UI directory (the repo's local `packages/ui/`, else the prebuilt
 * UI that ships inside the installed package at `dist/ui`), derives a `dashboard.<apex>`
 * host, and injects it into `config.sites` as a server-static site. It is served
 * behind htpasswd ONLY when `TS_CLOUD_UI_PASSWORD` is set; when it is not, the
 * dashboard is served without auth (no password is invented).
 *
 * Env:
 * - `TS_CLOUD_UI_PASSWORD`  htpasswd password (unset ⇒ no auth)
 * - `TS_CLOUD_UI_USERNAME`  htpasswd user (default `admin`)
 * - `TS_CLOUD_UI_DOMAIN`    explicit dashboard host (else `dashboard.<apex>`)
 * - `TS_CLOUD_UI_REALM`     browser auth realm
 * - `TS_CLOUD_UI_DISABLE`   set truthy to skip auto-deploy
 */

import type { CloudConfig, EnvironmentType } from '@stacksjs/ts-cloud'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasManagementDashboardSite, resolveManagementDashboardSite } from '@stacksjs/ts-cloud'

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

  const password = process.env.TS_CLOUD_UI_PASSWORD?.trim() || undefined
  const environment = (config.environments && Object.keys(config.environments)[0]) as EnvironmentType | undefined

  const resolved = resolveManagementDashboardSite(config, environment ?? 'production', {
    uiRoot: ui.uiRoot,
    build: ui.build,
    domain: process.env.TS_CLOUD_UI_DOMAIN?.trim() || undefined,
    username: process.env.TS_CLOUD_UI_USERNAME?.trim() || undefined,
    password,
    realm: process.env.TS_CLOUD_UI_REALM?.trim() || undefined,
  })

  if (!resolved) {
    logger.info('Management dashboard: no domain resolved (set TS_CLOUD_UI_DOMAIN or configure a site domain) — skipping.')
    return config
  }

  config.sites = { ...(config.sites ?? {}), [resolved.name]: resolved.site }
  logger.info(`Management dashboard → https://${resolved.site.domain} (${password ? 'htpasswd-protected' : 'NO AUTH — set TS_CLOUD_UI_PASSWORD'})`)
  return config
}
