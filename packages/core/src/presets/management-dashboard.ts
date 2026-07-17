import type { CloudConfig, EnvironmentType, SiteConfig } from '../types'

/**
 * Auto-deployed management dashboard (the `@ts-cloud/ui` stx app — the Server +
 * Serverless views). When a server is provisioned, ts-cloud injects this so the
 * dashboard ships automatically with every box.
 *
 * Two models:
 *
 * **Live (the default).** The dashboard runs as a service on the box
 * (`cloud dashboard:serve --box`) behind the proxy, and authenticates itself:
 * a login page, sessions, and per-site collaborator grants. No htpasswd — the
 * app is the authentication, and a shared Basic-auth password in front of it
 * would defeat the point, since every collaborator would need the box's one
 * password just to reach the login page.
 *
 * **Static (`TS_CLOUD_UI_STATIC`).** The built UI shipped as files behind
 * htpasswd. One shared password, all data baked into the HTML at build time,
 * and therefore **no collaborators** — whoever holds the password sees every
 * site on the box. Kept for boxes that cannot run the service.
 *
 * Live mode is single-host by design: one control panel per box, many sites,
 * per-site grants (the Forge/Coolify model). Static mode fans out one dashboard
 * per apex, since it is only serving the same files on each domain.
 */

export interface ManagementDashboardOptions {
  /** Directory shipped as the static site root (built UI, or source dir + build). */
  uiRoot: string
  /** Build command producing {@link uiRoot}, or false when it is already built. */
  build?: string | false
  /** Explicit domain (e.g. from `TS_CLOUD_UI_DOMAIN`); else derived. */
  domain?: string
  /** Basic-auth username, static mode only. @default 'admin' */
  username?: string
  /**
   * Basic-auth password, static mode only. When empty/undefined the static
   * dashboard is served WITHOUT htpasswd (no default password is invented).
   * Ignored in live mode, where the app authenticates.
   */
  password?: string
  /** Browser auth realm, static mode only. */
  realm?: string
  /**
   * Live mode: run the dashboard as a service on the box, serving live data,
   * the control API, and its own login + collaborator model.
   * @default true
   */
  live?: boolean
  /**
   * Loopback port for the live (box-mode) dashboard service. Defaults to a value
   * derived per dashboard host via {@link deriveManagementDashboardPort} so two
   * apps on one box never collide; set this (or `TS_CLOUD_UI_PORT`) to pin it.
   */
  port?: number
  /**
   * ts-cloud version the box installs to run the dashboard. Defaults to the
   * published range so a box always gets a dashboard matching this generation.
   */
  version?: string
}

/** Where the live dashboard keeps its users, session key and cache. */
export const DASHBOARD_STATE_DIR = '.ts-cloud'

/**
 * The dashboard service's entry point inside its release dir. The CLI is
 * installed from npm by the release's `bun install`, so this path exists on the
 * box without the deploy having to ship a binary.
 *
 * Called through the module path rather than the `cloud` bin shim because the
 * systemd unit runs `/usr/local/bin/bun <args>` directly — a bare `cloud` would
 * be resolved by bun as a FILE to execute, and the service would never start.
 */
export const DASHBOARD_ENTRY = './node_modules/@stacksjs/ts-cloud/dist/bin/cli.js'

/** The registrable apex (`acme.com`) of a hostname, naïvely the last two labels. */
function apexOf(domain: string): string {
  const parts = domain.split('.').filter(Boolean)
  return parts.length <= 2 ? domain : parts.slice(-2).join('.')
}

