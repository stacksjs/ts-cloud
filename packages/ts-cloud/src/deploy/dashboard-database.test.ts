import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildBackupScript,
  buildCreateDatabaseScript,
  buildCreateUserScript,
  buildListBackupsScript,
  buildListScript,
  buildVitessListScript,
  DEFAULT_DB_BACKUP_RETENTION,
  isExternalEngine,
  isValidDbIdentifier,
  parseBackups,
  parseDbList,
  parseVitessTopology,
  resolveDbBackupRetention,
  resolveDbEngine,
  shardsMissingPrimary,
  unhealthyTablets,
} from './dashboard-database'

describe('resolveDbEngine', () => {
  const cfg = (infra: any): CloudConfig => ({ project: { name: 'a', slug: 'a' }, infrastructure: infra }) as any
  it('prefers the appDatabase engine, then managed services, default mysql', () => {
    expect(resolveDbEngine(cfg({ appDatabase: { engine: 'postgres' } }))).toBe('postgres')
    expect(resolveDbEngine(cfg({ appDatabase: { engine: 'pgsql' } }))).toBe('postgres')
    expect(resolveDbEngine(cfg({ compute: { managedServices: { mariadb: true } } }))).toBe('mariadb')
    expect(resolveDbEngine(cfg({ compute: { managedServices: { postgres: true } } }))).toBe('postgres')
    expect(resolveDbEngine(cfg({ compute: {} }))).toBe('mysql')
  })
})

describe('isValidDbIdentifier', () => {
  it('accepts normal names, rejects injection', () => {
    expect(isValidDbIdentifier('acme_prod')).toBe(true)
    expect(isValidDbIdentifier('1bad')).toBe(false)
    expect(isValidDbIdentifier('drop;table')).toBe(false)
    expect(isValidDbIdentifier('a`b')).toBe(false)
  })
})

describe('buildCreateDatabaseScript', () => {
  it('mysql: CREATE DATABASE via the socket', () => {
    const cmds = buildCreateDatabaseScript('mysql', 'acme').join('\n')
    expect(cmds).toContain('mysql --socket=/var/lib/pantry/mysql/mysqld.sock -u root')
    expect(cmds).toContain('CREATE DATABASE IF NOT EXISTS `acme`')
  })
  it('mariadb uses the mariadb socket', () => {
    expect(buildCreateDatabaseScript('mariadb', 'acme').join('\n')).toContain('mariadb/mariadbd.sock')
  })
  it('postgres: gexec-guarded CREATE DATABASE over the local unix socket', () => {
    // The pantry postgres pg_hba trusts the local socket but demands md5 over
    // TCP loopback — admin commands must not pass -h 127.0.0.1.
    const cmds = buildCreateDatabaseScript('postgres', 'acme').join('\n')
    expect(cmds).toContain('psql -p 5432 -U postgres')
    expect(cmds).not.toContain('psql -h')
    expect(cmds).toContain('CREATE DATABASE "acme"')
    expect(cmds).toContain('\\gexec')
  })
  it('postgres: an external database host keeps TCP with credentials', () => {
    const external = {
      engine: 'postgres' as const,
      name: 'acme',
      host: 'db.example.com',
      username: 'admin',
      password: 's3cret',
    }
    const cmds = buildCreateDatabaseScript('postgres', 'acme', external).join('\n')
    expect(cmds).toContain(`PGPASSWORD='s3cret' psql -h db.example.com -p 5432 -U admin -w`)
  })
})

