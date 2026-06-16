/**
 * Provision on-box managed services (Forge single-server model): the database
 * engine, cache, and search, plus create the application database + user.
 *
 * These run at bootstrap (cloud-init), not on deploy, since installing an
 * engine is a machine-level, one-time operation. The app's database
 * credentials are referenced from the site's `.env` (`DB_*`). When the app
 * points at a managed/external database instead, install nothing and just wire
 * `.env` — see {@link buildManagedDbEnv}.
 */
import type { ComputeServicesConfig, DatabaseConfig } from '@ts-cloud/core'

type ServiceSpec = boolean | { version?: string } | undefined

function enabled(spec: ServiceSpec): boolean {
  return spec === true || (typeof spec === 'object' && spec != null)
}

/** Single-quote for safe embedding in the generated shell. */
function sq(value: string): string {
  const escaped = value.split('\'').join('\'\\\'\'')
  return `'${escaped}'`
}

/**
 * Build apt install + enable commands for each requested on-box service.
 * Idempotent: apt install is a no-op when already present.
 */
export function buildServicesProvisionScript(services: ComputeServicesConfig = {}): string[] {
  const out: string[] = ['export DEBIAN_FRONTEND=noninteractive']
  let touchedApt = false
  const ensureUpdate = (): void => {
    if (!touchedApt) {
      out.push('apt-get update -y')
      touchedApt = true
    }
  }

  if (enabled(services.mysql)) {
    ensureUpdate()
    out.push('apt-get install -y mysql-server', 'systemctl enable mysql', 'systemctl start mysql')
  }
  if (enabled(services.mariadb)) {
    ensureUpdate()
    out.push('apt-get install -y mariadb-server', 'systemctl enable mariadb', 'systemctl start mariadb')
  }
  if (enabled(services.postgres)) {
    ensureUpdate()
    out.push('apt-get install -y postgresql postgresql-contrib', 'systemctl enable postgresql', 'systemctl start postgresql')
  }
  if (enabled(services.redis)) {
    ensureUpdate()
    out.push('apt-get install -y redis-server', 'systemctl enable redis-server', 'systemctl start redis-server')
  }
  if (enabled(services.memcached)) {
    ensureUpdate()
    out.push('apt-get install -y memcached', 'systemctl enable memcached', 'systemctl start memcached')
  }
  if (enabled(services.meilisearch)) {
    // Meilisearch ships a single static binary + an official systemd setup.
    out.push(
      'curl -fsSL https://install.meilisearch.com | sh',
      'mv ./meilisearch /usr/local/bin/meilisearch',
      'getent passwd meilisearch >/dev/null || useradd --system --home-dir /var/lib/meilisearch --create-home --shell /usr/sbin/nologin meilisearch',
      'mkdir -p /var/lib/meilisearch',
      'chown -R meilisearch:meilisearch /var/lib/meilisearch',
      'cat > /etc/systemd/system/meilisearch.service <<\'TS_CLOUD_MEILI_EOF\'',
      '[Unit]',
      'Description=Meilisearch',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=meilisearch',
      'Group=meilisearch',
      'ExecStart=/usr/local/bin/meilisearch --db-path /var/lib/meilisearch/data --env production',
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'TS_CLOUD_MEILI_EOF',
      'systemctl daemon-reload',
      'systemctl enable meilisearch',
      'systemctl start meilisearch',
    )
  }

  return out
}

/**
 * Build the commands that create the application database + user on the on-box
 * engine. Idempotent (uses IF NOT EXISTS / existence guards). Returns `[]` when
 * the database points at a managed host or lacks a name.
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
    // Create role + database as the postgres superuser, guarding for re-runs.
    return [
      `sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname=${sq(user)}" | grep -q 1 `
      + `|| sudo -u postgres psql -c "CREATE ROLE ${sq(user)} LOGIN PASSWORD ${sq(pass)};"`,
      `sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname=${sq(name)}" | grep -q 1 `
      + `|| sudo -u postgres psql -c "CREATE DATABASE ${sq(name)} OWNER ${sq(user)};"`,
    ]
  }

  // MySQL / MariaDB share the same client + SQL.
  const sql = [
    `CREATE DATABASE IF NOT EXISTS \\\`${name}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${pass}';`,
    `GRANT ALL PRIVILEGES ON \\\`${name}\\\`.* TO '${user}'@'%';`,
    'FLUSH PRIVILEGES;',
  ].join(' ')
  return [`mysql -e "${sql}"`]
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
