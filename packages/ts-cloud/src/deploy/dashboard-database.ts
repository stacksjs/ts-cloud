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

export type DbEngine = 'mysql' | 'mariadb' | 'postgres'

const SOCKETS: Record<'mysql' | 'mariadb', string> = {
  mysql: '/var/lib/pantry/mysql/mysqld.sock',
  mariadb: '/var/lib/pantry/mariadb/mariadbd.sock',
}

/** Valid SQL identifier for a database/user name (kept strict for safety). */
export function isValidDbIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)
}

function normalizeEngine(engine: string | undefined): DbEngine {
  if (engine === 'postgres' || engine === 'pgsql')
    return 'postgres'
  if (engine === 'mariadb')
    return 'mariadb'
  return 'mysql'
}

export function resolveDbEngine(config: CloudConfig): DbEngine {
  const compute = config.infrastructure?.compute as any
  const declared = resolveAppDatabase(config)?.engine
  if (declared)
    return normalizeEngine(declared)
  const managed = compute?.managedServices ?? {}
  if (managed.postgres)
    return 'postgres'
  if (managed.mariadb)
    return 'mariadb'
  return 'mysql'
}

const mysqlIdent = (v: string): string => v.replace(/`/g, '``')
const mysqlLit = (v: string): string => v.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')
const pgIdent = (v: string): string => `"${v.replace(/"/g, '""')}"`
const pgLit = (v: string): string => `'${v.replace(/'/g, '\'\'')}'`

function mysqlExec(engine: DbEngine, sql: string[]): string[] {
  const sock = engine === 'mariadb' ? SOCKETS.mariadb : SOCKETS.mysql
  return [`mysql --socket=${sock} -u root <<'TS_CLOUD_SQL_EOF'`, ...sql, 'TS_CLOUD_SQL_EOF']
}

function pgExec(sql: string[], database?: DatabaseConfig): string[] {
  return [`${pgAdminCommand(database)} -tA <<'TS_CLOUD_PG_EOF'`, ...sql, 'TS_CLOUD_PG_EOF']
}

export function buildListScript(engine: DbEngine, database?: DatabaseConfig): string[] {
  if (engine === 'postgres') {
    return pgExec([
      'SELECT \'DB=\' || datname FROM pg_database WHERE datistemplate = false;',
      'SELECT \'USER=\' || usename FROM pg_user;',
    ], database)
  }
  return mysqlExec(engine, [
    'SELECT CONCAT(\'DB=\', schema_name) FROM information_schema.schemata WHERE schema_name NOT IN (\'information_schema\', \'mysql\', \'performance_schema\', \'sys\');',
    'SELECT DISTINCT CONCAT(\'USER=\', User) FROM mysql.user WHERE User NOT IN (\'root\', \'mysql.sys\', \'mysql.session\', \'mysql.infoschema\', \'debian-sys-maint\');',
  ])
}

