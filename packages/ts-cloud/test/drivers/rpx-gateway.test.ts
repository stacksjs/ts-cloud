import type { ComputeProxyConfig, SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildCertManagementCommands,
  buildRpxConfig,
  buildRpxLbConfig,
  buildRpxProvisionScript,
  certDomainsForConfig,
  DEFAULT_ACME_WEBROOT,
  deriveRouteId,
  mergeRpxFragments,
  normalizeRoutePath,
  normalizeSiteRedirect,
  renderRpxAssembler,
  renderRpxLauncher,
  resolveRouteAuth,
  RPX_LAUNCHER_PATH,
  RPX_SERVICE_NAME,
  RPX_SITES_DIR,
  usesRpxProxy,
} from '../../src/drivers/shared/rpx-gateway'

const rpxProxy: ComputeProxyConfig = { engine: 'rpx' }

// A stacksjs.com-style multi-site config: an app (server-app) under /api, a
// docs static site under /docs, and a public static site at the root, all on
// one domain — plus a second domain and a bucket site that must be ignored.
const sites: Record<string, SiteConfig> = {
  main: {
    domain: 'stacksjs.com',
    path: '/api',
    root: '.output',
    start: 'bun run server.ts',
    port: 3000,
  },
  docs: {
    domain: 'stacksjs.com',
    path: '/docs',
    deploy: 'server',
    root: 'docs/dist',
  },
  public: {
    domain: 'stacksjs.com',
    deploy: 'server',
    root: 'public',
  },
  app2: {
    domain: 'app.other.com',
    root: '.output',
    start: 'bun run app.ts',
    port: 4000,
  },
  marketing: {
    domain: 'marketing.example.com',
    root: 'dist',
    // no start, no deploy → bucket → ignored by the gateway.
  },
}

describe('normalizeRoutePath', () => {
  it('maps root/empty to undefined and normalizes others', () => {
    expect(normalizeRoutePath(undefined)).toBeUndefined()
    expect(normalizeRoutePath('/')).toBeUndefined()
    expect(normalizeRoutePath('api')).toBe('/api')
    expect(normalizeRoutePath('/docs/')).toBe('/docs')
  })
})

describe('deriveRouteId', () => {
  it('folds the path into the id so same-host routes do not collide', () => {
    expect(deriveRouteId('stacksjs.com')).toBe('stacksjs.com')
    expect(deriveRouteId('stacksjs.com', '/api')).toBe('stacksjs.com-api')
    expect(deriveRouteId('stacksjs.com', '/docs')).toBe('stacksjs.com-docs')
  })
})