describe('buildCreateUserScript', () => {
  it('mysql: creates user for %/localhost and grants on the database', () => {
    const cmds = buildCreateUserScript('mysql', {
      username: 'app',
      password: 's3cret',
      database: 'acme',
      access: 'all',
    }).join('\n')
    expect(cmds).toContain("CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 's3cret';")
    expect(cmds).toContain("CREATE USER IF NOT EXISTS 'app'@'localhost'")
    expect(cmds).toContain("GRANT ALL PRIVILEGES ON `acme`.* TO 'app'@'%';")
    expect(cmds).toContain('FLUSH PRIVILEGES;')
  })
  it('mysql readonly grants SELECT only', () => {
    expect(
      buildCreateUserScript('mysql', { username: 'ro', password: 'p', database: 'acme', access: 'readonly' }).join(
        '\n',
      ),
    ).toContain('GRANT SELECT ON `acme`.*')
  })
  it('escapes a single quote in the password', () => {
    expect(buildCreateUserScript('mysql', { username: 'app', password: "a'b" }).join('\n')).toContain(
      "IDENTIFIED BY 'a\\'b'",
    )
  })
  it('postgres: ensures a login role and grants', () => {
    const cmds = buildCreateUserScript('postgres', {
      username: 'app',
      password: 'p',
      database: 'acme',
      access: 'all',
    }).join('\n')
    expect(cmds).toContain('CREATE ROLE "app" LOGIN PASSWORD')
    expect(cmds).toContain('GRANT ALL PRIVILEGES ON DATABASE "acme" TO "app";')
  })
})

