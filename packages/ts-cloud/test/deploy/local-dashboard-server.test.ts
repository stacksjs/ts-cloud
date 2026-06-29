import { describe, expect, it } from 'bun:test'
import {
  dashboardActions,
  dashboardServerOperations,
  resolveDashboardAction,
  resolveDashboardServerOperation,
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

  it('builds only allowlisted systemd service operations', () => {
    const data = {
      servicesDetail: [
        { name: 'rpx-gateway' },
        { name: 'php8.3-fpm' },
        { name: 'bad; rm -rf /' },
      ],
    }

    const operations = dashboardServerOperations(data)

    expect(operations.map(operation => operation.id)).toEqual([
      'restart:rpx-gateway',
      'reload:rpx-gateway',
      'restart:php8.3-fpm',
      'reload:php8.3-fpm',
    ])
    expect(resolveDashboardServerOperation('restart:php8.3-fpm', data)?.confirm).toBe('php8.3-fpm')
    expect(resolveDashboardServerOperation('restart:bad; rm -rf /', data)).toBeUndefined()
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
          sshKeys: [
            {
              name: 'chris@macbook',
              publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEFnZmFrZWtleWJvZHlmb3J0ZXN0b25seTEyMzQ chris@macbook',
            },
          ],
        },
      },
      sites: {
        app: { domain: 'example.com', root: 'dist', port: 3000 },
      },
    } as any)

    expect(sanitized.compute.proxy).toEqual({ engine: 'rpx', onDemandTls: true, cdn: true })
    expect(sanitized.compute.sshKeys[0].name).toBe('chris@macbook')
    expect(sanitized.compute.sshKeys[0].fingerprint.startsWith('SHA256:')).toBe(true)
    expect(JSON.stringify(sanitized)).not.toContain('do-not-leak')
    expect(JSON.stringify(sanitized)).not.toContain('AAAAC3Nza')
    expect(sanitized.sites.app.domain).toBe('example.com')
  })
})