/** 32-bit FNV-1a hash — deterministic, dependency-free, good spread for hostnames. */
function fnv1a(str: string): number {
  let h = 0x811C9DC5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Loopback port band for box-mode dashboards. Chosen to sit ABOVE the app port
 * range projects use (3000s) and BELOW the Linux ephemeral range (32768+), so a
 * derived dashboard port can neither clash with a project's own service nor with
 * an outbound socket the box opens.
 */
export const DASHBOARD_PORT_BASE = 20000
export const DASHBOARD_PORT_SPAN = 12000

/**
 * The loopback port for a tenant's box-mode dashboard, derived deterministically
 * from its dashboard host.
 *
 * Every dashboard used to default to a single hard-coded port (7676), so two
 * Stacks apps sharing a box both tried to bind it: the first won, the second
 * crash-looped on EADDRINUSE, and — because its rpx route still pointed at that
 * port — the second tenant's `dashboard.<domain>` silently served the FIRST
 * tenant's dashboard. Deriving from the (globally unique) dashboard host gives
 * each tenant its own port with no cross-tenant coordination, stays stable
 * across deploys (same host → same port), and stays inside {@link
 * DASHBOARD_PORT_BASE}..+{@link DASHBOARD_PORT_SPAN}. An explicit port (config
 * `port` / `TS_CLOUD_UI_PORT`) still wins for anyone who wants to pin it.
 */
export function deriveManagementDashboardPort(dashboardHost: string): number {
  return DASHBOARD_PORT_BASE + (fnv1a(dashboardHost) % DASHBOARD_PORT_SPAN)
}

/**
 * The dashboard host for a domain the project serves.
 *
 * Collapses to `dashboard.<apex>` ONLY when the project actually owns the apex —
 * i.e. it serves the bare apex domain among `ownedDomains`. A project that only
 * serves a subdomain under someone else's apex (e.g. `everything.stacksjs.com`,
 * where `stacksjs.com` belongs to a different project on the same box) must NOT
 * collapse, or two projects would both claim `dashboard.stacksjs.com` and the
 * first-loaded one silently shadows the other. Such a project gets a dashboard
 * on its own subdomain instead: `dashboard.everything.stacksjs.com`.
 */
function dashboardHostFor(domain: string, ownedDomains: Iterable<string>): string {
  const apex = apexOf(domain)
  if (apex === domain)
    return `dashboard.${apex}`
  for (const owned of ownedDomains) {
    if (owned === apex)
      return `dashboard.${apex}`
  }
  return `dashboard.${domain}`
}

/**
 * Collect the project's configured domains, in priority order: the project's
 * canonical domain first (`infrastructure.dns.domain`, then the environment
 * domain), then every site domain. Canonical-first is deliberate — it fixes the
 * PRIMARY dashboard (and its site key, e.g. `dashboard-stacksjs-com`) to the
 * project domain, so it stays stable no matter which `--site` a partial deploy
 * narrows to. `dashboard.*` hosts are skipped (a dashboard never gets its own
 * dashboard).
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

  const domains = collectDomains(config, environment)
  const base = domains[0]
  if (!base)
    return null
  // Pass the full owned set so the apex is only claimed when this project
  // actually serves it (see dashboardHostFor).
  return dashboardHostFor(base, domains)
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

  const domains = collectDomains(config, environment)
  const hosts: string[] = []
  for (const d of domains) {
    // Only collapse to the apex when the project owns it; a subdomain under
    // another project's apex gets its own `dashboard.<subdomain>` host so two
    // projects on one box never collide on `dashboard.<apex>`.
    const host = dashboardHostFor(d, domains)
    if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

/** Does the config already define the management dashboard as a site? */
export function hasManagementDashboardSite(config: Pick<CloudConfig, 'sites'>): boolean {
  return Object.entries(config.sites ?? {}).some(([name, site]) => {
    if (!site) return false
    const root = (site as { root?: string }).root ?? ''
    return isManagementDashboardSiteName(name) || root === 'ui/dist' || root.endsWith('/ui/dist') || root.endsWith('/dist/ui')
  })
}

/** Prefix under which every auto-injected dashboard is keyed. */
export const MANAGEMENT_DASHBOARD_SITE_PREFIX = 'dashboard-'

/**
 * The site key for a dashboard on `domain`: `dashboard-<apex-dashed>` (e.g.
 * `dashboard-chrisbreuer-me`), so each dashboard is its own service +
 * `/var/www` dir. Every dashboard is domain-keyed — including the primary —
 * because a bare `dashboard` key collides on a shared multi-tenant box
 * (`attachTo`): every attaching project would ship its dashboard release to
 * the same `/var/www/dashboard/current`, silently overwriting the others.
 */
export function managementDashboardSiteName(domain: string): string {
  // `dashboard.acme.com` → `dashboard-acme-com`
  return MANAGEMENT_DASHBOARD_SITE_PREFIX + domain.replace(/^dashboard\./, '').replace(/\./g, '-')
}

/**
 * Is `name` a management-dashboard site key? Matches the domain-keyed form
 * (`dashboard-<apex-dashed>`) plus the bare `dashboard` key, which is how
 * hand-configured dashboards and pre-0.8 deploys are keyed.
 */
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

  // Live is the default: one control panel per box, authenticating itself.
  if (opts.live !== false) {
    const domain = resolveDashboardDomain(config, environment, opts.domain)
    if (!domain)
      return []

    const port = opts.port ?? deriveManagementDashboardPort(domain)
    const site: SiteConfig = {
      // The release ships the project's cloud config + a package.json; the
      // CLI (and the UI it serves) come from npm via `bun install` below, so
      // the artifact stays tiny and the box always runs a real published build.
      root: opts.uiRoot,
      deploy: 'server',
      domain,
      preStart: ['bun install --production --no-save'],
      start: `bun ${DASHBOARD_ENTRY} dashboard:serve --box --host 127.0.0.1 --port ${port}`,
      port,
      // The zero-downtime cutover overlaps two instances on one port via
      // SO_REUSEPORT. The dashboard's server does not bind that way, so the new
      // instance would hit EADDRINUSE, fail, and only start after a retry that
      // stops the old one. Stop-then-start is what actually happens either way —
      // ask for it directly rather than through a guaranteed failure. A second
      // of downtime on a control panel is not worth the complexity.
      zeroDowntime: false,
      // Users, site grants and the session key live here. Without this every
      // deploy would hand the box a fresh release dir and silently wipe every
      // collaborator, forcing a new admin password each time.
      sharedPaths: [DASHBOARD_STATE_DIR],
      healthCheck: { path: '/login' },
      ssl: { provider: 'letsencrypt' },
      // Deliberately no `auth`: the dashboard authenticates itself. htpasswd in
      // front would make every collaborator need the box's shared password just
      // to see the login page, which is exactly what per-site grants replace.
    }
    return [{ name: managementDashboardSiteName(domain), site }]
  }

  const domains = resolveDashboardDomains(config, environment, opts.domain)
  return domains.map(domain => ({
    name: managementDashboardSiteName(domain),
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
