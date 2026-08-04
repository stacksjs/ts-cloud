import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  applySchemaChange,
  applyVSchema,
  buildApplySchemaScript,
  buildApplyVSchemaScript,
  buildCreateKeyspaceScript,
  buildMigrationActionScript,
  buildMigrationsScript,
  buildVtctldClientInstallScript,
  createKeyspace,
  DEFAULT_VTCTLDCLIENT_VERSION,
  failedMigrations,
  isValidKeyspaceName,
  isValidMigrationUuid,
  parseMigrations,
  resolveVitessConfig,
  runningMigrations,
  vtctldCommand,
} from './dashboard-vitess'

const VTCTLD = { vtctldAddr: 'vtctld.internal:15999', cell: 'zone1' }
const DB = {
  engine: 'vitess',
  name: 'commerce',
  host: 'vtgate.internal',
  port: 15306,
  username: 'app',
  password: 'pw',
} as any

const cfg = (database: any): CloudConfig =>
  ({ project: { name: 'a', slug: 'a' }, infrastructure: { appDatabase: database } }) as any

describe('identifier validation', () => {
  // These values reach a shell command line and a SQL string literal, so
  // they are matched exactly rather than escaped.
  it('accepts ordinary keyspace names', () => {
    expect(isValidKeyspaceName('commerce')).toBe(true)
    expect(isValidKeyspaceName('_internal2')).toBe(true)
  })

  it('rejects anything that could break out of a shell word', () => {
    for (const bad of ['a b', 'a;rm -rf /', "a'b", 'a`b`', 'a$(b)', '../etc', '', '1abc'])
      expect(isValidKeyspaceName(bad)).toBe(false)
  })

  it('accepts a Vitess migration UUID and rejects near-misses', () => {
    expect(isValidMigrationUuid('a1b2c3d4_1234_5678_9abc_def012345678')).toBe(true)
    // Dashed (RFC 4122) form is not what Vitess emits.
    expect(isValidMigrationUuid('a1b2c3d4-1234-5678-9abc-def012345678')).toBe(false)
    expect(isValidMigrationUuid("a1b2c3d4_1234_5678_9abc_def012345678'; DROP")).toBe(false)
    expect(isValidMigrationUuid('')).toBe(false)
  })
})

