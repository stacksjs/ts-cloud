/**
 * Provision on-box managed services (Forge single-server model) via **pantry**:
 * the database engine, cache, and search are installed from the pantry registry
 * and run as boot-time systemd services, plus the application database + user
 * are created. When the app points at a managed/external database instead,
 * install nothing and just wire `.env` — see {@link buildManagedDbEnv}.
 *
 * pantry services listen on TCP localhost ports (mysql/mariadb 3306, postgres
 * 5432, redis 6379, memcached 11211, meilisearch 7700) and the engine clients
 * are on PATH via `pantry env`. Admin commands (db setup, dumps, restores)
 * connect over the engine's local unix socket — see {@link pgAdminCommand}.
 */
import type { ComputeServicesConfig, DatabaseConfig, DatabaseUserConfig, ResolvedMailService } from '@ts-cloud/core'
import type { PantrySpec } from './package-manager'
import { buildMailProvisionScript } from './mail-provision'
import { buildPantryInstallScript, buildPantryServiceScript, PANTRY_PACKAGES, pantryEnvActivation } from './package-manager'
import { buildVitessProvisionScript } from './vitess-provision'

/**
 * Engines whose APP DATABASE is always administered off-box.
 *
 * SingleStore is a managed service (Helios) with no self-hosted package.
 * Vitess now has one (`services.vitess` provisions a single-box cluster),
 * but it still belongs here: even when this box runs the daemons, the app's
 * keyspace is created through vtctld, not by `CREATE DATABASE` over a local
 * mysqld socket. The tablet's mysqld exists, and writing to it directly
 * bypasses Vitess entirely.
 *
 * This matters because {@link isLocalDatabase} decides "on-box or not" from
 * the HOST, and host is optional. Declaring `engine: 'singlestore'` without
 * a host therefore read as local and fell through to the MySQL branch of
 * {@link buildDatabaseSetupScript}, which shells out to
 * `mysql --socket=/var/lib/pantry/mysql/mysqld.sock` — a socket that cannot
 * exist, because nothing installed MySQL. The provision step failed with a
 * missing-socket error that named MySQL, an engine the user never asked for.
 */
const ALWAYS_EXTERNAL_ENGINES = new Set(['singlestore', 'vitess'])

/**
 * True when the database is co-located with the box (the managed-services
 * engine): no host configured, or an explicit loopback host. Anything else is
 * an external/managed database reached over TCP.
 *
 * An always-external engine is never local regardless of host — pointing one
 * at 127.0.0.1 means a tunnel or a local proxy, not an engine this box
 * installed and can administer over a unix socket.
 */
export function isLocalDatabase(database: DatabaseConfig | undefined): boolean {
  if (database?.engine && ALWAYS_EXTERNAL_ENGINES.has(database.engine))
    return false
  return !database?.host || database.host === '127.0.0.1' || database.host === 'localhost'
}

/**
 * Build the connection prefix for a postgres admin command (`psql`/`pg_dump`)
 * run on the box.
 *
 * The pantry postgres pg_hba grants `trust` on the local unix socket but
 * requires md5 password auth over TCP loopback — and the `postgres` superuser
 * has no password — so against the co-located engine admin clients MUST use
 * the socket: omit `-h` entirely and the pantry client uses its compiled-in
 * default socket dir, which matches the server's by construction (verified
 * on-box: `psql -U postgres` from root connects passwordless). Against an
 * external/managed host, use TCP with the configured credentials
 * (`PGPASSWORD` inline + `-w`, so a missing password fails fast instead of
 * prompting forever).
 */
