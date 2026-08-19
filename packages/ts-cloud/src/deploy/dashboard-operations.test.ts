import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildDashboardOperations, isSafeSystemdUnit, resolveDashboardOperation } from './dashboard-operations'

function config(overrides: Partial<CloudConfig> = {}): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    infrastructure: {
      compute: { webServer: 'rpx', backups: { enabled: true } },
      appDatabase: { name: 'acme', engine: 'mysql' },
    },
    sites: {
      web: { domain: 'acme.com', root: '.', start: 'bun run server.ts', port: 3000, queues: ['default'] },
      docs: { domain: 'acme.com', path: '/docs', root: 'docs/dist', deploy: 'server', type: 'static' },
      api: { domain: 'api.acme.com', root: '.', start: 'bun run api.ts', port: 3001, scheduler: true },
    },
    ...overrides,
  } as unknown as CloudConfig
}

const data = {
  servicesDetail: [{ name: 'rpx-gateway' }, { name: 'php8.3-fpm' }, { name: 'bad; rm -rf /' }],
  workers: [{ name: 'web:default' }, { name: 'web:emails' }],
}

describe('buildDashboardOperations', () => {
  const ops = buildDashboardOperations(config(), data)
  const ids = ops.map((o) => o.id)

  it('builds all six service verbs per safe unit and drops unsafe ones', () => {
    for (const verb of ['restart', 'reload', 'start', 'stop', 'enable', 'disable'])
      expect(ids).toContain(`${verb}:rpx-gateway`)
    expect(ids.filter((id) => id.endsWith(':rpx-gateway'))).toHaveLength(6)
    expect(ids.some((id) => id.includes('rm -rf'))).toBe(false)
  })

  it('marks stop/disable as danger and carries the unit as the confirm token', () => {
    expect(ops.find((o) => o.id === 'stop:rpx-gateway')?.danger).toBe(true)
    expect(ops.find((o) => o.id === 'restart:rpx-gateway')?.danger).toBeFalsy()
    expect(ops.find((o) => o.id === 'restart:php8.3-fpm')?.confirm).toBe('php8.3-fpm')
  })

  it('offers rollback only for release-based sites (server-app/php), not static', () => {
    expect(ids).toContain('rollback:web')
    expect(ids).toContain('rollback:api')
    expect(ids).not.toContain('rollback:docs')
    expect(ops.find((o) => o.id === 'rollback:web')?.danger).toBe(true)
  })

  it('offers worker restart per worker site (deduped) and scheduler run for scheduled sites', () => {
    expect(ids).toContain('worker:restart:web')
    expect(ids.filter((id) => id === 'worker:restart:web')).toHaveLength(1)
    expect(ids).toContain('scheduler:run:api')
    expect(ids).not.toContain('scheduler:run:web')
  })

  it('labels the scheduler op per framework (Stacks daemon → restart, Laravel one-shot → run)', () => {
    // `api` has no framework/type → Stacks-first default → the daemon is cycled.
    expect(ops.find((o) => o.id === 'scheduler:run:api')?.label).toBe('Restart scheduler (api)')

    const laravel = buildDashboardOperations(
      config({
        sites: { blog: { domain: 'acme.com', root: '.', type: 'laravel', scheduler: true } },
      } as any),
      data,
    )
    expect(laravel.find((o) => o.id === 'scheduler:run:blog')?.label).toBe('Run scheduler (blog)')
  })

  it('offers backup run + restore when backups are enabled and a db exists', () => {
    expect(ids).toContain('backup:run')
    expect(ids).toContain('backup:restore')
    expect(ops.find((o) => o.id === 'backup:restore')?.danger).toBe(true)
  })

  it('omits backup ops when backups are disabled, and restore without a db', () => {
    const noBackups = buildDashboardOperations(
      config({ infrastructure: { compute: { webServer: 'rpx' } } } as any),
      data,
    )
    expect(noBackups.some((o) => o.group === 'backup')).toBe(false)

    const noDb = buildDashboardOperations(
      config({ infrastructure: { compute: { webServer: 'rpx', backups: { enabled: true } } } } as any),
      data,
    )
    expect(noDb.some((o) => o.id === 'backup:run')).toBe(true)
    expect(noDb.some((o) => o.id === 'backup:restore')).toBe(false)
  })

  it('resolves an operation by id', () => {
    expect(resolveDashboardOperation('rollback:web', config(), data)?.target).toBe('web')
    expect(resolveDashboardOperation('nope:nope', config(), data)).toBeUndefined()
  })
})

describe('isSafeSystemdUnit', () => {
  it('accepts normal unit names and rejects shell metacharacters', () => {
    expect(isSafeSystemdUnit('php8.3-fpm')).toBe(true)
    expect(isSafeSystemdUnit('acme-web.service')).toBe(true)
    expect(isSafeSystemdUnit('bad; rm -rf /')).toBe(false)
    expect(isSafeSystemdUnit('a b')).toBe(false)
  })
})
