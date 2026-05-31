import type { CaddyAppConfig, CaddyOnDemandTlsConfig, CaddyProxyConfig, SiteConfig } from '@ts-cloud/core'
import { resolveSiteKind } from '../../deploy/site-target'

/** A domain is "on-demand" (needs lazy TLS) if it's a wildcard or bare catch-all. */
export function isOnDemandDomain(domain: string): boolean {
  return domain === '*' || domain.includes('*')
}

/** A Caddy app is "static" (file_server) when it declares a `root` directory. */
function isStaticApp(app: CaddyAppConfig): boolean {
  return typeof app.root === 'string' && app.root.length > 0
}

/** A Caddy app is a usable reverse-proxy when it declares a numeric `port`. */
function isProxyApp(app: CaddyAppConfig): boolean {
  return typeof app.port === 'number'
}

/**
 * The on-server install path a static site's `root` is shipped to. Mirrors the
 * release layout used by the systemd app deploy (`/var/www/<name>`), so a box
 * can host both proxied apps and file-served static sites side by side.
 */
export function staticSiteServerRoot(name: string): string {
  return `/var/www/${name}`
}

function normalizeOnDemandTls(
  onDemandTls: CaddyProxyConfig['onDemandTls'],
): CaddyOnDemandTlsConfig | undefined {
  if (!onDemandTls)
    return undefined
  if (onDemandTls === true)
    return {}
  return onDemandTls
}

/** Wrap an inner directive body in a `handle <path> { ... }` block for path routing. */
function wrapInHandle(body: string, path: string, indent: string): string {
  const inner = body
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')
  return `${indent}handle ${path} {\n${inner}\n${indent}}`
}

/**
 * Render the `reverse_proxy` directive (and optional handle wrapper) for one
 * dynamic app. Indentation is applied by the caller via `indent`.
 */
function renderUpstreamBlock(app: CaddyAppConfig, indent: string): string {
  const host = app.upstreamHost || 'localhost'
  const upstream = `${host}:${app.port}`
  const directives = app.reverseProxyDirectives ?? []

  const proxyLine = directives.length === 0
    ? `${indent}reverse_proxy ${upstream}`
    : [
        `${indent}reverse_proxy ${upstream} {`,
        ...directives.map(d => `${indent}  ${d}`),
        `${indent}}`,
      ].join('\n')

  const isCatchAll = !app.path || app.path === '/'
  if (isCatchAll)
    return proxyLine

  // Wrap in a handle so several apps can share a domain with path routing.
  return wrapInHandle(proxyLine, app.path!, indent)
}

/**
 * Render a static `file_server` block for one app: serves files from `root`,
 * with SPA fallback / extensionless rewrites and optional cache headers. The
 * box itself is the origin (no upstream port).
 */
function renderStaticBlock(app: CaddyAppConfig, indent: string): string {
  const root = app.root!
  const lines: string[] = [`${indent}root * ${root}`]

  // Optional Cache-Control header for served assets.
  if (app.cache?.enabled) {
    const maxAge = app.cache.maxAge ?? 3600
    lines.push(`${indent}header Cache-Control "public, max-age=${maxAge}"`)
  }

  if (app.spa) {
    // SPA: any unmatched path falls back to the app shell for client routing.
    lines.push(`${indent}try_files {path} /index.html`)
  }
  else if (app.pathRewriteStyle === 'flat') {
    // /guide/get-started -> /guide/get-started.html
    lines.push(`${indent}try_files {path} {path}.html {path}/index.html`)
  }
  else {
    // directory (default): /guide/get-started -> /guide/get-started/index.html
    lines.push(`${indent}try_files {path} {path}/index.html {path}.html`)
  }

  lines.push(`${indent}file_server`)
  const body = lines.join('\n')

  const isCatchAll = !app.path || app.path === '/'
  if (isCatchAll)
    return body

  return wrapInHandle(body, app.path!, indent)
}

