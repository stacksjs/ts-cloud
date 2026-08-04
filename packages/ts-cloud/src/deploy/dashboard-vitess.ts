/**
 * Vitess control plane: keyspaces, VSchema, and online schema changes.
 *
 * ## Two planes, two transports
 *
 * A Vitess cluster is administered through two different endpoints, and
 * conflating them is the first thing that goes wrong:
 *
 * - **vtgate** speaks the MySQL wire protocol and serves queries. It also
 *   answers a surprising amount of observability (`SHOW VITESS_SHARDS`,
 *   `SHOW VITESS_MIGRATIONS`) and can even run online DDL, all over the
 *   connection the application already holds. Nothing extra is needed.
 * - **vtctld** speaks gRPC and owns the topology. Creating a keyspace and
 *   applying a VSchema are only possible here, which is why those operations
 *   need `vitess.vtctldAddr` configured and the `vtctldclient` binary on the
 *   box.
 *
 * Everything in this module is written to prefer vtgate, because that path
 * needs no extra binary, no extra network hole, and no extra credential. Only
 * the two genuinely topology-level operations reach for vtctldclient.
 *
 * ## Why online DDL is the default
 *
 * A `direct` schema change locks the table on every shard at once. On a
 * sharded keyspace that is an outage, not a migration. Vitess's own online
 * DDL applies shard by shard, is revertible, and reports progress, so it is
 * the default here and `direct` has to be asked for explicitly.
 */

import type { CloudConfig, DatabaseConfig, EnvironmentType, VitessControlPlaneConfig } from '@ts-cloud/core'
import { resolveAppDatabase } from '@ts-cloud/core'
import type { DbRunResult } from './dashboard-database'
import { externalMysqlExec, resolveDbEngine, runDb, VTGATE_DEFAULT_PORT } from './dashboard-database'

/** Where `vtctldclient` is installed, matching the pantry CLI's location. */
export const VTCTLDCLIENT_BIN = '/usr/local/bin/vtctldclient'

/** Pinned default. See `VitessControlPlaneConfig.clientVersion` for why. */
export const DEFAULT_VTCTLDCLIENT_VERSION = '21.0.0'

/** Single-quote a value for safe embedding in generated shell. */
function sh(value: string): string {
  return `'${String(value).split("'").join("'\\''")}'`
}

export function resolveVitessConfig(config: CloudConfig): VitessControlPlaneConfig {
  return resolveAppDatabase(config)?.vitess ?? {}
}

/**
 * A keyspace or table identifier accepted by Vitess.
 *
 * Deliberately stricter than Vitess itself: these values are interpolated
 * into a shell command line, so anything outside this set is rejected rather
 * than escaped. A name that legitimately needs more than this is rare enough
 * to be worth doing by hand.
 */
export function isValidKeyspaceName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)
}

/**
 * A Vitess online-DDL migration UUID, e.g. `a1b2c3d4_1234_5678_9abc_def012345678`.
 *
 * Same reasoning as above: the UUID reaches a SQL string literal, and
 * matching the exact shape is cheaper than reasoning about escaping.
 */
export function isValidMigrationUuid(value: string): boolean {
  return /^[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}$/i.test(value)
}

/**
 * Install `vtctldclient` from its GitHub release.
 *
 * Idempotent, and a no-op when the pinned version is already present so a
 * re-provision does not re-download. Follows the same shape as the pantry
 * CLI bootstrap: curl the release tarball, extract one binary, mark it
 * executable.
 *
 * Pinned rather than "latest" on purpose. vtctldclient talks gRPC to vtctld
 * and Vitess supports only a bounded version skew between them, so tracking
 * latest means the control plane breaks the day the cluster is upgraded, at
 * a moment nobody is expecting it to.
 */
