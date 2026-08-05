import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { planDashboardVitessProvision } from './dashboard-vitess-provision'

function config(database?: Record<string, unknown>, managedServices?: Record<string, unknown>): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme' },
    infrastructure: {
      appDatabase: database,
      compute: { managedServices },
    },
  } as CloudConfig
}

describe('dashboard Vitess provisioning', () => {
  it('builds the canonical safe single-box cluster plan', () => {
    const plan = planDashboardVitessProvision(config({ engine: 'vitess', name: 'commerce' }), {
      keyspace: 'commerce',
      username: 'commerce_app',
      password: 'a-production-password',
      confirm: 'commerce',
    })

    expect(plan.service).toEqual({
      mode: 'cluster',
      cell: 'zone1',
      keyspaces: [{ name: 'commerce', sharded: false }],
      vtgatePort: 15306,
      username: 'commerce_app',
      password: 'a-production-password',
      bindAddress: '127.0.0.1',
    })
    expect(plan.appDatabase).toEqual({
      engine: 'vitess',
      name: 'commerce',
      username: 'commerce_app',
      host: '127.0.0.1',
      port: 15306,
      ssl: false,
    })
    const script = plan.commands.join('\n')
    expect(script).toContain('pantry')
    expect(script).toContain('vitess-vtgate.service')
    expect(script).toContain('vtgate is serving on 15306')
  })

  it('requires deliberate confirmation, identifiers, and a strong password', () => {
    expect(() =>
      planDashboardVitessProvision(config(), {
        keyspace: 'bad-name',
        username: 'app',
        password: 'short',
        confirm: '',
      }),
    ).toThrow('Keyspace')
    expect(() =>
      planDashboardVitessProvision(config(), {
        keyspace: 'commerce',
        username: 'app',
        password: 'short',
        confirm: 'commerce',
      }),
    ).toThrow('16 characters')
    expect(() =>
      planDashboardVitessProvision(config(), {
        keyspace: 'commerce',
        username: 'app',
        password: 'a-production-password',
        confirm: 'wrong',
      }),
    ).toThrow('confirm')
  })

  it('refuses to replace an existing database declaration', () => {
    expect(() =>
      planDashboardVitessProvision(config({ engine: 'postgres', name: 'acme' }, { postgres: true }), {
        keyspace: 'commerce',
        username: 'app',
        password: 'a-production-password',
        confirm: 'commerce',
      }),
    ).toThrow('already declares postgres')
  })
})
