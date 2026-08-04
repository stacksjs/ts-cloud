/**
 * Database & user management for the cockpit: list databases/users and create a
 * database or an app user over the active driver. MySQL/MariaDB run as root via
 * the pantry UNIX socket; Postgres over local TCP — mirroring the provisioning
 * path in {@link import('../drivers/shared/db-provision')}.
 */
import type { CloudConfig, DatabaseConfig, EnvironmentType } from '@ts-cloud/core'
import { resolveAppDatabase } from '@ts-cloud/core'
import { createCloudDriver } from '../drivers'
import { pgAdminCommand } from '../drivers/shared/db-provision'

export type DbEngine = 'mysql' | 'mariadb' | 'postgres' | 'singlestore' | 'vitess'

/**
 * Engines that only ever exist as an external cluster.
 *
 * Neither has a pantry package, so the box never hosts one and there is no
 * local socket to administer it through. That matters here because every
 * operation in this module assumes an on-box engine: before these were
 * recognized, `normalizeEngine` fell through to `mysql` for both, so a
 * SingleStore or Vitess deployment reported "mysql" in the dashboard and
 * every button shelled into `/var/lib/pantry/mysql/mysqld.sock` — a socket
 * that cannot exist, failing with an error naming an engine the user never
 * configured.
 *
 * Mirrors `ALWAYS_EXTERNAL_ENGINES` in `../drivers/shared/db-provision`,
 * which keeps the same engines out of the provisioning path.
 */
const EXTERNAL_ENGINES: ReadonlySet<DbEngine> = new Set<DbEngine>(['singlestore', 'vitess'])

/** Whether this engine is an external cluster with no on-box socket. */
export function isExternalEngine(engine: DbEngine): boolean {
  return EXTERNAL_ENGINES.has(engine)
}

const SOCKETS: Record<'mysql' | 'mariadb', string> = {
  mysql: '/var/lib/pantry/mysql/mysqld.sock',
  mariadb: '/var/lib/pantry/mariadb/mariadbd.sock',
}

/** Valid SQL identifier for a database/user name (kept strict for safety). */
export function isValidDbIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)
}

function normalizeEngine(engine: string | undefined): DbEngine {
  if (engine === 'postgres' || engine === 'pgsql') return 'postgres'
  if (engine === 'mariadb') return 'mariadb'
  // Recognized explicitly rather than falling through to mysql. Both speak
  // the MySQL wire protocol, which is exactly why the old default looked
  // harmless: the dashboard would report "mysql" and then administer a
  // local engine that does not exist.
  if (engine === 'singlestore') return 'singlestore'
  if (engine === 'vitess') return 'vitess'
  return 'mysql'
}

export function resolveDbEngine(config: CloudConfig): DbEngine {
  const compute = config.infrastructure?.compute as any
  const declared = resolveAppDatabase(config)?.engine
  if (declared) return normalizeEngine(declared)
  const managed = compute?.managedServices ?? {}
  if (managed.postgres) return 'postgres'
  if (managed.mariadb) return 'mariadb'
  return 'mysql'
}

const mysqlIdent = (v: string): string => v.replace(/`/g, '``')
const mysqlLit = (v: string): string => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const pgIdent = (v: string): string => `"${v.replace(/"/g, '""')}"`
const pgLit = (v: string): string => `'${v.replace(/'/g, "''")}'`

function mysqlExec(engine: DbEngine, sql: string[]): string[] {
  const sock = engine === 'mariadb' ? SOCKETS.mariadb : SOCKETS.mysql
  return [`mysql --socket=${sock} -u root <<'TS_CLOUD_SQL_EOF'`, ...sql, 'TS_CLOUD_SQL_EOF']
}

function pgExec(sql: string[], database?: DatabaseConfig): string[] {
  return [`${pgAdminCommand(database)} -tA <<'TS_CLOUD_PG_EOF'`, ...sql, 'TS_CLOUD_PG_EOF']
}

export function buildListScript(engine: DbEngine, database?: DatabaseConfig): string[] {
  // Vitess has no on-box engine; its keyspaces come from vtgate over TCP.
  if (engine === 'vitess') return buildVitessListScript(database)
  if (engine === 'postgres') {
    return pgExec(
      [
        "SELECT 'DB=' || datname FROM pg_database WHERE datistemplate = false;",
        "SELECT 'USER=' || usename FROM pg_user;",
      ],
      database,
    )
  }
  return mysqlExec(engine, [
    "SELECT CONCAT('DB=', schema_name) FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys');",
    "SELECT DISTINCT CONCAT('USER=', User) FROM mysql.user WHERE User NOT IN ('root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'debian-sys-maint');",
  ])
}

