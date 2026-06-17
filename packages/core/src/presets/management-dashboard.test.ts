import type { CloudConfig } from '../types'
import { describe, expect, it } from 'bun:test'
import { hasManagementDashboardSite, resolveDashboardDomain, resolveManagementDashboardSite } from './management-dashboard'

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
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: 'ui/dist', build: 'cd ui && bun run build', password: 's3cret' })
    expect(r?.name).toBe('dashboard')
    expect(r?.site.domain).toBe('dashboard.acme.com')
    expect(r?.site.type).toBe('static')
    expect(r?.site.deploy).toBe('server')
    expect(r?.site.build).toBe('cd ui && bun run build')
    expect(r?.site.auth).toEqual({ username: 'admin', password: 's3cret', realm: undefined })
  })

  it('serves WITHOUT auth when no password is provided', () => {
    const r = resolveManagementDashboardSite(base, 'production', { uiRoot: '/pkg/dist/ui', build: false })
    expect(r?.site.auth).toBeUndefined()
    expect(r?.site.build).toBeUndefined()
    expect(r?.site.root).toBe('/pkg/dist/ui')
  })

  it('returns null when a dashboard is already configured', () => {
    const c = cfg({ sites: { dashboard: { root: 'ui/dist', domain: 'd.acme.com' } as any } })
    expect(hasManagementDashboardSite(c)).toBe(true)
    expect(resolveManagementDashboardSite(c, 'production', { uiRoot: 'ui/dist' })).toBeNull()
  })

  it('returns null when no domain can be resolved', () => {
    expect(resolveManagementDashboardSite(cfg({}), 'production', { uiRoot: 'ui/dist' })).toBeNull()
  })
})
