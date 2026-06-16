import { describe, expect, it } from 'bun:test'
import { createDashboardSite } from '../src/presets/dashboard'

describe('createDashboardSite', () => {
  it('builds a server static site behind basic auth + SSL', () => {
    const site = createDashboardSite({ domain: 'dashboard.acme.com', password: 'pw' })
    expect(site.deploy).toBe('server')
    expect(site.type).toBe('static')
    expect(site.root).toBe('ui/dist')
    expect(site.domain).toBe('dashboard.acme.com')
    expect(site.ssl?.provider).toBe('letsencrypt')
    expect(site.auth?.username).toBe('admin')
    expect(site.auth?.password).toBe('pw')
    expect(site.build).toContain('bun run build')
  })

  it('allows overriding username, root, and build', () => {
    const site = createDashboardSite({ domain: 'd.acme.com', username: 'ops', root: 'out', build: 'make ui' })
    expect(site.auth?.username).toBe('ops')
    expect(site.root).toBe('out')
    expect(site.build).toBe('make ui')
  })
})