describe('buildRpxConfig', () => {
  it('maps a multi-site domain into app + static routes by path', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })

    const stacks = config.proxies.filter(r => r.to === 'stacksjs.com')
    expect(stacks).toHaveLength(3)

    const api = stacks.find(r => r.path === '/api')!
    expect(api.from).toBe('localhost:3000')
    expect(api.static).toBeUndefined()

    const docs = stacks.find(r => r.path === '/docs')!
    expect(docs.static).toMatchObject({ dir: '/var/www/app-docs/current' })
    expect(docs.from).toBeUndefined()
    expect(docs.cleanUrls).toBe(true)

    const root = stacks.find(r => r.path === undefined)!
    expect(root.static).toMatchObject({ dir: '/var/www/app-public/current' })
  })

  it('nests spa + pathRewriteStyle inside the static object (rpx ignores them at the route level)', () => {
    // Regression: rpx's resolveStaticRoute reads `spa`/`pathRewriteStyle` ONLY
    // from the object form of `static`; a bare string forces `spa:false`, which
    // 404s every SPA deep link. A server-static SPA must therefore emit
    // `static: { dir, spa: true, ... }`, not a string with sibling `spa`.
    const spaSites: Record<string, SiteConfig> = {
      app: { domain: 'everything.stacksjs.com', deploy: 'server', root: 'dist', spa: true },
      flat: { domain: 'flat.example.com', deploy: 'server', root: 'dist', pathRewriteStyle: 'flat' },
    }
    const config = buildRpxConfig(spaSites, { proxy: rpxProxy })

    const app = config.proxies.find(r => r.to === 'everything.stacksjs.com')!
    expect(app.static).toMatchObject({ spa: true, pathRewriteStyle: 'directory' })
    expect(typeof app.static).toBe('object')

    const flat = config.proxies.find(r => r.to === 'flat.example.com')!
    expect(flat.static).toMatchObject({ spa: false, pathRewriteStyle: 'flat' })
    expect(flat.cleanUrls).toBe(false)
  })

  it('groups routes by domain, most-specific path first', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    const stacks = config.proxies.filter(r => r.to === 'stacksjs.com')
    // /api and /docs (len 4) before the root default (undefined).
    expect(stacks[stacks.length - 1].path).toBeUndefined()
  })

  it('includes a second domain and excludes bucket sites', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    expect(config.proxies.some(r => r.to === 'app.other.com' && r.from === 'localhost:4000')).toBe(true)
    expect(config.proxies.some(r => r.to === 'marketing.example.com')).toBe(false)
  })

  it('points TLS at the default certs dir and disables hosts management', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    expect(config.productionCerts.certsDir).toBe('/etc/rpx/certs')
    expect(config.https).toBe(true)
    expect(config.hostsManagement).toBe(false)
    expect(config.onDemandTls).toBeUndefined()
  })

  it('honors a custom certs dir and enables on-demand TLS with domain allowlist', () => {
    const proxy: ComputeProxyConfig = {
      engine: 'rpx',
      certsDir: '/etc/bun-gateway/certs',
      onDemandTls: true,
      onDemandTlsEmail: 'ops@stacksjs.com',
    }
    const config = buildRpxConfig(sites, { proxy })
    expect(config.productionCerts.certsDir).toBe('/etc/bun-gateway/certs')
    expect(config.onDemandTls?.enabled).toBe(true)
    expect(config.onDemandTls?.email).toBe('ops@stacksjs.com')
    // stacksjs.com is an apex domain, so its auto-added www redirect (see the
    // 'auto-adds a www redirect' tests below) is on the allowlist too —
    // app.other.com isn't apex (3 labels), so it gets no www counterpart.
    expect(config.onDemandTls?.allowedSuffixes.sort()).toEqual(['app.other.com', 'stacksjs.com', 'www.stacksjs.com'])
    expect(config.onDemandTls?.certsDir).toBe('/etc/bun-gateway/certs')
  })

  it('enables origin lockdown from proxy.cdn when a secret is set', () => {
    const proxy: ComputeProxyConfig = {
      engine: 'rpx',
      cdn: {
        originDomain: 'origin.stacksjs.com',
        frontedHosts: ['stacksjs.com', 'www.stacksjs.com', 'origin.stacksjs.com'],
        secret: 'shh',
      },
    }
    const config = buildRpxConfig(sites, { proxy })
    expect(config.originGuard?.header).toBe('X-Origin-Verify')
    expect(config.originGuard?.value).toBe('shh')
    expect(config.originGuard?.hosts).toContain('origin.stacksjs.com')
    // appears in the rendered launcher so startProxies applies it
    expect(renderRpxLauncher(config)).toContain('originGuard')
  })

  it('omits origin lockdown when cdn has no secret', () => {
    const proxy: ComputeProxyConfig = {
      engine: 'rpx',
      cdn: { originDomain: 'origin.x.com', frontedHosts: ['x.com'] },
    }
    expect(buildRpxConfig(sites, { proxy }).originGuard).toBeUndefined()
  })

  it('skips a server-app without a port (not routable)', () => {
    const config = buildRpxConfig({
      noport: { domain: 'x.com', root: '.output', start: 'bun run s.ts' },
    }, { proxy: rpxProxy })
    expect(config.proxies).toHaveLength(0)
  })

  it('respects a custom wwwRoot for static routes', () => {
    const config = buildRpxConfig({
      docs: { domain: 'd.com', deploy: 'server', root: 'dist' },
    }, { proxy: rpxProxy, wwwRoot: '/srv/sites' })
    expect(config.proxies[0].static).toMatchObject({ dir: '/srv/sites/app-docs/current' })
  })

  it('maps a redirect site to a redirect route (no upstream, no static)', () => {
    const config = buildRpxConfig({
      altApex: { domain: 'very-good-adblock.org', redirect: 'https://verygoodadblock.org' },
      altWww: { domain: 'www.very-good-adblock.org', redirect: { to: 'https://verygoodadblock.org', status: 308, preservePath: false } },
    }, { proxy: { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'hello@stacksjs.com' } })

    const apex = config.proxies.find(r => r.to === 'very-good-adblock.org')!
    expect(apex.redirect).toEqual({ to: 'https://verygoodadblock.org' })
    expect(apex.from).toBeUndefined()
    expect(apex.static).toBeUndefined()
    expect(apex.id).toBe('very-good-adblock.org')

    const www = config.proxies.find(r => r.to === 'www.very-good-adblock.org')!
    expect(www.redirect).toEqual({ to: 'https://verygoodadblock.org', status: 308, preservePath: false })

    // Redirect domains still get a cert via the on-demand allowlist.
    expect(config.onDemandTls?.allowedSuffixes).toContain('very-good-adblock.org')
    expect(config.onDemandTls?.allowedSuffixes).toContain('www.very-good-adblock.org')
  })

  describe('auto-adds a www redirect', () => {
    it('adds www.<domain> -> https://<domain> for an apex domain with no explicit www route', () => {
      const config = buildRpxConfig({
        main: { domain: 'example.com', deploy: 'server', root: 'dist' },
      }, { proxy: rpxProxy })

      const www = config.proxies.find(r => r.to === 'www.example.com')!
      expect(www).toBeDefined()
      expect(www.redirect).toEqual({ to: 'https://example.com' })
      expect(www.from).toBeUndefined()
      expect(www.static).toBeUndefined()
    })

    it('does not add a www route for a non-apex domain', () => {
      const config = buildRpxConfig({
        app: { domain: 'app.other.com', root: '.output', start: 'bun run app.ts', port: 4000 },
      }, { proxy: rpxProxy })
      expect(config.proxies.some(r => r.to.startsWith('www.'))).toBe(false)
    })

    it('does not duplicate an explicit www route already declared by another site', () => {
      const config = buildRpxConfig({
        main: { domain: 'example.com', deploy: 'server', root: 'dist' },
        wwwRedirect: { domain: 'www.example.com', redirect: { to: 'https://example.com', status: 308 } },
      }, { proxy: rpxProxy })

      const wwwRoutes = config.proxies.filter(r => r.to === 'www.example.com')
      expect(wwwRoutes).toHaveLength(1)
      // The explicit site's own redirect config wins, untouched.
      expect(wwwRoutes[0].redirect).toEqual({ to: 'https://example.com', status: 308 })
    })

    it('skips an already-www domain (no www.www.<domain>)', () => {
      const config = buildRpxConfig({
        site: { domain: 'www.example.com', deploy: 'server', root: 'dist' },
      }, { proxy: rpxProxy })
      expect(config.proxies.some(r => r.to.startsWith('www.www.'))).toBe(false)
    })

    it('is opted out with proxy.autoWww: false', () => {
      const config = buildRpxConfig({
        main: { domain: 'example.com', deploy: 'server', root: 'dist' },
      }, { proxy: { engine: 'rpx', autoWww: false } })
      expect(config.proxies.some(r => r.to === 'www.example.com')).toBe(false)
    })

    it('includes the auto-added www domain in the on-demand TLS allowlist', () => {
      const config = buildRpxConfig({
        main: { domain: 'example.com', deploy: 'server', root: 'dist' },
      }, { proxy: { engine: 'rpx', onDemandTls: true } })
      expect(config.onDemandTls?.allowedSuffixes.sort()).toEqual(['example.com', 'www.example.com'])
    })
  })
})

