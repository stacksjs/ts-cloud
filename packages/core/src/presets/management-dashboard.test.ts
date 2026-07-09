import type { CloudConfig } from '../types'
import { describe, expect, it } from 'bun:test'
import { hasManagementDashboardSite, isManagementDashboardSiteName, resolveDashboardDomain, resolveDashboardDomains, resolveManagementDashboardSite, resolveManagementDashboardSites } from './management-dashboard'

function cfg(partial: Partial<CloudConfig>): CloudConfig {
  return { project: { name: 'Acme', slug: 'acme' }, environments: {}, ...partial } as CloudConfig
}

describe('resolveDashboardDomain', () => {
  it('derives dashboard.<apex> from a site domain', () => {
    const c = cfg({ sites: { main: { root: 'dist', domain: 'acme.com' } as any } })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.acme.com')
  })

  it('reduces a deep host to its apex', () => {
    const c = cfg({ sites: { api: { root: 'dist', domain: 'api.staging.acme.com' } as any } })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.acme.com')
  })

  it('prefers an explicit override', () => {
    const c = cfg({ sites: { main: { root: 'dist', domain: 'acme.com' } as any } })
    expect(resolveDashboardDomain(c, 'production', 'admin.acme.io')).toBe('admin.acme.io')
  })

  it('falls back to infrastructure.dns.domain', () => {
    const c = cfg({ infrastructure: { dns: { domain: 'example.org' } } as any })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.example.org')
  })

  it('returns null when no domain is configured', () => {
    expect(resolveDashboardDomain(cfg({}), 'production')).toBeNull()
  })
})

describe('resolveManagementDashboardSite', () => {
  const base = cfg({ sites: { main: { root: 'dist', domain: 'acme.com' } as any } })

  it('builds a server-static site with htpasswd when a password is given', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: 'packages/ui/dist', build: 'cd packages/ui && bun run build', password: 's3cret' })
    expect(r?.name).toBe('dashboard')
    expect(r?.site.domain).toBe('dashboard.acme.com')
    expect(r?.site.type).toBe('static')
    expect(r?.site.deploy).toBe('server')
    expect(r?.site.build).toBe('cd packages/ui && bun run build')
    expect(r?.site.auth).toEqual({ username: 'admin', password: 's3cret', realm: undefined })
  })

  it('serves WITHOUT auth when no password is provided', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '/pkg/dist/ui', build: false })
    expect(r?.site.auth).toBeUndefined()
    expect(r?.site.build).toBeUndefined()
    expect(r?.site.root).toBe('/pkg/dist/ui')
  })

  it('returns null when a dashboard is already configured', () => {
    const c = cfg({ sites: { dashboard: { root: 'packages/ui/dist', domain: 'd.acme.com' } as any } })
    expect(hasManagementDashboardSite(c)).toBe(true)
    expect(resolveManagementDashboardSite(c, 'production', { uiRoot: 'packages/ui/dist' })).toBeNull()
  })

  it('returns null when no domain can be resolved', () => {
    expect(resolveManagementDashboardSite(cfg({}), 'production', { uiRoot: 'packages/ui/dist' })).toBeNull()
  })

  it('live mode builds a server-app (box-mode service) behind the proxy', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '/pkg/dist/ui-src', build: false, live: true, port: 7700, password: 's3cret' })
    expect(r?.site.deploy).toBe('server')
    expect(r?.site.type).toBeUndefined() // server-app, not static
    expect(r?.site.start).toBe('cloud dashboard:serve --box --host 127.0.0.1 --port 7700')
    expect(r?.site.port).toBe(7700)
    expect(r?.site.auth).toEqual({ username: 'admin', password: 's3cret', realm: undefined })
  })

  it('live mode defaults the port to 7676', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '/pkg/dist/ui-src', build: false, live: true })
    expect(r?.site.port).toBe(7676)
    expect(r?.site.start).toContain('--port 7676')
  })
})

