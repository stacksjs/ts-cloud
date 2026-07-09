import type { CloudConfig, EnvironmentType, SiteConfig } from '../types'

/**
 * Auto-deployed management dashboard (the `@ts-cloud/ui` stx app — the Server +
 * Serverless views). When a server is provisioned, ts-cloud injects this as a
 * server-static site so the dashboard ships automatically with every box.
 *
 * It is served behind HTTP Basic auth (htpasswd) whose password comes from an
 * environment value (`TS_CLOUD_UI_PASSWORD`). If that value is NOT set, the
 * dashboard is served WITHOUT auth — no password is invented.
 */

export interface ManagementDashboardOptions {
  /** Directory shipped as the static site root (built UI, or source dir + build). */
  uiRoot: string
  /** Build command producing {@link uiRoot}, or false when it is already built. */
  build?: string | false
  /** Explicit domain (e.g. from `TS_CLOUD_UI_DOMAIN`); else derived. */
  domain?: string
  /** Basic-auth username. @default 'admin' */
  username?: string
  /**
   * Basic-auth password. When empty/undefined the dashboard is served WITHOUT
   * htpasswd (no default password is invented).
   */
  password?: string
  /** Browser auth realm. */
  realm?: string
  /**
   * Live mode: deploy the dashboard as a server-app (a `cloud dashboard:serve
   * --box` service on the box) instead of static files, so it serves the
   * project's LIVE data + a working control API on the server. The proxy routes
   * the dashboard host to its loopback port (behind Basic auth).
   */
  live?: boolean
  /** Loopback port for the live (box-mode) dashboard service. @default 7676 */
  port?: number
}

/** The registrable apex (`acme.com`) of a hostname, naïvely the last two labels. */
function apexOf(domain: string): string {
  const parts = domain.split('.').filter(Boolean)
  return parts.length <= 2 ? domain : parts.slice(-2).join('.')
}

/**
 * Collect the project's configured domains, in priority order: the project's
 * canonical domain first (`infrastructure.dns.domain`, then the environment
 * domain), then every site domain. Canonical-first is deliberate — it fixes the
 * PRIMARY dashboard (the bare `dashboard` site key, served from `/var/www/dashboard`)
 * to the project domain, so it stays stable no matter which `--site` a partial
 * deploy narrows to. `dashboard.*` hosts are skipped (a dashboard never gets its
 * own dashboard).
 */
function collectDomains(
  config: Pick<CloudConfig, 'sites' | 'environments' | 'infrastructure'>,
  environment?: EnvironmentType,
): string[] {
  const candidates: string[] = []
  const dnsDomain = (config.infrastructure as { dns?: { domain?: string } } | undefined)?.dns?.domain
  if (dnsDomain) candidates.push(dnsDomain)
  if (environment && config.environments?.[environment]?.domain)
    candidates.push(config.environments[environment].domain!)
  for (const site of Object.values(config.sites ?? {})) {
    const s = site as { domain?: string | string[], redirect?: string } | undefined
    // Redirect-only sites (a `redirect` target, e.g. www → apex) serve no app and
    // get no dashboard — otherwise every alias would spawn a redundant cert.
    if (!s || s.redirect) continue
    const d = s.domain
    if (typeof d === 'string') candidates.push(d)
    else if (Array.isArray(d)) candidates.push(...d.filter((x): x is string => typeof x === 'string'))
  }

  return candidates.filter(d => d && !d.startsWith('dashboard.'))
}

/**
 * Derive the PRIMARY dashboard hostname (`dashboard.<apex>`) for the project.
 * Prefers `explicit`, else the project's canonical domain (`infrastructure.dns.domain`,
 * then the environment domain), else the first site domain. Returns null when
 * nothing is available.
 */
export function resolveDashboardDomain(
  config: Pick<CloudConfig, 'sites' | 'environments' | 'infrastructure'>,
  environment?: EnvironmentType,
  explicit?: string,
): string | null {
  if (explicit)
    return explicit

  const base = collectDomains(config, environment)[0]
  if (!base)
    return null
  return `dashboard.${apexOf(base)}`
}

/**
 * Derive EVERY dashboard hostname the project should expose — one
 * `dashboard.<apex>` per distinct registrable apex across all configured
 * domains, so each site gets a dashboard on its own domain. Deduped by apex,
 * order-preserving (the first-seen apex leads, and stays the "primary").
 *
 * An `explicit` domain (e.g. `TS_CLOUD_UI_DOMAIN`) pins a single host and
 * suppresses the per-apex fan-out — an operator asking for one host gets one.
 */
