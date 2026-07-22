import { describe, expect, it } from 'bun:test'
import { dashboardPageRoutes, resolveLegacyDashboardRoute, routesForDashboard } from './dashboard-route-manifest'

describe('dashboard route manifest', () => {
  it('uses unique route ids and paths', () => {
    expect(new Set(dashboardPageRoutes.map(route => route.id)).size).toBe(dashboardPageRoutes.length)
    expect(new Set(dashboardPageRoutes.map(route => route.path)).size).toBe(dashboardPageRoutes.length)
  })

  it('keeps member navigation on explicitly non-admin server routes', () => {
    const memberRoutes = routesForDashboard('server', true)
    expect(memberRoutes.map(route => route.id)).toEqual(['services.list', 'deployments.list', 'logs.list', 'sources.integrations', 'applications.create', 'applications.compose', 'operations.queue', 'operations.previews', 'operations.releases', 'runtime.workloads', 'observability.overview', 'alerts.overview', 'automation.jobs', 'configuration.entries', 'backups.list', 'volumes.list', 'fleet.list', 'data.services', 'security.posture'])
    expect(memberRoutes.every(route => !route.adminOnly)).toBe(true)
  })

  it('keeps legacy deep links working during the shell transition', () => {
    expect(resolveLegacyDashboardRoute('/sites')).toBe('/server/sites')
    expect(resolveLegacyDashboardRoute('/database')).toBe('/data/services')
    expect(resolveLegacyDashboardRoute('/server/database')).toBe('/data/services')
    expect(resolveLegacyDashboardRoute('/serverless/data')).toBe('/data/services')
    expect(resolveLegacyDashboardRoute('/server/workers')).toBe('/operations/jobs')
    expect(resolveLegacyDashboardRoute('/serverless/scheduler')).toBe('/operations/jobs')
    expect(resolveLegacyDashboardRoute('/server/backups')).toBe('/data/backups')
    expect(resolveLegacyDashboardRoute('/unknown')).toBeUndefined()
  })
})
