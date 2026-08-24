/**
 * End-to-end check that a moved site's on-box database really arrives.
 *
 * This is the part of `site:move` with the least margin for error. The tree and
 * the units can be re-shipped by a deploy if something goes wrong; the rows
 * cannot. And it is the part unit tests can say least about, because what has to
 * be true is not "the right string was built" but "pg_dump wrote something psql
 * could read back into a database that setup had just created".
 *
 * So this stands up Postgres on two machines and drives the ACTUAL builders the
 * move composes — `buildBackupScript` for the dump, `buildDatabaseSetupScript`
 * for the role and schema, `buildBackupRestoreScript` for the load — then reads
 * the rows back out of the target.
 *
 * Local `trust` auth on the unix socket is not a fudge for the test: it is what
 * the pantry Postgres the drivers provision actually configures, and it is why
 * `pgAdminCommand` omits `-h` for a co-located engine.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 */

import type { DatabaseConfig } from '@ts-cloud/core'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBackupScript } from '../../src/deploy/dashboard-database'
import { buildBackupRestoreScript } from '../../src/drivers/shared/backups'
import { buildDatabaseSetupScript } from '../../src/drivers/shared/db-provision'

const SOURCE = 'ts-cloud-db-source'
const TARGET = 'ts-cloud-db-target'
const IMAGE = 'ts-cloud-db-box:22.04'
const DB_NAME = 'bughq'
const DUMP = '/tmp/ts-cloud-move-hq-bughq.sql.gz'

const database: DatabaseConfig = {
  engine: 'postgres',
  name: DB_NAME,
  username: 'bughq_app',
  password: 'not-a-real-password',
}

async function available(command: string[]): Promise<boolean> {
  const result = await Bun.$`${command}`.quiet().nothrow()
  return result.exitCode === 0
}

const canRun = await available(['docker', 'info'])