describe('buildListScript + parseDbList', () => {
  it('lists databases + users, excluding system schemas', () => {
    const cmds = buildListScript('mysql').join('\n')
    expect(cmds).toContain("schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')")
    expect(cmds).toContain("CONCAT('USER=', User)")
  })
  it('parses DB=/USER= lines, ignores noise, and dedupes', () => {
    const parsed = parseDbList('DB=acme\nDB=acme\nDB=blog\nUSER=app\nrandom noise line\nUSER=app')
    expect(parsed.databases).toEqual(['acme', 'blog'])
    expect(parsed.users).toEqual(['app'])
  })

  it('builds a per-database dump script (mysqldump / pg_dump) to a timestamped file', () => {
    const my = buildBackupScript('mysql', 'acme').join('\n')
    expect(my).toContain('mysqldump --socket=')
    expect(my).toContain('acme-$TS_CLOUD_BACKUP_STAMP.sql.gz')
    // Local pantry engine: socket (no -h) — TCP loopback demands md5.
    const pg = buildBackupScript('postgres', 'acme').join('\n')
    expect(pg).toContain('pg_dump -p 5432 -U postgres acme')
    expect(pg).not.toContain('pg_dump -h')
    // External host: TCP with credentials.
    const ext = buildBackupScript('postgres', 'acme', '/var/backups/ts-cloud/databases', {
      engine: 'postgres',
      name: 'acme',
      host: 'db.example.com',
      username: 'admin',
      password: 'pw',
    }).join('\n')
    expect(ext).toContain(`PGPASSWORD='pw' pg_dump -h db.example.com -p 5432 -U admin -w acme`)
  })

  /**
   * The timestamp has to be taken ONCE. Written inline as `$(date …)` it runs
   * again in every command that mentions the filename, so a dump crossing a
   * second boundary writes one file and then reports — and lists — a different
   * one that does not exist: a backup that succeeds and names a path nobody can
   * find. Caught on CI by the docker end-to-end test, which is slower than a
   * laptop and so actually crossed the boundary.
   */
  it('names the dump once, so the file it writes is the file it reports', () => {
    for (const engine of ['postgres', 'mysql', 'mariadb'] as const) {
      const script = buildBackupScript(engine, 'acme')
      expect(script.filter(line => line.includes('$(date'))).toHaveLength(1)
      expect(script.some(line => line.startsWith('TS_CLOUD_BACKUP_STAMP='))).toBe(true)

      // The publish, the report and the listing must all name the same thing.
      const named = script.filter(line => line.includes('acme-$TS_CLOUD_BACKUP_STAMP.sql.gz'))
      expect(named).toHaveLength(3)
      // And the scratch file is named once and consistently: written to,
      // renamed from, removed on failure.
      expect(script.filter(line => line.includes('.acme-$TS_CLOUD_BACKUP_STAMP.part'))).toHaveLength(3)

      // And the stamp is set before anything uses it.
      expect(script.findIndex(l => l.startsWith('TS_CLOUD_BACKUP_STAMP=')))
        .toBeLessThan(script.findIndex(l => l.includes('acme-$TS_CLOUD_BACKUP_STAMP')))
    }
  })


  /**
   * Every on-demand dump used to be kept forever: `buildBackupScript` wrote a
   * timestamped file and nothing pruned the directory, so each dashboard
   * "Backup" click left a full dump on the box. The scheduled path has honoured
   * `retentionCount`/`retentionDays` all along; this path had no bound at all.
   */
  describe('on-demand dump retention', () => {
    it('keeps the newest N dumps of that database and drops the rest', () => {
      const script = buildBackupScript('mysql', 'acme', '/var/backups/ts-cloud/databases', undefined, { count: 3 }).join('\n')
      // Newest first, so `+4` is everything past the newest 3. The dump just
      // taken is newest, so it always survives.
      expect(script).toContain('ls -1t /var/backups/ts-cloud/databases/acme-*.sql.gz 2>/dev/null | tail -n +4 | xargs -r rm -f')
    })

    it('drops dumps older than the configured age', () => {
      const script = buildBackupScript('mysql', 'acme', '/var/backups/ts-cloud/databases', undefined, { days: 7 }).join('\n')
      expect(script).toContain('-name "acme-*.sql.gz" -mtime +7 -delete')
    })

    it('defaults to a bound rather than to unbounded', () => {
      const script = buildBackupScript('mysql', 'acme').join('\n')
      expect(script).toContain(`tail -n +${DEFAULT_DB_BACKUP_RETENTION.count + 1}`)
      expect(script).toContain(`-mtime +${DEFAULT_DB_BACKUP_RETENTION.days} -delete`)
    })

    /** A shared box holds every database's dumps in one directory. */
    it('never prunes another database\'s dumps', () => {
      const script = buildBackupScript('mysql', 'acme').join('\n')
      for (const line of script.split('\n').filter(l => l.includes('rm -f') || l.includes('-delete')))
        expect(line).toContain('acme-')
    })

    it('can be turned off for a caller that owns the directory itself', () => {
      const script = buildBackupScript('postgres', 'acme', '/tmp', undefined, false).join('\n')
      expect(script).not.toContain('-delete')
      expect(script).not.toContain('tail -n +')
    })

    /**
     * `runDb` runs these under `set -uo pipefail` with NO `-e`, so a failed dump
     * does not stop the script — and `gzip` exits 0 even when its upstream died.
     * If retention ran anyway it would count a 20-byte gzip header as the newest
     * backup and delete a good one to make room: adding a bound would then
     * destroy data that accumulating never did.
     */
    it('prunes nothing when the dump fails', () => {
      const script = buildBackupScript('mysql', 'acme')
      const elseAt = script.indexOf('else')
      expect(elseAt).toBeGreaterThan(-1)
      const failureBranch = script.slice(elseAt).join('\n')
      expect(failureBranch).not.toContain('-delete')
      expect(failureBranch).not.toContain('tail -n +')
      // And it reports the failure rather than exiting 0 with no dump.
      expect(failureBranch).toContain('exit 1')
    })

    /**
     * The stamp is only second-granular. Redirecting straight to the final name
     * opens and truncates it before the dump is known to work, so a failed retry
     * within the same second as a good dump destroyed that dump. Reproduced
     * before the fix.
     */
    it('publishes by rename, so a failed retry cannot clobber a good dump', () => {
      const script = buildBackupScript('mysql', 'acme')
      const dumpLine = script.find(l => l.startsWith('if '))!
      // The dump writes to the scratch name, never to the published one.
      expect(dumpLine).toContain('.acme-$TS_CLOUD_BACKUP_STAMP.part"')
      expect(dumpLine).not.toContain('acme-$TS_CLOUD_BACKUP_STAMP.sql.gz')
      expect(script.join('\n')).toContain('mv -f "/var/backups/ts-cloud/databases/.acme-$TS_CLOUD_BACKUP_STAMP.part"')
      // Scratch files are outside the `*.sql.gz` glob, so they are never listed
      // as a backup — and stale ones get reaped.
      expect(buildListBackupsScript()).toEqual([expect.stringContaining('*.sql.gz')])
      expect(script.join('\n')).toContain('-name ".acme-*.part" -mmin +60 -delete')
    })

    it('reads its bounds from the same config the scheduled path uses', () => {
      const base = { project: { name: 'acme', slug: 'acme' } } as any
      expect(resolveDbBackupRetention(base)).toEqual(DEFAULT_DB_BACKUP_RETENTION)
      expect(resolveDbBackupRetention({
        ...base,
        infrastructure: { compute: { backups: { retentionCount: 2, retentionDays: 3 } } },
      })).toEqual({ count: 2, days: 3 })
    })
  })

  it('parses BACKUP= lines into database + file, deriving the db from the filename', () => {
    const parsed = parseBackups(
      'BACKUP=/var/backups/ts-cloud/databases/acme-20260702-101500.sql.gz\nnoise\nBACKUP=/var/backups/ts-cloud/databases/blog-20260701-090000.sql.gz',
    )
    expect(parsed).toEqual([
      { file: '/var/backups/ts-cloud/databases/acme-20260702-101500.sql.gz', database: 'acme' },
      { file: '/var/backups/ts-cloud/databases/blog-20260701-090000.sql.gz', database: 'blog' },
    ])
  })
})

