/**
 * Generate the rpx reverse-proxy gateway config + provisioning from the `sites`
 * model.
 *
 * ts-cloud's per-site deploy model resolves each site to a kind
 * (see {@link import('../../deploy/site-target').resolveSiteKind}):
 *  - `server-app`    — a dynamic app running on a port (systemd service);
 *  - `server-static` — a static site shipped to `/var/www/<name>`;
 *  - `redirect`      — answered here with a Location header, nothing shipped;
 *  - `proxy`         — forwarded here to an upstream ts-cloud does not manage;
 *  - `bucket`        — object storage + CDN (not on the box; ignored here).
 *
 * The rpx gateway fronts :80/:443 on the box and routes by host **and path**:
 * several sites can share one `domain` on different `path`s (e.g.
 * `stacksjs.com/api/*` → app on :3000, `stacksjs.com/docs*` → `/var/www/docs`,
 * `stacksjs.com/` → `/var/www/public`). This module maps the sites model to the
 * rpx `proxies` array so `buddy deploy` can ship the config + wire the gateway.
 *
 * It replaces the old Caddyfile generation — pantry/stacks use rpx (their own
 * tooling), so the gateway is rpx, not Caddy.
 */
import type { CloudConfig, ComputeProxyConfig, RpxLoadBalancerConfig, SiteConfig, SiteRedirectConfig } from '@ts-cloud/core'
import { isIP } from 'node:net'
import { isManagementDashboardSiteName } from '@ts-cloud/core'
import { resolveProxyUpstreams, resolveSiteKind } from '../../deploy/site-target'

/** Default directory on the box that holds real per-domain TLS certs. */
export const DEFAULT_RPX_CERTS_DIR = '/etc/rpx/certs'

/**
 * Where the LAN certificate authority lives on the box. rpx writes the CA
 * (`rpx-root-ca.crt` / `.key`) and the leaf it signs here; the CA cert is the
 * one file an operator copies off the box to trust on a laptop or a phone.
 */
export const DEFAULT_LOCAL_CA_DIR = '/etc/rpx/local-ca'

/** rpx's own filename for the CA certificate inside {@link DEFAULT_LOCAL_CA_DIR}. */
export const LOCAL_CA_ROOT_CERT_FILENAME = 'rpx-root-ca.crt'

/** Absolute path to the CA certificate a client has to trust. */
export function localCaCertPath(dir: string = DEFAULT_LOCAL_CA_DIR): string {
  return `${dir.replace(/\/+$/, '')}/${LOCAL_CA_ROOT_CERT_FILENAME}`
}

/**
 * Whether the gateway adds a `www.` redirect for `domain` on its own.
 *
 * Apex domains only, and never an mDNS name: `pi-app.local` also has two
 * labels, but nobody types `www.pi-app.local`, no LAN resolves it, and the
 * route it would create is a host the LAN certificate does not cover, so it
 * is a browser warning on a name that exists for no reason.
 */
export function hasAutoWwwVariant(domain: string): boolean {
  if (domain.toLowerCase().endsWith('.local')) return false
  return domain.split('.').length === 2
}

/**
 * Every hostname the gateway will answer for a sites config.
 *
 * This is the set DNS has to publish, and it is deliberately derived from the
 * same rules {@link buildRpxConfig} routes by, because the two drifting apart
 * produces a specific and nasty failure: a name that resolves, has no route or
 * certificate, and so is served the gateway's fallback cert — which on a shared
 * box belongs to whichever *other* tenant sorts first. A visitor gets someone
 * else's certificate and a browser warning, which is strictly worse than the
 * name not existing.
 *
 * Two rules, both mirroring the route builder:
 *  - every site's literal `domain`, including an explicitly declared
 *    `www.<sub>.<apex>` (that host gets a real route here, so it needs a real
 *    record — collapsing it to its apex is what left `www.ps1.stacksjs.com`
 *    resolving onto another tenant's cert);
 *  - plus `www.<domain>` for two-label apexes, which the gateway synthesizes
 *    itself unless `autoWww` is off.
 *
 * `bucket` sites are excluded: they live on object storage + CDN, not this box.
 */
export function gatewayHostnames(
  sites: Record<string, SiteConfig | undefined>,
  options: { autoWww?: boolean } = {},
): string[] {
  const hosts = new Set<string>()

  for (const site of Object.values(sites)) {
    if (!site?.domain) continue
    if (resolveSiteKind(site) === 'bucket') continue
    hosts.add(site.domain)
  }

  if (options.autoWww !== false) {
    for (const domain of [...hosts]) {
      if (!hasAutoWwwVariant(domain)) continue
      hosts.add(`www.${domain}`)
    }
  }

  return [...hosts]
}

/**
 * Public recursive resolvers used to decide whether a hostname is ready for an
 * ACME http-01 challenge.
 *
 * The question the check has to answer is "can Let's Encrypt see this record
 * yet", and LE resolves from the public internet — so the box's own resolver is
 * the wrong vantage point, and a stale negative entry there blocks issuance for
 * a record the rest of the world can already resolve. Two independent operators
 * so one being unreachable does not stall a deploy.
 */
export const PUBLIC_DNS_RESOLVERS: readonly string[] = ['1.1.1.1', '8.8.8.8']

/** Default webroot the gateway serves ACME http-01 challenges from on `:80`. */
export const DEFAULT_ACME_WEBROOT = '/var/www/acme-challenge'

/** A normalized redirect target on an {@link RpxRoute} (see rpx's `redirect`). */
export interface RpxRedirect {
  to: string
  status?: 301 | 302 | 307 | 308
  preservePath?: boolean
}

/**
 * Normalize a site's `redirect` (string shorthand or object) into the minimal
 * {@link RpxRedirect} the gateway config carries. Optional fields are omitted
 * when unset so rpx applies its own defaults (status `301`, path-preserving).
 */
export function normalizeSiteRedirect(input: string | SiteRedirectConfig): RpxRedirect {
  if (typeof input === 'string') return { to: input }
  const out: RpxRedirect = { to: input.to }
  if (input.status != null) out.status = input.status
  if (input.preservePath != null) out.preservePath = input.preservePath
  return out
}

/** A single rpx proxy route, mapped from one site. */
export interface RpxRoute {
  /** Public host this route is served under (the site's `domain`). */
  to: string
  /** Path prefix within the host this route owns (e.g. `/api`). Omitted = `/`. */
  path?: string
  /**
   * Upstream(s) for a `server-app` route: a single `host:port` for a co-located
   * (single-box) deploy, or an array of `host:port` — one per app box — when the
   * route is fronted by a dedicated load-balancer box (see
   * {@link buildRpxLbConfig}). rpx turns an array into a real load-balanced pool
   * with automatic health-check failover (see rpx's `ProxyFrom`/`UpstreamTarget`).
   */
  from?: string | string[]
  /**
   * Static serving for a `server-static` route. rpx reads `spa` and
   * `pathRewriteStyle` ONLY from the object form (`{ dir, spa, pathRewriteStyle }`);
   * a bare string disables both (rpx forces `spa: false`, `pathRewriteStyle:
   * 'directory'`). So SPA fallback + flat-URL sites MUST use the object form —
   * see `buildRpxConfig`. The string shorthand remains valid for a plain
   * directory served with the route-level `cleanUrls`.
   */
  static?: string | { dir: string; spa?: boolean; pathRewriteStyle?: 'directory' | 'flat'; maxAge?: number }
  /**
   * Redirect target for a `redirect` site — the gateway answers `to` (the host)
   * with an HTTP redirect here instead of proxying/serving. The request path +
   * query are appended unless `preservePath` is `false`.
   */
  redirect?: RpxRedirect
  /** Strip `.html` and resolve clean URLs (set for static sites). */
  cleanUrls?: boolean
  /** SPA fallback for static sites. */
  spa?: boolean
  /**
   * HTTP Basic auth gate for this route (from the site's `auth`). rpx challenges
   * every request to the route until valid credentials are supplied — this is
   * how the management dashboard (and other protected sites) stay private behind
   * rpx, the same way the nginx driver applies htpasswd.
   */
  auth?: { username: string; password: string; realm?: string }
  /**
   * Load-balancing strategy/health-check tuning for a multi-upstream `from`
   * (see {@link ComputeProxyConfig.loadBalancer}). Only meaningful when `from`
   * is an array — rpx ignores it for a single-upstream route.
   */
  loadBalancer?: RpxLoadBalancerConfig
  /** Stable id used when rpx registers the route. Derived from `to`+`path`. */
  id: string
}

/**
 * Resolve a site's `auth` into the rpx route auth shape, or `undefined` when the
 * site is public. Mirrors the management-dashboard preset: auth applies only when
 * enabled (default) AND a password is present — no password is ever invented.
 */
export function resolveRouteAuth(site: SiteConfig): RpxRoute['auth'] {
  const auth = site.auth
  if (!auth || auth.enabled === false || !auth.password) return undefined
  return {
    username: auth.username || 'admin',
    password: auth.password,
    ...(auth.realm ? { realm: auth.realm } : {}),
  }
}