export function resolveDashboardDomains(
  config: Pick<CloudConfig, 'sites' | 'environments' | 'infrastructure'>,
  environment?: EnvironmentType,
  explicit?: string,
): string[] {
  if (explicit)
    return [explicit]

  const apexes: string[] = []
  for (const d of collectDomains(config, environment)) {
    const apex = apexOf(d)
    if (!apexes.includes(apex)) apexes.push(apex)
  }
  return apexes.map(apex => `dashboard.${apex}`)
}

/** Does the config already define the management dashboard as a site? */
export function hasManagementDashboardSite(config: Pick<CloudConfig, 'sites'>): boolean {
  return Object.entries(config.sites ?? {}).some(([name, site]) => {
    if (!site) return false
    const root = (site as { root?: string }).root ?? ''
    return name === 'dashboard' || root === 'ui/dist' || root.endsWith('/ui/dist') || root.endsWith('/dist/ui')
  })
}

/** Prefix under which non-primary per-apex dashboards are keyed. */
export const MANAGEMENT_DASHBOARD_SITE_PREFIX = 'dashboard-'

/**
 * The site key for a dashboard on `domain`. The first (primary) dashboard keeps
 * the bare `dashboard` key — stable service name, credentials, and artifact key.
 * Extra per-apex dashboards get `dashboard-<apex-dashed>` (e.g.
 * `dashboard-ghostanalytics-org`) so each is its own service + `/var/www` dir.
 */
function dashboardSiteName(domain: string, primary: boolean): string {
  if (primary)
    return 'dashboard'
  // `dashboard.acme.com` → `dashboard-acme-com`
  return MANAGEMENT_DASHBOARD_SITE_PREFIX + domain.replace(/^dashboard\./, '').replace(/\./g, '-')
}

/** Is `name` a management-dashboard site key (the primary or a per-apex one)? */
export function isManagementDashboardSiteName(name: string): boolean {
  return name === 'dashboard' || name.startsWith(MANAGEMENT_DASHBOARD_SITE_PREFIX)
}

/**
 * Build EVERY management-dashboard site to auto-inject on a server deploy — one
 * per distinct apex domain (each site's own `dashboard.<apex>` host), all sharing
 * the same UI artifact and Basic-auth credentials. Returns an empty array when no
 * domain resolves (the static-site model is domain-routed) or the user already
 * configured a dashboard site by hand.
 *
 * Live mode stays single-host: a box-mode service binds one loopback port, so
 * fanning it out per apex would collide. Per-apex dashboards are a static-model
 * feature (the default) — the same files served on each domain.
 */
export function resolveManagementDashboardSites(
  config: Pick<CloudConfig, 'sites' | 'environments' | 'infrastructure'>,
  environment: EnvironmentType,
  opts: ManagementDashboardOptions,
): Array<{ name: string, site: SiteConfig }> {
  if (hasManagementDashboardSite(config))
    return []

  const auth = opts.password
    ? { auth: { username: opts.username || 'admin', password: opts.password, realm: opts.realm } }
    : {}
  const build = opts.build === false || opts.build === undefined ? {} : { build: opts.build }

  if (opts.live) {
    const domain = resolveDashboardDomain(config, environment, opts.domain)
    if (!domain)
      return []
    // Server-app: a box-mode dashboard service on a loopback port, fronted by the
    // proxy (with Basic auth). Serves live data + the control API on the box.
    const port = opts.port ?? 7676
    const site: SiteConfig = {
      root: opts.uiRoot,
      deploy: 'server',
      domain,
      start: `cloud dashboard:serve --box --host 127.0.0.1 --port ${port}`,
      port,
      ssl: { provider: 'letsencrypt' },
      ...build,
      ...auth,
    }
    return [{ name: 'dashboard', site }]
  }

  const domains = resolveDashboardDomains(config, environment, opts.domain)
  return domains.map((domain, i) => ({
    name: dashboardSiteName(domain, i === 0),
    site: {
      root: opts.uiRoot,
      deploy: 'server',
      type: 'static',
      domain,
      ssl: { provider: 'letsencrypt' },
      ...build,
      // Auth only when a password is provided; otherwise serve without htpasswd.
      ...auth,
    } satisfies SiteConfig,
  }))
}

/**
 * Build the primary management-dashboard site (the `dashboard.<apex>` on the
 * project's first domain), or null when none resolves / one is already
 * configured. Thin wrapper over {@link resolveManagementDashboardSites} kept for
 * callers that only want the single primary host.
 */
export function resolveManagementDashboardSite(
  config: Pick<CloudConfig, 'sites' | 'environments' | 'infrastructure'>,
  environment: EnvironmentType,
  opts: ManagementDashboardOptions,
): { name: string, site: SiteConfig } | null {
  return resolveManagementDashboardSites(config, environment, opts)[0] ?? null
}