// ---------------------------------------------------------------------------
// External engines (SingleStore, Vitess)
//
// Both speak the MySQL wire protocol, and that is precisely why the previous
// behavior looked harmless: `normalizeEngine` fell through to `mysql`, so the
// dashboard reported "mysql" for a Vitess deployment and every operation
// shelled into `/var/lib/pantry/mysql/mysqld.sock` - a socket that cannot
// exist, because nothing ever installed MySQL on that box. The user saw a
// missing-socket error naming an engine they never configured.
// ---------------------------------------------------------------------------

describe('external engines are reported honestly', () => {
  const cfgFor = (engine: string): CloudConfig =>
    ({ project: { name: 'a', slug: 'a' }, infrastructure: { appDatabase: { engine, name: 'app' } } }) as any

  it('does not silently report vitess as mysql', () => {
    expect(resolveDbEngine(cfgFor('vitess'))).toBe('vitess')
  })

  it('does not silently report singlestore as mysql', () => {
    expect(resolveDbEngine(cfgFor('singlestore'))).toBe('singlestore')
  })

  it('classifies which engines have no on-box socket', () => {
    expect(isExternalEngine('vitess')).toBe(true)
    expect(isExternalEngine('singlestore')).toBe(true)
    expect(isExternalEngine('mysql')).toBe(false)
    expect(isExternalEngine('mariadb')).toBe(false)
    expect(isExternalEngine('postgres')).toBe(false)
  })

  it('still resolves the on-box engines unchanged', () => {
    expect(resolveDbEngine(cfgFor('mysql'))).toBe('mysql')
    expect(resolveDbEngine(cfgFor('mariadb'))).toBe('mariadb')
    expect(resolveDbEngine(cfgFor('postgres'))).toBe('postgres')
    expect(resolveDbEngine(cfgFor('pgsql'))).toBe('postgres')
  })
})

describe('vitess list script targets vtgate, not a local socket', () => {
  const db = { engine: 'vitess', name: 'commerce', host: 'vtgate.internal', port: 15306, username: 'app', password: 'pw' } as any

  it('never references the pantry socket', () => {
    const script = buildListScript('vitess', db).join('\n')
    expect(script).not.toContain('--socket=')
    expect(script).not.toContain('/var/lib/pantry')
  })

  it('connects to the configured vtgate host and port', () => {
    const script = buildListScript('vitess', db).join('\n')
    expect(script).toContain('vtgate.internal')
    expect(script).toContain('15306')
  })

  it('defaults to vtgate 15306 rather than mysql 3306', () => {
    // 3306 would reach a tablet's underlying mysqld and bypass sharding -
    // a working connection that silently does the wrong thing.
    const script = buildVitessListScript({ engine: 'vitess', name: 'k', host: 'h' } as any).join('\n')
    expect(script).toContain('15306')
    expect(script).not.toContain('3306')
  })

  it('passes the password by env, not on the command line', () => {
    // A `-p<pass>` argument is visible to any `ps` on the box.
    const script = buildListScript('vitess', db).join('\n')
    expect(script).toContain('MYSQL_PWD=')
    expect(script).not.toContain('-ppw')
  })

  it('uses SHOW KEYSPACES, because the information_schema view does not exist', () => {
    // vtgate answers a fixed set of SHOW commands and does not synthesize an
    // information_schema view for its own topology. An earlier version
    // selected from `information_schema.vitess_keyspaces`, which is not a
    // table in any Vitess version.
    const script = buildListScript('vitess', db).join('\n')
    expect(script).toContain('SHOW KEYSPACES')
    expect(script).not.toContain('information_schema')
    // SHOW cannot CONCAT a prefix, so the DB= marker is added on the way out.
    expect(script).toContain(`sed 's/^/DB=/'`)
    expect(parseDbList('DB=commerce\nDB=lookup\n').databases).toEqual(['commerce', 'lookup'])
  })
})

