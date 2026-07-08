/**
 * Provision on-box managed services (Forge single-server model) via **pantry**:
 * the database engine, cache, and search are installed from the pantry registry
 * and run as boot-time systemd services, plus the application database + user
 * are created. When the app points at a managed/external database instead,
 * install nothing and just wire `.env` — see {@link buildManagedDbEnv}.
 *
 * pantry services listen on TCP localhost ports (mysql/mariadb 3306, postgres
 * 5432, redis 6379, memcached 11211, meilisearch 7700); DB setup connects over
 * TCP, and the engine clients are on PATH via `pantry env`.
 */
import type { ComputeServicesConfig, DatabaseConfig, DatabaseUserConfig } from '@ts-cloud/core'
import type { PantrySpec } from './package-manager'
import { buildPantryInstallScript, buildPantryServiceScript, PANTRY_PACKAGES, pantryEnvActivation } from './package-manager'

type ServiceSpec = boolean | { version?: string } | undefined

function enabled(spec: ServiceSpec): boolean {
  return spec === true || (typeof spec === 'object' && spec != null)
}

/** Map a service flag set to the pantry package domains + service names to run. */
interface ServicePlan {
  packages: PantrySpec[]
  services: string[]
}

function planServices(services: ComputeServicesConfig): ServicePlan {
  const packages: PantrySpec[] = []
  const names: string[] = []
  if (enabled(services.mysql)) {
    // Pin the version pantry actually source-builds + publishes for both arches.
    // The catalog's newest tags are "innovation" releases (9.x) with no source
    // tarball; 8.0.43 is the latest GA whose bundled-boost source builds cleanly.
    // (MariaDB is the default MySQL-compatible engine; mysql.com is opt-in.)
    packages.push(typeof services.mysql === 'object' && services.mysql.version
      ? `mysql.com@${services.mysql.version}`
      : 'mysql.com@8.0.43')
    names.push('mysql')
  }
  else if (enabled(services.mariadb)) {
    packages.push(PANTRY_PACKAGES.mariadb)
    names.push('mariadb')
  }
  if (enabled(services.postgres)) {
    packages.push('postgresql.org')
    names.push('postgres')
  }
  if (enabled(services.redis)) {
    packages.push('redis.io')
    names.push('redis')
  }
  if (enabled(services.memcached)) {
    packages.push('memcached.org')
    names.push('memcached')
  }
  if (enabled(services.meilisearch)) {
    packages.push('meilisearch.com')
    names.push('meilisearch')
  }
  return { packages, services: names }
}

/**
 * Build pantry install + enable/start commands for each requested on-box
 * service. Idempotent (pantry install/enable/start are no-ops when satisfied).
 * `options.bindPrivate` is accepted for fleet compatibility; pantry's services
 * already bind all interfaces behind the firewall.
 */
export function buildServicesProvisionScript(services: ComputeServicesConfig = {}, _options: { bindPrivate?: boolean } = {}): string[] {
  const plan = planServices(services)
  if (plan.packages.length === 0)
    return []
  return [
    ...buildPantryInstallScript(plan.packages),
    ...buildPantryServiceScript(plan.services),
  ]
}

/**
 * Build the commands that create the application database + user on the on-box
 * engine. Idempotent (uses IF NOT EXISTS / existence guards). Returns `[]` when
 * the database points at a managed host or lacks a name. The engine client is
 * put on PATH via `pantry env` and connects over TCP localhost.
 */