async function exec(box: string, script: string): Promise<{ stdout: string, code: number }> {
  const child = Bun.spawn(['docker', 'exec', '-i', box, 'bash', '-s'], {
    stdin: new Blob([script]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { stdout: stdout + stderr, code }
}

async function run(box: string, script: string): Promise<string> {
  const result = await exec(box, script)
  if (result.code !== 0) throw new Error(`${box} exited ${result.code}:\n${result.stdout}`)
  return result.stdout
}

/** Query the box's Postgres the way an operator would, and return the raw value. */
async function query(box: string, sql: string, db = DB_NAME): Promise<string> {
  const out = await run(box, `psql -tA -U postgres -d ${db} -c ${JSON.stringify(sql)}`)
  return out.trim()
}

describe.skipIf(!canRun)('a moved site\'s database (docker)', () => {
  let workspace: string

  async function boot(name: string): Promise<void> {
    await Bun.$`docker rm -f ${name}`.quiet().nothrow()
    await Bun.$`docker run -d --name ${name} ${IMAGE} sleep infinity`.quiet()
    // `trust` on the local socket — what pantry's postgres configures, and what
    // lets `psql -U postgres` connect passwordless as root.
    await run(name, [
      'set -eu',
      'PGDIR=$(ls -d /etc/postgresql/*/main | head -1)',
      // Replaced outright rather than patched: Ubuntu ships several `local`
      // lines (postgres and all), and editing only one leaves peer auth in
      // force for the superuser the admin commands connect as.
      'cat > "$PGDIR/pg_hba.conf" <<EOF',
      'local   all   all                  trust',
      'host    all   all   127.0.0.1/32   trust',
      'host    all   all   ::1/128        trust',
      'EOF',
      'CLUSTER=$(ls /etc/postgresql | head -1)',
      'pg_ctlcluster "$CLUSTER" main start || pg_ctlcluster "$CLUSTER" main reload',
      'for i in $(seq 1 30); do pg_isready -q && break; sleep 1; done',
      'pg_isready',
    ].join('\n'))
  }

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ts-cloud-db-e2e-'))
    const dockerfile = join(workspace, 'Dockerfile')
    await writeFile(
      dockerfile,
      [
        'FROM ubuntu:22.04',
        'ENV DEBIAN_FRONTEND=noninteractive',
        'RUN apt-get update && apt-get install -y postgresql gzip \\',
        ' && apt-get clean && rm -rf /var/lib/apt/lists/*',
        // The builders put the engine client on PATH via `pantry env`, which is a
        // no-op here; the apt client already is.
        'ENV PATH=/usr/lib/postgresql/14/bin:$PATH',
      ].join('\n'),
    )
    await Bun.$`docker build -q -f ${dockerfile} -t ${IMAGE} ${workspace}`.quiet()
    await boot(SOURCE)
    await boot(TARGET)

    // The source's live database, with rows worth losing.
    await run(SOURCE, [
      'set -eu',
      ...buildDatabaseSetupScript(database, { postgres: true }),
    ].join('\n'))
    // Seeded AS THE APP ROLE, because that is who runs migrations in practice.
    // Creating the tables as the superuser instead would leave the app unable to
    // read its own data on the source too, and quietly turn the ownership check
    // below into a test of nothing.
    const asApp = `PGPASSWORD='${database.password}' psql -h 127.0.0.1 -U ${database.username} -d ${DB_NAME}`
    await run(SOURCE, [
      'set -eu',
      `${asApp} -c "CREATE TABLE incidents (id serial primary key, title text not null);"`,
      `${asApp} -c "INSERT INTO incidents (title) VALUES ('edge outage'), ('db failover'), ('cert expiry');"`,
    ].join('\n'))
  }, 900_000)

  afterAll(async () => {
    await Bun.$`docker rm -f ${SOURCE}`.quiet().nothrow()
    await Bun.$`docker rm -f ${TARGET}`.quiet().nothrow()
    await rm(workspace, { recursive: true, force: true })
  })

  it('creates the role and database from the same script provisioning runs', async () => {
    expect(await query(SOURCE, 'SELECT count(*) FROM incidents')).toBe('3')
    const role = await query(SOURCE, `SELECT count(*) FROM pg_roles WHERE rolname = '${database.username}'`, 'postgres')
    expect(role).toBe('1')
  })

  /** Idempotent by design — a re-run must not fail or disturb the data. */
  it('is idempotent, so a resumed move does not break the database', async () => {
    await run(SOURCE, ['set -eu', ...buildDatabaseSetupScript(database, { postgres: true })].join('\n'))
    expect(await query(SOURCE, 'SELECT count(*) FROM incidents')).toBe('3')
  })

  it('dumps the database to a file the move can carry', async () => {
    await run(SOURCE, [
      'set -euo pipefail',
      ...buildBackupScript('postgres', DB_NAME, '/tmp', database),
      `mv -f "$(ls -1t /tmp/${DB_NAME}-*.sql.gz | head -1)" ${DUMP}`,
    ].join('\n'))
    const size = await run(SOURCE, `stat -c %s ${DUMP}`)
    expect(Number(size.trim())).toBeGreaterThan(0)
    // A real dump, not an error page written to the file.
    const head = await run(SOURCE, `gunzip -c ${DUMP} | head -40`)
    expect(head).toContain('CREATE TABLE')
    expect(head.toLowerCase()).toContain('incidents')
  })

  it('starts from a target that does not have the database at all', async () => {
    const exists = await query(TARGET, `SELECT count(*) FROM pg_database WHERE datname = '${DB_NAME}'`, 'postgres')
    expect(exists).toBe('0')
  })

  /**
   * The whole point: rows written on one machine, read back on another, through
   * the builders the move actually composes.
   */
  it('restores every row on the target', async () => {
    const local = join(workspace, 'dump.sql.gz')
    await Bun.$`docker cp ${`${SOURCE}:${DUMP}`} ${local}`.quiet()
    await Bun.$`docker cp ${local} ${`${TARGET}:${DUMP}`}`.quiet()

    await run(TARGET, [
      ...buildDatabaseSetupScript(database, { postgres: true }),
      ...buildBackupRestoreScript(database, { from: DUMP }),
    ].join('\n'))

    expect(await query(TARGET, 'SELECT count(*) FROM incidents')).toBe('3')
    const titles = await query(TARGET, 'SELECT title FROM incidents ORDER BY id')
    expect(titles.split('\n')).toEqual(['edge outage', 'db failover', 'cert expiry'])
  })

  /**
   * The app connects as its own role, not as the superuser the restore ran as.
   * `pg_dump` records ownership; if the restore lost it, the app would come up
   * against a database full of tables it cannot read — which looks exactly like
   * an empty database until someone reads the logs.
   */
  it('preserves table ownership, so the application role can still read', async () => {
    const owner = await query(TARGET, "SELECT tableowner FROM pg_tables WHERE tablename = 'incidents'")
    expect(owner).toBe(database.username!)

    const out = await run(
      TARGET,
      `PGPASSWORD='${database.password}' psql -tA -h 127.0.0.1 -U ${database.username} -d ${DB_NAME} `
      + `-c 'SELECT count(*) FROM incidents'`,
    )
    expect(out.trim()).toBe('3')
  })

  it('leaves the source untouched, so the move is still reversible', async () => {
    expect(await query(SOURCE, 'SELECT count(*) FROM incidents')).toBe('3')
  })
})
