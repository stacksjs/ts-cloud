import type { CloudConfig } from '../types'
import { describe, expect, it } from 'bun:test'
import { DASHBOARD_PORT_BASE, DASHBOARD_PORT_SPAN, deriveManagementDashboardPort, hasManagementDashboardSite, isManagementDashboardSiteName, managementDashboardSiteName, resolveDashboardDomain, resolveDashboardDomains, resolveManagementDashboardSite, resolveManagementDashboardSites } from './management-dashboard'

function cfg(partial: Partial<CloudConfig>): CloudConfig {
  return { project: { name: 'Acme', slug: 'acme' }, environments: {}, ...partial } as CloudConfig
}

describe('resolveDashboardDomain', () => {
  it('derives dashboard.<apex> from a site domain', () => {
    const c = cfg({ sites: { main: { root: 'dist', domain: 'acme.com' } as any } })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.acme.com')
  })

  it('reduces a deep host to its apex when the project owns the apex', () => {
    const c = cfg({ sites: {
      main: { root: 'dist', domain: 'acme.com' } as any,
      api: { root: 'dist', domain: 'api.staging.acme.com' } as any,
    } })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.acme.com')
  })

  it('keeps a deep host in full when the project does NOT own the apex', () => {
    // Collapsing to dashboard.acme.com here would claim an apex owned by
    // another project — the collision this rule prevents.
    const c = cfg({ sites: { api: { root: 'dist', domain: 'api.staging.acme.com' } as any } })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.api.staging.acme.com')
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

  /**
   * The `everything` project serves only `everything.stacksjs.com`. The apex
   * `stacksjs.com` belongs to a DIFFERENT project on the same box, so this one
   * must not claim `dashboard.stacksjs.com` — that collision let a stale route
   * shadow the real dashboard.
   */
  it('does not collapse to an apex the project does not own', () => {
    const c = cfg({ sites: { main: { root: 'dist', domain: 'everything.stacksjs.com' } as any } })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.everything.stacksjs.com')
  })

  it('collapses to the apex when the project serves the bare apex', () => {
    // Serving both the apex and a subdomain still yields one apex dashboard.
    const c = cfg({ sites: {
      main: { root: 'dist', domain: 'stacksjs.com' } as any,
      api: { root: 'dist', domain: 'api.stacksjs.com' } as any,
    } })
    expect(resolveDashboardDomain(c, 'production')).toBe('dashboard.stacksjs.com')
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
    // Port is derived per dashboard host (no longer a shared 7676), so two apps
    // on one box can't collide.
    expect(r?.site.port).toBe(deriveManagementDashboardPort('dashboard.acme.com'))
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

  // Regression: every dashboard used to default to 7676, so a second app on the
  // same box crash-looped on EADDRINUSE and its domain silently served the first
  // app's dashboard. The default port is now derived per dashboard host.
  it('gives two apps on one box distinct, stable, in-band dashboard ports', () => {
    const stacks = cfg({ sites: { main: { root: 'dist', domain: 'stacksjs.com' } as any } })
    const chris = cfg({ sites: { main: { root: 'dist', domain: 'chrisbreuer.me' } as any } })
    const a = resolveManagementDashboardSite(stacks, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })
    const b = resolveManagementDashboardSite(chris, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })

    // Distinct hosts → distinct ports (no collision).
    expect(a?.site.port).not.toBe(b?.site.port)
    // Deterministic + stable across calls, and matches the exported helper.
    expect(a?.site.port).toBe(deriveManagementDashboardPort('dashboard.stacksjs.com'))
    expect(a?.site.port).toBe(deriveManagementDashboardPort('dashboard.stacksjs.com'))
    // In-band: above app ports, below the Linux ephemeral range.
    for (const p of [a?.site.port, b?.site.port]) {
      expect(p).toBeGreaterThanOrEqual(DASHBOARD_PORT_BASE)
      expect(p).toBeLessThan(DASHBOARD_PORT_BASE + DASHBOARD_PORT_SPAN)
      expect(p).toBeLessThan(32768)
    }
    // The generated systemd start + rpx `from` port agree with site.port.
    expect(a?.site.start).toContain(`--port ${a?.site.port}`)
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

  /**
   * The zero-downtime cutover overlaps two instances on one port via
   * SO_REUSEPORT, which the dashboard's server does not do — the new instance
   * would hit EADDRINUSE and only start after a retry stops the old one.
   */
  it('opts out of the zero-downtime overlap it cannot satisfy', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '.ts-cloud/dashboard-release', build: false })
    expect(r?.site.zeroDowntime).toBe(false)
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

  it('gives a subdomain-only project its own host, never the shared apex', () => {
    const c = cfg({ sites: { main: { root: 'dist', domain: 'everything.stacksjs.com' } as any } })
    expect(resolveDashboardDomains(c, 'production')).toEqual(['dashboard.everything.stacksjs.com'])
  })

  it('collapses subdomains under an apex the project DOES own', () => {
    const c = cfg({ sites: {
      main: { root: 'dist', domain: 'acme.com' } as any,
      api: { root: 'dist', domain: 'api.acme.com' } as any,
      cdn: { root: 'dist', domain: 'cdn.acme.com' } as any,
    } })
    expect(resolveDashboardDomains(c, 'production')).toEqual(['dashboard.acme.com'])
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
