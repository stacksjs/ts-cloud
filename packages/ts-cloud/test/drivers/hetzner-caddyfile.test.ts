import type { CaddyProxyConfig, SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildCaddyfile,
  buildCaddyfileFromProxy,
  isOnDemandDomain,
  proxyConfigFromSites,
  resolveCaddyfile,
} from '../../src/drivers/shared/caddyfile'

describe('isOnDemandDomain', () => {
  it('flags wildcards and bare catch-all', () => {
    expect(isOnDemandDomain('*')).toBe(true)
    expect(isOnDemandDomain('*.tunnel.example.com')).toBe(true)
    expect(isOnDemandDomain('app.example.com')).toBe(false)
  })
})

describe('buildCaddyfileFromProxy', () => {
  it('returns undefined when there are no apps', () => {
    expect(buildCaddyfileFromProxy({})).toBeUndefined()
    expect(buildCaddyfileFromProxy({ apps: [] })).toBeUndefined()
  })

  it('generates a single host-based reverse_proxy block', () => {
    const out = buildCaddyfileFromProxy({
      apps: [{ domains: ['app.example.com'], port: 3000 }],
    })!
    expect(out).toContain('app.example.com {')
    expect(out).toContain('reverse_proxy localhost:3000')
    // catch-all app => bare reverse_proxy, no handle wrapper
    expect(out).not.toContain('handle {')
  })

  it('routes multiple apps to distinct domains on one server', () => {
    const out = buildCaddyfileFromProxy({
      apps: [
        { name: 'registry', domains: ['registry.example.com'], port: 9007 },
        { name: 'web', domains: ['example.com', 'www.example.com'], port: 3000 },
      ],
    })!
    expect(out).toContain('registry.example.com {')
    expect(out).toContain('reverse_proxy localhost:9007')
    // multiple domains share one block, comma-joined
    expect(out).toContain('example.com, www.example.com {')
    expect(out).toContain('reverse_proxy localhost:3000')
  })

  it('groups apps sharing a domain into one block with path handles, catch-all last', () => {
    const out = buildCaddyfileFromProxy({
      apps: [
        { domains: ['example.com'], port: 3000 },
        { domains: ['example.com'], port: 9007, path: '/api' },
      ],
    })!
    const apiIdx = out.indexOf('handle /api')
    const catchAllIdx = out.indexOf('reverse_proxy localhost:3000')
    expect(apiIdx).toBeGreaterThan(-1)
    expect(catchAllIdx).toBeGreaterThan(-1)
    // specific path handled before catch-all
    expect(apiIdx).toBeLessThan(catchAllIdx)
    expect(out).toContain('handle /api {')
    expect(out).toContain('reverse_proxy localhost:9007')
  })

  it('emits ACME email and staging CA in the global options block', () => {
    const out = buildCaddyfileFromProxy({
      email: 'ops@example.com',
      staging: true,
      apps: [{ domains: ['app.example.com'], port: 3000 }],
    })!
    expect(out).toContain('email ops@example.com')
    expect(out).toContain('acme_ca https://acme-staging-v02.api.letsencrypt.org/directory')
    // global block comes first
    expect(out.indexOf('{')).toBeLessThan(out.indexOf('app.example.com'))
  })

  it('configures on-demand TLS with an ask endpoint for tunnel domains', () => {
    const out = buildCaddyfileFromProxy({
      onDemandTls: { ask: 'http://localhost:9007/check-domain' },
      apps: [
        { name: 'tunnel', domains: ['*.tunnel.example.com'], port: 8080 },
      ],
    })!
    expect(out).toContain('on_demand_tls {')
    expect(out).toContain('ask http://localhost:9007/check-domain')
    // the wildcard block opts into on-demand TLS
    expect(out).toContain('*.tunnel.example.com {')
    expect(out).toContain('tls {')
    expect(out).toContain('on_demand')
  })

  it('accepts onDemandTls: true with no ask (empty block)', () => {
    const out = buildCaddyfileFromProxy({
      onDemandTls: true,
      apps: [{ domains: ['*'], port: 8080 }],
    })!
    expect(out).toContain('on_demand_tls {')
    expect(out).toContain('tls {')
    expect(out).toContain('on_demand')
  })

  it('emits a rate_limit block when interval/burst are set', () => {
    const out = buildCaddyfileFromProxy({
      onDemandTls: { ask: 'http://localhost:9007/check', interval: '2m', burst: 5 },
      apps: [{ domains: ['*.t.example.com'], port: 8080 }],
    })!
    expect(out).toContain('rate_limit {')
    expect(out).toContain('interval 2m')
    expect(out).toContain('burst 5')
  })

  it('does NOT add tls on_demand to explicit (non-wildcard) domains', () => {
    const out = buildCaddyfileFromProxy({
      onDemandTls: { ask: 'http://localhost:9007/check' },
      apps: [{ domains: ['app.example.com'], port: 3000 }],
    })!
    // global on_demand_tls present, but explicit domain block must not opt in
    expect(out).toContain('on_demand_tls {')
    const blockStart = out.indexOf('app.example.com {')
    expect(out.slice(blockStart)).not.toContain('on_demand')
  })

  it('mixes explicit and wildcard apps: only wildcard gets on_demand', () => {
    const out = buildCaddyfileFromProxy({
      onDemandTls: { ask: 'http://localhost:9007/check' },
      apps: [
        { name: 'web', domains: ['app.example.com'], port: 3000 },
        { name: 'tunnel', domains: ['*.tunnel.example.com'], port: 8080 },
      ],
    })!
    const explicit = out.slice(out.indexOf('app.example.com {'), out.indexOf('*.tunnel'))
    expect(explicit).not.toContain('on_demand')
    const wildcard = out.slice(out.indexOf('*.tunnel.example.com {'))
    expect(wildcard).toContain('on_demand')
  })

  it('warns when a wildcard domain has no on-demand TLS configured', () => {
    const out = buildCaddyfileFromProxy({
      apps: [{ domains: ['*.tunnel.example.com'], port: 8080 }],
    })!
    expect(out).toContain('# WARNING')
    expect(out).toContain('on_demand_tls')
  })

  it('honors a custom upstreamHost and extra reverse_proxy directives', () => {
    const out = buildCaddyfileFromProxy({
      apps: [{
        domains: ['app.example.com'],
        port: 3000,
        upstreamHost: '10.0.0.5',
        reverseProxyDirectives: ['header_up Host {host}', 'lb_policy round_robin'],
      }],
    })!
    expect(out).toContain('reverse_proxy 10.0.0.5:3000 {')
    expect(out).toContain('header_up Host {host}')
    expect(out).toContain('lb_policy round_robin')
  })

  it('passes through global directives', () => {
    const out = buildCaddyfileFromProxy({
      globalDirectives: ['admin off'],
      apps: [{ domains: ['app.example.com'], port: 3000 }],
    })!
    expect(out).toContain('admin off')
  })

  it('returns a raw Caddyfile verbatim, bypassing generation', () => {
    const raw = 'example.com {\n  respond "hi"\n}'
    const out = buildCaddyfileFromProxy({ raw, apps: [{ domains: ['x.com'], port: 1 }] })!
    expect(out).toBe(raw)
    expect(out).not.toContain('reverse_proxy')
  })
})

