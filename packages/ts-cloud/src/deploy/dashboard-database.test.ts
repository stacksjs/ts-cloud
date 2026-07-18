import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildBackupScript, buildCreateDatabaseScript, buildCreateUserScript, buildListScript, isValidDbIdentifier, parseBackups, parseDbList, resolveDbEngine } from './dashboard-database'

describe('resolveDbEngine', () => {
  const cfg = (infra: any): CloudConfig => ({ project: { name: 'a', slug: 'a' }, infrastructure: infra } as any)
  it('prefers the appDatabase engine, then managed services, default mysql', () => {
    expect(resolveDbEngine(cfg({ appDatabase: { engine: 'postgres' } }))).toBe('postgres')
    expect(resolveDbEngine(cfg({ appDatabase: { engine: 'pgsql' } }))).toBe('postgres')
    expect(resolveDbEngine(cfg({ compute: { managedServices: { mariadb: true } } }))).toBe('mariadb')
    expect(resolveDbEngine(cfg({ compute: { managedServices: { postgres: true } } }))).toBe('postgres')
    expect(resolveDbEngine(cfg({ compute: {} }))).toBe('mysql')
  })
})

describe('isValidDbIdentifier', () => {
  it('accepts normal names, rejects injection', () => {
    expect(isValidDbIdentifier('acme_prod')).toBe(true)
    expect(isValidDbIdentifier('1bad')).toBe(false)
    expect(isValidDbIdentifier('drop;table')).toBe(false)
    expect(isValidDbIdentifier('a`b')).toBe(false)
  })
})

describe('buildCreateDatabaseScript', () => {
  it('mysql: CREATE DATABASE via the socket', () => {
    const cmds = buildCreateDatabaseScript('mysql', 'acme').join('\n')
    expect(cmds).toContain('mysql --socket=/var/lib/pantry/mysql/mysqld.sock -u root')
    expect(cmds).toContain('CREATE DATABASE IF NOT EXISTS `acme`')
  })
  it('mariadb uses the mariadb socket', () => {
    expect(buildCreateDatabaseScript('mariadb', 'acme').join('\n')).toContain('mariadb/mariadbd.sock')
  })
  it('postgres: gexec-guarded CREATE DATABASE over the local unix socket', () => {
    // The pantry postgres pg_hba trusts the local socket but demands md5 over
    // TCP loopback — admin commands must not pass -h 127.0.0.1.
    const cmds = buildCreateDatabaseScript('postgres', 'acme').join('\n')
    expect(cmds).toContain('psql -p 5432 -U postgres')
    expect(cmds).not.toContain('psql -h')
    expect(cmds).toContain('CREATE DATABASE "acme"')
    expect(cmds).toContain('\\gexec')
  })
  it('postgres: an external database host keeps TCP with credentials', () => {
    const external = { engine: 'postgres' as const, name: 'acme', host: 'db.example.com', username: 'admin', password: 's3cret' }
    const cmds = buildCreateDatabaseScript('postgres', 'acme', external).join('\n')
    expect(cmds).toContain(`PGPASSWORD='s3cret' psql -h db.example.com -p 5432 -U admin -w`)
  })
})

describe('buildCreateUserScript', () => {
  it('mysql: creates user for %/localhost and grants on the database', () => {
    const cmds = buildCreateUserScript('mysql', { username: 'app', password: 's3cret', database: 'acme', access: 'all' }).join('\n')
    expect(cmds).toContain("CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 's3cret';")
    expect(cmds).toContain("CREATE USER IF NOT EXISTS 'app'@'localhost'")
    expect(cmds).toContain("GRANT ALL PRIVILEGES ON `acme`.* TO 'app'@'%';")
    expect(cmds).toContain('FLUSH PRIVILEGES;')
  })
  it('mysql readonly grants SELECT only', () => {
    expect(buildCreateUserScript('mysql', { username: 'ro', password: 'p', database: 'acme', access: 'readonly' }).join('\n')).toContain('GRANT SELECT ON `acme`.*')
  })
  it('escapes a single quote in the password', () => {
    expect(buildCreateUserScript('mysql', { username: 'app', password: "a'b" }).join('\n')).toContain("IDENTIFIED BY 'a\\'b'")
  })
  it('postgres: ensures a login role and grants', () => {
    const cmds = buildCreateUserScript('postgres', { username: 'app', password: 'p', database: 'acme', access: 'all' }).join('\n')
    expect(cmds).toContain('CREATE ROLE "app" LOGIN PASSWORD')
    expect(cmds).toContain('GRANT ALL PRIVILEGES ON DATABASE "acme" TO "app";')
  })
})

describe('buildListScript + parseDbList', () => {
  it('lists databases + users, excluding system schemas', () => {
    const cmds = buildListScript('mysql').join('\n')
    expect(cmds).toContain("schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')")
    expect(cmds).toContain('CONCAT(\'USER=\', User)')
  })
  it('parses DB=/USER= lines, ignores noise, and dedupes', () => {
    const parsed = parseDbList('DB=acme\nDB=acme\nDB=blog\nUSER=app\nrandom noise line\nUSER=app')
    expect(parsed.databases).toEqual(['acme', 'blog'])
    expect(parsed.users).toEqual(['app'])
  })

  it('builds a per-database dump script (mysqldump / pg_dump) to a timestamped file', () => {
    const my = buildBackupScript('mysql', 'acme').join('\n')
    expect(my).toContain('mysqldump --socket=')
    expect(my).toContain('acme-$(date +%Y%m%d-%H%M%S).sql.gz')
    // Local pantry engine: socket (no -h) — TCP loopback demands md5.
    const pg = buildBackupScript('postgres', 'acme').join('\n')
    expect(pg).toContain('pg_dump -p 5432 -U postgres acme')
    expect(pg).not.toContain('pg_dump -h')
    // External host: TCP with credentials.
    const ext = buildBackupScript('postgres', 'acme', '/var/backups/ts-cloud/databases', { engine: 'postgres', name: 'acme', host: 'db.example.com', username: 'admin', password: 'pw' }).join('\n')
    expect(ext).toContain(`PGPASSWORD='pw' pg_dump -h db.example.com -p 5432 -U admin -w acme`)
  })

  it('parses BACKUP= lines into database + file, deriving the db from the filename', () => {
    const parsed = parseBackups('BACKUP=/var/backups/ts-cloud/databases/acme-20260702-101500.sql.gz\nnoise\nBACKUP=/var/backups/ts-cloud/databases/blog-20260701-090000.sql.gz')
    expect(parsed).toEqual([
      { file: '/var/backups/ts-cloud/databases/acme-20260702-101500.sql.gz', database: 'acme' },
      { file: '/var/backups/ts-cloud/databases/blog-20260701-090000.sql.gz', database: 'blog' },
    ])
  })
})
