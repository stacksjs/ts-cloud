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
import type { ComputeServicesConfig, DatabaseConfig } from '@ts-cloud/core'
import type { PantrySpec } from './package-manager'
import { buildPantryInstallScript, buildPantryServiceScript, pantryEnvActivation } from './package-manager'

type ServiceSpec = boolean | { version?: string } | undefined

function enabled(spec: ServiceSpec): boolean {
  return spec === true || (typeof spec === 'object' && spec != null)
}

/** Single-quote for safe embedding in the generated shell. */
function sq(value: string): string {
  const escaped = value.split('\'').join('\'\\\'\'')
  return `'${escaped}'`
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
    packages.push('mysql.com')
    names.push('mysql')
  }
  else if (enabled(services.mariadb)) {
    packages.push('mariadb.org')
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
    // Create role + database via psql over TCP, guarding for re-runs.
    const psql = 'psql -h 127.0.0.1 -p 5432 -U postgres'
    return [
      pantryEnvActivation(),
      `${psql} -tc "SELECT 1 FROM pg_roles WHERE rolname=${sq(user)}" | grep -q 1 `
      + `|| ${psql} -c "CREATE ROLE ${sq(user)} LOGIN PASSWORD ${sq(pass)};"`,
      `${psql} -tc "SELECT 1 FROM pg_database WHERE datname=${sq(name)}" | grep -q 1 `
      + `|| ${psql} -c "CREATE DATABASE ${sq(name)} OWNER ${sq(user)};"`,
    ]
  }

  // MySQL / MariaDB share the same client + SQL. Connect over TCP localhost and
  // pipe the SQL via a quoted heredoc; SQL-escape every value.
  const ident = (v: string): string => v.replace(/`/g, '``')
  const lit = (v: string): string => v.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')
  return [
    pantryEnvActivation(),
    'mysql -h 127.0.0.1 -P 3306 -u root <<\'TS_CLOUD_SQL_EOF\'',
    `CREATE DATABASE IF NOT EXISTS \`${ident(name)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${lit(user)}'@'%' IDENTIFIED BY '${lit(pass)}';`,
    `GRANT ALL PRIVILEGES ON \`${ident(name)}\`.* TO '${lit(user)}'@'%';`,
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
  const connection = database.engine === 'postgres' ? 'pgsql' : 'mysql'
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
  return env
}