describe('proxyConfigFromSites', () => {
  it('maps sites with domain + port to apps and ignores the rest', () => {
    const sites: Record<string, SiteConfig> = {
      web: { root: '.', domain: 'example.com', port: 3000 },
      api: { root: '.', domain: 'example.com', port: 9007, path: '/api' },
      staticOnly: { root: 'dist', domain: 'cdn.example.com' },
      noDomain: { root: '.', port: 4000 },
    }
    const { apps } = proxyConfigFromSites(sites)
    expect(apps).toHaveLength(2)
    expect(apps.map(a => a.port).sort()).toEqual([3000, 9007])
  })
})

describe('resolveCaddyfile', () => {
  const sites: Record<string, SiteConfig> = {
    web: { root: '.', domain: 'example.com', port: 3000 },
  }

  it('falls back to sites when no proxy config is given', () => {
    const out = resolveCaddyfile(sites)!
    expect(out).toContain('example.com {')
    expect(out).toContain('reverse_proxy localhost:3000')
  })

  it('inherits sites apps when proxy omits apps (e.g. bare onDemandTls)', () => {
    const proxy: CaddyProxyConfig = { email: 'ops@example.com', onDemandTls: true }
    const out = resolveCaddyfile(sites, proxy)!
    expect(out).toContain('email ops@example.com')
    expect(out).toContain('reverse_proxy localhost:3000')
  })

  it('uses proxy.apps when provided, ignoring sites', () => {
    const proxy: CaddyProxyConfig = {
      apps: [{ domains: ['registry.example.com'], port: 9007 }],
    }
    const out = resolveCaddyfile(sites, proxy)!
    expect(out).toContain('registry.example.com')
    expect(out).not.toContain('localhost:3000')
  })

  it('returns undefined when nothing routes', () => {
    expect(resolveCaddyfile({})).toBeUndefined()
    expect(resolveCaddyfile({ web: { root: '.' } })).toBeUndefined()
  })
})

describe('buildCaddyfile (deprecated, backward compat)', () => {
  it('still builds from a sites map', () => {
    const out = buildCaddyfile({ web: { root: '.', domain: 'example.com', port: 3000 } })!
    expect(out).toContain('example.com {')
    expect(out).toContain('reverse_proxy localhost:3000')
  })

  it('returns undefined for sites without domain/port', () => {
    expect(buildCaddyfile({ web: { root: '.' } })).toBeUndefined()
  })
})
