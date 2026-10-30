/**
 * Scheduled database backups powered by `ts-backups`, synced to object storage.
 *
 * On the box we generate a `ts-backups` config from the ts-cloud database
 * config, install the tool (Bun + `ts-backups`), and add a cron job that runs
 * the backup and syncs the output directory to an S3-compatible bucket
 * (AWS S3 or Hetzner object storage). `ts-backups` handles dump + local
 * retention; ts-cloud handles the off-box copy.
 */
import type { ComputeBackupConfig, DatabaseConfig } from '@ts-cloud/core'
import { pgAdminCommand } from './db-provision'

/** Where backups are written on the box before being synced off. */
export const BACKUP_OUTPUT_DIR = '/var/backups/ts-cloud'
/** Generated ts-backups config location. */
export const BACKUP_CONFIG_PATH = '/etc/ts-cloud/backups.config.ts'
/** Cron file + runner paths. */
export const BACKUP_CRON_PATH = '/etc/cron.d/ts-cloud-backups'
export const BACKUP_RUNNER_PATH = '/usr/local/bin/ts-cloud-backup.sh'

/** Map a ts-cloud DB engine to a ts-backups database entry. Returns null if unmappable. */
function backupEntryFor(database: DatabaseConfig): string | null {
  if (!database.name) return null
  if (!['postgres', 'mysql', 'mariadb'].includes(database.engine || '')) throw new Error('Unsupported scheduled SQL backup engine')
  return JSON.stringify({
    type: database.engine === 'postgres' ? 'postgresql' : 'mysql', name: database.name,
    connection: { hostname: database.host || '127.0.0.1', port: database.port ?? (database.engine === 'postgres' ? 5432 : 3306), database: database.name, username: database.username || database.name, password: database.password || '', ssl: false },
    includeSchema: true, includeData: true,
  })
}

/** Generate the `ts-backups` config file content from the database config. */
export function buildBackupsConfigTs(database: DatabaseConfig | undefined, backups: ComputeBackupConfig): string {
  const entry = database ? backupEntryFor(database) : null
  const destination = backups.bucket ? {
    type: 's3', bucket: backups.bucket, prefix: backups.prefix || 'db-backups',
    ...(backups.endpoint ? { endpoint: backups.endpoint } : {}),
    ...(backups.region ? { region: backups.region } : {}),
    keepDays: backups.retentionDays ?? 30, optional: false,
    ...(backups.encryptionKey ? { encryption: { keyEnv: 'TS_CLOUD_BACKUP_ENCRYPTION_KEY' } } : {}),
  } : undefined
  const config = {
    verbose: true, outputPath: BACKUP_OUTPUT_DIR,
    retention: { count: backups.retentionCount ?? 5, maxAge: backups.retentionDays ?? 30 },
    databases: [], files: backups.files || [], destinations: destination ? [destination] : [],
  }
  return [
    "import type { BackupConfig } from 'ts-backups'",
    `const config: BackupConfig = ${JSON.stringify(config, null, 2)}`,
    `config.databases = [\n${entry || ''}\n]`,
    ...(backups.credentials ? ['config.destinations![0]!.credentials = { accessKeyId: process.env.TS_CLOUD_BACKUP_ACCESS_KEY!, secretAccessKey: process.env.TS_CLOUD_BACKUP_SECRET_KEY! }'] : []),
    'export default config', '',
  ].join('\n')
}

export interface BackupProvisionOptions {
  database?: DatabaseConfig
  backups: ComputeBackupConfig
}

/**
 * Build the commands that install + schedule backups. Returns `[]` when
 * disabled. Assumes the box can install Bun (to run `ts-backups`).
 */
