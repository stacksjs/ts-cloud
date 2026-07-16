import type { CloudConfig } from '../types'
import { describe, expect, it } from 'bun:test'
import { hasManagementDashboardSite, isManagementDashboardSiteName, managementDashboardSiteName, resolveDashboardDomain, resolveDashboardDomains, resolveManagementDashboardSite, resolveManagementDashboardSites } from './management-dashboard'

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

  it('defaults to live: a box-mode service, not static files', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })
    expect(r?.name).toBe('dashboard-acme-com')
    expect(r?.site.domain).toBe('dashboard.acme.com')
    expect(r?.site.deploy).toBe('server')
    expect(r?.site.type).toBeUndefined() // server-app, not static
    expect(r?.site.port).toBe(7676)
  })

  /**
   * The systemd unit runs `/usr/local/bin/bun <args>`, so a bare `cloud` would
   * be resolved by bun as a FILE to execute and the service would never start.
   * The entry has to be the installed module path.
   */
  it('starts the CLI by module path, runnable by `bun <args>`', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false, port: 7700 })
    expect(r?.site.start).toBe('bun ./node_modules/@stacksjs/ts-cloud/dist/bin/cli.js dashboard:serve --box --host 127.0.0.1 --port 7700')
    expect(r?.site.start).not.toMatch(/^bun cloud\b/)
    expect(r?.site.port).toBe(7700)
  })

  it('installs the CLI on the box, so the artifact need not ship one', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })
    expect(r?.site.preStart).toEqual(['bun install --production --no-save'])
  })

  /**
   * Users, grants and the session key are written by the running dashboard. A
   * release is a fresh directory, so without a shared path every deploy would
   * silently wipe every collaborator.
   */
  it('persists dashboard state across deploys', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })
    expect(r?.site.sharedPaths).toEqual(['.ts-cloud'])
  })

  /**
   * htpasswd in front of the live dashboard would make every collaborator need
   * the box's one shared password just to reach the login page — defeating the
   * per-site grants it exists to provide.
   */
  it('never puts htpasswd in front of the live dashboard', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false, password: 's3cret', username: 'admin' })
    expect(r?.site.auth).toBeUndefined()
  })

  it('health-gates the live service on its login page', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })
    expect(r?.site.healthCheck).toEqual({ path: '/login' })
  })

  it('builds a server-static site with htpasswd in static mode', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: 'packages/ui/dist', build: 'cd packages/ui && bun run build', password: 's3cret', live: false })
    expect(r?.name).toBe('dashboard-acme-com')
    expect(r?.site.type).toBe('static')
    expect(r?.site.deploy).toBe('server')
    expect(r?.site.build).toBe('cd packages/ui && bun run build')
    expect(r?.site.auth).toEqual({ username: 'admin', password: 's3cret', realm: undefined })
  })

  it('static mode serves WITHOUT auth when no password is provided', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '/pkg/dist/ui', build: false, live: false })
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

  it('is single-host in live mode even with several apexes', () => {
    // One control panel per box, many sites, per-site grants — a second host
    // would collide on the loopback port.
    const multi = cfg({ sites: {
      a: { root: 'dist', domain: 'acme.com' } as any,
      b: { root: 'dist', domain: 'other.io' } as any,
    } })
    const sites = resolveManagementDashboardSites(multi, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })
    expect(sites).toHaveLength(1)
    expect(sites[0].site.domain).toBe('dashboard.acme.com')
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
    // dns.domain leads regardless of site declaration order → the primary is
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

  it('injects one static dashboard per apex, every key domain-derived', () => {
    // Per-apex fan-out is a static-mode feature: it is only serving the same
    // files on each domain, so there is no port to collide on.
    const sites = resolveManagementDashboardSites(multi, 'production', { uiRoot: '/pkg/dist/ui', build: false, password: 's3cret', live: false })
    expect(sites.map(s => s.name)).toEqual(['dashboard-ghostanalytics-org', 'dashboard-bughq-org', 'dashboard-stacksjs-com'])
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
    expect(sites[0].name).toBe('dashboard-ghostanalytics-org')
    expect(sites[0].site.domain).toBe('dashboard.ghostanalytics.org')
  })

  it('is empty when a dashboard is already configured by hand', () => {
    const c = cfg({ sites: { dashboard: { root: 'packages/ui/dist', domain: 'd.acme.com' } as any, main: { root: 'dist', domain: 'acme.com' } as any } })
    expect(resolveManagementDashboardSites(c, 'production', { uiRoot: 'packages/ui/dist' })).toEqual([])
  })
})

describe('isManagementDashboardSiteName', () => {
  it('matches the domain-keyed and legacy bare keys, not app sites', () => {
    expect(isManagementDashboardSiteName('dashboard')).toBe(true)
    expect(isManagementDashboardSiteName('dashboard-bughq-org')).toBe(true)
    expect(isManagementDashboardSiteName('main')).toBe(false)
    expect(isManagementDashboardSiteName('ghostanalytics-api')).toBe(false)
  })
})

describe('managementDashboardSiteName', () => {
  it('keys a dashboard host by its dashed apex — never the bare `dashboard`', () => {
    expect(managementDashboardSiteName('dashboard.chrisbreuer.me')).toBe('dashboard-chrisbreuer-me')
    expect(managementDashboardSiteName('dashboard.stacksjs.com')).toBe('dashboard-stacksjs-com')
    expect(managementDashboardSiteName('admin.acme.io')).toBe('dashboard-admin-acme-io')
  })
})