/**
 * The gateway's LAN certificate authority, mirroring rpx's `LocalCaConfig`
 * (see `@stacksjs/rpx`'s `types.ts`, available since 0.11.49). rpx loads or
 * creates the CA under `dir`, signs ONE leaf covering `hosts` + `ips`, and
 * registers it both per server name and as the default TLS context, so a
 * connection that sends no SNI at all (an IP-literal URL) still gets it.
 */
export interface RpxLocalCaConfig {
  /** Directory holding the CA and the leaf it signs. See {@link DEFAULT_LOCAL_CA_DIR}. */
  dir: string
  /** dNSName SANs on the leaf, e.g. `['pi-app.local']`. Never empty. */
  hosts: string[]
  /** iPAddress SANs, so the box is also reachable by address over TLS. */
  ips?: string[]
  /** Install the CA into the box's OWN system trust store (rpx runs as root here). */
  installTrust?: boolean
  /** Leaf validity in days. Omitted so rpx applies its documented default (825). */
  validityDays?: number
  /** Re-mint when fewer than this many days remain. Omitted for rpx's default (30). */
  renewBeforeDays?: number
}

/**
 * LAN settings for a gateway on a host that is not on the public internet.
 *
 * This is the ONLY input that makes {@link buildRpxConfig} emit `localCa` or
 * `https: false`, and it is passed exclusively on the ssh-provider path (see
 * {@link resolveGatewayLan}), which is what keeps every cloud driver's
 * emitted config byte-identical to what it produced before LAN TLS existed.
 */
export interface RpxLanOptions {
  /** The LAN name the gateway's certificate covers. Defaults to `<slug>.local`. */
  hostname?: string
  /** `'local-ca'` issues a LAN certificate; `'off'` serves plain HTTP. @default 'local-ca' */
  tls?: 'local-ca' | 'off'
  /**
   * The box's LAN address, when it is actually known: the ssh preflight's
   * `lanIp`, else the configured ssh host when that is an IP literal. Never
   * guessed: a wrong iPAddress SAN is worse than an absent one.
   */
  ip?: string
}

/** `lan.tls` with its default applied, or `undefined` when there is no LAN config. */
export function lanTlsMode(lan?: RpxLanOptions): 'local-ca' | 'off' | undefined {
  if (!lan) return undefined
  return lan.tls ?? 'local-ca'
}

/**
 * The LAN options for a config, or `undefined` when LAN TLS does not apply.
 *
 * The provider gate lives HERE, in one function, rather than at each call
 * site: `ssh.lan` is meaningless for a cloud box (a Hetzner host has no LAN an
 * operator can reach), and a driver that reads it anyway would start emitting
 * a `localCa` the box can never use. Callers with resolved ssh settings should
 * pass those instead; this reads `cloud.config.ts` alone, so a `TS_CLOUD_SSH_*`
 * override is not visible to it.
 */
export function resolveGatewayLan(
  config: Pick<CloudConfig, 'cloud' | 'ssh'>,
  lanIp?: string,
): RpxLanOptions | undefined {
  if (config.cloud?.provider !== 'ssh') return undefined
  const lan = config.ssh?.lan
  if (!lan) return undefined
  return {
    ...(lan.hostname ? { hostname: lan.hostname } : {}),
    tls: lan.tls ?? 'local-ca',
    ...(lanIp ? { ip: lanIp } : {}),
  }
}

/** The host profile the gateway unit should be tuned for, when one is known. */
export function resolveGatewayProfile(
  config: Pick<CloudConfig, 'cloud' | 'ssh'>,
): 'raspberry-pi' | 'generic' | undefined {
  if (config.cloud?.provider !== 'ssh') return undefined
  return config.ssh?.profile
}

/**
 * Is `domain` a name only a LAN can resolve? Either an mDNS `.local` name or a
 * bare single-label hostname. Public CAs cannot issue for either, so these are
 * exactly the names that need the box's own CA instead.
 */
export function isLanHostname(domain: string): boolean {
  const host = domain.trim().toLowerCase()
  if (!host || host.startsWith('*') || host.includes(':') || host.includes('/') || host.includes(' ')) return false
  if (isIP(host) !== 0) return false
  return host.endsWith('.local') || !host.includes('.')
}

/** One LAN hostname plus where it came from, so an overlap can name its source. */
interface LanHostSource {
  host: string
  source: string
}

/**
 * Every hostname the LAN certificate has to cover, in a stable order:
 * the LAN hostname itself, the dashboard host under it when this project
 * deploys a management dashboard, then any site domain a public CA could
 * never issue for.
 */
function collectLocalCaHosts(
  sites: Record<string, SiteConfig | undefined>,
  lan: RpxLanOptions,
  slug: string,
): LanHostSource[] {
  const out: LanHostSource[] = []
  const seen = new Set<string>()
  const add = (host: string, source: string): void => {
    const normalized = host.trim().toLowerCase()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    out.push({ host: normalized, source })
  }

  const configured = lan.hostname?.trim()
  const lanHost = (configured || `${slug}.local`).toLowerCase()
  add(lanHost, configured ? 'ssh.lan.hostname' : `the ssh provider's default LAN name for project "${slug}"`)

  // The dashboard is served on its own host, so a LAN certificate that only
  // covers the app name leaves the control panel on a warning page, and that
  // is the one page an operator opens first on a box with no public DNS.
  const hasDashboard = Object.entries(sites).some(([name, site]) => !!site && isManagementDashboardSiteName(name))
  if (hasDashboard) add(`dashboard.${lanHost}`, 'the management dashboard site')

  for (const [name, site] of Object.entries(sites)) {
    if (!site?.domain) continue
    if (resolveSiteKind(site) === 'bucket') continue
    if (!isLanHostname(site.domain)) continue
    add(site.domain, `site "${name}"`)
  }

  return out
}

/** rpx's own suffix match for `onDemandTls.allowedSuffixes` (see its `matchesAllowedSuffix`). */
function matchesAllowedSuffix(host: string, suffixes: string[] | undefined): string | undefined {
  if (!suffixes?.length) return undefined
  return suffixes.find((entry) => {
    const suffix = (entry.startsWith('.') ? entry.slice(1) : entry).toLowerCase()
    return host === suffix || host.endsWith(`.${suffix}`)
  })
}

/**
 * Refuse a config where one host is claimed by both the LAN CA and public
 * on-demand TLS. rpx throws on this too, but only once the gateway restarts on
 * the box, by which point the deploy has already reported success and the
 * operator is reading a systemd journal. Failing here names the host AND both
 * sources, which is the difference between a fixable message and a puzzle.
 */
function assertNoLocalCaOverlap(hosts: LanHostSource[], onDemandTls: RpxGatewayConfig['onDemandTls']): void {
  if (!onDemandTls?.enabled) return
  for (const { host, source } of hosts) {
    const suffix = matchesAllowedSuffix(host, onDemandTls.allowedSuffixes)
    if (!suffix) continue
    throw new Error(
      `The LAN certificate authority and public on-demand TLS both claim "${host}". `
      + `LAN source: ${source}. Public source: the on-demand TLS allowed suffix "${suffix}", `
      + 'which is derived from the site domains. A host is either LAN-only, with a certificate '
      + "signed by the box's own CA, or public, with one issued by Let's Encrypt, never both. "
      + 'Give the LAN a name no site domain covers (ssh.lan.hostname), or take that domain out '
      + 'of the sites this deploy routes.',
    )
  }
}

/** The rpx daemon/proxy config produced from a sites model. */
export interface RpxGatewayConfig {
  /** Multi-proxy route list (host + path keyed). */
  proxies: RpxRoute[]
  /**
   * Production per-domain SNI certs: rpx serves a real PEM per server name from
   * this directory (`<domain>.crt` / `<domain>.key`).
   */
  productionCerts: { certsDir: string; certsDirServerNames?: string[] }
  /**
   * On-demand TLS (opt-in): lazily issue a real cert for an approved host the
   * first time it's needed. The site domains form the allowlist.
   */
  onDemandTls?: { enabled: true; allowedSuffixes: string[]; email?: string; certsDir: string; staging: boolean }
  /**
   * Directory the gateway serves ACME http-01 challenge tokens from on `:80`
   * before redirecting to HTTPS. Set when ts-cloud manages certs so the renewal
   * cron (`tlsx acme:renew --webroot`) can issue/renew without taking the gateway
   * down to free `:80`. Omitted ⇒ the `:80` server only redirects.
   */
  acmeChallengeWebroot?: string
  /**
   * `true` (the only value any public deploy produces) terminates TLS on the
   * box. `false` is the LAN opt-out (`ssh.lan.tls: 'off'`): rpx then binds the
   * HTTP port only, and nothing on `:443`.
   */
  https: boolean
  /**
   * LAN certificate authority: rpx signs one leaf for these names with a CA it
   * keeps on the box. Emitted ONLY on the ssh-provider path; see
   * {@link RpxLanOptions}.
   */
  localCa?: RpxLocalCaConfig
  /** Never touch `/etc/hosts` on a real server with real DNS. */
  hostsManagement: false
  /** Don't remove certs/hosts on exit. */
  cleanup: { hosts: false; certs: false }
  /**
   * Origin lockdown (from `proxy.cdn` when a `secret` is set): rpx rejects
   * direct hits to the CDN-fronted hosts that lack the shared-secret header.
   */
  originGuard?: { header: string; value: string; hosts: string[] }
}