/** Render the appropriate block for an app (static file_server or reverse_proxy). */
function renderAppBlock(app: CaddyAppConfig, indent: string): string {
  return isStaticApp(app) ? renderStaticBlock(app, indent) : renderUpstreamBlock(app, indent)
}

/**
 * Group apps by their domain set so apps that share a domain (path routing)
 * collapse into one site block. The grouping key is the sorted domain list,
 * which keeps host-based routing deterministic.
 */
function groupAppsByDomains(apps: CaddyAppConfig[]): Array<{ domains: string[], apps: CaddyAppConfig[] }> {
  const groups = new Map<string, { domains: string[], apps: CaddyAppConfig[] }>()
  for (const app of apps) {
    const domains = [...app.domains].filter(Boolean)
    if (domains.length === 0)
      continue
    const key = [...domains].sort().join(' ')
    const group = groups.get(key) ?? { domains, apps: [] }
    group.apps.push(app)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Order apps within a shared-domain block: specific paths first, catch-all last. */
function sortAppsByPath(apps: CaddyAppConfig[]): CaddyAppConfig[] {
  return [...apps].sort((a, b) => {
    const aCatchAll = !a.path || a.path === '/'
    const bCatchAll = !b.path || b.path === '/'
    if (aCatchAll && !bCatchAll)
      return 1
    if (!aCatchAll && bCatchAll)
      return -1
    return (b.path?.length ?? 0) - (a.path?.length ?? 0)
  })
}

/**
 * Build a complete Caddyfile from a typed {@link CaddyProxyConfig}.
 *
 * Produces:
 *  - a global options block (ACME email, on-demand TLS `ask`, staging CA, extras);
 *  - one site block per unique domain set, each performing host-based routing to
 *    its upstream app(s);
 *  - `tls { on_demand }` inside any block whose domains are wildcards/catch-all.
 *
 * Returns `undefined` when there's nothing to route (no apps, no raw).
 */
export function buildCaddyfileFromProxy(proxy: CaddyProxyConfig): string | undefined {
  if (proxy.raw && proxy.raw.trim())
    return proxy.raw.trim()

  // An app routes when it has at least one domain AND is either a reverse-proxy
  // (numeric port) or a static file_server (root directory).
  const apps = (proxy.apps ?? []).filter(app => app.domains.length > 0 && (isProxyApp(app) || isStaticApp(app)))
  if (apps.length === 0)
    return undefined

  const onDemand = normalizeOnDemandTls(proxy.onDemandTls)
  const hasOnDemandDomain = apps.some(app => app.domains.some(isOnDemandDomain))

  // Global options block.
  const globalLines: string[] = []
  if (proxy.email)
    globalLines.push(`email ${proxy.email}`)
  if (proxy.staging)
    globalLines.push('acme_ca https://acme-staging-v02.api.letsencrypt.org/directory')
  if (onDemand) {
    if (onDemand.ask || onDemand.interval || onDemand.burst != null) {
      const inner: string[] = []
      if (onDemand.ask)
        inner.push(`  ask ${onDemand.ask}`)
      if (onDemand.interval || onDemand.burst != null) {
        const rl: string[] = []
        if (onDemand.interval)
          rl.push(`    interval ${onDemand.interval}`)
        if (onDemand.burst != null)
          rl.push(`    burst ${onDemand.burst}`)
        inner.push(`  rate_limit {\n${rl.join('\n')}\n  }`)
      }
      globalLines.push(`on_demand_tls {\n${inner.join('\n')}\n}`)
    }
    else {
      globalLines.push('on_demand_tls {\n}')
    }
  }
  for (const directive of proxy.globalDirectives ?? [])
    globalLines.push(directive)

  const blocks: string[] = []
  if (globalLines.length > 0)
    blocks.push(`{\n${globalLines.map(line => `  ${line}`).join('\n')}\n}`)

  for (const group of groupAppsByDomains(apps)) {
    const sorted = sortAppsByPath(group.apps)
    const body = sorted.map(app => renderAppBlock(app, '  ')).join('\n')

    // A block needs on-demand TLS if any of its domains is a wildcard/catch-all.
    const needsOnDemand = onDemand && group.domains.some(isOnDemandDomain)
    const tlsBlock = needsOnDemand ? '\n  tls {\n    on_demand\n  }' : ''

    blocks.push(`${group.domains.join(', ')} {\n${body}${tlsBlock}\n}`)
  }

  // Wildcard/catch-all domains without on-demand TLS can't get a cert — surface
  // it as a comment so an operator inspecting the box understands why.
  if (hasOnDemandDomain && !onDemand) {
    blocks.unshift(
      '# WARNING: wildcard/catch-all domain present but on_demand_tls is not enabled.\n'
      + '# Caddy cannot provision TLS for these hosts. Set compute.proxy.onDemandTls.',
    )
  }

  return blocks.join('\n\n')
}

/**
 * Derive a {@link CaddyProxyConfig} from the legacy `sites` map: every site
 * that declares a `domain` + `port` becomes a Caddy app. Keeps single-app /
 * sites-driven deploys working without an explicit `compute.proxy` block.
 */
export function proxyConfigFromSites(sites: Record<string, SiteConfig>): CaddyProxyConfig & { apps: CaddyAppConfig[] } {
  const apps: CaddyAppConfig[] = []
  for (const [name, site] of Object.entries(sites)) {
    if (typeof site.domain !== 'string' || !site.domain)
      continue

    if (typeof site.port === 'number' && site.deploy !== 'bucket') {
      // Dynamic app → reverse_proxy to its port. Backward compat: any site
      // declaring a domain + port (with or without `start`) becomes a proxy app
      // unless explicitly forced onto the bucket path (deploy:'bucket').
      apps.push({
        name,
        domains: [site.domain],
        port: site.port,
        path: site.path,
      })
    }
    else if (resolveSiteKind(site) === 'server-static') {
      // Static site served on the box → file_server from the shipped root.
      apps.push({
        name,
        domains: [site.domain],
        root: staticSiteServerRoot(name),
        path: site.path,
        spa: site.spa,
        pathRewriteStyle: site.pathRewriteStyle,
        cache: site.cache,
      })
    }
  }
  return { apps }
}

/**
 * Resolve the final Caddyfile for a deploy. Prefers the typed `compute.proxy`
 * config (merging in `sites`-derived apps when `proxy.apps` is omitted), and
 * falls back to deriving everything from `sites`.
 *
 * Returns `undefined` when there's nothing to route.
 */
export function resolveCaddyfile(
  sites: Record<string, SiteConfig>,
  proxy?: CaddyProxyConfig,
): string | undefined {
  if (proxy) {
    if (proxy.raw && proxy.raw.trim())
      return proxy.raw.trim()
    // If the proxy block doesn't enumerate apps, inherit them from sites so a
    // bare `proxy: { onDemandTls: true }` still routes the configured sites.
    const resolved: CaddyProxyConfig = proxy.apps && proxy.apps.length > 0
      ? proxy
      : { ...proxy, apps: proxyConfigFromSites(sites).apps }
    return buildCaddyfileFromProxy(resolved)
  }
  return buildCaddyfileFromProxy(proxyConfigFromSites(sites))
}

/**
 * Build a Caddyfile from site configs. Sites sharing a domain are grouped;
 * explicit paths are ordered before catch-all routes.
 *
 * @deprecated Prefer {@link resolveCaddyfile} / {@link buildCaddyfileFromProxy},
 * which support multi-app host routing and on-demand TLS. Retained for
 * backward compatibility.
 */
export function buildCaddyfile(sites: Record<string, SiteConfig>): string | undefined {
  return buildCaddyfileFromProxy(proxyConfigFromSites(sites))
}
