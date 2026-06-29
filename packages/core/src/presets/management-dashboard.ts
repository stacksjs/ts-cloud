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
 * Derive a dashboard hostname (`dashboard.<apex>`) from the project's configured
 * domains. Prefers `explicit`, then any site domain, then the environment domain,
 * then `infrastructure.dns.domain`. Returns null when nothing is available.
 */
export function resolveDashboardDomain(
  config: Pick<CloudConfig, 'sites' | 'environments' | 'infrastructure'>,
  environment?: EnvironmentType,
  explicit?: string,
): string | null {
  if (explicit)
    return explicit

  const candidates: string[] = []
  for (const site of Object.values(config.sites ?? {})) {
    const d = (site as { domain?: string | string[] } | undefined)?.domain
    if (typeof d === 'string') candidates.push(d)
    else if (Array.isArray(d)) candidates.push(...d.filter((x): x is string => typeof x === 'string'))
  }
  if (environment && config.environments?.[environment]?.domain)
    candidates.push(config.environments[environment].domain!)
  const dnsDomain = (config.infrastructure as { dns?: { domain?: string } } | undefined)?.dns?.domain
  if (dnsDomain) candidates.push(dnsDomain)

  // Skip any candidate that is already a `dashboard.*` host.
  const base = candidates.find(d => d && !d.startsWith('dashboard.'))
  if (!base)
    return null
  return `dashboard.${apexOf(base)}`
}

/** Does the config already define the management dashboard as a site? */
export function hasManagementDashboardSite(config: Pick<CloudConfig, 'sites'>): boolean {
  return Object.entries(config.sites ?? {}).some(([name, site]) => {
    if (!site) return false
    const root = (site as { root?: string }).root ?? ''
    return name === 'dashboard' || root === 'ui/dist' || root.endsWith('/ui/dist') || root.endsWith('/dist/ui')
  })
}

/**
 * Build the management-dashboard site to auto-inject on server deploys, or null
 * when no domain can be resolved (the static-site model is domain-routed) or it
 * is already configured.
 */
export function resolveManagementDashboardSite(
  config: Pick<CloudConfig, 'sites' | 'environments' | 'infrastructure'>,
  environment: EnvironmentType,
  opts: ManagementDashboardOptions,
): { name: string, site: SiteConfig } | null {
  if (hasManagementDashboardSite(config))
    return null

  const domain = resolveDashboardDomain(config, environment, opts.domain)
  if (!domain)
    return null

  const auth = opts.password
    ? { auth: { username: opts.username || 'admin', password: opts.password, realm: opts.realm } }
    : {}

  if (opts.live) {
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
      ...(opts.build === false || opts.build === undefined ? {} : { build: opts.build }),
      ...auth,
    }
    return { name: 'dashboard', site }
  }

  const site: SiteConfig = {
    root: opts.uiRoot,
    deploy: 'server',
    type: 'static',
    domain,
    ssl: { provider: 'letsencrypt' },
    ...(opts.build === false || opts.build === undefined ? {} : { build: opts.build }),
    // Auth only when a password is provided; otherwise serve without htpasswd.
    ...auth,
  }

  return { name: 'dashboard', site }
}