describe('buildRpxLbConfig', () => {
  it('produces byte-for-byte the same output as buildRpxConfig for a single-box call site', () => {
    // The existing single-box call site (buildRpxConfig with no app boxes) must
    // remain completely unchanged — this pins that guarantee.
    const single = buildRpxConfig(sites, { proxy: rpxProxy })
    const viaLb = buildRpxLbConfig(sites, [], { proxy: rpxProxy })
    expect(viaLb).toEqual(single)
  })

  it('resolves a server-app route to an array of host:port, one per app box (private IP preferred)', () => {
    const appBoxes = [
      { privateIp: '10.0.0.2', publicIp: '203.0.113.2' },
      { privateIp: '10.0.0.3', publicIp: '203.0.113.3' },
    ]
    const config = buildRpxLbConfig(sites, appBoxes, { proxy: rpxProxy })

    const api = config.proxies.find(r => r.to === 'stacksjs.com' && r.path === '/api')!
    expect(api.from).toEqual(['10.0.0.2:3000', '10.0.0.3:3000'])

    const app2 = config.proxies.find(r => r.to === 'app.other.com')!
    expect(app2.from).toEqual(['10.0.0.2:4000', '10.0.0.3:4000'])
  })

  it('falls back to an app box public IP when it has no private IP', () => {
    const appBoxes = [
      { privateIp: '10.0.0.2', publicIp: '203.0.113.2' },
      { publicIp: '203.0.113.9' }, // no private IP — e.g. network attach failed
    ]
    const config = buildRpxLbConfig(sites, appBoxes, { proxy: rpxProxy })
    const api = config.proxies.find(r => r.to === 'stacksjs.com' && r.path === '/api')!
    expect(api.from).toEqual(['10.0.0.2:3000', '203.0.113.9:3000'])
  })

  it('leaves server-static and redirect routes unaffected (no from array)', () => {
    const appBoxes = [{ privateIp: '10.0.0.2' }]
    const config = buildRpxLbConfig(sites, appBoxes, { proxy: rpxProxy })
    const docs = config.proxies.find(r => r.to === 'stacksjs.com' && r.path === '/docs')!
    expect(docs.static).toMatchObject({ dir: '/var/www/app-docs/current' })
    expect(docs.from).toBeUndefined()
  })

  it('passes through an optional loadBalancer strategy/health-check tuning onto multi-upstream routes only', () => {
    const proxy: ComputeProxyConfig = {
      engine: 'rpx',
      loadBalancer: { strategy: 'least-connections', healthCheck: { path: '/healthz', interval: 5 } },
    }
    const appBoxes = [{ privateIp: '10.0.0.2' }, { privateIp: '10.0.0.3' }]
    const config = buildRpxLbConfig(sites, appBoxes, { proxy })
    const api = config.proxies.find(r => r.to === 'stacksjs.com' && r.path === '/api')!
    expect(api.loadBalancer).toEqual({ strategy: 'least-connections', healthCheck: { path: '/healthz', interval: 5 } })

    // A single-upstream (single-box) route never carries loadBalancer tuning.
    const single = buildRpxConfig(sites, { proxy })
    expect(single.proxies.find(r => r.to === 'stacksjs.com' && r.path === '/api')!.loadBalancer).toBeUndefined()
  })

  it('skips a server-app without a port, same as buildRpxConfig', () => {
    const config = buildRpxLbConfig({
      noport: { domain: 'x.com', root: '.output', start: 'bun run s.ts' },
    }, [{ privateIp: '10.0.0.2' }], { proxy: rpxProxy })
    expect(config.proxies).toHaveLength(0)
  })
})

