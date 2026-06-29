import type { ComputeProxyConfig, SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildRpxConfig,
  buildRpxProvisionScript,
  deriveRouteId,
  normalizeRoutePath,
  renderRpxLauncher,
  RPX_LAUNCHER_PATH,
  RPX_SERVICE_NAME,
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
    expect(docs.static).toBe('/var/www/docs')
    expect(docs.from).toBeUndefined()
    expect(docs.cleanUrls).toBe(true)

    const root = stacks.find(r => r.path === undefined)!
    expect(root.static).toBe('/var/www/public')
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
    expect(config.onDemandTls?.allowedSuffixes.sort()).toEqual(['app.other.com', 'stacksjs.com'])
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
    expect(config.proxies[0].static).toBe('/srv/sites/docs')
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

    expect(script).toContain('bun add -g @stacksjs/rpx@latest')
    expect(script).toContain(`mkdir -p /etc/rpx /etc/rpx/certs`)
    expect(script).toContain(`cat > ${RPX_LAUNCHER_PATH}`)
    expect(script).toContain('/tmp/ts-cloud-rpx-install')
    expect(script).toContain(`/etc/systemd/system/${RPX_SERVICE_NAME}`)
    expect(script).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
    expect(script).toContain(`systemctl enable ${RPX_SERVICE_NAME}`)
    expect(script).toContain(`systemctl restart ${RPX_SERVICE_NAME}`)
  })

  it('pins the rpx version when provided', () => {
    const config = buildRpxConfig(sites, { proxy: { engine: 'rpx', version: '0.12.0' } })
    const script = buildRpxProvisionScript({ proxy: { engine: 'rpx', version: '0.12.0' }, config }).join('\n')
    expect(script).toContain('bun add -g @stacksjs/rpx@0.12.0')
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