/**
 * Run SQL against an external MySQL-wire cluster over TCP.
 *
 * Executed from the app box, which by definition can already reach the
 * cluster (the application connects to it), so this needs no extra network
 * path. The password goes through `MYSQL_PWD` rather than `-p<pass>`
 * because a command-line password is visible to any `ps` on the box; this
 * mirrors how `pgAdminCommand` handles `PGPASSWORD`.
 */
export function externalMysqlExec(sql: string[], database: DatabaseConfig | undefined, port: number): string[] {
  const host = database?.host ?? '127.0.0.1'
  const user = database?.username ?? 'root'
  const pass = database?.password ?? ''
  const tls = database?.ssl === false ? '' : ' --ssl-mode=PREFERRED'
  const shq = (v: string): string => `'${String(v).replace(/'/g, `'\\''`)}'`
  const env = pass ? `MYSQL_PWD=${shq(pass)} ` : ''
  return [
    `${env}mysql -h ${shq(host)} -P ${database?.port ?? port} -u ${shq(user)}${tls} --batch --skip-column-names <<'TS_CLOUD_SQL_EOF'`,
    ...sql,
    'TS_CLOUD_SQL_EOF',
  ]
}

/** vtgate's MySQL-protocol port. Not 3306, which would reach a tablet's mysqld. */
export const VTGATE_DEFAULT_PORT = 15306

/**
 * List a Vitess cluster's keyspaces in the same `DB=` shape the on-box
 * engines emit, so {@link parseDbList} handles it unchanged.
 *
 * A keyspace is Vitess's unit of sharding and occupies the same slot a
 * database does elsewhere, which makes it the honest thing to show in the
 * dashboard's "Databases" list. Users are deliberately not listed: vtgate
 * authentication is configured on the cluster, not through SQL, so there is
 * nothing here to enumerate or create.
 */
export function buildVitessListScript(database?: DatabaseConfig): string[] {
  return externalMysqlExec(
    [`SELECT CONCAT('DB=', keyspace_name) FROM information_schema.vitess_keyspaces;`],
    database,
    VTGATE_DEFAULT_PORT,
  )
}

/**
 * Introspect a Vitess cluster: keyspaces, shards, and tablet health.
 *
 * These are vtgate's own `SHOW` commands, served over the MySQL protocol,
 * so they need nothing beyond the connection the app already uses. Each row
 * is prefixed so one round trip can carry all three lists.
 */
export function buildVitessTopologyScript(database?: DatabaseConfig): string[] {
  return externalMysqlExec(
    [
      `SELECT CONCAT('KEYSPACE=', keyspace_name) FROM information_schema.vitess_keyspaces;`,
      `SHOW VITESS_SHARDS;`,
      `SHOW VITESS_TABLETS;`,
    ],
    database,
    VTGATE_DEFAULT_PORT,
  )
}

export interface VitessShard {
  keyspace: string
  shard: string
}

export interface VitessTablet {
  cell: string
  keyspace: string
  shard: string
  type: string
  state: string
  alias: string
  hostname: string
}

export interface VitessTopology {
  keyspaces: string[]
  shards: VitessShard[]
  tablets: VitessTablet[]
}

/**
 * Parse the combined topology output.
 *
 * `SHOW VITESS_SHARDS` emits `keyspace/shard` rows and `SHOW VITESS_TABLETS`
 * emits tab-separated columns, so the two are told apart by shape rather
 * than by position — the command output order is not something to depend on
 * when a cluster can legitimately return zero rows for either.
 */
export function parseVitessTopology(output: string): VitessTopology {
  const keyspaces: string[] = []
  const shards: VitessShard[] = []
  const tablets: VitessTablet[] = []

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('KEYSPACE=')) {
      keyspaces.push(line.slice(9))
      continue
    }

    const cols = line.split('\t').map(c => c.trim()).filter(Boolean)
    // Tablet rows carry many columns; shard rows are a single keyspace/shard.
    if (cols.length >= 6) {
      const [cell, keyspace, shard, type, state, alias, hostname] = cols
      tablets.push({
        cell: cell ?? '',
        keyspace: keyspace ?? '',
        shard: shard ?? '',
        type: type ?? '',
        state: state ?? '',
        alias: alias ?? '',
        hostname: hostname ?? '',
      })
      continue
    }

    if (cols.length === 1 && cols[0]?.includes('/')) {
      const [keyspace, shard] = (cols[0] as string).split('/')
      if (keyspace && shard) shards.push({ keyspace, shard })
    }
  }

  return {
    keyspaces: [...new Set(keyspaces)].filter(Boolean).sort(),
    shards,
    tablets,
  }
}

export function buildCreateDatabaseScript(engine: DbEngine, name: string, database?: DatabaseConfig): string[] {
  if (engine === 'postgres') {
    return pgExec(
      [
        `SELECT 'CREATE DATABASE ${pgIdent(name)}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${pgLit(name)})\\gexec`,
      ],
      database,
    )
  }
  return mysqlExec(engine, [
    `CREATE DATABASE IF NOT EXISTS \`${mysqlIdent(name)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
  ])
}

export interface CreateUserInput {
  username: string
  password: string
  database?: string
  access?: 'all' | 'readonly'
}

export function buildCreateUserScript(engine: DbEngine, input: CreateUserInput, database?: DatabaseConfig): string[] {
  const { username, password, database: grantDb, access } = input
  if (engine === 'postgres') {
    const lines = [
      'DO $$ BEGIN',
      `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${pgLit(username)}) THEN CREATE ROLE ${pgIdent(username)} LOGIN PASSWORD ${pgLit(password)};`,
      `  ELSE ALTER ROLE ${pgIdent(username)} LOGIN PASSWORD ${pgLit(password)}; END IF;`,
      'END $$;',
    ]
    if (grantDb) {
      lines.push(
        access === 'readonly'
          ? `GRANT CONNECT ON DATABASE ${pgIdent(grantDb)} TO ${pgIdent(username)};`
          : `GRANT ALL PRIVILEGES ON DATABASE ${pgIdent(grantDb)} TO ${pgIdent(username)};`,
      )
    }
    return pgExec(lines, database)
  }

  const priv = access === 'readonly' ? 'SELECT' : 'ALL PRIVILEGES'
  const lines = [
    `CREATE USER IF NOT EXISTS '${mysqlLit(username)}'@'%' IDENTIFIED BY '${mysqlLit(password)}';`,
    `CREATE USER IF NOT EXISTS '${mysqlLit(username)}'@'localhost' IDENTIFIED BY '${mysqlLit(password)}';`,
    `ALTER USER '${mysqlLit(username)}'@'%' IDENTIFIED BY '${mysqlLit(password)}';`,
    `ALTER USER '${mysqlLit(username)}'@'localhost' IDENTIFIED BY '${mysqlLit(password)}';`,
  ]
  if (grantDb) {
    lines.push(
      `GRANT ${priv} ON \`${mysqlIdent(grantDb)}\`.* TO '${mysqlLit(username)}'@'%';`,
      `GRANT ${priv} ON \`${mysqlIdent(grantDb)}\`.* TO '${mysqlLit(username)}'@'localhost';`,
    )
  }
  lines.push('FLUSH PRIVILEGES;')
  return mysqlExec(engine, lines)
}

