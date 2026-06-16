import { describe, expect, it } from 'bun:test'
import {
  buildDatabaseSetupScript,
  buildManagedDbEnv,
  buildServicesProvisionScript,
} from '../../src/drivers/shared/db-provision'

describe('buildServicesProvisionScript', () => {
  it('installs and enables the requested engines', () => {
    const script = buildServicesProvisionScript({ mysql: true, redis: true }).join('\n')
    expect(script).toContain('apt-get install -y mysql-server')
    expect(script).toContain('systemctl enable mysql')
    expect(script).toContain('apt-get install -y redis-server')
  })

  it('installs postgres + meilisearch when requested', () => {
    const script = buildServicesProvisionScript({ postgres: true, meilisearch: { version: '1.6' } }).join('\n')
    expect(script).toContain('apt-get install -y postgresql postgresql-contrib')
    expect(script).toContain('install.meilisearch.com')
    expect(script).toContain('/etc/systemd/system/meilisearch.service')
  })

  it('emits nothing engine-specific for an empty config', () => {
    const script = buildServicesProvisionScript({})
    expect(script.some(l => l.includes('mysql-server'))).toBe(false)
  })
})

describe('buildDatabaseSetupScript', () => {
  it('creates a MySQL database + user', () => {
    const script = buildDatabaseSetupScript(
      { name: 'forge', username: 'forge', password: 'secret' },
      { mysql: true },
    ).join('\n')
    expect(script).toContain('CREATE DATABASE IF NOT EXISTS')
    expect(script).toContain("CREATE USER IF NOT EXISTS 'forge'@'%' IDENTIFIED BY 'secret'")
    expect(script).toContain('GRANT ALL PRIVILEGES')
  })

  it('creates a Postgres role + database with existence guards', () => {
    const script = buildDatabaseSetupScript(
      { name: 'app', username: 'app', password: 'pw' },
      { postgres: true },
    ).join('\n')
    expect(script).toContain('pg_roles WHERE rolname=')
    expect(script).toContain('CREATE DATABASE')
    expect(script).toContain('OWNER')
  })

  it('skips creation for a managed (remote-host) database', () => {
    const script = buildDatabaseSetupScript(
      { name: 'app', host: 'db.internal.example.com' },
      { mysql: true },
    )
    expect(script).toEqual([])
  })

  it('skips when no database name is set', () => {
    expect(buildDatabaseSetupScript(undefined, { mysql: true })).toEqual([])
  })
})

describe('buildManagedDbEnv', () => {
  it('wires DB_* for MySQL', () => {
    const env = buildManagedDbEnv({ engine: 'mysql', name: 'forge', username: 'forge', password: 'pw' })
    expect(env.DB_CONNECTION).toBe('mysql')
    expect(env.DB_PORT).toBe('3306')
    expect(env.DB_DATABASE).toBe('forge')
    expect(env.DB_USERNAME).toBe('forge')
  })

  it('uses pgsql + 5432 for Postgres', () => {
    const env = buildManagedDbEnv({ engine: 'postgres', name: 'app' })
    expect(env.DB_CONNECTION).toBe('pgsql')
    expect(env.DB_PORT).toBe('5432')
    expect(env.DB_HOST).toBe('127.0.0.1')
  })

  it('returns nothing without a database name', () => {
    expect(buildManagedDbEnv(undefined)).toEqual({})
  })
})