export interface BuildRpxConfigOptions {
  /** Proxy config from `infrastructure.compute.proxy`. */
  proxy: ComputeProxyConfig
  /** Directory static sites are shipped to. @default '/var/www' */
  wwwRoot?: string
  /**
   * Project slug — server-static routes are served from the slug-namespaced
   * install dir (`<wwwRoot>/<slug>-<name>/current`), matching where the deploy
   * ships them (see {@link siteInstallBase}). Omitted ⇒ `app` (single-tenant
   * back-compat). MUST be set on a shared box or static routes point at the
   * wrong directory.
   */
  slug?: string
  /**
   * LAN settings for a host with no public DNS. Passed on the ssh-provider
   * path only (see {@link resolveGatewayLan}); every other driver leaves it
   * undefined and gets exactly the config it always got.
   */
  lan?: RpxLanOptions
}

/**
 * Normalize a path prefix to a leading-slash, no-trailing-slash form, or
 * `undefined` for the host default. Mirrors rpx's `normalizePathPrefix`.
 */
export function normalizeRoutePath(path: string | undefined): string | undefined {
  if (!path || path === '/') return undefined
  let p = `/${path}`.replace(/\/+/g, '/').replace(/\/+$/, '')
  if (!p.startsWith('/')) p = `/${p}`
  return p === '' || p === '/' ? undefined : p
}

/** Derive a stable, filesystem/registry-safe id from a host (+ optional path). */
export function deriveRouteId(to: string, path?: string): string {
  const base = path ? `${to}${path}` : to
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
  return cleaned.length > 0 ? cleaned : 'rpx'
}

/**
 * Resolve a `server-app` site's upstream `from` — either a single co-located
 * `localhost:<port>` (the default, single-box behavior) or, when `appBoxes` is
 * given (a load-balanced fleet), one `host:port` per app box using each box's
 * private IP (falling back to its public IP when no private IP is available).
 */
function resolveServerAppFrom(port: number, appBoxes?: RpxLbAppBox[]): string | string[] {
  if (!appBoxes || appBoxes.length === 0) return `localhost:${port}`
  return appBoxes.map((box) => `${box.privateIp ?? box.publicIp}:${port}`)
}

/**
 * Shared route-building core for {@link buildRpxConfig} and
 * {@link buildRpxLbConfig}. `appBoxes` is undefined for the single-box path
 * (unchanged behavior) or the fleet's app-box IPs for the LB path.
 */
function buildRpxConfigInternal(
  sites: Record<string, SiteConfig | undefined>,
  options: BuildRpxConfigOptions,
  appBoxes?: RpxLbAppBox[],
): RpxGatewayConfig {
  const wwwRoot = (options.wwwRoot ?? '/var/www').replace(/\/+$/, '')
  // Slug-namespaced install dir for server-static routes — must match the
  // deploy's siteInstallBase(slug, name) so the route serves the dir the
  // release was actually shipped to. Bare `<wwwRoot>/<name>` collided two
  // projects' same-named static sites on a shared box.
  const installSlug = options.slug ?? 'app'
  const certsDir = options.proxy.certsDir ?? DEFAULT_RPX_CERTS_DIR
  const loadBalancer = options.proxy.loadBalancer

  const proxies: RpxRoute[] = []
  const domains = new Set<string>()

  for (const [name, site] of Object.entries(sites)) {
    if (!site || !site.domain) continue
    const kind = resolveSiteKind(site)
    if (kind === 'bucket') continue

    const path = normalizeRoutePath(site.path)
    const id = deriveRouteId(site.domain, path)
    const auth = resolveRouteAuth(site)

    if (kind === 'redirect') {
      // Gateway-only redirect: answer `domain` with a Location to the target.
      // `site.redirect` is guaranteed here (it's what makes the kind 'redirect').
      proxies.push({
        to: site.domain,
        path,
        redirect: normalizeSiteRedirect(site.redirect!),
        id,
        ...(auth ? { auth } : {}),
      })
      domains.add(site.domain)
      continue
    }

    if (kind === 'proxy') {
      // Gateway-only proxy: forward `domain` to an upstream ts-cloud does not
      // manage. Unlike server-app the upstream is given verbatim (host:port),
      // because there is no ts-cloud-owned service whose port we could derive
      // it from — and no appBoxes rewrite, since the operator chose the target.
      const upstreams = resolveProxyUpstreams(site)
      if (upstreams.length === 0) continue
      const from = upstreams.length === 1 ? upstreams[0]! : upstreams
      proxies.push({
        to: site.domain,
        path,
        from,
        id,
        ...(auth ? { auth } : {}),
        ...(Array.isArray(from) && loadBalancer ? { loadBalancer } : {}),
      })
      // Joining `domains` is the whole reason this kind exists: it puts the host
      // into certsDirServerNames + onDemandTls.allowedSuffixes, so the project's
      // rpx-cert-renew units cover a service ts-cloud never deploys.
      domains.add(site.domain)
      continue
    }

    if (kind === 'server-app') {
      // A server-app must declare the port it listens on to be routable.
      if (typeof site.port !== 'number') continue
      const from = resolveServerAppFrom(site.port, appBoxes)
      proxies.push({
        to: site.domain,
        path,
        from,
        id,
        ...(auth ? { auth } : {}),
        ...(Array.isArray(from) && loadBalancer ? { loadBalancer } : {}),
      })
    } else {
      // server-static: served from the atomic-release `current` symlink under
      // /var/www/<name> (zero-downtime swaps — see buildStaticSiteDeployScript).
      // `spa` + `pathRewriteStyle` MUST live inside the `static` object — rpx
      // ignores them at the route level and forces `spa:false` for a bare-string
      // `static`, which 404s every SPA deep link (e.g. an inspector at
      // /grid/depth) instead of falling back to index.html. cleanUrls stays at
      // the route level (rpx reads it there, as the .html-stripping redirect).
      proxies.push({
        to: site.domain,
        path,
        static: {
          dir: `${wwwRoot}/${installSlug}-${name}/current`,
          spa: site.spa ?? false,
          pathRewriteStyle: site.pathRewriteStyle ?? 'directory',
        },
        cleanUrls: site.pathRewriteStyle !== 'flat',
        ...(auth ? { auth } : {}),
        id,
      })
    }
    domains.add(site.domain)
  }

  // Auto-add a `www.<domain>` -> `https://<domain>` redirect for every apex
  // domain (2 labels, e.g. `example.com`) that doesn't already have an
  // explicit `www.` route of its own. DNS reconciliation (reconcileHetznerDns)
  // already creates both the apex and `www` A records pointing at this box —
  // without a matching gateway route, `www.<domain>` resolves fine but 404s
  // at the proxy, since rpx only ever knew about the literal `site.domain`
  // string. Opt out per-deploy with `proxy.autoWww: false` (e.g. multi-tenant
  // custom domains where `www.<domain>` might belong to someone else).
  if (options.proxy.autoWww !== false) {
    for (const domain of [...domains]) {
      if (!hasAutoWwwVariant(domain)) continue
      const wwwDomain = `www.${domain}`
      if (domains.has(wwwDomain)) continue
      proxies.push({ to: wwwDomain, redirect: { to: `https://${domain}` }, id: deriveRouteId(wwwDomain) })
      domains.add(wwwDomain)
    }
  }

  // Sort so routes group by domain and, within a domain, the most-specific path
  // comes first (cosmetic — rpx re-sorts longest-prefix-first at runtime).
  proxies.sort((a, b) => {
    if (a.to !== b.to) return a.to.localeCompare(b.to)
    return (b.path?.length ?? 0) - (a.path?.length ?? 0)
  })

  const config: RpxGatewayConfig = {
    proxies,
    productionCerts: { certsDir, certsDirServerNames: [...domains] },
    https: true,
    hostsManagement: false,
    cleanup: { hosts: false, certs: false },
  }

  if (options.proxy.onDemandTls && domains.size > 0) {
    config.onDemandTls = {
      enabled: true,
      allowedSuffixes: [...domains],
      email: options.proxy.onDemandTlsEmail,
      certsDir,
      // Always explicit — see ComputeProxyConfig.onDemandTlsStaging. An absent
      // flag makes tlsx fall back to the staging directory, which issues certs
      // that every client rejects while the deploy reports success.
      staging: options.proxy.onDemandTlsStaging ?? false,
    }
  }

  // When ts-cloud manages TLS, the gateway serves ACME http-01 challenges on :80
  // so certs can be issued/renewed (by the deploy + a renewal cron) without
  // taking the gateway down to free :80. See buildRpxProvisionScript's cert step.
  if (options.proxy.onDemandTls) {
    config.acmeChallengeWebroot = options.proxy.acmeWebroot ?? DEFAULT_ACME_WEBROOT
  }

  // CDN-in-front origin lockdown: enforce the shared secret on the fronted hosts.
  //
  // `frontedHosts` defaults to every hostname the gateway answers for — the same
  // default the CDN reconcile uses. Deriving both from one rule is what keeps the
  // guarded set and the fronted set identical: a host the CDN fronts but the
  // gateway does not guard is a way around the edge, and a host the gateway
  // guards but the CDN does not front rejects all of its traffic.
  const cdn = options.proxy.cdn
  const guardedHosts = cdn?.frontedHosts?.length ? cdn.frontedHosts : [...domains]
  if (cdn?.secret && guardedHosts.length > 0) {
    config.originGuard = {
      header: cdn.secretHeader ?? 'X-Origin-Verify',
      value: cdn.secret,
      hosts: guardedHosts,
    }
  }

  // LAN mode, last so it can see the resolved `onDemandTls` set it must not
  // collide with. Only the ssh-provider path supplies `lan`, so every other
  // driver's emitted config is unchanged down to the key order: `https` keeps
  // its position in the literal above and is only reassigned here.
  //
  // WHY THIS LIVES IN THE PER-SLUG FRAGMENT, not the assembled launcher.
  // `localCa` is a gateway-wide setting, so the launcher looks like its
  // natural home, but the launcher is REWRITTEN verbatim by every
  // buildRpxProvisionScript run on the box, including a co-tenant's deploy
  // that knows nothing about this project's LAN. Baked into the launcher, the
  // CA would survive exactly until the next unrelated deploy and then quietly
  // disappear, taking the box's only certificate with it. Carried in
  // `sites.d/<slug>.json` it is owned by the project that configured it, and
  // the assembler unions every fragment's `localCa` at startup into the one
  // gateway-wide setting rpx wants. That is the same shape `onDemandTls` and
  // `originGuard` already use, for the same reason.
  if (options.lan) {
    if (lanTlsMode(options.lan) === 'off') {
      // Plain HTTP on the LAN: rpx binds the HTTP port only, no `:443` and no
      // HTTP to HTTPS redirect, even though productionCerts is still set.
      config.https = false
    }
    else {
      const lanHosts = collectLocalCaHosts(sites, options.lan, installSlug)
      assertNoLocalCaOverlap(lanHosts, config.onDemandTls)
      const lanIps = options.lan.ip && isIP(options.lan.ip) !== 0 ? [options.lan.ip] : []
      config.localCa = {
        dir: DEFAULT_LOCAL_CA_DIR,
        hosts: lanHosts.map(entry => entry.host),
        ...(lanIps.length > 0 ? { ips: lanIps } : {}),
        // The gateway runs as root, and the box itself is a client of its own
        // names: health checks, the dashboard's own API calls and any `curl`
        // an operator runs over ssh all go through this certificate.
        installTrust: true,
      }
    }
  }

  return config
}