export function parseDbList(output: string): { databases: string[]; users: string[] } {
  const databases: string[] = []
  const users: string[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('DB=')) databases.push(line.slice(3))
    else if (line.startsWith('USER=')) users.push(line.slice(5))
  }
  return {
    databases: [...new Set(databases)].filter(Boolean).sort(),
    users: [...new Set(users)].filter(Boolean).sort(),
  }
}

export interface DbRunResult {
  ok: boolean
  stdout?: string
  stderr?: string
  error?: string
}

export async function runDb(
  config: CloudConfig,
  environment: EnvironmentType,
  commands: string[],
  comment: string,
): Promise<DbRunResult> {
  let driver: ReturnType<typeof createCloudDriver>
  try {
    driver = createCloudDriver({ config })
  } catch (error: any) {
    return { ok: false, error: `Could not initialize the cloud driver: ${error?.message ?? error}` }
  }
  const slug = config.project.slug
  const targets = await driver.findComputeTargets({ slug, environment, role: 'app' })
  if (!targets.length) return { ok: false, error: 'No app server target was found for this environment.' }

  const result = await driver.runRemoteDeploy({
    targets: [targets[0]],
    commands: ['set -uo pipefail', ...commands],
    comment,
    tags: { Project: slug, Environment: environment, Role: 'app' },
  })
  return {
    ok: result.success,
    stdout: result.perInstance?.[0]?.output ?? '',
    stderr: result.perInstance?.[0]?.error ?? result.error ?? '',
  }
}