describe('normalizeSiteRedirect', () => {
  it('wraps a string shorthand and omits unset fields', () => {
    expect(normalizeSiteRedirect('https://example.com')).toEqual({ to: 'https://example.com' })
  })

  it('keeps explicit status and preservePath', () => {
    expect(normalizeSiteRedirect({ to: 'https://example.com', status: 302, preservePath: false }))
      .toEqual({ to: 'https://example.com', status: 302, preservePath: false })
  })
})

describe('resolveRouteAuth', () => {
  it('maps an enabled auth block, defaulting the username', () => {
    expect(resolveRouteAuth({ domain: 'd', root: '.', auth: { password: 'pw' } } as SiteConfig))
      .toEqual({ username: 'admin', password: 'pw' })
    expect(resolveRouteAuth({ domain: 'd', root: '.', auth: { username: 'ops', password: 'pw', realm: 'Cockpit' } } as SiteConfig))
      .toEqual({ username: 'ops', password: 'pw', realm: 'Cockpit' })
  })

  it('returns undefined for public sites, disabled auth, or a missing password', () => {
    expect(resolveRouteAuth({ domain: 'd', root: '.' } as SiteConfig)).toBeUndefined()
    expect(resolveRouteAuth({ domain: 'd', root: '.', auth: { enabled: false, username: 'a', password: 'p' } } as SiteConfig)).toBeUndefined()
    expect(resolveRouteAuth({ domain: 'd', root: '.', auth: { username: 'a' } } as SiteConfig)).toBeUndefined()
  })
})