export function buildVtctldClientInstallScript(version: string = DEFAULT_VTCTLDCLIENT_VERSION): string[] {
  const v = sh(version)
  const tarball = `vitess-${version}-*.tar.gz`
  return [
    `if ${VTCTLDCLIENT_BIN} --version 2>/dev/null | grep -q ${v}; then echo "vtctldclient ${version} already installed"; else`,
    '  command -v curl >/dev/null 2>&1 || (apt-get update -y && apt-get install -y curl ca-certificates)',
    '  tmp="$(mktemp -d)"',
    `  arch="$(uname -m)"; case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac`,
    `  url="https://github.com/vitessio/vitess/releases/download/v${version}/vitess-${version}-\${arch}.tar.gz"`,
    '  curl -fsSL "$url" -o "$tmp/vitess.tar.gz"',
    // Extract only the one binary we need; the full release tarball is large
    // and nothing else on the box uses it.
    `  tar -xzf "$tmp/vitess.tar.gz" -C "$tmp" --strip-components=2 --wildcards '*/bin/vtctldclient'`,
    `  install -m 0755 "$tmp/vtctldclient" ${VTCTLDCLIENT_BIN}`,
    '  rm -rf "$tmp"',
    `  echo "installed vtctldclient ${version}"`,
    'fi',
    `# ${tarball}`,
  ]
}

/** The `vtctldclient --server <addr>` prefix, or null when unconfigured. */
export function vtctldCommand(vitess: VitessControlPlaneConfig): string | null {
  if (!vitess.vtctldAddr) return null
  return `${VTCTLDCLIENT_BIN} --server ${sh(vitess.vtctldAddr)}`
}

/**
 * Create a keyspace.
 *
 * `sharded` only declares intent: a keyspace becomes genuinely sharded when
 * its VSchema names a vindex per table, which is the next step. Creating it
 * sharded with no VSchema yields a keyspace vtgate cannot route to, so the
 * dashboard flow always pairs the two.
 */
export function buildCreateKeyspaceScript(
  vitess: VitessControlPlaneConfig,
  name: string,
  options: { sharded?: boolean } = {},
): string[] | null {
  const base = vtctldCommand(vitess)
  if (!base) return null
  const sharded = options.sharded ? ' --sharded' : ''
  return [`${base} CreateKeyspace${sharded} ${sh(name)}`]
}

/**
 * Apply a VSchema document to a keyspace.
 *
 * The JSON is written to a temp file rather than passed inline: a VSchema for
 * a real application is many kilobytes, and shell argument limits are not
 * where you want to discover that.
 */
export function buildApplyVSchemaScript(
  vitess: VitessControlPlaneConfig,
  keyspace: string,
  vschemaJson: string,
): string[] | null {
  const base = vtctldCommand(vitess)
  if (!base) return null
  return [
    'vschema_tmp="$(mktemp)"',
    `cat > "$vschema_tmp" <<'TS_CLOUD_VSCHEMA_EOF'`,
    vschemaJson,
    'TS_CLOUD_VSCHEMA_EOF',
    `${base} ApplyVSchema --vschema-file "$vschema_tmp" ${sh(keyspace)}`,
    'rm -f "$vschema_tmp"',
  ]
}

/**
 * Apply a schema change through Vitess online DDL.
 *
 * Routed through vtgate rather than vtctldclient so it works on a cluster
 * where only the query endpoint is reachable. `SET @@ddl_strategy` tells
 * vtgate to treat the following DDL as an online migration and return a
 * migration UUID immediately instead of blocking.
 */
export function buildApplySchemaScript(
  database: DatabaseConfig | undefined,
  sql: string,
  strategy: 'vitess' | 'direct' = 'vitess',
): string[] {
  return externalMysqlExec(
    [`SET @@ddl_strategy='${strategy}';`, sql.endsWith(';') ? sql : `${sql};`],
    database,
    VTGATE_DEFAULT_PORT,
  )
}

export interface VitessMigration {
  uuid: string
  keyspace: string
  shard: string
  table: string
  status: string
  strategy: string
  added: string
  completed: string
  progress: string
}

