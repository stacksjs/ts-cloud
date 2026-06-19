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

/** Where backups are written on the box before being synced off. */
export const BACKUP_OUTPUT_DIR = '/var/backups/ts-cloud'
/** Generated ts-backups config location. */
export const BACKUP_CONFIG_PATH = '/etc/ts-cloud/backups.config.ts'
/** Cron file + runner paths. */
export const BACKUP_CRON_PATH = '/etc/cron.d/ts-cloud-backups'
export const BACKUP_RUNNER_PATH = '/usr/local/bin/ts-cloud-backup.sh'

/** Map a ts-cloud DB engine to a ts-backups database entry. Returns null if unmappable. */
function backupEntryFor(database: DatabaseConfig): string | null {
  if (!database.name)
    return null
  const host = database.host || '127.0.0.1'
  const isPostgres = database.engine === 'postgres'
  const type = isPostgres ? 'postgresql' : 'mysql'
  const port = database.port ?? (isPostgres ? 5432 : 3306)
  // Escape for a single-quoted TS string literal so a `'` or `\` in a
  // credential can't break the generated backups.config.ts.
  const ts = (v: string): string => v.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')

  return [
    '  {',
    `    type: '${type}',`,
    `    name: '${ts(database.name)}',`,
    '    connection: {',
    `      hostname: '${ts(host)}',`,
    `      port: ${port},`,
    `      database: '${ts(database.name)}',`,
    `      username: '${ts(database.username || database.name)}',`,
    `      password: '${ts(database.password || '')}',`,
    '      ssl: false,',
    '    },',
    '    includeSchema: true,',
    '    includeData: true,',
    '  },',
  ].join('\n')
}

/** Generate the `ts-backups` config file content from the database config. */
export function buildBackupsConfigTs(database: DatabaseConfig | undefined, backups: ComputeBackupConfig): string {
  const entry = database ? backupEntryFor(database) : null
  // Use ts-backups' native S3 destination (uploads every backup off-box, S3 +
  // S3-compatible endpoints like Hetzner Object Storage) instead of a separate
  // `aws s3 sync`. `optional: false` so an upload failure fails the run.
  const destinations = backups.bucket
    ? [
        '  destinations: [',
        '    {',
        '      type: \'s3\',',
        `      bucket: '${backups.bucket}',`,
        '      prefix: \'db-backups\',',
        ...(backups.endpoint ? [`      endpoint: '${backups.endpoint}',`] : []),
        '      optional: false,',
        '    },',
        '  ],',
      ]
    : []
  return [
    'import type { BackupConfig } from \'ts-backups\'',
    '',
    'const config: BackupConfig = {',
    '  verbose: true,',
    `  outputPath: '${BACKUP_OUTPUT_DIR}',`,
    '  retention: {',
    `    count: ${backups.retentionCount ?? 5},`,
    `    maxAge: ${backups.retentionDays ?? 30},`,
    '  },',
    '  databases: [',
    ...(entry ? [entry] : []),
    '  ],',
    ...destinations,
    '}',
    '',
    'export default config',
    '',
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
  if (!backups.enabled)
    return []

  const schedule = backups.schedule || '0 2 * * *'
  const configTs = buildBackupsConfigTs(database, backups)

  return [
    'export DEBIAN_FRONTEND=noninteractive',
    `mkdir -p /etc/ts-cloud ${BACKUP_OUTPUT_DIR}`,
    // Bun runtime for ts-backups (no-op if already installed).
    'command -v bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun)',
    // Install ts-backups globally at provision time so scheduled runs don't
    // depend on the registry being reachable each night.
    'bun add -g ts-backups || true',
    // Generated ts-backups config (dump + native off-box S3 upload).
    `cat > ${BACKUP_CONFIG_PATH} <<'TS_CLOUD_BACKUP_CFG_EOF'`,
    configTs.replace(/\n$/, ''),
    'TS_CLOUD_BACKUP_CFG_EOF',
    // Runner: ts-backups dumps + uploads to the configured destination natively.
    `cat > ${BACKUP_RUNNER_PATH} <<'TS_CLOUD_BACKUP_RUN_EOF'`,
    '#!/bin/bash',
    'set -uo pipefail',
    // cron has a minimal PATH; make the globally-installed bun/ts-backups reachable.
    'export PATH="/root/.bun/bin:/usr/local/bin:$PATH"',
    'notify() { [ -x /usr/local/bin/ts-cloud-notify ] && /usr/local/bin/ts-cloud-notify "$1" || true; }',
    'cd /etc/ts-cloud',
    'if ! ts-backups backup --config /etc/ts-cloud/backups.config.ts; then notify "❌ ts-cloud backup failed"; exit 1; fi',
    'TS_CLOUD_BACKUP_RUN_EOF',
    `chmod +x ${BACKUP_RUNNER_PATH}`,
    // Cron entry.
    `cat > ${BACKUP_CRON_PATH} <<'TS_CLOUD_BACKUP_CRON_EOF'`,
    `${schedule} root ${BACKUP_RUNNER_PATH} >> /var/log/ts-cloud-backup.log 2>&1`,
    'TS_CLOUD_BACKUP_CRON_EOF',
    `chmod 644 ${BACKUP_CRON_PATH}`,
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
 * MariaDB restore over the root unix socket; Postgres via `psql -U postgres`.
 * Returns `[]` when the database has no name.
 */
export function buildBackupRestoreScript(database: DatabaseConfig | undefined, options: BackupRestoreOptions = {}): string[] {
  if (!database?.name)
    return []
  const name = database.name
  const isPg = database.engine === 'postgres'
  const locate = options.from
    ? `TS_CLOUD_DUMP="${options.from}"`
    : `TS_CLOUD_DUMP="$(find ${BACKUP_OUTPUT_DIR} -type f -name '*${name}*.sql' -o -type f -name '*${name}*.sql.gz' 2>/dev/null | xargs -r ls -1t 2>/dev/null | head -1)"`
  const client = isPg
    ? `psql -h 127.0.0.1 -p ${database.port ?? 5432} -U postgres -d "${name}"`
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