export function buildBackupProvisionScript(options: BackupProvisionOptions): string[] {
  const { database, backups } = options
  if (!backups.enabled) return []
  if (backups.credentials && (!backups.bucket || !backups.credentials.accessKeyId || !backups.credentials.secretAccessKey))
    throw new Error('Scheduled backups require complete destination credentials and a bucket')
  if (backups.encryptionKey && (backups.encryptionKey.length < 32 || !backups.bucket))
    throw new Error('Encrypted offsite backups require a bucket and a separate recovery key of at least 32 characters')
  const version = backups.version || '0.1.6'
  // The official archive is a complete, published distribution. Fresh hosts
  // need no npm authentication or access to the maintainer's release account.
  const archive = backups.archive || (!backups.version ? {
    url: 'https://github.com/stacksjs/ts-backups/releases/download/v0.1.6/ts-backups-0.1.6.tgz',
    sha256: '20b8295d8c092f9e0ed17239b0233e781d71466077b555f163d67dfcfa2a9744',
  } : undefined)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Pin a released ts-backups version')
  const schedule = backups.schedule || '0 2 * * *'
  if (!/^[0-9*,/ -]+$/.test(schedule) || schedule.trim().split(/\s+/).length !== 5) throw new Error('Invalid backup schedule')
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  if (archive) {
    const url = new URL(archive.url)
    if (url.protocol !== 'https:' || url.username || url.password || !/^[a-f0-9]{64}$/i.test(archive.sha256))
      throw new Error('Backup archives require an HTTPS URL and SHA-256 checksum')
  }
  const environment = Object.entries({
    ...(backups.credentials ? { TS_CLOUD_BACKUP_ACCESS_KEY: backups.credentials.accessKeyId, TS_CLOUD_BACKUP_SECRET_KEY: backups.credentials.secretAccessKey } : {}),
    ...(backups.encryptionKey ? { TS_CLOUD_BACKUP_ENCRYPTION_KEY: backups.encryptionKey } : {}),
  }).map(([name, value]) => `${name}=${quote(value)}`).join('\n')
  const install = '/opt/ts-cloud/backups'
  return [
    '(',
    'umask 077',
    `mkdir -p /etc/ts-cloud ${BACKUP_OUTPUT_DIR} ${install}`,
    `chmod 700 ${BACKUP_OUTPUT_DIR} ${install}`,
    'export PATH="/opt/ts-cloud/bun/bin:/opt/pantry/pantry/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    `test -f ${install}/package.json || printf '%s' '{"private":true}' > ${install}/package.json`,
    ...(archive ? [
      `curl --fail --silent --show-error --location ${quote(archive.url)} --output ${install}/release.tgz`,
      `printf '%s\\n' ${quote(`${archive.sha256.toLowerCase()}  ${install}/release.tgz`)} | sha256sum --check --status`,
      `bun add --cwd ${install} --no-save ${install}/release.tgz`,
      `test "$(cd ${install} && bun -e 'console.log((await Bun.file("node_modules/ts-backups/package.json").json()).version)')" = ${quote(version)}`,
    ] : [`bun add --cwd ${install} --no-save ts-backups@${version}`]),
    `printf '%s' ${quote(buildBackupsConfigTs(database, backups))} > ${BACKUP_CONFIG_PATH}`,
    `printf '%s\\n' ${quote(environment)} > /etc/ts-cloud/backups.env`,
    `chmod 600 ${BACKUP_CONFIG_PATH} /etc/ts-cloud/backups.env`,
    `cat > ${BACKUP_RUNNER_PATH} <<'TS_CLOUD_BACKUP_RUN_EOF'`,
    '#!/bin/bash', 'set -euo pipefail', 'umask 077',
    'exec 9>/run/lock/ts-cloud-backups.lock', 'flock -n 9 || exit 0',
    'export PATH="/opt/ts-cloud/bun/bin:/opt/pantry/pantry/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    'eval "$(cd /opt/pantry && pantry env)"',
    'set -a', '. /etc/ts-cloud/backups.env', 'set +a',
    'notify() { [ -x /usr/local/bin/ts-cloud-notify ] && /usr/local/bin/ts-cloud-notify "$1" || true; }',
    'cd /etc/ts-cloud',
    `if ! ${install}/node_modules/.bin/ts-backups start --config ${BACKUP_CONFIG_PATH}; then notify "ts-cloud backup failed"; exit 1; fi`,
    'date -u +%FT%TZ > /var/backups/ts-cloud/last-success',
    'TS_CLOUD_BACKUP_RUN_EOF',
    `chmod 700 ${BACKUP_RUNNER_PATH}`,
    `printf '%s\\n' ${quote(`${schedule} root ${BACKUP_RUNNER_PATH} >> /var/log/ts-cloud-backup.log 2>&1`)} > ${BACKUP_CRON_PATH}`,
    `chmod 644 ${BACKUP_CRON_PATH}`,
    ')',
  ]
}

/** Unix socket for the on-box engine (root connects passwordless via socket). */
function engineSocket(engine?: string): string {
  return engine === 'mariadb' ? '/var/lib/pantry/mariadb/mariadbd.sock' : '/var/lib/pantry/mysql/mysqld.sock'
}

export interface BackupRestoreOptions {
  /** Specific dump file on the box (absolute path). Default: newest matching dump. */
  from?: string
}

/**
 * Build the commands that restore a database from a ts-backups dump on the box.
 * With no `from`, the newest dump under {@link BACKUP_OUTPUT_DIR} matching the
 * database name is used. Handles plain `.sql` and gzipped `.sql.gz`. MySQL/
 * MariaDB restore over the root unix socket; Postgres over the local unix
 * socket for a co-located engine, or TCP with credentials for an external
 * host (see {@link pgAdminCommand}).
 * Returns `[]` when the database has no name.
 */
export function buildBackupRestoreScript(
  database: DatabaseConfig | undefined,
  options: BackupRestoreOptions = {},
): string[] {
  if (!database?.name) return []
  const name = database.name
  const isPg = database.engine === 'postgres'
  const locate = options.from
    ? `TS_CLOUD_DUMP="${options.from}"`
    : `TS_CLOUD_DUMP="$(find ${BACKUP_OUTPUT_DIR} -type f -name '*${name}*.sql' -o -type f -name '*${name}*.sql.gz' 2>/dev/null | xargs -r ls -1t 2>/dev/null | head -1)"`
  const client = isPg
    ? `${pgAdminCommand(database)} -d "${name}"`
    : `mysql --socket=${engineSocket(database.engine)} -u root "${name}"`
  return [
    'set -uo pipefail',
    'eval "$(cd /opt/pantry && pantry env 2>/dev/null)" || true',
    locate,
    '[ -n "$TS_CLOUD_DUMP" ] && [ -f "$TS_CLOUD_DUMP" ] || { echo "no backup dump found to restore" >&2; exit 1; }',
    'echo "[ts-cloud] restoring ' + name + ' from $TS_CLOUD_DUMP"',
    // Decompress on the fly when gzipped, else stream the plain SQL.
    `case "$TS_CLOUD_DUMP" in *.gz) gunzip -c "$TS_CLOUD_DUMP" ;; *) cat "$TS_CLOUD_DUMP" ;; esac | ${client}`,
    'echo "restore complete"',
  ]
}