/**
 * Read online-DDL migration state from vtgate.
 *
 * Selected explicitly rather than `SHOW VITESS_MIGRATIONS` so the column
 * order is ours: the `SHOW` form's layout varies across Vitess versions, and
 * a positional parser against it silently mislabels fields after an upgrade.
 */
export function buildMigrationsScript(database: DatabaseConfig | undefined, keyspace?: string): string[] {
  const where = keyspace ? ` WHERE keyspace = '${keyspace.replace(/'/g, "''")}'` : ''
  return externalMysqlExec(
    [
      `SELECT CONCAT_WS('\\t', migration_uuid, keyspace, shard, mysql_table, migration_status, strategy, added_timestamp, completed_timestamp, progress) `
      + `FROM _vt.schema_migrations${where} ORDER BY added_timestamp DESC LIMIT 100;`,
    ],
    database,
    VTGATE_DEFAULT_PORT,
  )
}

export function parseMigrations(output: string): VitessMigration[] {
  const rows: VitessMigration[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const c = line.split('\t')
    // Nine columns, in the order the SELECT above lists them. A short row is
    // noise from the client (a warning, a banner) rather than a migration.
    if (c.length < 9) continue
    rows.push({
      uuid: c[0] ?? '',
      keyspace: c[1] ?? '',
      shard: c[2] ?? '',
      table: c[3] ?? '',
      status: c[4] ?? '',
      strategy: c[5] ?? '',
      added: c[6] ?? '',
      completed: c[7] ?? '',
      progress: c[8] ?? '',
    })
  }
  return rows.filter(r => r.uuid)
}

/** Migrations needing attention: failed, or running long enough to notice. */
export function failedMigrations(migrations: VitessMigration[]): VitessMigration[] {
  return migrations.filter(m => m.status.toLowerCase() === 'failed')
}

export function runningMigrations(migrations: VitessMigration[]): VitessMigration[] {
  return migrations.filter(m => ['running', 'queued', 'ready'].includes(m.status.toLowerCase()))
}

export type MigrationAction = 'retry' | 'cancel' | 'cleanup' | 'complete'

/**
 * Act on a single online-DDL migration.
 *
 * `complete` exists because a migration started with a postponed completion
 * waits for an explicit cutover; without it the change is applied but never
 * swapped in, which looks like a migration that finished and did nothing.
 */
