import { describe, expect, it } from 'bun:test'
import { resolveDashboardEnvironment } from './local-dashboard-server'

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