/**
 * Map the sites model to an rpx gateway config. Each non-bucket site with a
 * `domain` becomes a route:
 *  - `server-app`    → `{ to: domain, path, from: 'localhost:<port>' }`
 *  - `server-static` → `{ to: domain, path, static: '<wwwRoot>/<name>' }`
 *
 * Routes are grouped by domain so rpx's path-based routing can serve an app +
 * several static dirs under one host. Bucket sites and sites without a `domain`
 * (or a `server-app` without a `port`) are skipped.
 *
 * This is the single-box path: every `server-app` route always resolves to
 * `localhost:<port>` — unchanged, byte-for-byte, from before load-balanced
 * fleets existed. Use {@link buildRpxLbConfig} for a dedicated LB box fronting
 * more than one app box.
 */
export function buildRpxConfig(
  sites: Record<string, SiteConfig | undefined>,
  options: BuildRpxConfigOptions,
): RpxGatewayConfig {
  return buildRpxConfigInternal(sites, options)
}

/** An app box's addresses, as known to the LB box building routes to it. */
export interface RpxLbAppBox {
  /** Private IP of the app box, reachable from the LB over the fleet's private network. Preferred. */
  privateIp?: string
  /** Public IP of the app box — used only when no private IP is available. */
  publicIp?: string
}

/**
 * Build the rpx gateway config for a **dedicated load-balancer box**: like
 * {@link buildRpxConfig}, but every `server-app` route's `from` is an array of
 * `host:port` — one per entry in `appBoxes` (private IP preferred, public IP as
 * fallback) — instead of `localhost:<port>`. rpx turns that array into a real
 * load-balanced pool with health-check failover (see rpx's `ProxyFrom`).
 *
 * `server-static`/`redirect` routes are unaffected (the LB box doesn't serve
 * static files or own redirects itself in the primary bun-fleet flow — those
 * kinds simply pass through unchanged if present in `sites`).
 */
export function buildRpxLbConfig(
  sites: Record<string, SiteConfig | undefined>,
  appBoxes: RpxLbAppBox[],
  options: BuildRpxConfigOptions,
): RpxGatewayConfig {
  return buildRpxConfigInternal(sites, options, appBoxes)
}

/**
 * Render the rpx gateway config as a self-contained launcher TS module. The
 * systemd unit runs `bun <file>`, which imports `startProxies` from the
 * managed `/opt/rpx-gateway` install and starts the gateway with the generated
 * options. We ship a runnable launcher (not a bare config) because rpx's CLI
 * resolves its own config from its install dir, not an arbitrary path.
 */
export function renderRpxLauncher(config: RpxGatewayConfig): string {
  const json = JSON.stringify(config, null, 2)
  return `// Generated by ts-cloud — rpx reverse-proxy gateway.
// Routes are derived from the \`sites\` model on every \`buddy deploy\`.
import { startProxies } from '@stacksjs/rpx'

const config = ${json} as const

// Verbose is the hard default for ts-cloud-installed gateways (RPX_VERBOSE=false
// opts out) — without it rpx's TLS/routing diagnostics never reach the journal.
await startProxies({ verbose: process.env.RPX_VERBOSE !== 'false', ...config } as any)
`
}

/**
 * True when this compute is fronted by the rpx gateway — either explicitly
 * (`webServer: 'rpx'`) or implicitly by opting into the rpx proxy engine
 * (`proxy.engine: 'rpx'`). Setting `proxy.engine: 'rpx'` alone provisions and
 * runs the gateway on :80/:443, so the deploy MUST NOT also stand up nginx +
 * certbot for a site — that races the gateway for :80 and the certbot HTTP-01
 * challenge fails with "Address already in use". Treating either signal as
 * "rpx mode" keeps the nginx/SSL path and the gateway path from contradicting.
 */
export function usesRpxProxy(compute?: { webServer?: string; proxy?: { engine?: string } }): boolean {
  return compute?.webServer === 'rpx' || compute?.proxy?.engine === 'rpx'
}

/** Default install location for the gateway launcher + config on the box. */
export const RPX_DIR = '/etc/rpx'
export const RPX_INSTALL_DIR = '/opt/rpx-gateway'
export const RPX_LAUNCHER_PATH = '/etc/rpx/gateway.ts'
export const RPX_BINARY_PATH = '/etc/rpx/gateway'
export const RPX_SERVICE_NAME = 'rpx-gateway.service'
/**
 * Per-app gateway registry. Each project's deploy writes ONLY its own fragment
 * (`<slug>.json`) here; the launcher ({@link renderRpxAssembler}) merges every
 * fragment at startup. So several independent apps share one box's gateway
 * Forge-style — one app's deploy never clobbers another's routes.
 */
export const RPX_SITES_DIR = '/etc/rpx/sites.d'

/** A registry fragment: one project's gateway config, tagged with its slug. */
export type RpxFragment = RpxGatewayConfig & { slug: string }

/**
 * Merge per-app fragments into one gateway config (the runtime equivalent of
 * what {@link renderRpxAssembler} does on the box, exported for testing).
 *
 * Routes are concatenated (deduped by `id`, first writer wins); on-demand
 * suffixes and origin-guard hosts are unioned; the first non-empty email /
 * certsDir / acmeChallengeWebroot / origin-guard header+secret wins. Fragments
 * are applied in the given order (the box sorts them by filename).
 */