describe('parseVitessTopology', () => {
  // Real-ish vtgate output: prefixed keyspaces, `keyspace/shard` rows from
  // SHOW VITESS_SHARDS, and tab-separated rows from SHOW VITESS_TABLETS.
  const output = [
    'commerce',
    'lookup',
    'commerce/-80',
    'commerce/80-',
    'zone1\tcommerce\t-80\tPRIMARY\tSERVING\tzone1-0000000100\thost-a',
    'zone1\tcommerce\t-80\tREPLICA\tSERVING\tzone1-0000000101\thost-b',
    'zone1\tcommerce\t80-\tREPLICA\tNOT_SERVING\tzone1-0000000102\thost-c',
  ].join('\n')

  const topology = parseVitessTopology(output)

  it('separates keyspaces, shards, and tablets', () => {
    expect(topology.keyspaces).toEqual(['commerce', 'lookup'])
    expect(topology.shards).toEqual([
      { keyspace: 'commerce', shard: '-80' },
      { keyspace: 'commerce', shard: '80-' },
    ])
    expect(topology.tablets).toHaveLength(3)
  })

  it('reads tablet columns in order', () => {
    expect(topology.tablets[0]).toEqual({
      cell: 'zone1',
      keyspace: 'commerce',
      shard: '-80',
      type: 'PRIMARY',
      state: 'SERVING',
      alias: 'zone1-0000000100',
      hostname: 'host-a',
    })
  })

  it('tolerates empty output', () => {
    expect(parseVitessTopology('')).toEqual({ keyspaces: [], shards: [], tablets: [] })
  })

  it('ignores blank lines', () => {
    expect(parseVitessTopology('\n\nk\n\n').keyspaces).toEqual(['k'])
  })
})

describe('vitess health helpers', () => {
  const topology = parseVitessTopology([
    'commerce/-80',
    'commerce/80-',
    'zone1\tcommerce\t-80\tPRIMARY\tSERVING\tzone1-0000000100\thost-a',
    'zone1\tcommerce\t80-\tREPLICA\tSERVING\tzone1-0000000102\thost-c',
    'zone1\tcommerce\t80-\tPRIMARY\tNOT_SERVING\tzone1-0000000103\thost-d',
  ].join('\n'))

  it('flags tablets that are not serving', () => {
    const bad = unhealthyTablets(topology.tablets)
    expect(bad).toHaveLength(1)
    expect(bad[0]?.alias).toBe('zone1-0000000103')
  })

  it('flags a shard whose primary is not serving', () => {
    // The failure most worth naming: the shard still answers reads and
    // silently fails writes, so it does not look like an outage.
    const missing = shardsMissingPrimary(topology)
    expect(missing).toEqual([{ keyspace: 'commerce', shard: '80-' }])
  })

  it('reports nothing when every shard has a serving primary', () => {
    const healthy = parseVitessTopology([
      'commerce/-80',
      'zone1\tcommerce\t-80\tPRIMARY\tSERVING\tzone1-0000000100\thost-a',
    ].join('\n'))
    expect(shardsMissingPrimary(healthy)).toEqual([])
    expect(unhealthyTablets(healthy.tablets)).toEqual([])
  })
})
