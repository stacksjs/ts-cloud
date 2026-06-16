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

  return [
    '  {',
    `    type: '${type}',`,
    `    name: '${database.name}',`,
    '    connection: {',
    `      hostname: '${host}',`,
    `      port: ${port},`,
    `      database: '${database.name}',`,
    `      username: '${database.username || database.name}',`,
    `      password: '${database.password || ''}',`,
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

  // Object-storage sync. Hetzner object storage is S3-compatible via an endpoint.
  const syncCmd = backups.bucket
    ? `aws s3 sync ${BACKUP_OUTPUT_DIR} s3://${backups.bucket}/db-backups${backups.endpoint ? ` --endpoint-url ${backups.endpoint}` : ''}`
    : `echo "ts-cloud: no backup bucket configured; keeping ${BACKUP_OUTPUT_DIR} local only"`

  return [
    'export DEBIAN_FRONTEND=noninteractive',
    `mkdir -p /etc/ts-cloud ${BACKUP_OUTPUT_DIR}`,
    // Bun runtime for ts-backups (no-op if already installed).
    'command -v bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun)',
    // Generated ts-backups config.
    `cat > ${BACKUP_CONFIG_PATH} <<'TS_CLOUD_BACKUP_CFG_EOF'`,
    configTs.replace(/\n$/, ''),
    'TS_CLOUD_BACKUP_CFG_EOF',
    // Runner: dump via ts-backups, then sync off-box.
    `cat > ${BACKUP_RUNNER_PATH} <<'TS_CLOUD_BACKUP_RUN_EOF'`,
    '#!/bin/bash',
    'set -uo pipefail',
    'notify() { [ -x /usr/local/bin/ts-cloud-notify ] && /usr/local/bin/ts-cloud-notify "$1" || true; }',
    'cd /etc/ts-cloud',
    'if ! bunx ts-backups backup --config /etc/ts-cloud/backups.config.ts; then notify "❌ ts-cloud backup failed (dump)"; exit 1; fi',
    `if ! ${syncCmd}; then notify "❌ ts-cloud backup failed (upload)"; exit 1; fi`,
    'TS_CLOUD_BACKUP_RUN_EOF',
    `chmod +x ${BACKUP_RUNNER_PATH}`,
    // Cron entry.
    `cat > ${BACKUP_CRON_PATH} <<'TS_CLOUD_BACKUP_CRON_EOF'`,
    `${schedule} root ${BACKUP_RUNNER_PATH} >> /var/log/ts-cloud-backup.log 2>&1`,
    'TS_CLOUD_BACKUP_CRON_EOF',
    `chmod 644 ${BACKUP_CRON_PATH}`,
  ]
}