export function mergeRpxFragments(fragments: RpxGatewayConfig[]): RpxGatewayConfig {
  const proxies: RpxRoute[] = []
  const seen = new Set<string>()
  const suffixes = new Set<string>()
  const guardHosts = new Set<string>()
  let email: string | undefined
  let certsDir = DEFAULT_RPX_CERTS_DIR
  let acmeChallengeWebroot: string | undefined
  let guard: { header: string; value: string } | undefined
  let anyProduction = false
  let localCa: RpxLocalCaConfig | undefined
  const localCaHosts = new Set<string>()
  const localCaIps = new Set<string>()
  // TLS stays on unless EVERY fragment asks for plain HTTP. One co-tenant
  // opting out of HTTPS must not unbind `:443` for a tenant that needs it:
  // that is a total outage for the second tenant, where the first merely keeps
  // serving over TLS it did not ask for.
  let anyTls = false

  for (const f of fragments) {
    if (f.https !== false) anyTls = true
    if (f.localCa) {
      // The CA is a property of the box, so the first fragment's directory is
      // the box's directory and later fragments contribute names to the same
      // leaf. A fragment naming a different directory still contributes its
      // hosts: a name left off the leaf gets no certificate at all, which is a
      // worse outcome than a CA living somewhere the fragment did not expect.
      localCa ??= { dir: f.localCa.dir, hosts: [] }
      for (const host of f.localCa.hosts ?? []) localCaHosts.add(host)
      for (const ip of f.localCa.ips ?? []) localCaIps.add(ip)
      if (f.localCa.installTrust) localCa.installTrust = true
      localCa.validityDays ??= f.localCa.validityDays
      localCa.renewBeforeDays ??= f.localCa.renewBeforeDays
    }
  }

  for (const f of fragments) {
    for (const p of f.proxies ?? []) {
      const key = p.id || `${p.to}${p.path ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      proxies.push(p)
    }
    for (const s of f.onDemandTls?.allowedSuffixes ?? []) suffixes.add(s)
    email ??= f.onDemandTls?.email
    // One gateway means one ACME directory, so co-tenants must agree. Production
    // wins any disagreement: a production cert is valid for a tenant that only
    // wanted staging, whereas a staging cert breaks every client of a tenant
    // that wanted production. A fragment predating this field counts as
    // production, matching the documented default.
    if (f.onDemandTls && f.onDemandTls.staging !== true) anyProduction = true
    if (f.productionCerts?.certsDir) certsDir = f.productionCerts.certsDir
    acmeChallengeWebroot ??= f.acmeChallengeWebroot
    if (f.originGuard) {
      // rpx enforces ONE header/value pair for the whole gateway, so co-tenants
      // cannot each bring their own secret. Adopting the first and then adding a
      // disagreeing tenant's hosts to the guarded set would be the worst
      // possible outcome: its CDN sends secret B, the gateway demands secret A,
      // and every request to that host is rejected — a total outage for a host
      // that was working. Leaving those hosts unguarded is a weaker posture but
      // a serving one, so the conflict degrades instead of breaking.
      guard ??= { header: f.originGuard.header, value: f.originGuard.value }
      if (f.originGuard.header === guard.header && f.originGuard.value === guard.value) {
        for (const h of f.originGuard.hosts) guardHosts.add(h)
      }
    }
  }

  const merged: RpxGatewayConfig = {
    proxies,
    productionCerts: {
      certsDir,
      certsDirServerNames: [...new Set(proxies.map(proxy => proxy.to).filter(Boolean))],
    },
    https: true,
    hostsManagement: false,
    cleanup: { hosts: false, certs: false },
  }
  if (suffixes.size > 0)
    merged.onDemandTls = { enabled: true, allowedSuffixes: [...suffixes], email, certsDir, staging: !anyProduction }
  if (acmeChallengeWebroot) merged.acmeChallengeWebroot = acmeChallengeWebroot
  if (guard) merged.originGuard = { header: guard.header, value: guard.value, hosts: [...guardHosts] }
  if (localCa) {
    localCa.hosts = [...localCaHosts]
    if (localCaIps.size > 0) localCa.ips = [...localCaIps]
    merged.localCa = localCa
  }
  if (fragments.length > 0) merged.https = anyTls
  return merged
}

/**
 * Render the stable assembler launcher. Its content is identical for every app
 * and every deploy — it reads all `<slug>.json` fragments from {@link RPX_SITES_DIR}
 * at startup, merges them (same algorithm as {@link mergeRpxFragments}), and
 * starts the gateway. A malformed fragment is skipped, not fatal.
 */
export function renderRpxAssembler(
  sitesDir: string = RPX_SITES_DIR,
  defaultCertsDir: string = DEFAULT_RPX_CERTS_DIR,
): string {
  return `// Generated by ts-cloud — rpx gateway assembler.
// Merges every app's fragment in ${sitesDir} so independent deploys compose
// without clobbering each other. Each deploy writes only its own <slug>.json.
import { startProxies } from '@stacksjs/rpx'
import { readdirSync, readFileSync } from 'node:fs'

const dir = ${JSON.stringify(sitesDir)}
const proxies = []
const seen = new Set()
const owners = new Map()
const suffixes = new Set()
const guardHosts = new Set()
let email
let certsDir = ${JSON.stringify(defaultCertsDir)}
let acmeChallengeWebroot
let guard
let anyProduction = false
// LAN certificate authority, unioned across fragments. It is gateway-wide, but
// it is carried per fragment because THIS file is rewritten wholesale by every
// deploy on the box: a co-tenant's deploy would erase a CA baked in here, while
// a fragment belongs to the project that configured it.
let localCa
const localCaHosts = new Set()
const localCaIps = new Set()
// TLS stays on unless every fragment asks for plain HTTP.
let fragmentCount = 0
let anyTls = false
let files = []
try { files = readdirSync(dir).filter(n => n.endsWith('.json')).sort() } catch {}
for (const f of files) {
  let frag
  // Fragments are written atomically (temp + rename by ts-cloud), so a parse
  // failure here means a genuinely corrupt fragment, not a mid-write read. Log
  // it LOUD — a silent skip drops that app's whole host from the routing table,
  // which then answers 404 until someone notices. We still continue so one bad
  // fragment can't take every other app down, but the drop is now visible.
  try { frag = JSON.parse(readFileSync(dir + '/' + f, 'utf8')) }
  catch (err) { console.error('[rpx-assembler] SKIPPING malformed fragment ' + f + ' — its host(s) will 404 until fixed: ' + err); continue }
  fragmentCount++
  if (frag.https !== false) anyTls = true
  if (frag.localCa) {
    if (!localCa) localCa = { dir: frag.localCa.dir }
    else if (frag.localCa.dir !== localCa.dir) console.warn('[rpx-assembler] ' + f + ' asks for a local CA in ' + frag.localCa.dir + '; the box already uses ' + localCa.dir + ', so its hosts join that CA instead')
    for (const h of frag.localCa.hosts ?? []) localCaHosts.add(h)
    for (const ip of frag.localCa.ips ?? []) localCaIps.add(ip)
    if (frag.localCa.installTrust) localCa.installTrust = true
    if (localCa.validityDays === undefined) localCa.validityDays = frag.localCa.validityDays
    if (localCa.renewBeforeDays === undefined) localCa.renewBeforeDays = frag.localCa.renewBeforeDays
  }
  for (const p of frag.proxies ?? []) {
    const key = p.id || (p.to + (p.path ?? ''))
    if (seen.has(key)) {
      console.warn('[rpx-assembler] duplicate route ' + key + ' in ' + f + ' ignored; first declared by ' + owners.get(key))
      continue
    }
    seen.add(key)
    owners.set(key, f)
    proxies.push(p)
  }
  for (const s of frag.onDemandTls?.allowedSuffixes ?? []) suffixes.add(s)
  email ??= frag.onDemandTls?.email
  // One gateway, one ACME directory: production wins any disagreement between
  // co-tenants, and a fragment predating the flag counts as production. A
  // staging cert chains to an untrusted root, so defaulting the other way
  // breaks every client of every tenant that wanted a real cert.
  if (frag.onDemandTls && frag.onDemandTls.staging !== true) anyProduction = true
  if (frag.productionCerts?.certsDir) certsDir = frag.productionCerts.certsDir
  acmeChallengeWebroot ??= frag.acmeChallengeWebroot
  if (frag.originGuard) {
    // One gateway means one origin-guard secret (rpx takes a single
    // header/value). A tenant whose secret disagrees with the adopted one must
    // NOT have its hosts guarded: its CDN would send a different value, the
    // gateway would reject every request, and a working host would go dark.
    // Unguarded is weaker but serving, and the mismatch is logged.
    guard ??= { header: frag.originGuard.header, value: frag.originGuard.value }
    if (frag.originGuard.header === guard.header && frag.originGuard.value === guard.value) {
      for (const h of frag.originGuard.hosts ?? []) guardHosts.add(h)
    }
    else {
      console.warn('[rpx-assembler] origin-guard secret in ' + f + ' differs from the one already in force; its hosts stay unguarded rather than rejecting all traffic')
    }
  }
}
if (localCa) {
  localCa.hosts = [...localCaHosts]
  if (localCaIps.size > 0) localCa.ips = [...localCaIps]
}
const config = {
  proxies,
  productionCerts: {
    certsDir,
    // A shared host's cert directory also contains mail and retired-site PEMs.
    // Keep those files on disk for their owners, but do not turn them into live
    // OpenSSL SNI contexts when no current route can select them.
    certsDirServerNames: [...new Set(proxies.map(p => p.to).filter(Boolean))],
  },
  https: fragmentCount === 0 ? true : anyTls,
  hostsManagement: false,
  cleanup: { hosts: false, certs: false },
  // Verbose is the hard default for ts-cloud-installed gateways: without it,
  // rpx's TLS/routing diagnostics (tlsx on-demand 'refused issuance',
  // 'issuance failed', 'adopted existing on-disk cert') never reach the systemd
  // journal and a production TLS failure looks like "nothing happens". Silence
  // it by setting RPX_VERBOSE=false on the systemd unit.
  verbose: process.env.RPX_VERBOSE !== 'false',
  ...(suffixes.size > 0 ? { onDemandTls: { enabled: true, allowedSuffixes: [...suffixes], email, certsDir, staging: !anyProduction } } : {}),
  ...(acmeChallengeWebroot ? { acmeChallengeWebroot } : {}),
  ...(guard ? { originGuard: { header: guard.header, value: guard.value, hosts: [...guardHosts] } } : {}),
  ...(localCa && localCa.hosts.length > 0 ? { localCa } : {}),
}

await startProxies(config)
`
}

/**
 * Embed a here-doc that writes `content` to `path` without the shell expanding
 * `$`/backticks (quoted heredoc delimiter).
 *
 * The write is ATOMIC: content streams into a unique temp file in the same
 * directory, then a single `mv -f` renames it into place. `rename(2)` on one
 * filesystem is atomic, so a concurrent reader — the rpx gateway assembler
 * re-reading `sites.d/<slug>.json` during an overlapping deploy — never observes
 * a truncated / half-written file. Without this, `cat > file` truncates then
 * streams, and a reader that catches that window gets a parse error; the
 * assembler's `catch { continue }` then silently drops that whole host from the
 * routing table until the next reload, producing a transient 404 for the host.
 * The temp name never ends in `.json`, so the assembler's `*.json` filter
 * ignores it even mid-write. Perms default to 0644 (mktemp creates 0600) to
 * match the previous `cat >`/umask behavior; pass `mode` for files carrying
 * credentials (route fragments hold basic-auth passwords + the origin-guard
 * shared secret — on a multi-tenant box those must stay root-only).
 */
function writeFileHeredoc(path: string, content: string, delimiter: string, mode = '0644'): string[] {
  return [
    `__tsc_tmp="$(mktemp "${path}.XXXXXX")"`,
    `cat > "$__tsc_tmp" <<'${delimiter}'`,
    content,
    delimiter,
    `mv -f "$__tsc_tmp" ${path}`,
    `chmod ${mode} ${path}`,
  ]
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Write one project's route fragment while optionally retaining the dashboard
 * routes already active on the box.
 *
 * A narrowed application deploy intentionally does not restart the management
 * dashboard. Its local config can still contain a different dashboard port,
 * for example from a stale TS_CLOUD_UI_PORT override. Replacing the whole
 * fragment in that state points rpx at a service the deploy never started and
 * turns an otherwise healthy dashboard into a 502. Preserve the current
 * dashboard routes for those app-only reloads, while replacing every regular
 * application route from the new source model.
 */
function writeRpxFragment(
  path: string,
  content: string,
  delimiter: string,
  options: { preserveManagementDashboardRoutes?: boolean, bunBin: string },
): string[] {
  if (!options.preserveManagementDashboardRoutes)
    return writeFileHeredoc(path, content, delimiter, '0600')

  const mergeScript = `
const { readFileSync, writeFileSync } = require('node:fs')
const currentPath = process.env.TS_CLOUD_RPX_CURRENT_FRAGMENT
const candidatePath = process.env.TS_CLOUD_RPX_CANDIDATE_FRAGMENT
const isDashboard = route => /^(?:dashboard|cloud)\\./i.test(String(route?.to || ''))
const current = JSON.parse(readFileSync(currentPath, 'utf8'))
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'))
const retained = Array.isArray(current.proxies) ? current.proxies.filter(isDashboard) : []
const next = Array.isArray(candidate.proxies) ? candidate.proxies.filter(route => !isDashboard(route)) : []
candidate.proxies = [...next, ...retained]
writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + '\\n', { mode: 0o600 })
`.trim()

  return [
    `__tsc_fragment_candidate="$(mktemp "${path}.candidate.XXXXXX")"`,
    `cat > "$__tsc_fragment_candidate" <<'${delimiter}'`,
    content,
    delimiter,
    'chmod 0600 "$__tsc_fragment_candidate"',
    `if [ -f ${path} ]; then TS_CLOUD_RPX_CURRENT_FRAGMENT=${path} TS_CLOUD_RPX_CANDIDATE_FRAGMENT="$__tsc_fragment_candidate" ${options.bunBin} -e ${shellSingleQuote(mergeScript)}; fi`,
    `mv -f "$__tsc_fragment_candidate" ${path}`,
    `chmod 0600 ${path}`,
  ]
}

export interface BuildRpxProvisionOptions {
  config: RpxGatewayConfig
  proxy: ComputeProxyConfig
  /**
   * This project's slug — the registry fragment is written to
   * `<sites.d>/<slug>.json`. So a box can host several independent apps and each
   * deploy only rewrites its own fragment. Defaults to `'app'` for single-app
   * boxes / backward compatibility.
   */
  slug?: string
  /** Absolute path to the `bun` binary on the box. @default '/usr/local/bin/bun' */
  bunBin?: string
  /** Keep the dashboard route currently running on the box during an app-only deploy. */
  preserveManagementDashboardRoutes?: boolean
  /**
   * Host profile, when the caller knows it (the ssh provider resolves one; the
   * cloud drivers do not and leave this undefined, keeping their unit byte for
   * byte what it was). `raspberry-pi` lowers the gateway's memory ceilings, see
   * {@link RASPBERRY_PI_PROXY_MEMORY}.
   */
  profile?: 'raspberry-pi' | 'generic'
}

/**
 * Gateway cgroup ceilings by host profile.
 *
 * The generic defaults are sized for a 4G+ cloud box. A Pi is commonly a 2G
 * board also running the app, a database and swap on an SD card, where a
 * 768M ceiling is not a bound at all: the gateway can take a third of RAM
 * before systemd notices, and the reclaim that follows lands on the SD card.
 * The gateway's steady state is well under 100M on either machine, so the
 * lower pair still leaves the same order of magnitude of burst room.
 */
export const RASPBERRY_PI_PROXY_MEMORY = { high: '256M', max: '384M' } as const
export const DEFAULT_PROXY_MEMORY = { high: '512M', max: '768M' } as const

export const RPX_CERT_RENEW_SCRIPT = '/etc/rpx/renew-certs.sh'
export const RPX_CERT_RENEW_SERVICE = 'rpx-cert-renew.service'
export const RPX_CERT_RENEW_TIMER = 'rpx-cert-renew.timer'

export function rpxCertRenewServiceName(slug: string): string {
  const safeSlug = (slug || 'app').replace(/[^a-z0-9._-]+/gi, '-')
  return `rpx-cert-renew-${safeSlug}.service`
}

/** The routable FQDNs in a gateway config — each terminates TLS so each needs a cert. */
export function certDomainsForConfig(config: RpxGatewayConfig): string[] {
  const seen = new Set<string>()
  for (const r of config.proxies) {
    const host = r.to
    // Skip wildcards / non-FQDN / host:port — http-01 can only cover real names.
    if (!host || host.startsWith('*') || host.includes(':') || !host.includes('.')) continue
    seen.add(host)
  }
  return [...seen]
}

/**
 * Commands that make ts-cloud manage the gateway's TLS certs end-to-end: install
 * tlsx, issue a Let's Encrypt cert for every routed domain via http-01 (the
 * running gateway serves the challenge from {@link RpxGatewayConfig.acmeChallengeWebroot}
 * on `:80`, so no downtime), and a daily systemd timer that renews anything
 * expiring within 30 days and reloads the gateway only when a cert changed.
 *
 * Returns `[]` (no-op) unless on-demand/managed TLS is enabled and there's at
 * least one routable domain. Must run AFTER the gateway is started so the
 * challenge listener is live.
 */
export function buildCertManagementCommands(options: BuildRpxProvisionOptions): string[] {
  const { config, proxy } = options
  const webroot = config.acmeChallengeWebroot
  const domains = certDomainsForConfig(config)
  if (!proxy.onDemandTls || !webroot || domains.length === 0) return []

  const bunBin = options.bunBin ?? '/usr/local/bin/bun'
  const version = proxy.version ?? 'latest'
  const certsDir = config.productionCerts.certsDir
  const email = proxy.onDemandTlsEmail ?? `webmaster@${domains[0]}`
  const tlsxCli = `${bunBin} ${RPX_INSTALL_DIR}/node_modules/@stacksjs/tlsx/dist/bin/cli.js`
  const csv = domains.join(',')
  const spaced = domains.join(' ')
  // Per-app renewal units so each app's deploy manages only its own certs — one
  // app's deploy never touches another app's renewal (Forge-style independence).
  const slug = (options.slug || 'app').replace(/[^a-z0-9._-]+/gi, '-')
  const renewScriptPath = `${RPX_DIR}/renew-certs-${slug}.sh`
  const renewServiceName = rpxCertRenewServiceName(slug)
  const renewTimerName = `rpx-cert-renew-${slug}.timer`

  const renewScript = [
    '#!/bin/sh',
    '# Generated by ts-cloud — issue/renew rpx gateway TLS certs via tlsx http-01.',
    '# The running gateway serves the challenge from $WEBROOT on :80, so this needs',
    '# no downtime and no DNS credentials. Reloads the gateway only if a cert changed.',
    'set -u',
    `CERTS='${certsDir}'`,
    `WEBROOT='${webroot}'`,
    `EMAIL='${email}'`,
    `TLSX="${tlsxCli}"`,
    `BUN='${bunBin}'`,
    `DOMAINS='${csv}'`,
    "DNS_ATTEMPTS='24'",
    "DNS_DELAY_SECONDS='5'",
    `DNS_RESOLVERS='${PUBLIC_DNS_RESOLVERS.join(' ')}'`,
    // Ask PUBLIC resolvers, not this box's.
    //
    // Let's Encrypt validates from its own recursive resolvers, which query the
    // domain's authoritative nameservers — the box's view of DNS has nothing to
    // do with whether the challenge will succeed. Gating on `getent` (the local
    // stub, i.e. whatever the host provider runs) made a freshly-created record
    // unissuable for as long as that resolver cached the zone's previous
    // negative answer: Hetzner's resolvers hold NODATA for the zone's SOA
    // minimum, which is routinely 30 minutes, so the first deploy of a new
    // domain waited two minutes, gave up, and shipped a site with no
    // certificate — while the record had been publicly resolvable the whole time.
    'dns_resolves() {',
    '  d="$1"',
    '  for ns in $DNS_RESOLVERS; do',
    '    if $BUN --eval "const{Resolver}=require(\'node:dns\');const r=new Resolver();r.setServers([process.argv[1]]);r.resolve4(process.argv[2],e=>process.exit(e?1:0))" "$ns" "$d" >/dev/null 2>&1; then',
    '      return 0',
    '    fi',
    '  done',
    // Last resort: the local resolver. Correct whenever it is not holding a
    // stale negative answer, and the only option if egress to :53 is blocked.
    '  getent ahosts "$d" >/dev/null 2>&1',
    '}',
    'wait_for_dns() {',
    '  d="$1"',
    '  attempt=1',
    '  while ! dns_resolves "$d"; do',
    '    if [ "$attempt" -ge "$DNS_ATTEMPTS" ]; then',
    '      echo "DNS for $d did not become resolvable after $DNS_ATTEMPTS attempts" >&2',
    '      return 1',
    '    fi',
    '    echo "Waiting for public DNS before ACME: $d (attempt $attempt/$DNS_ATTEMPTS)"',
    '    sleep "$DNS_DELAY_SECONDS"',
    '    attempt=$((attempt + 1))',
    '  done',
    '}',
    'before=$(cat "$CERTS"/*.crt 2>/dev/null | sha256sum)',
    `for d in ${spaced}; do`,
    '  if [ ! -s "$CERTS/$d.crt" ]; then',
    '    if wait_for_dns "$d"; then',
    '      $TLSX acme:issue -d "$d" --method http-01 --webroot "$WEBROOT" --dir "$CERTS" --prod --email "$EMAIL" || echo "issue $d failed (non-fatal)"',
    '    else',
    '      echo "issue $d skipped until DNS resolves (non-fatal)"',
    '    fi',
    '    # rpx reloads its SNI set when a PEM appears. Complete that reload',
    '    # before the next hostname starts http-01, or :80 can disappear in',
    '    # the middle of the following challenge on a multi-domain deploy.',
    `    [ -s "$CERTS/$d.crt" ] && systemctl restart ${RPX_SERVICE_NAME}`,
    '  fi',
    'done',
    '$TLSX acme:renew --domains "$DOMAINS" --method http-01 --webroot "$WEBROOT" --dir "$CERTS" --days 30 --prod --email "$EMAIL" || echo "renew: some domains failed (non-fatal)"',
    'rm -f "$CERTS"/*.chain.crt',
    'after=$(cat "$CERTS"/*.crt 2>/dev/null | sha256sum)',
    `[ "$before" = "$after" ] || systemctl restart ${RPX_SERVICE_NAME}`,
  ].join('\n')

  const renewService = [
    '[Unit]',
    `Description=Issue/renew rpx gateway TLS certs for ${slug} (tlsx http-01)`,
    `After=network-online.target ${RPX_SERVICE_NAME}`,
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${renewScriptPath}`,
  ].join('\n')

  const renewTimer = [
    '[Unit]',
    `Description=Daily rpx gateway TLS cert issuance/renewal for ${slug}`,
    '',
    '[Timer]',
    'OnCalendar=*-*-* 03:30:00',
    'RandomizedDelaySec=1h',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
  ].join('\n')

  return [
    `mkdir -p ${webroot}`,
    `(cd ${RPX_INSTALL_DIR} && ${bunBin} add @stacksjs/tlsx@${version}) || true`,
    ...writeFileHeredoc(renewScriptPath, renewScript, 'TS_CLOUD_RENEW_EOF'),
    `chmod +x ${renewScriptPath}`,
    ...writeFileHeredoc(`/etc/systemd/system/${renewServiceName}`, renewService, 'TS_CLOUD_RENEW_SVC_EOF'),
    ...writeFileHeredoc(`/etc/systemd/system/${renewTimerName}`, renewTimer, 'TS_CLOUD_RENEW_TIMER_EOF'),
    'systemctl daemon-reload',
    `systemctl enable --now ${renewTimerName} || true`,
    // Initial issuance now (gateway is already up to answer the challenge).
    `${renewScriptPath} || true`,
  ]
}

