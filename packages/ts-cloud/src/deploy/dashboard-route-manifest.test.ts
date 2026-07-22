import { describe, expect, it } from 'bun:test'
import { dashboardPageRoutes, resolveLegacyDashboardRoute, routesForDashboard } from './dashboard-route-manifest'

describe('dashboard route manifest', () => {
  it('uses unique route ids and paths', () => {
    expect(new Set(dashboardPageRoutes.map(route => route.id)).size).toBe(dashboardPageRoutes.length)
    expect(new Set(dashboardPageRoutes.map(route => route.path)).size).toBe(dashboardPageRoutes.length)
  })

  it('keeps member navigation on explicitly non-admin server routes', () => {
    const memberRoutes = routesForDashboard('server', true)
    expect(memberRoutes.map(route => route.id)).toEqual(['services.list', 'deployments.list', 'logs.list', 'sources.integrations', 'security.posture'])
    expect(memberRoutes.every(route => !route.adminOnly)).toBe(true)
  })

  it('keeps legacy deep links working during the shell transition', () => {
    expect(resolveLegacyDashboardRoute('/sites')).toBe('/server/sites')
    expect(resolveLegacyDashboardRoute('/database')).toBe('/server/database')
    expect(resolveLegacyDashboardRoute('/unknown')).toBeUndefined()
  })
})