describe('buildRpxConfig auth (dashboard protection)', () => {
  it('gates a protected static site (e.g. the management dashboard) behind Basic auth', () => {
    const config = buildRpxConfig({
      dashboard: {
        domain: 'dashboard.acme.com',
        deploy: 'server',
        type: 'static',
        root: 'ui/dist',
        auth: { username: 'admin', password: 's3cret', realm: 'ts-cloud' },
      },
    } as Record<string, SiteConfig>, { proxy: rpxProxy })

    const route = config.proxies.find(r => r.to === 'dashboard.acme.com')!
    expect(route.static).toMatchObject({ dir: '/var/www/app-dashboard/current' })
    expect(route.auth).toEqual({ username: 'admin', password: 's3cret', realm: 'ts-cloud' })
    // The credentials must survive serialization into the launcher.
    expect(renderRpxLauncher(config)).toContain('"password": "s3cret"')
  })

  it('gates a protected server-app route too', () => {
    const config = buildRpxConfig({
      admin: { domain: 'admin.acme.com', root: '.', start: 'bun run server.ts', port: 9000, auth: { password: 'pw' } },
    } as Record<string, SiteConfig>, { proxy: rpxProxy })
    const route = config.proxies.find(r => r.to === 'admin.acme.com')!
    expect(route.from).toBe('localhost:9000')
    expect(route.auth).toEqual({ username: 'admin', password: 'pw' })
  })

  it('leaves public sites without an auth field', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    expect(config.proxies.every(r => r.auth === undefined)).toBe(true)
  })
})

describe('renderRpxLauncher', () => {
  it('emits a runnable launcher that imports startProxies', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    const launcher = renderRpxLauncher(config)
    expect(launcher).toContain(`import { startProxies } from '@stacksjs/rpx'`)
    expect(launcher).toContain('startProxies(config')
    expect(launcher).toContain('"to": "stacksjs.com"')
  })
})

describe('buildRpxProvisionScript', () => {
  it('installs rpx, writes the launcher + unit, and starts the gateway', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    const script = buildRpxProvisionScript({ proxy: rpxProxy, config }).join('\n')

    expect(script).toContain('bun add @stacksjs/rpx@latest')
    expect(script).toContain(`mkdir -p /etc/rpx /etc/rpx/sites.d /etc/rpx/certs`)
    // Registry: this app's fragment + the stable assembler launcher.
    expect(script).toContain(`cat > ${RPX_SITES_DIR}/app.json`)
    expect(script).toContain(`cat > ${RPX_LAUNCHER_PATH}`)
    expect(script).toContain('rpx gateway assembler')
    expect(script).toContain('/opt/rpx-gateway')
    expect(script).toContain('ln -sfn /opt/rpx-gateway/node_modules /etc/rpx/node_modules')
    expect(script).toContain(`/etc/systemd/system/${RPX_SERVICE_NAME}`)
    expect(script).toContain('WorkingDirectory=/opt/rpx-gateway')
    expect(script).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
    expect(script).toContain('systemctl disable --now bun-gateway.service')
    expect(script).toContain('systemctl disable --now ts-cloud-nginx.service')
    expect(script).toContain(`systemctl enable ${RPX_SERVICE_NAME}`)
    expect(script).toContain(`systemctl restart ${RPX_SERVICE_NAME}`)
  })

  it('pins the rpx version when provided', () => {
    const config = buildRpxConfig(sites, { proxy: { engine: 'rpx', version: '0.12.0' } })
    const script = buildRpxProvisionScript({ proxy: { engine: 'rpx', version: '0.12.0' }, config }).join('\n')
    expect(script).toContain('bun add @stacksjs/rpx@0.12.0')
  })

  // A production gateway must bound stalled upstreams, or rpx's per-upstream
  // connection pool leaks slots until the gateway wedges (the outage this fixes).
  it('bounds stalled upstreams with a default upstream timeout', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    const script = buildRpxProvisionScript({ proxy: rpxProxy, config }).join('\n')
    expect(script).toContain('Environment=RPX_UPSTREAM_TIMEOUT=60')
    // The env must land inside the unit, before Restart= — i.e. in [Service].
    expect(script.indexOf('RPX_UPSTREAM_TIMEOUT')).toBeLessThan(script.indexOf('Restart=always'))
    // No max-conns override unless asked for.
    expect(script).not.toContain('RPX_MAX_UPSTREAM_CONNS')
  })

  it('honors a custom upstream timeout, including 0 to disable', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    const t30 = buildRpxProvisionScript({ proxy: { engine: 'rpx', upstreamTimeout: 30 }, config }).join('\n')
    expect(t30).toContain('Environment=RPX_UPSTREAM_TIMEOUT=30')
    expect(t30).not.toContain('RPX_UPSTREAM_TIMEOUT=60')

    const off = buildRpxProvisionScript({ proxy: { engine: 'rpx', upstreamTimeout: 0 }, config }).join('\n')
    expect(off).toContain('Environment=RPX_UPSTREAM_TIMEOUT=0')
  })

  it('passes through a max-upstream-conns override when set', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    const script = buildRpxProvisionScript({ proxy: { engine: 'rpx', maxUpstreamConns: 512 }, config }).join('\n')
    expect(script).toContain('Environment=RPX_MAX_UPSTREAM_CONNS=512')
    expect(script.indexOf('RPX_MAX_UPSTREAM_CONNS')).toBeLessThan(script.indexOf('Restart=always'))
  })
})