export function buildMigrationActionScript(
  database: DatabaseConfig | undefined,
  uuid: string,
  action: MigrationAction,
): string[] {
  const verb = action.toUpperCase()
  return externalMysqlExec([`ALTER VITESS_MIGRATION '${uuid}' ${verb};`], database, VTGATE_DEFAULT_PORT)
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function requireVitess(config: CloudConfig): DbRunResult | null {
  if (resolveDbEngine(config) !== 'vitess')
    return { ok: false, error: 'The configured database engine is not Vitess.' }
  return null
}

function requireControlPlane(vitess: VitessControlPlaneConfig): DbRunResult | null {
  if (!vitess.vtctldAddr) {
    return {
      ok: false,
      error:
        'No vtctld address is configured. Creating keyspaces and applying a VSchema are topology operations that vtgate cannot perform. '
        + 'Set `infrastructure.appDatabase.vitess.vtctldAddr` (for example `vtctld.internal:15999`) and redeploy.',
    }
  }
  return null
}

/** Install the pinned `vtctldclient` on the app box. */
export async function installVtctldClient(
  config: CloudConfig,
  environment: EnvironmentType,
): Promise<DbRunResult> {
  const wrong = requireVitess(config)
  if (wrong) return wrong
  const vitess = resolveVitessConfig(config)
  return runDb(
    config,
    environment,
    buildVtctldClientInstallScript(vitess.clientVersion),
    'ts-cloud vitess:install-client',
  )
}

export async function createKeyspace(
  config: CloudConfig,
  environment: EnvironmentType,
  name: string,
  options: { sharded?: boolean } = {},
): Promise<DbRunResult & { keyspace: string }> {
  const wrong = requireVitess(config)
  if (wrong) return { ...wrong, keyspace: name }
  if (!isValidKeyspaceName(name))
    return { ok: false, error: 'Keyspace name must be a valid identifier.', keyspace: name }

  const vitess = resolveVitessConfig(config)
  const missing = requireControlPlane(vitess)
  if (missing) return { ...missing, keyspace: name }

  const script = buildCreateKeyspaceScript(vitess, name, options)
  if (!script) return { ...requireControlPlane({})!, keyspace: name }

  const r = await runDb(config, environment, script, `ts-cloud vitess:create-keyspace ${name}`)
  return { ...r, keyspace: name }
}

export async function applyVSchema(
  config: CloudConfig,
  environment: EnvironmentType,
  keyspace: string,
  vschemaJson: string,
): Promise<DbRunResult & { keyspace: string }> {
  const wrong = requireVitess(config)
  if (wrong) return { ...wrong, keyspace }
  if (!isValidKeyspaceName(keyspace))
    return { ok: false, error: 'Keyspace name must be a valid identifier.', keyspace }

  // Reject malformed JSON here rather than letting vtctld do it: the error
  // from a failed gRPC call is far less specific than a parse error, and a
  // truncated paste is the likeliest cause.
  try {
    const parsed = JSON.parse(vschemaJson)
    if (!parsed || typeof parsed !== 'object')
      return { ok: false, error: 'The VSchema must be a JSON object.', keyspace }
  }
  catch (error: any) {
    return { ok: false, error: `The VSchema is not valid JSON: ${error?.message ?? error}`, keyspace }
  }

  const vitess = resolveVitessConfig(config)
  const missing = requireControlPlane(vitess)
  if (missing) return { ...missing, keyspace }

  const script = buildApplyVSchemaScript(vitess, keyspace, vschemaJson)
  if (!script) return { ...requireControlPlane({})!, keyspace }

  const r = await runDb(config, environment, script, `ts-cloud vitess:apply-vschema ${keyspace}`)
  return { ...r, keyspace }
}

export async function applySchemaChange(
  config: CloudConfig,
  environment: EnvironmentType,
  sql: string,
): Promise<DbRunResult> {
  const wrong = requireVitess(config)
  if (wrong) return wrong
  if (!sql.trim()) return { ok: false, error: 'No SQL was provided.' }

  const vitess = resolveVitessConfig(config)
  return runDb(
    config,
    environment,
    buildApplySchemaScript(resolveAppDatabase(config), sql, vitess.ddlStrategy ?? 'vitess'),
    'ts-cloud vitess:apply-schema',
  )
}

export async function listMigrations(
  config: CloudConfig,
  environment: EnvironmentType,
  keyspace?: string,
): Promise<DbRunResult & { migrations: VitessMigration[], failed: VitessMigration[], running: VitessMigration[] }> {
  const wrong = requireVitess(config)
  if (wrong) return { ...wrong, migrations: [], failed: [], running: [] }

  const r = await runDb(
    config,
    environment,
    buildMigrationsScript(resolveAppDatabase(config), keyspace),
    'ts-cloud vitess:migrations',
  )
  const migrations = r.ok && r.stdout ? parseMigrations(r.stdout) : []
  return { ...r, migrations, failed: failedMigrations(migrations), running: runningMigrations(migrations) }
}

export async function actOnMigration(
  config: CloudConfig,
  environment: EnvironmentType,
  uuid: string,
  action: MigrationAction,
): Promise<DbRunResult & { uuid: string }> {
  const wrong = requireVitess(config)
  if (wrong) return { ...wrong, uuid }
  if (!isValidMigrationUuid(uuid))
    return { ok: false, error: 'Migration UUID is not in the expected format.', uuid }

  const r = await runDb(
    config,
    environment,
    buildMigrationActionScript(resolveAppDatabase(config), uuid, action),
    `ts-cloud vitess:migration ${action} ${uuid}`,
  )
  return { ...r, uuid }
}
