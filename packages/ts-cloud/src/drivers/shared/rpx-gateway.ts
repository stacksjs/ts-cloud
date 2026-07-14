/**
 * Generate the rpx reverse-proxy gateway config + provisioning from the `sites`
 * model.
 *
 * ts-cloud's per-site deploy model resolves each site to one of three kinds
 * (see {@link import('../../deploy/site-target').resolveSiteKind}):
 *  - `server-app`    — a dynamic app running on a port (systemd service);
 *  - `server-static` — a static site shipped to `/var/www/<name>`;
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
import type { ComputeProxyConfig, RpxLoadBalancerConfig, SiteConfig, SiteRedirectConfig } from '@ts-cloud/core'
import { resolveSiteKind } from '../../deploy/site-target'

/** Default directory on the box that holds real per-domain TLS certs. */
export const DEFAULT_RPX_CERTS_DIR = '/etc/rpx/certs'

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
  if (typeof input === 'string')
    return { to: input }
  const out: RpxRedirect = { to: input.to }
  if (input.status != null)
    out.status = input.status
  if (input.preservePath != null)
    out.preservePath = input.preservePath
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
  static?: string | { dir: string, spa?: boolean, pathRewriteStyle?: 'directory' | 'flat', maxAge?: number }
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
  auth?: { username: string, password: string, realm?: string }
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
  if (!auth || auth.enabled === false || !auth.password)
    return undefined
  return {
    username: auth.username || 'admin',
    password: auth.password,
    ...(auth.realm ? { realm: auth.realm } : {}),
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
  productionCerts: { certsDir: string }
  /**
   * On-demand TLS (opt-in): lazily issue a real cert for an approved host the
   * first time it's needed. The site domains form the allowlist.
   */
  onDemandTls?: { enabled: true, allowedSuffixes: string[], email?: string, certsDir: string }
  /**
   * Directory the gateway serves ACME http-01 challenge tokens from on `:80`
   * before redirecting to HTTPS. Set when ts-cloud manages certs so the renewal
   * cron (`tlsx acme:renew --webroot`) can issue/renew without taking the gateway
   * down to free `:80`. Omitted ⇒ the `:80` server only redirects.
   */
  acmeChallengeWebroot?: string
  /** Always `true` — the gateway terminates TLS on the box. */
  https: true
  /** Never touch `/etc/hosts` on a real server with real DNS. */
  hostsManagement: false
  /** Don't remove certs/hosts on exit. */
  cleanup: { hosts: false, certs: false }
  /**
   * Origin lockdown (from `proxy.cdn` when a `secret` is set): rpx rejects
   * direct hits to the CDN-fronted hosts that lack the shared-secret header.
   */
  originGuard?: { header: string, value: string, hosts: string[] }
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
}

/**
 * Normalize a path prefix to a leading-slash, no-trailing-slash form, or
 * `undefined` for the host default. Mirrors rpx's `normalizePathPrefix`.
 */
export function normalizeRoutePath(path: string | undefined): string | undefined {
  if (!path || path === '/')
    return undefined
  let p = `/${path}`.replace(/\/+/g, '/').replace(/\/+$/, '')
  if (!p.startsWith('/'))
    p = `/${p}`
  return p === '' || p === '/' ? undefined : p
}

/** Derive a stable, filesystem/registry-safe id from a host (+ optional path). */
export function deriveRouteId(to: string, path?: string): string {
  const base = path ? `${to}${path}` : to
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128)
  return cleaned.length > 0 ? cleaned : 'rpx'
}

/**
 * Resolve a `server-app` site's upstream `from` — either a single co-located
 * `localhost:<port>` (the default, single-box behavior) or, when `appBoxes` is
 * given (a load-balanced fleet), one `host:port` per app box using each box's
 * private IP (falling back to its public IP when no private IP is available).
 */