/**
 * Build the idempotent, re-runnable shell commands that install rpx as the
 * gateway, write the generated launcher + ensure the certs dir, install the
 * systemd unit, and enable + (re)start it on :80/:443.
 *
 * Safe to run at first boot (cloud-init) and again on every deploy — the unit
 * write + `systemctl restart` reloads the regenerated routes so new
 * server-app/server-static sites appear in the gateway automatically.
 */
export function buildRpxProvisionScript(options: BuildRpxProvisionOptions): string[] {
  const { config, proxy } = options
  const bunBin = options.bunBin ?? '/usr/local/bin/bun'
  const version = proxy.version ?? 'latest'
  const certsDir = config.productionCerts.certsDir
  // This app's registry fragment + the stable assembler launcher. Writing only
  // the fragment (not the whole launcher) is what lets independent app deploys
  // share one box's gateway without clobbering each other (see RPX_SITES_DIR).
  const slug = (options.slug || 'app').replace(/[^a-z0-9._-]+/gi, '-')
  const fragment = JSON.stringify({ slug, ...config }, null, 2)
  const assembler = renderRpxAssembler(RPX_SITES_DIR, certsDir)

  // Bound stalled upstreams. rpx's pooled transport caps connections per
  // upstream and queues requests for a free slot; with no inactivity timeout a
  // hung upstream socket holds its slot forever, and enough leaked slots wedge
  // the gateway (handshakes succeed but no request is ever answered). rpx leaves
  // this opt-in for dev streaming, so a production gateway must set it — default
  // 60s, `0` to disable. `RPX_MAX_UPSTREAM_CONNS` is passed through only when set.
  const upstreamTimeout = proxy.upstreamTimeout ?? 60
  const poolEnv = [`Environment=RPX_UPSTREAM_TIMEOUT=${upstreamTimeout}`]
  if (typeof proxy.maxUpstreamConns === 'number')
    poolEnv.push(`Environment=RPX_MAX_UPSTREAM_CONNS=${proxy.maxUpstreamConns}`)
  // A shared app box can run many Bun tenants plus databases and search. Keep a
  // gateway spike inside its own cgroup so global pressure cannot make the
  // kernel choose the mail server or another unrelated service as the victim.
  // The gateway normally stays well below 100M; these defaults leave ample
  // burst room while remaining safe on a 4G host, and the raspberry-pi profile
  // scales them down for a board that has a fraction of that RAM. An explicit
  // `proxy.memoryHigh` / `proxy.memoryMax` always wins over either default.
  const memoryDefaults = options.profile === 'raspberry-pi' ? RASPBERRY_PI_PROXY_MEMORY : DEFAULT_PROXY_MEMORY
  const memoryHigh = proxy.memoryHigh ?? memoryDefaults.high
  const memoryMax = proxy.memoryMax ?? memoryDefaults.max

  return [
    'set -euo pipefail',
    `mkdir -p ${RPX_DIR} ${RPX_SITES_DIR} ${certsDir} ${RPX_INSTALL_DIR}`,
    // Install @stacksjs/rpx into an isolated managed project. Bun's global
    // install state can inherit stale dependency metadata, while a clean local
    // project install is deterministic and keeps the gateway self-contained.
    // The install is STAGED, then swapped in: the old flow wiped node_modules
    // BEFORE `bun add`, so a failed add (registry hiccup) left the live gateway
    // uninstallable — the next restart (cert renewal, box reboot) crashed the
    // proxy. A failed add now aborts with the previous install untouched, and
    // the swap itself is two renames on one filesystem.
    `rm -rf ${RPX_INSTALL_DIR}.next ${RPX_INSTALL_DIR}.prev`,
    `mkdir -p ${RPX_INSTALL_DIR}.next`,
    `(cd ${RPX_INSTALL_DIR}.next && ${bunBin} add @stacksjs/rpx@${version})`,
    `mv ${RPX_INSTALL_DIR} ${RPX_INSTALL_DIR}.prev`,
    `mv ${RPX_INSTALL_DIR}.next ${RPX_INSTALL_DIR}`,
    `rm -rf ${RPX_INSTALL_DIR}.prev`,
    `ln -sfn ${RPX_INSTALL_DIR}/node_modules ${RPX_DIR}/node_modules`,
    // Write THIS app's registry fragment (its routes only) — root-only: it
    // carries basic-auth passwords and the origin-guard shared secret, and the
    // assembler runs as root so nothing else needs read access.
    ...writeRpxFragment(`${RPX_SITES_DIR}/${slug}.json`, fragment, 'TS_CLOUD_RPX_FRAGMENT_EOF', {
      bunBin,
      preserveManagementDashboardRoutes: options.preserveManagementDashboardRoutes,
    }),
    // ... and the stable assembler launcher that merges every app's fragment.
    ...writeFileHeredoc(RPX_LAUNCHER_PATH, assembler, 'TS_CLOUD_RPX_EOF'),
    // Compile the generated, route-specific launcher in Bun production mode.
    // This removes runtime TypeScript parsing/module traversal from the hot
    // gateway process. The command runs before the unit is rewritten or
    // restarted, so a failed compile leaves the currently-running gateway
    // untouched.
    `${bunBin} build --production --compile --outfile ${RPX_BINARY_PATH}.next ${RPX_LAUNCHER_PATH}`,
    `chmod 0755 ${RPX_BINARY_PATH}.next`,
    `mv -f ${RPX_BINARY_PATH}.next ${RPX_BINARY_PATH}`,
    // systemd unit: runs the launcher as root so it can bind :80/:443.
    ...writeFileHeredoc(
      `/etc/systemd/system/${RPX_SERVICE_NAME}`,
      [
        '[Unit]',
        'Description=rpx reverse-proxy gateway (managed by ts-cloud)',
        'After=network.target network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${RPX_BINARY_PATH}`,
        `WorkingDirectory=${RPX_INSTALL_DIR}`,
        `Environment=BUN_INSTALL=/root/.bun`,
        `Environment=APP_ENV=production`,
        `Environment=NODE_ENV=production`,
        ...poolEnv,
        'MemoryAccounting=true',
        `MemoryHigh=${memoryHigh}`,
        `MemoryMax=${memoryMax}`,
        // Every tenant on the box is served THROUGH this process, so under
        // contention it has to outrank the work it is serving. The default
        // weight is 100: a batch scanner or a build saturating the cores would
        // otherwise compete with the gateway on equal terms, and the symptom
        // is every site on the host getting slower at once — which reads as a
        // network problem rather than a scheduling one.
        //
        // This box had exactly this hierarchy applied by hand, gateway at 500
        // down to dashboards at 10, recorded in no repo and surviving only
        // because nobody rebuilt the machine. Declared here it survives a
        // rebuild, which is the whole difference between a policy and a
        // memory of one.
        'CPUWeight=500',
        'IOWeight=500',
        'OOMPolicy=stop',
        'Restart=always',
        'RestartSec=5',
        // Without a start limit, a gateway that cannot bind restarts forever.
        // A production box was found mid-crash-loop at restart 65: an orphaned
        // predecessor held :443, every new instance died on EADDRINUSE, and
        // systemd reported the unit as `activating` the whole time while the
        // orphan served a stale route table. Bounded, it lands in `failed`,
        // which is visible to both an operator and a monitor.
        'StartLimitIntervalSec=120',
        'StartLimitBurst=5',
        // `systemctl disable --now` on a predecessor does not kill a process
        // whose unit is already inactive, and that is precisely the case that
        // wedged the box. Clear the ports from whatever actually holds them
        // before binding. `|| true` so a clean boot is not a startup failure.
        'ExecStartPre=/bin/sh -c \'for p in 80 443; do fuser -k -n tcp "$p" 2>/dev/null || true; done; sleep 1\'',
        'LimitNOFILE=1048576',
        'AmbientCapabilities=CAP_NET_BIND_SERVICE',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
      ].join('\n'),
      'TS_CLOUD_RPX_UNIT_EOF',
    ),
    'systemctl daemon-reload',
    // Older ts-cloud/stacks boxes used bun-gateway.service for the same
    // :80/:443 role. Retire managed predecessors so rpx can bind cleanly.
    'systemctl disable --now bun-gateway.service 2>/dev/null || true',
    'systemctl disable --now bun-gateway-renew.timer bun-gateway-renew.service 2>/dev/null || true',
    'rm -f /etc/systemd/system/bun-gateway-renew.timer /etc/systemd/system/bun-gateway-renew.service',
    'systemctl disable --now ts-cloud-nginx.service 2>/dev/null || true',
    // Retired tenants must not leave daily renewal processes behind. A live
    // tenant always owns a same-slug atomic route fragment, so absence is a
    // safe and deterministic ownership test on a shared box.
    `for timer in /etc/systemd/system/rpx-cert-renew-*.timer; do [ -e "$timer" ] || continue; unit="$(basename "$timer")"; tenant="\${unit#rpx-cert-renew-}"; tenant="\${tenant%.timer}"; [ -f "${RPX_SITES_DIR}/$tenant.json" ] && continue; systemctl disable --now "$unit" 2>/dev/null || true; rm -f "$timer" "/etc/systemd/system/rpx-cert-renew-$tenant.service" "${RPX_DIR}/renew-certs-$tenant.sh"; done`,
    `systemctl enable ${RPX_SERVICE_NAME}`,
    `systemctl restart ${RPX_SERVICE_NAME}`,
    // Managed TLS (issue on deploy + daily renewal). No-op unless onDemandTls is
    // set. Runs after the gateway is up so the http-01 challenge is answerable.
    ...buildCertManagementCommands(options),
  ]
}