export function buildDatabaseSetupScript(
  database: DatabaseConfig | undefined,
  services: ComputeServicesConfig = {},
): string[] {
  if (!database?.name)
    return []
  // A managed/external DB is created out-of-band; nothing to do on the box.
  if (database.host && database.host !== '127.0.0.1' && database.host !== 'localhost')
    return []

  const name = database.name
  const user = database.username || name
  const pass = database.password || ''

  const usePostgres = enabled(services.postgres) || database.engine === 'postgres'
  const useMariadb = enabled(services.mariadb) || database.engine === 'mariadb'
  const useMysql = enabled(services.mysql) || database.engine === 'mysql'

  if (usePostgres && !useMysql && !useMariadb) {
    // Create role + database via a psql heredoc over TCP. Identifiers are
    // double-quoted (Postgres treats single-quoted as string literals, which is
    // a syntax error for a role/db name); string literals (the password,
    // existence-check comparisons) are single-quoted. Idempotent: a DO block
    // guards the role, and `\gexec` conditionally creates the database (which
    // can't run inside a DO block / transaction). The heredoc is quoted so the
    // shell leaves the SQL untouched.
    const pgIdent = (v: string): string => `"${v.replace(/"/g, '""')}"`
    const pgLit = (v: string): string => `'${v.replace(/'/g, '\'\'')}'`
    // Idempotently ensure a login role exists with the given password.
    const pgEnsureRole = (u: string, p: string): string[] => [
      'DO $$ BEGIN',
      `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${pgLit(u)}) THEN`,
      `    CREATE ROLE ${pgIdent(u)} LOGIN PASSWORD ${pgLit(p)};`,
      '  ELSE',
      `    ALTER ROLE ${pgIdent(u)} LOGIN PASSWORD ${pgLit(p)};`,
      '  END IF;',
      'END $$;',
    ]
    // Grant a role access to a database. `readonly` gets connect + SELECT on
    // existing and future tables; `all` gets full privileges on the database.
    const pgGrant = (u: DatabaseUserConfig): string[] => {
      const dbs = u.databases && u.databases.length > 0 ? u.databases : [name]
      const lines: string[] = []
      for (const db of dbs) {
        if (u.access === 'readonly') {
          lines.push(
            `GRANT CONNECT ON DATABASE ${pgIdent(db)} TO ${pgIdent(u.username)};`,
            // Per-database object grants must run connected to that database.
            `\\connect ${pgIdent(db)}`,
            `GRANT USAGE ON SCHEMA public TO ${pgIdent(u.username)};`,
            `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${pgIdent(u.username)};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${pgIdent(u.username)};`,
            '\\connect postgres',
          )
        }
        else {
          lines.push(`GRANT ALL PRIVILEGES ON DATABASE ${pgIdent(db)} TO ${pgIdent(u.username)};`)
        }
      }
      return lines
    }
    const extraUsers = (database.users || [])
    return [
      pantryEnvActivation(),
      // The engine service was just started; wait until it accepts connections
      // (first boot runs initdb, which takes a few seconds) before setup.
      'for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p 5432 -q && break; sleep 2; done',
      'psql -h 127.0.0.1 -p 5432 -U postgres <<\'TS_CLOUD_PG_EOF\'',
      ...pgEnsureRole(user, pass),
      `SELECT 'CREATE DATABASE ${pgIdent(name)} OWNER ${pgIdent(user)}' `
      + `WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${pgLit(name)})\\gexec`,
      // Additional users (read-only / extra logins) with their own grants.
      ...extraUsers.flatMap(u => [...pgEnsureRole(u.username, u.password), ...pgGrant(u)]),
      'TS_CLOUD_PG_EOF',
    ]
  }

  // MySQL / MariaDB share the same client + SQL. Connect as root via the UNIX
  // SOCKET — a freshly-initialized pantry engine grants passwordless root only
  // from localhost (socket); a TCP root@127.0.0.1 doesn't exist, so a TCP setup
  // would fail and the app user would never be created. The socket lives in the
  // engine's system-scope data dir. Create the app user for both `%` (TCP from
  // the app) and `localhost` (socket) so either connection path authenticates.
  const sock = useMariadb ? '/var/lib/pantry/mariadb/mariadbd.sock' : '/var/lib/pantry/mysql/mysqld.sock'
  const ident = (v: string): string => v.replace(/`/g, '``')
  const lit = (v: string): string => v.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')
  // Create a user for both `%` (TCP) and `localhost` (socket), then grant the
  // given privilege list on each database. `ALTER USER` keeps the password in
  // sync on a re-provision (a Forge-style password reset).
  const mysqlUser = (u: DatabaseUserConfig | { username: string, password: string, databases?: string[], access?: 'all' | 'readonly' }): string[] => {
    const dbs = u.databases && u.databases.length > 0 ? u.databases : [name]
    const priv = u.access === 'readonly' ? 'SELECT' : 'ALL PRIVILEGES'
    const lines = [
      `CREATE USER IF NOT EXISTS '${lit(u.username)}'@'%' IDENTIFIED BY '${lit(u.password)}';`,
      `CREATE USER IF NOT EXISTS '${lit(u.username)}'@'localhost' IDENTIFIED BY '${lit(u.password)}';`,
      `ALTER USER '${lit(u.username)}'@'%' IDENTIFIED BY '${lit(u.password)}';`,
      `ALTER USER '${lit(u.username)}'@'localhost' IDENTIFIED BY '${lit(u.password)}';`,
    ]
    for (const db of dbs) {
      lines.push(
        `GRANT ${priv} ON \`${ident(db)}\`.* TO '${lit(u.username)}'@'%';`,
        `GRANT ${priv} ON \`${ident(db)}\`.* TO '${lit(u.username)}'@'localhost';`,
      )
    }
    return lines
  }
  const extraUsers = (database.users || [])
  return [
    pantryEnvActivation(),
    // Wait until the just-started engine accepts socket connections before setup.
    `for i in $(seq 1 30); do mysqladmin --socket=${sock} -u root ping 2>/dev/null | grep -q alive && break; sleep 2; done`,
    `mysql --socket=${sock} -u root <<'TS_CLOUD_SQL_EOF'`,
    `CREATE DATABASE IF NOT EXISTS \`${ident(name)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    ...mysqlUser({ username: user, password: pass }),
    // Additional users (read-only / extra logins) with their own grants.
    ...extraUsers.flatMap(mysqlUser),
    'FLUSH PRIVILEGES;',
    'TS_CLOUD_SQL_EOF',
  ]
}

/**
 * `.env` key/value pairs wiring a Laravel app at the (on-box or managed)
 * database. Merge into a site's `env` so `DB_*` is set without hand-copying
 * credentials. Returns `{}` when there's nothing to wire.
 */
export function buildManagedDbEnv(database: DatabaseConfig | undefined): Record<string, string> {
  if (!database?.name)
    return {}
  // SingleStore speaks the MySQL wire protocol on 3306, but keep DB_CONNECTION
  // as 'singlestore' so the app's query builder selects the SingleStore driver
  // (distributed DDL, isMysqlLike DML). Postgres → 'pgsql'; everything else →
  // 'mysql'.
  const isSingleStore = database.engine === 'singlestore'
  const connection = database.engine === 'postgres' ? 'pgsql' : isSingleStore ? 'singlestore' : 'mysql'
  const port = database.port ?? (database.engine === 'postgres' ? 5432 : 3306)
  const env: Record<string, string> = {
    DB_CONNECTION: connection,
    DB_HOST: database.host || '127.0.0.1',
    DB_PORT: String(port),
    DB_DATABASE: database.name,
  }
  if (database.username)
    env.DB_USERNAME = database.username
  if (database.password)
    env.DB_PASSWORD = database.password
  // Managed SingleStore (Helios) requires TLS; default it on unless explicitly
  // disabled via `database.ssl === false`.
  if (isSingleStore && database.ssl !== false)
    env.DB_SSL = 'true'
  return env
}