describe('vtctldclient install', () => {
  it('pins the version rather than tracking latest', () => {
    // vtctldclient talks gRPC to vtctld and Vitess supports only a bounded
    // skew, so "latest" breaks the control plane the day the cluster is
    // upgraded, at a moment nobody expects it.
    const script = buildVtctldClientInstallScript().join('\n')
    expect(script).toContain(DEFAULT_VTCTLDCLIENT_VERSION)
    expect(script).not.toContain('/latest/')
  })

  it('is a no-op when the pinned version is already present', () => {
    const script = buildVtctldClientInstallScript('21.0.0').join('\n')
    expect(script).toContain('--version')
    expect(script).toContain('already installed')
  })

  it('honors an explicit version', () => {
    expect(buildVtctldClientInstallScript('20.0.3').join('\n')).toContain('v20.0.3')
  })

  it('resolves the asset URL from the releases API instead of constructing it', () => {
    // Regression. The first version built the filename as
    // `vitess-<version>-<arch>.tar.gz`, but the real asset embeds the release
    // commit (`vitess-21.0.0-d9bc0da.tar.gz`), which cannot be derived from
    // the version. Every install 404'd, and the original test passed because
    // it only asserted the script MENTIONED a version and `uname -m` - it
    // never checked that the URL could resolve.
    const script = buildVtctldClientInstallScript('21.0.0').join('\n')
    expect(script).toContain('api.github.com/repos/vitessio/vitess/releases/tags/v21.0.0')
    expect(script).toContain('browser_download_url')
    // The filename must never be assembled from parts.
    expect(script).not.toMatch(/vitess-\$\{?version/)
    expect(script).not.toContain('vitess-21.0.0-${arch}')
  })

  it('fails clearly on architectures Vitess does not publish for', () => {
    // Vitess ships one x86_64 tarball; there is no arm64 asset. Saying so
    // beats a 404 from a URL that was quietly wrong.
    const script = buildVtctldClientInstallScript().join('\n')
    expect(script).toContain('uname -m')
    expect(script).toContain('x86_64')
    expect(script).toContain('only an x86_64 release tarball')
  })

  it('stops the download once the binary is found', () => {
    // The tarball is ~600MB and holds every Vitess binary; only one is wanted.
    const script = buildVtctldClientInstallScript().join('\n')
    expect(script).toContain('--occurrence=1')
    expect(script).toContain('vtctldclient')
  })
})

describe('vtctldCommand', () => {
  it('returns null when no control plane is configured', () => {
    // Read-only is the correct default for a cluster ts-cloud did not build.
    expect(vtctldCommand({})).toBeNull()
  })

  it('targets the configured vtctld address', () => {
    expect(vtctldCommand(VTCTLD)).toContain("--server 'vtctld.internal:15999'")
  })
})

describe('CreateKeyspace', () => {
  it('emits a sharded keyspace when asked', () => {
    expect(buildCreateKeyspaceScript(VTCTLD, 'commerce', { sharded: true })?.join('\n'))
      .toContain('CreateKeyspace --sharded')
  })

  it('defaults to unsharded', () => {
    const script = buildCreateKeyspaceScript(VTCTLD, 'commerce')?.join('\n') ?? ''
    expect(script).toContain('CreateKeyspace')
    expect(script).not.toContain('--sharded')
  })

  it('is unavailable without a vtctld address', () => {
    expect(buildCreateKeyspaceScript({}, 'commerce')).toBeNull()
  })
})

describe('ApplyVSchema', () => {
  const vschema = JSON.stringify({ sharded: true, vindexes: { hash: { type: 'hash' } }, tables: {} })

  it('writes the document to a file instead of an argument', () => {
    // A real application's VSchema is many kilobytes; shell argument limits
    // are not where that should be discovered.
    const script = buildApplyVSchemaScript(VTCTLD, 'commerce', vschema)?.join('\n') ?? ''
    expect(script).toContain('--vschema-file')
    expect(script).toContain('mktemp')
    expect(script).toContain('rm -f')
  })

  it('is unavailable without a vtctld address', () => {
    expect(buildApplyVSchemaScript({}, 'commerce', vschema)).toBeNull()
  })

  it('rejects malformed JSON before reaching the cluster', async () => {
    // A gRPC failure is far less specific than a parse error, and a
    // truncated paste is the likeliest cause.
    const r = await applyVSchema(cfg({ ...DB, vitess: VTCTLD }), 'production', 'commerce', '{ not json')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not valid JSON')
  })

  it('rejects a non-object VSchema', async () => {
    const r = await applyVSchema(cfg({ ...DB, vitess: VTCTLD }), 'production', 'commerce', '42')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('JSON object')
  })
})

describe('schema changes default to online DDL', () => {
  it('sets the vitess ddl_strategy', () => {
    // A `direct` change locks the table on every shard at once, which on a
    // sharded keyspace is an outage rather than a migration.
    const script = buildApplySchemaScript(DB, 'ALTER TABLE users ADD COLUMN nickname VARCHAR(64)').join('\n')
    expect(script).toContain(`SET @@ddl_strategy='vitess'`)
    expect(script).toContain('ALTER TABLE users')
  })

  it('allows direct when explicitly asked', () => {
    expect(buildApplySchemaScript(DB, 'ALTER TABLE t ADD c INT', 'direct').join('\n'))
      .toContain(`SET @@ddl_strategy='direct'`)
  })

  it('goes through vtgate, not vtctld', () => {
    // Works on a cluster where only the query endpoint is reachable.
    const script = buildApplySchemaScript(DB, 'ALTER TABLE t ADD c INT').join('\n')
    expect(script).toContain('vtgate.internal')
    expect(script).not.toContain('vtctldclient')
  })

  it('terminates the statement', () => {
    expect(buildApplySchemaScript(DB, 'ALTER TABLE t ADD c INT').join('\n')).toContain('ADD c INT;')
  })
})

describe('migration listing', () => {
  it('selects columns explicitly rather than relying on SHOW layout', () => {
    // The SHOW form's column order varies across Vitess versions, and a
    // positional parser against it silently mislabels fields after upgrade.
    const script = buildMigrationsScript(DB).join('\n')
    expect(script).toContain('_vt.schema_migrations')
    expect(script).toContain('migration_uuid')
    expect(script).not.toContain('SHOW VITESS_MIGRATIONS')
  })

  it('filters by keyspace when given one', () => {
    expect(buildMigrationsScript(DB, 'commerce').join('\n')).toContain(`keyspace = 'commerce'`)
  })

  const output = [
    'a1b2c3d4_1234_5678_9abc_def012345678\tcommerce\t-80\tusers\trunning\tvitess\t2026-08-04 01:00:00\t\t42%',
    'b1b2c3d4_1234_5678_9abc_def012345678\tcommerce\t80-\torders\tfailed\tvitess\t2026-08-04 00:00:00\t2026-08-04 00:05:00\t100%',
    'c1b2c3d4_1234_5678_9abc_def012345678\tcommerce\t-80\tcarts\tcomplete\tvitess\t2026-08-03 23:00:00\t2026-08-03 23:10:00\t100%',
  ].join('\n')

  const migrations = parseMigrations(output)

  it('parses every column in order', () => {
    expect(migrations).toHaveLength(3)
    expect(migrations[0]).toEqual({
      uuid: 'a1b2c3d4_1234_5678_9abc_def012345678',
      keyspace: 'commerce',
      shard: '-80',
      table: 'users',
      status: 'running',
      strategy: 'vitess',
      added: '2026-08-04 01:00:00',
      completed: '',
      progress: '42%',
    })
  })

  it('separates failed from running', () => {
    expect(failedMigrations(migrations).map(m => m.table)).toEqual(['orders'])
    expect(runningMigrations(migrations).map(m => m.table)).toEqual(['users'])
  })

  it('ignores client noise that is not a migration row', () => {
    expect(parseMigrations('Warning: something\n\n')).toEqual([])
  })

  it('tolerates empty output', () => {
    expect(parseMigrations('')).toEqual([])
  })
})

describe('migration actions', () => {
  it('builds the ALTER VITESS_MIGRATION statement', () => {
    const uuid = 'a1b2c3d4_1234_5678_9abc_def012345678'
    for (const action of ['retry', 'cancel', 'cleanup', 'complete'] as const) {
      expect(buildMigrationActionScript(DB, uuid, action).join('\n'))
        .toContain(`ALTER VITESS_MIGRATION '${uuid}' ${action.toUpperCase()};`)
    }
  })
})

describe('guards', () => {
  it('refuses every operation when the engine is not vitess', async () => {
    const mysql = cfg({ engine: 'mysql', name: 'app' })
    expect((await createKeyspace(mysql, 'production', 'k')).ok).toBe(false)
    expect((await applySchemaChange(mysql, 'production', 'ALTER TABLE t ADD c INT')).ok).toBe(false)
  })

  it('explains what to configure when vtctld is missing', async () => {
    // vtgate genuinely cannot do this, so the message has to say so rather
    // than looking like a transient failure.
    const r = await createKeyspace(cfg(DB), 'production', 'commerce')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('vtctldAddr')
    expect(r.error).toContain('vtgate cannot perform')
  })

  it('rejects an invalid keyspace name before reaching the cluster', async () => {
    const r = await createKeyspace(cfg({ ...DB, vitess: VTCTLD }), 'production', 'bad name')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('valid identifier')
  })

  it('rejects empty SQL', async () => {
    const r = await applySchemaChange(cfg({ ...DB, vitess: VTCTLD }), 'production', '   ')
    expect(r.ok).toBe(false)
  })
})

describe('resolveVitessConfig', () => {
  it('reads the control-plane block off the app database', () => {
    expect(resolveVitessConfig(cfg({ ...DB, vitess: VTCTLD })).vtctldAddr).toBe('vtctld.internal:15999')
  })

  it('defaults to empty, which keeps the dashboard read-only', () => {
    expect(resolveVitessConfig(cfg(DB))).toEqual({})
  })
})