export function pgAdminCommand(database: DatabaseConfig | undefined, tool: 'psql' | 'pg_dump' = 'psql'): string {
  const port = database?.port ?? 5432
  if (isLocalDatabase(database)) return `${tool} -p ${port} -U postgres`
  const user = database?.username || 'postgres'
  const env = database?.password ? `PGPASSWORD='${database.password.replace(/'/g, `'\\''`)}' ` : ''
  return `${env}${tool} -h ${database!.host} -p ${port} -U ${user} -w`
}

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
    packages.push(
      typeof services.mysql === 'object' && services.mysql.version
        ? `mysql.com@${services.mysql.version}`
        : 'mysql.com@8.0.43',
    )
    names.push('mysql')
  } else if (enabled(services.mariadb)) {
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
export function buildServicesProvisionScript(
  services: ComputeServicesConfig = {},
  options: { bindPrivate?: boolean, mail?: ResolvedMailService } = {},
): string[] {
  const plan = planServices(services)
  // Vitess is appended rather than folded into `planServices` because it is
  // not a `pantry start <name>` service: its daemons need explicit systemd
  // units with an ordering graph, its own topology bootstrap, and a health
  // gate. See `./vitess-provision`.
  const vitess = buildVitessProvisionScript(services.vitess)
  // Mail is likewise not a `pantry start` service: it needs a generated TOML,
  // an environment file, a DKIM key that must survive re-provisioning, and a
  // unit whose capabilities depend on which ports it was given. It also comes
  // in already resolved, because `services.mail: true` means different things
  // in production and in a preview — see `resolveMailService`.
  const mail = options.mail ? buildMailProvisionScript(options.mail) : []
  if (plan.packages.length === 0) return [...vitess, ...mail]
  return [
    ...buildPantryInstallScript(plan.packages),
    ...buildPantryServiceScript(plan.services),
    ...vitess,
    ...mail,
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
  if (!database?.name) return []
  // A managed/external DB is created out-of-band; nothing to do on the box.
  if (!isLocalDatabase(database)) return []

  const name = database.name
  const user = database.username || name
  const pass = database.password || ''

  const usePostgres = enabled(services.postgres) || database.engine === 'postgres'
  const useMariadb = enabled(services.mariadb) || database.engine === 'mariadb'
  const useMysql = enabled(services.mysql) || database.engine === 'mysql'

  if (usePostgres && !useMysql && !useMariadb) {
    // Create role + database via a psql heredoc over the local unix socket
    // (pg_hba `trust`; TCP loopback demands md5, which the superuser lacks —
    // see pgAdminCommand). Identifiers are double-quoted (Postgres treats
    // single-quoted as string literals, which is a syntax error for a role/db
    // name); string literals (the password, existence-check comparisons) are
    // single-quoted. Idempotent: a DO block guards the role, and `\gexec`
    // conditionally creates the database (which can't run inside a DO block /
    // transaction). The heredoc is quoted so the shell leaves the SQL untouched.
    const pgIdent = (v: string): string => `"${v.replace(/"/g, '""')}"`
    const pgLit = (v: string): string => `'${v.replace(/'/g, "''")}'`
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
            // Default privileges bind to the CREATING role — without FOR ROLE
            // they would only cover tables made by the superuser running this
            // script, leaving every table the app role creates (migrations)
            // invisible to the read-only user.
            `ALTER DEFAULT PRIVILEGES FOR ROLE ${pgIdent(user)} IN SCHEMA public GRANT SELECT ON TABLES TO ${pgIdent(u.username)};`,
            '\\connect postgres',
          )
        } else {
          lines.push(`GRANT ALL PRIVILEGES ON DATABASE ${pgIdent(db)} TO ${pgIdent(u.username)};`)
        }
      }
      return lines
    }
    const extraUsers = database.users || []
    const pgPort = database.port ?? 5432
    return [
      pantryEnvActivation(),
      // The engine service was just started; wait until it accepts connections
      // (first boot runs initdb, which takes a few seconds) before setup. Probe
      // over the local socket (no -h), same trust path as the setup itself.
      `for i in $(seq 1 30); do pg_isready -p ${pgPort} -q && break; sleep 2; done`,
      `${pgAdminCommand(database)} <<'TS_CLOUD_PG_EOF'`,
      ...pgEnsureRole(user, pass),
      `SELECT 'CREATE DATABASE ${pgIdent(name)} OWNER ${pgIdent(user)}' ` +
        `WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${pgLit(name)})\\gexec`,
      // Additional users (read-only / extra logins) with their own grants.
      ...extraUsers.flatMap((u) => [...pgEnsureRole(u.username, u.password), ...pgGrant(u)]),
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
  const lit = (v: string): string => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  // Create a user for both `%` (TCP) and `localhost` (socket), then grant the
  // given privilege list on each database. `ALTER USER` keeps the password in
  // sync on a re-provision (a Forge-style password reset).
  const mysqlUser = (
    u: DatabaseUserConfig | { username: string; password: string; databases?: string[]; access?: 'all' | 'readonly' },
  ): string[] => {
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
  const extraUsers = database.users || []
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
  if (!database?.name) return {}
  // SingleStore and Vitess both speak the MySQL wire protocol, but each keeps
  // its own DB_CONNECTION so the app selects the right driver: they share
  // MySQL's DML and diverge in DDL (SingleStore has distributed tables and no
  // foreign keys; Vitess additionally has no AUTO_INCREMENT and needs a
  // VSchema). Collapsing either to 'mysql' would emit DDL the engine rejects.
  // Postgres → 'pgsql'; everything else → 'mysql'.
  const isSingleStore = database.engine === 'singlestore'
  const isVitess = database.engine === 'vitess'
  const connection = database.engine === 'postgres'
    ? 'pgsql'
    : isSingleStore
      ? 'singlestore'
      : isVitess
        ? 'vitess'
        : 'mysql'
  // Vitess is reached through vtgate on 15306. Defaulting it to 3306 would
  // connect to a vttablet's underlying mysqld instead — a working connection
  // that silently bypasses sharding, which is worse than a failed one.
  const port = database.port ?? (database.engine === 'postgres' ? 5432 : isVitess ? 15306 : 3306)
  const env: Record<string, string> = {
    DB_CONNECTION: connection,
    DB_HOST: database.host || '127.0.0.1',
    DB_PORT: String(port),
    DB_DATABASE: database.name,
  }
  if (database.username) env.DB_USERNAME = database.username
  if (database.password) env.DB_PASSWORD = database.password
  // Managed SingleStore (Helios) requires TLS, and a managed Vitess endpoint
  // is likewise reached across a network boundary; default TLS on for both
  // unless explicitly disabled via `database.ssl === false`.
  if ((isSingleStore || isVitess) && database.ssl !== false) env.DB_SSL = 'true'
  return env
}
