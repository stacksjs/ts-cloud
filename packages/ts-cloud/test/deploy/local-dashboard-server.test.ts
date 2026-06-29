import { describe, expect, it } from 'bun:test'
import {
  dashboardActions,
  resolveDashboardAction,
  sanitizeCloudConfig,
} from '../../src/deploy/local-dashboard-server'

describe('local dashboard server helpers', () => {
  it('exposes an allowlisted action model with explicit mutation confirmation', () => {
    const actions = dashboardActions('production' as any)
    expect(actions.map(action => action.id)).toEqual(['status', 'doctor', 'security-scan', 'deploy'])
    expect(resolveDashboardAction('deploy', 'production' as any)?.confirm).toBe('deploy')
    expect(resolveDashboardAction('deploy', 'production' as any)?.mutates).toBe(true)
    expect(resolveDashboardAction('rm -rf', 'production' as any)).toBeUndefined()
  })

  it('sanitizes cloud config for the browser API', () => {
    const sanitized = sanitizeCloudConfig({
      project: { name: 'Stacks', slug: 'stacks', region: 'us-east-1' },
      provider: 'hetzner',
      environments: { production: {} },
      infrastructure: {
        compute: {
          runtime: 'bun',
          webServer: 'rpx',
          proxy: {
            engine: 'rpx',
            onDemandTls: true,
            cdn: { secret: 'do-not-leak', frontedHosts: ['example.com'], originDomain: 'origin.example.com' },
          },
        },
      },
      sites: {
        app: { domain: 'example.com', root: 'dist', port: 3000 },
      },
    } as any)

    expect(sanitized.compute.proxy).toEqual({ engine: 'rpx', onDemandTls: true, cdn: true })
    expect(JSON.stringify(sanitized)).not.toContain('do-not-leak')
    expect(sanitized.sites.app.domain).toBe('example.com')
  })
})