function resolveServerAppFrom(port: number, appBoxes?: RpxLbAppBox[]): string | string[] {
  if (!appBoxes || appBoxes.length === 0)
    return `localhost:${port}`
  return appBoxes.map(box => `${box.privateIp ?? box.publicIp}:${port}`)
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
    if (!site || !site.domain)
      continue
    const kind = resolveSiteKind(site)
    if (kind === 'bucket')
      continue

    const path = normalizeRoutePath(site.path)
    const id = deriveRouteId(site.domain, path)
    const auth = resolveRouteAuth(site)

    if (kind === 'redirect') {
      // Gateway-only redirect: answer `domain` with a Location to the target.
      // `site.redirect` is guaranteed here (it's what makes the kind 'redirect').
      proxies.push({ to: site.domain, path, redirect: normalizeSiteRedirect(site.redirect!), id, ...(auth ? { auth } : {}) })
      domains.add(site.domain)
      continue
    }

    if (kind === 'server-app') {
      // A server-app must declare the port it listens on to be routable.
      if (typeof site.port !== 'number')
        continue
      const from = resolveServerAppFrom(site.port, appBoxes)
      proxies.push({
        to: site.domain,
        path,
        from,
        id,
        ...(auth ? { auth } : {}),
        ...(Array.isArray(from) && loadBalancer ? { loadBalancer } : {}),
      })
    }
    else {
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
      if (domain.split('.').length !== 2)
        continue
      const wwwDomain = `www.${domain}`
      if (domains.has(wwwDomain))
        continue
      proxies.push({ to: wwwDomain, redirect: { to: `https://${domain}` }, id: deriveRouteId(wwwDomain) })
      domains.add(wwwDomain)
    }
  }

  // Sort so routes group by domain and, within a domain, the most-specific path
  // comes first (cosmetic — rpx re-sorts longest-prefix-first at runtime).
  proxies.sort((a, b) => {
    if (a.to !== b.to)
      return a.to.localeCompare(b.to)
    return (b.path?.length ?? 0) - (a.path?.length ?? 0)
  })

  const config: RpxGatewayConfig = {
    proxies,
    productionCerts: { certsDir },
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
    }
  }

  // When ts-cloud manages TLS, the gateway serves ACME http-01 challenges on :80
  // so certs can be issued/renewed (by the deploy + a renewal cron) without
  // taking the gateway down to free :80. See buildRpxProvisionScript's cert step.
  if (options.proxy.onDemandTls) {
    config.acmeChallengeWebroot = options.proxy.acmeWebroot ?? DEFAULT_ACME_WEBROOT
  }

  // CDN-in-front origin lockdown: enforce the shared secret on the fronted hosts.
  const cdn = options.proxy.cdn
  if (cdn?.secret && cdn.frontedHosts.length > 0) {
    config.originGuard = {
      header: cdn.secretHeader ?? 'X-Origin-Verify',
      value: cdn.secret,
      hosts: cdn.frontedHosts,
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

await startProxies(config as any)
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
export function usesRpxProxy(compute?: { webServer?: string, proxy?: { engine?: string } }): boolean {
  return compute?.webServer === 'rpx' || compute?.proxy?.engine === 'rpx'
}

/** Default install location for the gateway launcher + config on the box. */
export const RPX_DIR = '/etc/rpx'
export const RPX_INSTALL_DIR = '/opt/rpx-gateway'
export const RPX_LAUNCHER_PATH = '/etc/rpx/gateway.ts'
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
  let guard: { header: string, value: string } | undefined

  for (const f of fragments) {
    for (const p of f.proxies ?? []) {
      const key = p.id || `${p.to}${p.path ?? ''}`
      if (seen.has(key))
        continue
      seen.add(key)
      proxies.push(p)
    }
    for (const s of f.onDemandTls?.allowedSuffixes ?? [])
      suffixes.add(s)
    email ??= f.onDemandTls?.email
    if (f.productionCerts?.certsDir)
      certsDir = f.productionCerts.certsDir
    acmeChallengeWebroot ??= f.acmeChallengeWebroot
    if (f.originGuard) {
      guard ??= { header: f.originGuard.header, value: f.originGuard.value }
      for (const h of f.originGuard.hosts)
        guardHosts.add(h)
    }
  }

  const merged: RpxGatewayConfig = {
    proxies,
    productionCerts: { certsDir },
    https: true,
    hostsManagement: false,
    cleanup: { hosts: false, certs: false },
  }
  if (suffixes.size > 0)
    merged.onDemandTls = { enabled: true, allowedSuffixes: [...suffixes], email, certsDir }
  if (acmeChallengeWebroot)
    merged.acmeChallengeWebroot = acmeChallengeWebroot
  if (guard)
    merged.originGuard = { header: guard.header, value: guard.value, hosts: [...guardHosts] }
  return merged
}

/**
 * Render the stable assembler launcher. Its content is identical for every app
 * and every deploy — it reads all `<slug>.json` fragments from {@link RPX_SITES_DIR}
 * at startup, merges them (same algorithm as {@link mergeRpxFragments}), and
 * starts the gateway. A malformed fragment is skipped, not fatal.
 */
export function renderRpxAssembler(sitesDir: string = RPX_SITES_DIR, defaultCertsDir: string = DEFAULT_RPX_CERTS_DIR): string {
  return `// Generated by ts-cloud — rpx gateway assembler.
// Merges every app's fragment in ${sitesDir} so independent deploys compose
// without clobbering each other. Each deploy writes only its own <slug>.json.
import { startProxies } from '@stacksjs/rpx'
import { readdirSync, readFileSync } from 'node:fs'

const dir = ${JSON.stringify(sitesDir)}
const proxies = []
const seen = new Set()
const suffixes = new Set()
const guardHosts = new Set()
let email
let certsDir = ${JSON.stringify(defaultCertsDir)}
let acmeChallengeWebroot
let guard
let files = []
try { files = readdirSync(dir).filter(n => n.endsWith('.json')).sort() } catch {}
for (const f of files) {
  let frag
  try { frag = JSON.parse(readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  for (const p of frag.proxies ?? []) {
    const key = p.id || (p.to + (p.path ?? ''))
    if (seen.has(key)) continue
    seen.add(key)
    proxies.push(p)
  }
  for (const s of frag.onDemandTls?.allowedSuffixes ?? []) suffixes.add(s)
  email ??= frag.onDemandTls?.email
  if (frag.productionCerts?.certsDir) certsDir = frag.productionCerts.certsDir
  acmeChallengeWebroot ??= frag.acmeChallengeWebroot
  if (frag.originGuard) {
    guard ??= { header: frag.originGuard.header, value: frag.originGuard.value }
    for (const h of frag.originGuard.hosts ?? []) guardHosts.add(h)
  }
}
const config = {
  proxies,
  productionCerts: { certsDir },
  https: true,
  hostsManagement: false,
  cleanup: { hosts: false, certs: false },
  ...(suffixes.size > 0 ? { onDemandTls: { enabled: true, allowedSuffixes: [...suffixes], email, certsDir } } : {}),
  ...(acmeChallengeWebroot ? { acmeChallengeWebroot } : {}),
  ...(guard ? { originGuard: { header: guard.header, value: guard.value, hosts: [...guardHosts] } } : {}),
}

await startProxies(config)
`
}

/**
 * Embed a here-doc that writes `content` to `path` without the shell expanding
 * `$`/backticks (quoted heredoc delimiter).
 */
function writeFileHeredoc(path: string, content: string, delimiter: string): string[] {
  return [
    `cat > ${path} <<'${delimiter}'`,
    content,
    delimiter,
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
}

export const RPX_CERT_RENEW_SCRIPT = '/etc/rpx/renew-certs.sh'
export const RPX_CERT_RENEW_SERVICE = 'rpx-cert-renew.service'
export const RPX_CERT_RENEW_TIMER = 'rpx-cert-renew.timer'

/** The routable FQDNs in a gateway config — each terminates TLS so each needs a cert. */
export function certDomainsForConfig(config: RpxGatewayConfig): string[] {
  const seen = new Set<string>()
  for (const r of config.proxies) {
    const host = r.to
    // Skip wildcards / non-FQDN / host:port — http-01 can only cover real names.
    if (!host || host.startsWith('*') || host.includes(':') || !host.includes('.'))
      continue
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
  if (!proxy.onDemandTls || !webroot || domains.length === 0)
    return []

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
  const renewServiceName = `rpx-cert-renew-${slug}.service`
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
    `DOMAINS='${csv}'`,
    'before=$(cat "$CERTS"/*.crt 2>/dev/null | sha256sum)',
    `for d in ${spaced}; do`,
    '  [ -s "$CERTS/$d.crt" ] || $TLSX acme:issue -d "$d" --method http-01 --webroot "$WEBROOT" --dir "$CERTS" --prod --email "$EMAIL" || echo "issue $d failed (non-fatal)"',
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

  return [
    'set -euo pipefail',
    `mkdir -p ${RPX_DIR} ${RPX_SITES_DIR} ${certsDir} ${RPX_INSTALL_DIR}`,
    // Install @stacksjs/rpx into an isolated managed project. Bun's global
    // install state can inherit stale dependency metadata, while a clean local
    // project install is deterministic and keeps the gateway self-contained.
    `rm -rf ${RPX_INSTALL_DIR}/node_modules ${RPX_INSTALL_DIR}/bun.lock ${RPX_INSTALL_DIR}/package.json`,
    `(cd ${RPX_INSTALL_DIR} && ${bunBin} add @stacksjs/rpx@${version})`,
    `ln -sfn ${RPX_INSTALL_DIR}/node_modules ${RPX_DIR}/node_modules`,
    // Write THIS app's registry fragment (its routes only) ...
    ...writeFileHeredoc(`${RPX_SITES_DIR}/${slug}.json`, fragment, 'TS_CLOUD_RPX_FRAGMENT_EOF'),
    // ... and the stable assembler launcher that merges every app's fragment.
    ...writeFileHeredoc(RPX_LAUNCHER_PATH, assembler, 'TS_CLOUD_RPX_EOF'),
    // systemd unit: runs the launcher as root so it can bind :80/:443.
    ...writeFileHeredoc(`/etc/systemd/system/${RPX_SERVICE_NAME}`, [
      '[Unit]',
      'Description=rpx reverse-proxy gateway (managed by ts-cloud)',
      'After=network.target network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${bunBin} ${RPX_LAUNCHER_PATH}`,
      `WorkingDirectory=${RPX_INSTALL_DIR}`,
      `Environment=BUN_INSTALL=/root/.bun`,
      ...poolEnv,
      'Restart=always',
      'RestartSec=5',
      'LimitNOFILE=1048576',
      'AmbientCapabilities=CAP_NET_BIND_SERVICE',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n'), 'TS_CLOUD_RPX_UNIT_EOF'),
    'systemctl daemon-reload',
    // Older ts-cloud/stacks boxes used bun-gateway.service for the same
    // :80/:443 role. Retire managed predecessors so rpx can bind cleanly.
    'systemctl disable --now bun-gateway.service 2>/dev/null || true',
    'systemctl disable --now ts-cloud-nginx.service 2>/dev/null || true',
    `systemctl enable ${RPX_SERVICE_NAME}`,
    `systemctl restart ${RPX_SERVICE_NAME}`,
    // Managed TLS (issue on deploy + daily renewal). No-op unless onDemandTls is
    // set. Runs after the gateway is up so the http-01 challenge is answerable.
    ...buildCertManagementCommands(options),
  ]
}