export interface BuildRpxFragmentRefreshOptions {
  /** The gateway config this deploy resolved (single-box or LB multi-upstream). */
  config: RpxGatewayConfig
  /**
   * This project's slug — the registry fragment is rewritten at
   * `<sites.d>/<slug>.json`, exactly as in {@link buildRpxProvisionScript}.
   * Defaults to `'app'`.
   */
  slug?: string
  /** Keep the dashboard route currently running on the box during an app-only deploy. */
  preserveManagementDashboardRoutes?: boolean
}

/**
 * Build the shell commands that rewrite ONLY this app's rpx route fragment
 * (`<sites.d>/<slug>.json`) and restart the gateway, so the running assembler
 * re-merges every fragment and the new routes go live.
 *
 * Unlike {@link buildRpxProvisionScript} this does NOT reinstall rpx/tlsx,
 * rewrite the assembler launcher, or touch the systemd unit — it is the cheap
 * reload for a box whose gateway is already provisioned. That is exactly the
 * bun-fleet load-balancer situation: the LB box is created once (cloud-init
 * writes the fragment at first boot) but long outlives any single deploy, so
 * its routes must be refreshed from the CURRENT sites model + CURRENT app-box
 * upstreams on every provision/deploy — otherwise sites added later 404 and
 * app-fleet scale changes never reach the gateway. The `systemctl restart`
 * re-runs the stable assembler, which re-reads all of {@link RPX_SITES_DIR}.
 */
export function buildRpxFragmentRefreshScript(options: BuildRpxFragmentRefreshOptions): string[] {
  const slug = (options.slug || 'app').replace(/[^a-z0-9._-]+/gi, '-')
  // Byte-identical fragment serialization to buildRpxProvisionScript, so a box
  // cannot tell whether its fragment came from first boot or a later refresh.
  const fragment = JSON.stringify({ slug, ...options.config }, null, 2)
  return [
    'set -euo pipefail',
    `mkdir -p ${RPX_SITES_DIR}`,
    // Root-only (0600), atomic temp+rename — same as the provision-time write:
    // the fragment carries basic-auth passwords and the origin-guard secret.
    ...writeRpxFragment(`${RPX_SITES_DIR}/${slug}.json`, fragment, 'TS_CLOUD_RPX_FRAGMENT_EOF', {
      bunBin: '/usr/local/bin/bun',
      preserveManagementDashboardRoutes: options.preserveManagementDashboardRoutes,
    }),
    `systemctl restart ${RPX_SERVICE_NAME}`,
  ]
}