/**
 * The refusal returned for an operation that has no meaning on an external
 * cluster.
 *
 * Named rather than inlined so every entry point refuses identically, and
 * phrased to say where the operation DOES belong: the previous behavior was
 * a raw "can't connect to local MySQL server through socket
 * /var/lib/pantry/mysql/mysqld.sock" naming an engine the user never chose,
 * which sends people looking for a broken MySQL install that was never
 * supposed to be there.
 */
function externalEngineRefusal(engine: DbEngine, action: string): DbRunResult {
  const where = engine === 'vitess'
    ? 'Create a keyspace with `vtctldclient CreateKeyspace`, and manage vtgate credentials on the cluster.'
    : 'Use the provider console or the cluster\'s own admin connection.'
  return {
    ok: false,
    error: `${action} is not available for ${engine}: it is an external cluster, so this box has no engine to administer. ${where}`,
  }
}

export async function listDatabases(
  config: CloudConfig,
  environment: EnvironmentType,
): Promise<DbRunResult & { engine: DbEngine; databases: string[]; users: string[] }> {
  const engine = resolveDbEngine(config)
  // Vitess is external but still introspectable: vtgate serves its keyspace
  // list over the same connection the app uses. Other external engines have
  // no such generic path, so they refuse rather than shell into a socket
  // that cannot exist.
  if (isExternalEngine(engine) && engine !== 'vitess')
    return { ...externalEngineRefusal(engine, 'Listing databases'), engine, databases: [], users: [] }

  const r = await runDb(config, environment, buildListScript(engine, resolveAppDatabase(config)), 'ts-cloud db:list')
  const parsed = r.ok && r.stdout ? parseDbList(r.stdout) : { databases: [], users: [] }
  return { ...r, engine, ...parsed }
}

export async function createDatabase(
  config: CloudConfig,
  environment: EnvironmentType,
  name: string,
): Promise<DbRunResult> {
  const engine = resolveDbEngine(config)
  if (isExternalEngine(engine)) return externalEngineRefusal(engine, 'Creating a database')
  return runDb(
    config,
    environment,
    buildCreateDatabaseScript(engine, name, resolveAppDatabase(config)),
    `ts-cloud db:create ${name}`,
  )
}

export async function createDatabaseUser(
  config: CloudConfig,
  environment: EnvironmentType,
  input: CreateUserInput,
): Promise<DbRunResult> {
  const engine = resolveDbEngine(config)
  if (isExternalEngine(engine)) return externalEngineRefusal(engine, 'Creating a database user')
  return runDb(
    config,
    environment,
    buildCreateUserScript(engine, input, resolveAppDatabase(config)),
    `ts-cloud db:user ${input.username}`,
  )
}

/** Where per-database dumps are written on the box. */
export const DB_BACKUP_DIR = '/var/backups/ts-cloud/databases'

/**
 * Script that dumps a single database to a timestamped, gzipped file. The name
 * is a validated SQL identifier (no shell metacharacters), so it is safe to
 * embed directly. The timestamp is computed on the box. Postgres connects over
 * the local unix socket for a co-located engine, or TCP with credentials for
 * an external host (see {@link pgAdminCommand}).
 */
export function buildBackupScript(
  engine: DbEngine,
  name: string,
  destDir: string = DB_BACKUP_DIR,
  database?: DatabaseConfig,
): string[] {
  const file = `${destDir}/${name}-$(date +%Y%m%d-%H%M%S).sql.gz`
  const mkdir = `mkdir -p ${destDir}`
  if (engine === 'postgres')
    return [
      mkdir,
      `${pgAdminCommand(database, 'pg_dump')} ${name} | gzip > "${file}"`,
      `echo "BACKUP=${file}"`,
      `ls -l "${file}"`,
    ]
  const sock = engine === 'mariadb' ? SOCKETS.mariadb : SOCKETS.mysql
  return [
    mkdir,
    `mysqldump --socket=${sock} -u root ${name} | gzip > "${file}"`,
    `echo "BACKUP=${file}"`,
    `ls -l "${file}"`,
  ]
}