describe('managed TLS (acmeChallengeWebroot + cert renewal)', () => {
  const tlsProxy: ComputeProxyConfig = { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'hello@stacksjs.com' }

  it('sets acmeChallengeWebroot in the config only when onDemandTls is enabled', () => {
    expect(buildRpxConfig(sites, { proxy: tlsProxy }).acmeChallengeWebroot).toBe(DEFAULT_ACME_WEBROOT)
    expect(buildRpxConfig(sites, { proxy: rpxProxy }).acmeChallengeWebroot).toBeUndefined()
  })

  it('honors a custom acmeWebroot', () => {
    const config = buildRpxConfig(sites, { proxy: { engine: 'rpx', onDemandTls: true, acmeWebroot: '/srv/acme' } })
    expect(config.acmeChallengeWebroot).toBe('/srv/acme')
  })

  it('certDomainsForConfig returns the routable FQDNs, skipping wildcards/host:port', () => {
    const config = buildRpxConfig({
      app: { domain: 'app.example.com', root: '.out', start: 'bun run x', port: 3000 },
      site: { domain: 'example.com', deploy: 'server', root: 'dist' },
      alt: { domain: 'alt.example.com', redirect: 'https://example.com' },
    }, { proxy: tlsProxy })
    const domains = certDomainsForConfig(config)
    expect(domains).toContain('app.example.com')
    expect(domains).toContain('example.com')
    expect(domains).toContain('alt.example.com')
  })

  it('emits cert issuance + renewal timer when managed TLS is on', () => {
    const config = buildRpxConfig(sites, { proxy: tlsProxy })
    const cmds = buildCertManagementCommands({ proxy: tlsProxy, config })
    const joined = cmds.join('\n')
    expect(joined).toContain('@stacksjs/tlsx')
    expect(joined).toContain('acme:issue')
    expect(joined).toContain('acme:renew')
    expect(joined).toContain('--webroot')
    expect(joined).toContain(DEFAULT_ACME_WEBROOT)
    // Per-app renewal units (slug defaults to 'app').
    expect(joined).toContain('rpx-cert-renew-app.timer')
    expect(joined).toContain('hello@stacksjs.com')
    // The full provision script wires it in AFTER the gateway is (re)started.
    const script = buildRpxProvisionScript({ proxy: tlsProxy, config }).join('\n')
    expect(script.indexOf(`systemctl restart ${RPX_SERVICE_NAME}`)).toBeLessThan(script.indexOf('acme:renew'))
  })

  it('is a no-op without onDemandTls (no cert machinery in the script)', () => {
    const config = buildRpxConfig(sites, { proxy: rpxProxy })
    expect(buildCertManagementCommands({ proxy: rpxProxy, config })).toEqual([])
    expect(buildRpxProvisionScript({ proxy: rpxProxy, config }).join('\n')).not.toContain('acme:renew')
  })
})