describe('resolveDashboardDomains (per-apex)', () => {
  it('returns one dashboard host per distinct apex, order-preserving', () => {
    const c = cfg({ sites: {
      a: { root: 'dist', domain: 'ghostanalytics.org' } as any,
      aApi: { root: 'dist', domain: 'api.ghostanalytics.org' } as any,
      b: { root: 'dist', domain: 'bughq.org' } as any,
      main: { root: 'dist', domain: 'stacksjs.com' } as any,
    } })
    expect(resolveDashboardDomains(c, 'production')).toEqual([
      'dashboard.ghostanalytics.org',
      'dashboard.bughq.org',
      'dashboard.stacksjs.com',
    ])
  })

  it('an explicit override collapses to a single host', () => {
    const c = cfg({ sites: { a: { root: 'dist', domain: 'acme.com' } as any, b: { root: 'dist', domain: 'other.io' } as any } })
    expect(resolveDashboardDomains(c, 'production', 'admin.acme.io')).toEqual(['admin.acme.io'])
  })

  it('is empty when no domain is configured', () => {
    expect(resolveDashboardDomains(cfg({}), 'production')).toEqual([])
  })

  it('skips redirect-only sites (www aliases get no dashboard)', () => {
    const c = cfg({ sites: {
      main: { root: 'dist', domain: 'acme.com' } as any,
      www: { domain: 'www.acme.com', redirect: 'https://acme.com' } as any,
      alias: { domain: 'acme.io', redirect: 'https://acme.com' } as any,
    } })
    expect(resolveDashboardDomains(c, 'production')).toEqual(['dashboard.acme.com'])
  })

  it('puts the project canonical domain (dns.domain) first, for a stable primary', () => {
    const c = cfg({
      infrastructure: { dns: { domain: 'stacksjs.com' } } as any,
      sites: {
        gh: { root: 'dist', domain: 'ghostanalytics.org' } as any,
        bug: { root: 'dist', domain: 'bughq.org' } as any,
        main: { root: 'dist', domain: 'stacksjs.com' } as any,
      },
    })
    // dns.domain leads regardless of site declaration order → `dashboard` key is
    // always dashboard.stacksjs.com, even on a `--site ghostanalytics` deploy.
    expect(resolveDashboardDomains(c, 'production')).toEqual([
      'dashboard.stacksjs.com',
      'dashboard.ghostanalytics.org',
      'dashboard.bughq.org',
    ])
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.stacksjs.com')
  })
})

describe('resolveManagementDashboardSites (per-apex)', () => {
  const multi = cfg({ sites: {
    a: { root: 'dist', domain: 'ghostanalytics.org' } as any,
    b: { root: 'dist', domain: 'bughq.org' } as any,
    main: { root: 'dist', domain: 'stacksjs.com' } as any,
  } })

  it('injects one static dashboard per apex, primary keyed `dashboard`', () => {
    const sites = resolveManagementDashboardSites(multi, 'production', { uiRoot: '/pkg/dist/ui', build: false, password: 's3cret' })
    expect(sites.map(s => s.name)).toEqual(['dashboard', 'dashboard-bughq-org', 'dashboard-stacksjs-com'])
    expect(sites.map(s => s.site.domain)).toEqual(['dashboard.ghostanalytics.org', 'dashboard.bughq.org', 'dashboard.stacksjs.com'])
    // All share the same UI root + credentials.
    expect(new Set(sites.map(s => s.site.root))).toEqual(new Set(['/pkg/dist/ui']))
    for (const s of sites) {
      expect(s.site.type).toBe('static')
      expect(s.site.auth).toEqual({ username: 'admin', password: 's3cret', realm: undefined })
    }
  })

  it('live mode stays single-host (one loopback port)', () => {
    const sites = resolveManagementDashboardSites(multi, 'production', { uiRoot: '/pkg/dist/ui-src', build: false, live: true })
    expect(sites).toHaveLength(1)
    expect(sites[0].name).toBe('dashboard')
    expect(sites[0].site.domain).toBe('dashboard.ghostanalytics.org')
  })

  it('is empty when a dashboard is already configured by hand', () => {
    const c = cfg({ sites: { dashboard: { root: 'packages/ui/dist', domain: 'd.acme.com' } as any, main: { root: 'dist', domain: 'acme.com' } as any } })
    expect(resolveManagementDashboardSites(c, 'production', { uiRoot: 'packages/ui/dist' })).toEqual([])
  })
})

describe('isManagementDashboardSiteName', () => {
  it('matches the primary and per-apex keys, not app sites', () => {
    expect(isManagementDashboardSiteName('dashboard')).toBe(true)
    expect(isManagementDashboardSiteName('dashboard-bughq-org')).toBe(true)
    expect(isManagementDashboardSiteName('main')).toBe(false)
    expect(isManagementDashboardSiteName('ghostanalytics-api')).toBe(false)
  })
})