export function buildCreateDatabaseScript(engine: DbEngine, name: string, database?: DatabaseConfig): string[] {
  if (engine === 'postgres') {
    return pgExec([
      `SELECT 'CREATE DATABASE ${pgIdent(name)}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${pgLit(name)})\\gexec`,
    ], database)
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
      lines.push(access === 'readonly'
        ? `GRANT CONNECT ON DATABASE ${pgIdent(grantDb)} TO ${pgIdent(username)};`
        : `GRANT ALL PRIVILEGES ON DATABASE ${pgIdent(grantDb)} TO ${pgIdent(username)};`)
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

export function parseDbList(output: string): { databases: string[], users: string[] } {
  const databases: string[] = []
  const users: string[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('DB='))
      databases.push(line.slice(3))
    else if (line.startsWith('USER='))
      users.push(line.slice(5))
  }
  return {
    databases: [...new Set(databases)].filter(Boolean).sort(),
    users: [...new Set(users)].filter(Boolean).sort(),
  }
}

interface DbRunResult {
  ok: boolean
  stdout?: string
  stderr?: string
  error?: string
}

async function runDb(config: CloudConfig, environment: EnvironmentType, commands: string[], comment: string): Promise<DbRunResult> {
  let driver: ReturnType<typeof createCloudDriver>
  try {
    driver = createCloudDriver({ config })
  }
  catch (error: any) {
    return { ok: false, error: `Could not initialize the cloud driver: ${error?.message ?? error}` }
  }
  const slug = config.project.slug
  const targets = await driver.findComputeTargets({ slug, environment, role: 'app' })
  if (!targets.length)
    return { ok: false, error: 'No app server target was found for this environment.' }

  const result = await driver.runRemoteDeploy({
    targets: [targets[0]],
    commands: ['set -uo pipefail', ...commands],
    comment,
    tags: { Project: slug, Environment: environment, Role: 'app' },
  })
  return { ok: result.success, stdout: result.perInstance?.[0]?.output ?? '', stderr: result.perInstance?.[0]?.error ?? result.error ?? '' }
}

export async function listDatabases(config: CloudConfig, environment: EnvironmentType): Promise<DbRunResult & { engine: DbEngine, databases: string[], users: string[] }> {
  const engine = resolveDbEngine(config)
  const r = await runDb(config, environment, buildListScript(engine, resolveAppDatabase(config)), 'ts-cloud db:list')
  const parsed = r.ok && r.stdout ? parseDbList(r.stdout) : { databases: [], users: [] }
  return { ...r, engine, ...parsed }
}

export async function createDatabase(config: CloudConfig, environment: EnvironmentType, name: string): Promise<DbRunResult> {
  const engine = resolveDbEngine(config)
  return runDb(config, environment, buildCreateDatabaseScript(engine, name, resolveAppDatabase(config)), `ts-cloud db:create ${name}`)
}

export async function createDatabaseUser(config: CloudConfig, environment: EnvironmentType, input: CreateUserInput): Promise<DbRunResult> {
  const engine = resolveDbEngine(config)
  return runDb(config, environment, buildCreateUserScript(engine, input, resolveAppDatabase(config)), `ts-cloud db:user ${input.username}`)
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
export function buildBackupScript(engine: DbEngine, name: string, destDir: string = DB_BACKUP_DIR, database?: DatabaseConfig): string[] {
  const file = `${destDir}/${name}-$(date +%Y%m%d-%H%M%S).sql.gz`
  const mkdir = `mkdir -p ${destDir}`
  if (engine === 'postgres')
    return [mkdir, `${pgAdminCommand(database, 'pg_dump')} ${name} | gzip > "${file}"`, `echo "BACKUP=${file}"`, `ls -l "${file}"`]
  const sock = engine === 'mariadb' ? SOCKETS.mariadb : SOCKETS.mysql
  return [mkdir, `mysqldump --socket=${sock} -u root ${name} | gzip > "${file}"`, `echo "BACKUP=${file}"`, `ls -l "${file}"`]
}

/** Script that lists the most recent dumps (newest first). */
export function buildListBackupsScript(destDir: string = DB_BACKUP_DIR): string[] {
  return [`ls -1t ${destDir}/*.sql.gz 2>/dev/null | head -50 | sed 's|^|BACKUP=|' || true`]
}

export function parseBackups(output: string): Array<{ file: string, database: string }> {
  const out: Array<{ file: string, database: string }> = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('BACKUP='))
      continue
    const file = line.slice(7)
    const base = file.split('/').pop() ?? file
    const database = base.replace(/-\d{8}-\d{6}\.sql\.gz$/, '')
    if (file)
      out.push({ file, database })
  }
  return out
}

/** Dump a single database to a gzipped file on the box. */
export async function backupDatabase(config: CloudConfig, environment: EnvironmentType, name: string): Promise<DbRunResult & { database: string }> {
  if (!isValidDbIdentifier(name))
    return { ok: false, error: 'Database name must be a valid identifier.', database: name }
  const engine = resolveDbEngine(config)
  const r = await runDb(config, environment, buildBackupScript(engine, name, DB_BACKUP_DIR, resolveAppDatabase(config)), `ts-cloud db:backup ${name}`)
  return { ...r, database: name }
}

/** List the per-database dumps present on the box. */
export async function listDatabaseBackups(config: CloudConfig, environment: EnvironmentType): Promise<DbRunResult & { backups: Array<{ file: string, database: string }> }> {
  const r = await runDb(config, environment, buildListBackupsScript(), 'ts-cloud db:backups')
  const backups = r.ok && r.stdout ? parseBackups(r.stdout) : []
  return { ...r, backups }
}