describe('per-app gateway registry (independent deploys)', () => {
  const appA = buildRpxConfig({
    web: { domain: 'a.com', root: '.out', start: 'bun run a', port: 3000 },
  }, { proxy: { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'a@a.com' } })
  const appB = buildRpxConfig({
    site: { domain: 'b.com', deploy: 'server', root: 'dist' },
  }, { proxy: { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'b@b.com' } })

  it('writes only THIS app fragment + the assembler — not a full config launcher', () => {
    const script = buildRpxProvisionScript({ proxy: { engine: 'rpx', onDemandTls: true }, config: appA, slug: 'app-a' }).join('\n')
    expect(script).toContain(`cat > ${RPX_SITES_DIR}/app-a.json`)
    expect(script).toContain('"slug": "app-a"')
    expect(script).toContain('"to": "a.com"')
    // The launcher is the stable assembler, not app-a's baked-in config.
    expect(script).toContain('rpx gateway assembler')
    expect(script).not.toContain('"to": "b.com"')
    // Per-app cert renewal unit named for this slug only.
    expect(script).toContain('rpx-cert-renew-app-a.timer')
  })

  it('mergeRpxFragments composes two apps without dropping either app routes', () => {
    const merged = mergeRpxFragments([appA, appB])
    const hosts = merged.proxies.map(p => p.to)
    expect(hosts).toContain('a.com')
    expect(hosts).toContain('b.com')
    expect(merged.onDemandTls?.allowedSuffixes).toContain('a.com')
    expect(merged.onDemandTls?.allowedSuffixes).toContain('b.com')
  })

  it('mergeRpxFragments dedupes routes by id (first writer wins)', () => {
    const dupe = buildRpxConfig({ web: { domain: 'a.com', root: '.out', start: 'bun run a2', port: 3000 } }, { proxy: { engine: 'rpx' } })
    const merged = mergeRpxFragments([appA, dupe])
    expect(merged.proxies.filter(p => p.to === 'a.com')).toHaveLength(1)
  })

  it('renderRpxAssembler reads the sites dir and starts the merged config', () => {
    const asm = renderRpxAssembler()
    expect(asm).toContain('readdirSync')
    expect(asm).toContain(RPX_SITES_DIR)
    expect(asm).toContain('startProxies(config)')
    // Resilient: a malformed fragment is skipped, not fatal.
    expect(asm).toContain('catch { continue }')
  })
})

describe('buildRpxLbConfig is on the package public export barrel', () => {
  it('is importable from ../../src/drivers (not just the source module directly)', async () => {
    // Regression: buildRpxLbConfig/RpxLbAppBox were added to rpx-gateway.ts
    // but never added to packages/ts-cloud/src/drivers/index.ts's re-export
    // list, so `import { buildRpxLbConfig } from '@stacksjs/ts-cloud/drivers'`
    // (the intended consumer-facing path — see driver.ts's own import) failed
    // at runtime despite typechecking fine against the internal source path
    // every other test in this file uses. Caught during live e2e verification
    // when a standalone script importing from the public barrel got
    // `buildRpxLbConfig is not a function`.
    const barrel = await import('../../src/drivers/index')
    expect(typeof barrel.buildRpxLbConfig).toBe('function')
  })

  describe('usesRpxProxy', () => {
    it('is true when the proxy engine is rpx even without an explicit webServer', () => {
      // Regression: setting `proxy.engine: 'rpx'` alone provisions the gateway,
      // so the deploy must NOT also stand up nginx + certbot (races :80). Before
      // this helper, only `webServer: 'rpx'` skipped nginx, so a proxy-only
      // config hit "bind() to 0.0.0.0:80 failed (Address already in use)".
      expect(usesRpxProxy({ proxy: { engine: 'rpx' } })).toBe(true)
    })

    it('is true when webServer is rpx', () => {
      expect(usesRpxProxy({ webServer: 'rpx' })).toBe(true)
    })

    it('is false for nginx / unset / undefined', () => {
      expect(usesRpxProxy({ webServer: 'nginx' })).toBe(false)
      expect(usesRpxProxy({})).toBe(false)
      expect(usesRpxProxy(undefined)).toBe(false)
    })
  })
})
