import { describe, expect, it } from 'bun:test'
import {
  dashboardDataRefreshDue,
  preserveDashboardSiteSnapshot,
  resolveDashboardEnvironment,
} from './local-dashboard-server'

describe('dashboard environment scope', () => {
  it('resolves each request independently without shared mutable state', () => {
    const available = ['production', 'staging']
    const tabOne = resolveDashboardEnvironment(available, 'production', 'staging')
    const tabTwo = resolveDashboardEnvironment(available, 'production', 'production')

    expect(tabOne).toBe('staging')
    expect(tabTwo).toBe('production')
    expect(resolveDashboardEnvironment(available, 'production', 'staging')).toBe('staging')
  })

  it('falls back safely for stale or guessed environment links', () => {
    expect(resolveDashboardEnvironment(['production'], 'production', 'deleted')).toBe('production')
    expect(resolveDashboardEnvironment(['production'], 'production', null)).toBe('production')
  })
})

describe('dashboard data refresh cadence', () => {
  it('coalesces browser polling inside the minimum refresh interval', () => {
    expect(dashboardDataRefreshDue(undefined, 30_000, 30_000)).toBe(true)
    expect(dashboardDataRefreshDue(1_000, 30_999, 30_000)).toBe(false)
    expect(dashboardDataRefreshDue(1_000, 31_000, 30_000)).toBe(true)
  })

  it('keeps the last route-health snapshot during lightweight host refreshes', () => {
    const previous = {
      sites: [{ route: 'example.com', status: 'live' }],
      sitesDetail: [{ route: 'example.com', status: 'live', responseMs: 12 }],
      siteHealth: [{ route: 'example.com', status: 'live', responseMs: 12 }],
      systemMetrics: { cpuUsedPct: 10 },
    }
    const refreshed = preserveDashboardSiteSnapshot(previous, {
      sites: [{ route: 'example.com' }],
      sitesDetail: [{ route: 'example.com' }],
      siteHealth: [],
      systemMetrics: { cpuUsedPct: 20 },
    })

    expect(refreshed.systemMetrics).toEqual({ cpuUsedPct: 20 })
    expect(refreshed.sites).toEqual(previous.sites)
    expect(refreshed.sitesDetail).toEqual(previous.sitesDetail)
    expect(refreshed.siteHealth).toEqual(previous.siteHealth)
  })
})