/** Script that lists the most recent dumps (newest first). */
export function buildListBackupsScript(destDir: string = DB_BACKUP_DIR): string[] {
  return [`ls -1t ${destDir}/*.sql.gz 2>/dev/null | head -50 | sed 's|^|BACKUP=|' || true`]
}

export function parseBackups(output: string): Array<{ file: string; database: string }> {
  const out: Array<{ file: string; database: string }> = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('BACKUP=')) continue
    const file = line.slice(7)
    const base = file.split('/').pop() ?? file
    const database = base.replace(/-\d{8}-\d{6}\.sql\.gz$/, '')
    if (file) out.push({ file, database })
  }
  return out
}

/** Dump a single database to a gzipped file on the box. */
export async function backupDatabase(
  config: CloudConfig,
  environment: EnvironmentType,
  name: string,
): Promise<DbRunResult & { database: string }> {
  if (!isValidDbIdentifier(name))
    return { ok: false, error: 'Database name must be a valid identifier.', database: name }
  const engine = resolveDbEngine(config)
  // A sharded keyspace has no single mysqldump-able server, and a managed
  // cluster's backups belong to the provider. Offering a dump here would
  // produce either an error or, worse, a partial file that looks complete.
  if (isExternalEngine(engine))
    return { ...externalEngineRefusal(engine, 'Backing up'), database: name }
  const r = await runDb(
    config,
    environment,
    buildBackupScript(engine, name, DB_BACKUP_DIR, resolveAppDatabase(config)),
    `ts-cloud db:backup ${name}`,
  )
  return { ...r, database: name }
}

/** List the per-database dumps present on the box. */
export async function listDatabaseBackups(
  config: CloudConfig,
  environment: EnvironmentType,
): Promise<DbRunResult & { backups: Array<{ file: string; database: string }> }> {
  const r = await runDb(config, environment, buildListBackupsScript(), 'ts-cloud db:backups')
  const backups = r.ok && r.stdout ? parseBackups(r.stdout) : []
  return { ...r, backups }
}

/**
 * Read a Vitess cluster's topology for the dashboard.
 *
 * Read-only by design. Creating keyspaces, resharding, and moving tables are
 * vtctld operations with real blast radius, and exposing them behind a
 * dashboard button would invite someone to reshard production by accident.
 * The panel shows what exists and where it is unhealthy; changing the
 * topology stays with `vtctldclient`.
 */
export async function describeVitess(
  config: CloudConfig,
  environment: EnvironmentType,
): Promise<DbRunResult & VitessTopology & { engine: DbEngine }> {
  const engine = resolveDbEngine(config)
  const empty: VitessTopology = { keyspaces: [], shards: [], tablets: [] }

  if (engine !== 'vitess')
    return { ok: false, error: 'The configured database engine is not Vitess.', engine, ...empty }

  const r = await runDb(
    config,
    environment,
    buildVitessTopologyScript(resolveAppDatabase(config)),
    'ts-cloud vitess:topology',
  )
  const parsed = r.ok && r.stdout ? parseVitessTopology(r.stdout) : empty
  return { ...r, engine, ...parsed }
}

/**
 * Tablets that are not serving.
 *
 * Surfaced separately because it is the one thing in the topology worth
 * acting on: a keyspace whose primary is missing is a write outage, and a
 * flat list of a hundred healthy tablets buries that.
 */
export function unhealthyTablets(tablets: VitessTablet[]): VitessTablet[] {
  return tablets.filter(t => t.state.toUpperCase() !== 'SERVING')
}

/**
 * Shards with no PRIMARY tablet.
 *
 * Vitess routes writes to a shard's primary; without one the shard accepts
 * reads and silently fails writes, which is the failure most worth naming
 * explicitly in a dashboard.
 */
export function shardsMissingPrimary(topology: VitessTopology): VitessShard[] {
  const withPrimary = new Set(
    topology.tablets
      .filter(t => t.type.toUpperCase() === 'PRIMARY' && t.state.toUpperCase() === 'SERVING')
      .map(t => `${t.keyspace}/${t.shard}`),
  )
  return topology.shards.filter(s => !withPrimary.has(`${s.keyspace}/${s.shard}`))
}
