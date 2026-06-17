import { describe, expect, it } from 'bun:test'
import {
  buildDatabaseSetupScript,
  buildManagedDbEnv,
  buildServicesProvisionScript,
} from '../../src/drivers/shared/db-provision'

describe('buildServicesProvisionScript', () => {
  it('installs and enables the requested engines via pantry', () => {
    const script = buildServicesProvisionScript({ mysql: true, redis: true }).join('\n')
    expect(script).toContain('pantry install \'mysql.com@8.0.43\' \'redis.io\'')
    expect(script).toContain('pantry enable \'mysql\'')
    expect(script).toContain('pantry start \'mysql\'')
    expect(script).toContain('pantry start \'redis\'')
    expect(script).not.toContain('apt-get')
  })

  it('installs postgres + meilisearch when requested', () => {
    const script = buildServicesProvisionScript({ postgres: true, meilisearch: { version: '1.6' } }).join('\n')
    expect(script).toContain('pantry install \'postgresql.org\' \'meilisearch.com\'')
    expect(script).toContain('pantry start \'postgres\'')
    expect(script).toContain('pantry start \'meilisearch\'')
  })

  it('emits nothing for an empty config', () => {
    expect(buildServicesProvisionScript({})).toEqual([])
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
    expect(script).toContain("CREATE USER IF NOT EXISTS 'forge'@'localhost' IDENTIFIED BY 'secret'")
    expect(script).toContain('GRANT ALL PRIVILEGES')
    // Connects as root via the unix socket (fresh root is socket/localhost-only).
    expect(script).toContain('mysql --socket=/var/lib/pantry/mysql/mysqld.sock -u root')
  })

  it('creates a MariaDB database via the mariadb socket', () => {
    const script = buildDatabaseSetupScript(
      { name: 'app', username: 'app', password: 'pw' },
      { mariadb: true },
    ).join('\n')
    expect(script).toContain('mysql --socket=/var/lib/pantry/mariadb/mariadbd.sock -u root')
    expect(script).toContain("CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 'pw'")
  })

  it('creates a Postgres role + database with existence guards', () => {
    const script = buildDatabaseSetupScript(
      { name: 'app', username: 'app', password: 'pw' },
      { postgres: true },
    ).join('\n')
    // Role guarded by a DO block; identifiers double-quoted, password literal.
    expect(script).toContain('IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = \'app\')')
    expect(script).toContain('CREATE ROLE "app" LOGIN PASSWORD \'pw\'')
    // Database created idempotently via \gexec.
    expect(script).toContain('CREATE DATABASE "app" OWNER "app"')
    expect(script).toContain('\\gexec')
  })

  it('creates extra MySQL users with read-only + full grants', () => {
    const script = buildDatabaseSetupScript(
      {
        name: 'forge',
        username: 'forge',
        password: 'secret',
        users: [
          { username: 'reporter', password: 'ro', access: 'readonly' },
          { username: 'svc', password: 'sv', databases: ['forge', 'analytics'] },
        ],
      },
      { mysql: true },
    ).join('\n')
    // Read-only user gets SELECT only on the app database.
    expect(script).toContain("CREATE USER IF NOT EXISTS 'reporter'@'%' IDENTIFIED BY 'ro'")
    expect(script).toContain("GRANT SELECT ON `forge`.* TO 'reporter'@'%'")
    // Re-provision keeps the password in sync (Forge-style reset).
    expect(script).toContain("ALTER USER 'reporter'@'localhost' IDENTIFIED BY 'ro'")
    // Full user with multiple databases.
    expect(script).toContain("GRANT ALL PRIVILEGES ON `forge`.* TO 'svc'@'%'")
    expect(script).toContain("GRANT ALL PRIVILEGES ON `analytics`.* TO 'svc'@'%'")
  })

  it('creates extra Postgres users with read-only grants', () => {
    const script = buildDatabaseSetupScript(
      {
        name: 'app',
        username: 'app',
        password: 'pw',
        users: [{ username: 'reporter', password: 'ro', access: 'readonly' }],
      },
      { postgres: true },
    ).join('\n')
    expect(script).toContain('CREATE ROLE "reporter" LOGIN PASSWORD \'ro\'')
    expect(script).toContain('GRANT CONNECT ON DATABASE "app" TO "reporter"')
    expect(script).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO "reporter"')
    expect(script).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "reporter"')
    expect(script).toContain('\\connect "app"')
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
