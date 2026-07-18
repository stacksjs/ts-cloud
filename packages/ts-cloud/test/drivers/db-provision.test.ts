import { describe, expect, it } from 'bun:test'
import {
  buildDatabaseSetupScript,
  buildManagedDbEnv,
  buildServicesProvisionScript,
  isLocalDatabase,
  pgAdminCommand,
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

  // The pantry postgres pg_hba trusts the local unix socket but demands md5
  // over TCP loopback (and the postgres superuser has no password) — admin
  // commands against the co-located engine must NOT pass -h 127.0.0.1.
  it('connects the Postgres setup over the local unix socket, not TCP', () => {
    const script = buildDatabaseSetupScript(
      { name: 'app', username: 'app', password: 'pw' },
      { postgres: true },
    ).join('\n')
    expect(script).toContain('psql -p 5432 -U postgres <<\'TS_CLOUD_PG_EOF\'')
    expect(script).not.toContain('psql -h')
    expect(script).toContain('pg_isready -p 5432 -q')
    expect(script).not.toContain('pg_isready -h')
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
    expect(script).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "app" IN SCHEMA public GRANT SELECT ON TABLES TO "reporter"')
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

describe('isLocalDatabase', () => {
  it('treats unset/loopback hosts as local, anything else as external', () => {
    expect(isLocalDatabase(undefined)).toBe(true)
    expect(isLocalDatabase({ name: 'app' })).toBe(true)
    expect(isLocalDatabase({ name: 'app', host: '127.0.0.1' })).toBe(true)
    expect(isLocalDatabase({ name: 'app', host: 'localhost' })).toBe(true)
    expect(isLocalDatabase({ name: 'app', host: 'db.internal.example.com' })).toBe(false)
    expect(isLocalDatabase({ name: 'app', host: '10.0.0.5' })).toBe(false)
  })
})

describe('pgAdminCommand', () => {
  // Regression: the pantry postgres pg_hba grants `trust` on the local unix
  // socket but requires md5 over TCP loopback — and the postgres superuser has
  // no password — so `-h 127.0.0.1` admin commands failed on the box.
  it('uses the default local socket (no -h) for a co-located engine', () => {
    expect(pgAdminCommand({ name: 'app' })).toBe('psql -p 5432 -U postgres')
    expect(pgAdminCommand({ name: 'app', host: '127.0.0.1' })).toBe('psql -p 5432 -U postgres')
    expect(pgAdminCommand({ name: 'app', host: 'localhost' })).toBe('psql -p 5432 -U postgres')
    expect(pgAdminCommand(undefined)).toBe('psql -p 5432 -U postgres')
  })

  it('honors a custom local port', () => {
    expect(pgAdminCommand({ name: 'app', port: 5433 })).toBe('psql -p 5433 -U postgres')
  })

  it('supports pg_dump for dump commands', () => {
    expect(pgAdminCommand({ name: 'app' }, 'pg_dump')).toBe('pg_dump -p 5432 -U postgres')
  })

  it('keeps TCP with credentials for an external host', () => {
    expect(pgAdminCommand({ name: 'app', host: 'db.example.com', username: 'admin', password: 's3cret' }))
      .toBe(`PGPASSWORD='s3cret' psql -h db.example.com -p 5432 -U admin -w`)
  })

  it('omits PGPASSWORD for an external host without a password (still never prompts)', () => {
    expect(pgAdminCommand({ name: 'app', host: 'db.example.com', username: 'admin' }))
      .toBe('psql -h db.example.com -p 5432 -U admin -w')
  })

  it('escapes a single quote in the external password', () => {
    expect(pgAdminCommand({ name: 'app', host: 'db.example.com', password: "a'b" }))
      .toBe(`PGPASSWORD='a'\\''b' psql -h db.example.com -p 5432 -U postgres -w`)
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
