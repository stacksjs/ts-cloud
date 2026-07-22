import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { roleCapabilities } from '../control-plane'
import { allRoutePolicies, isPublicRoute, PUBLIC_ROUTES, routePolicy } from './dashboard-policy'

describe('routePolicy', () => {
  it('fails closed for an unlisted route', () => {
    const policy = routePolicy('POST', '/api/some-future-route')
    expect(policy).toMatchObject({ capability: 'runtime:terminal', scope: 'organization' })
    expect(roleCapabilities('viewer').has(policy.capability)).toBe(false)
  })

  it('is method-sensitive', () => {
    // Reading the site list is not the same as creating a site.
    expect(routePolicy('POST', '/api/sites').capability).toBe('config:write')
    expect(routePolicy('DELETE', '/api/sites').capability).toBe('config:write')
    expect(routePolicy('PATCH', '/api/sites')).toMatchObject({ capability: 'config:write', scope: 'site' })
  })

  it('is case-insensitive on the method', () => {
    expect(routePolicy('get', '/api/health').capability).toBe(routePolicy('GET', '/api/health').capability)
  })

  it('keeps every shell-equivalent route admin-only', () => {
    const rootRoutes = [
      ['GET', '/api/terminal'],
      ['POST', '/api/server/command'],
      ['POST', '/api/server/operations/run'],
      ['POST', '/api/actions/run'],
      ['POST', '/api/ssh-keys'],
      ['DELETE', '/api/ssh-keys'],
      ['POST', '/api/firewall'],
      ['POST', '/api/databases/users'],
    ] as const

    for (const [method, path] of rootRoutes) {
      const policy = routePolicy(method, path)
      expect(roleCapabilities('viewer').has(policy.capability)).toBe(false)
    }
  })

  it('uses resource scope only for explicitly site-scoped routes', () => {
    const siteRoutes = Object.entries(allRoutePolicies()).filter(([, policy]) => policy.scope === 'site')
    expect(siteRoutes.map(([route]) => route).sort()).toEqual(['PATCH /api/sites', 'POST /api/sites/deploy'])
    for (const [, policy] of siteRoutes)
      expect(policy.siteFrom).toBe('body')
  })

  it('gives every site-scoped policy a way to resolve its site', () => {
    for (const policy of Object.values(allRoutePolicies())) {
      if (policy.scope === 'site')
        expect(policy.siteFrom).toBe('body')
    }
  })
})

describe('policy coverage', () => {
  /**
   * The table is only a security boundary if it actually covers the server. Scan
   * the handler for the routes it implements and assert each one was given a
   * deliberate policy — an unlisted route still fails closed, but silently
   * locking admins-only is a bug we want to hear about here, not in production.
   */
  it('has an entry for every route the dashboard server implements', () => {
    const source = readFileSync(join(import.meta.dir, 'local-dashboard-server.ts'), 'utf8')
    const policies = allRoutePolicies()

    // `url.pathname === '/api/x' && req.method === 'POST'` → [path, method]
    const routes = new Set<string>()
    const re = /url\.pathname === '(\/api\/[^']*)'(?:\s*&&\s*req\.method === '([A-Z]+)')?/g
    for (const match of source.matchAll(re)) {
      const [, path, method] = match
      routes.add(`${method ?? 'GET'} ${path}`)
    }

    // Sanity-check the scan itself found something, so a regex that stops
    // matching can't turn this into a vacuous pass.
    expect(routes.size).toBeGreaterThan(20)

    const missing = [...routes].filter(route => !(route in policies) && !PUBLIC_ROUTES.has(route))
    expect(missing).toEqual([])
  })

  it('keeps the public surface to login, recovery, logout, and token-authenticated invitation acceptance', () => {
    // Anything reachable without a session is worth noticing in review, so pin
    // the exact set rather than asserting a count.
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      'POST /api/auth/password-reset/complete',
      'POST /api/auth/password-reset/request',
      'POST /api/invitations/accept',
      'POST /api/login',
      'POST /api/logout',
    ])
    expect(isPublicRoute('POST', '/api/login')).toBe(true)
    expect(isPublicRoute('GET', '/api/dashboard-data')).toBe(false)
    expect(isPublicRoute('POST', '/api/server/command')).toBe(false)
  })

  it('never marks a public route as also policy-governed', () => {
    // A route in both sets would be ambiguous: the gate skips public routes, so
    // its policy would be silently dead.
    for (const route of PUBLIC_ROUTES)
      expect(route in allRoutePolicies()).toBe(false)
  })
})
