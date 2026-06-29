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
import type { ComputeProxyConfig, SiteConfig } from '@ts-cloud/core'
import { resolveSiteKind } from '../../deploy/site-target'

/** Default directory on the box that holds real per-domain TLS certs. */
export const DEFAULT_RPX_CERTS_DIR = '/etc/rpx/certs'

/** A single rpx proxy route, mapped from one site. */
export interface RpxRoute {
  /** Public host this route is served under (the site's `domain`). */
  to: string
  /** Path prefix within the host this route owns (e.g. `/api`). Omitted = `/`. */
  path?: string
  /** Upstream `host:port` for a `server-app` route. */
  from?: string
  /** Absolute directory served for a `server-static` route (`/var/www/<name>`). */
  static?: string
  /** Strip `.html` and resolve clean URLs (set for static sites). */
  cleanUrls?: boolean
  /** SPA fallback for static sites. */
  spa?: boolean
  /** Stable id used when rpx registers the route. Derived from `to`+`path`. */
  id: string
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
 * Map the sites model to an rpx gateway config. Each non-bucket site with a
 * `domain` becomes a route:
 *  - `server-app`    → `{ to: domain, path, from: 'localhost:<port>' }`
 *  - `server-static` → `{ to: domain, path, static: '<wwwRoot>/<name>' }`
 *
 * Routes are grouped by domain so rpx's path-based routing can serve an app +
 * several static dirs under one host. Bucket sites and sites without a `domain`
 * (or a `server-app` without a `port`) are skipped.
 */
export function buildRpxConfig(
  sites: Record<string, SiteConfig | undefined>,
  options: BuildRpxConfigOptions,
): RpxGatewayConfig {
  const wwwRoot = (options.wwwRoot ?? '/var/www').replace(/\/+$/, '')
  const certsDir = options.proxy.certsDir ?? DEFAULT_RPX_CERTS_DIR

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

    if (kind === 'server-app') {
      // A server-app must declare the port it listens on to be routable.
      if (typeof site.port !== 'number')
        continue
      proxies.push({ to: site.domain, path, from: `localhost:${site.port}`, id })
    }
    else {
      // server-static: served from /var/www/<name>. cleanUrls maps the SSG
      // pathRewriteStyle; SPA mirrors the bucket path's spa flag.
      proxies.push({
        to: site.domain,
        path,
        static: `${wwwRoot}/${name}`,
        cleanUrls: site.pathRewriteStyle !== 'flat',
        spa: site.spa ?? false,
        id,
      })
    }
    domains.add(site.domain)
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
 * Render the rpx gateway config as a self-contained launcher TS module. The
 * systemd unit runs `bun <file>`, which imports `startProxies` from the
 * globally-installed `@stacksjs/rpx` and starts the gateway with the generated
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

/** Default install location for the gateway launcher + config on the box. */
export const RPX_DIR = '/etc/rpx'
export const RPX_LAUNCHER_PATH = '/etc/rpx/gateway.ts'
export const RPX_SERVICE_NAME = 'rpx-gateway.service'

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
  /** Absolute path to the `bun` binary on the box. @default '/usr/local/bin/bun' */
  bunBin?: string
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
  const launcher = renderRpxLauncher(config)

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
    `mkdir -p ${RPX_DIR} ${certsDir}`,
    // Install @stacksjs/rpx globally (idempotent — re-runs upgrade in place).
    `mkdir -p /tmp/ts-cloud-rpx-install && (cd /tmp/ts-cloud-rpx-install && ${bunBin} add -g @stacksjs/rpx@${version})`,
    // Write the generated gateway launcher (routes from the sites model).
    ...writeFileHeredoc(RPX_LAUNCHER_PATH, launcher, 'TS_CLOUD_RPX_EOF'),
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
    `systemctl enable ${RPX_SERVICE_NAME}`,
    `systemctl restart ${RPX_SERVICE_NAME}`,
  ]
}
