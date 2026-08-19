/**
 * The assertion that would have caught "every deploy starts from an empty
 * database": write a row, deploy again, and require the row to still be there.
 *
 * These run the REAL generated shell against a real temp directory tree, so the
 * release layout is exercised end to end (adoption → symlink → activate →
 * rollback) rather than string-matched. The systemd/tarball parts of a deploy
 * are stubbed — a shipped release is a `cp` of a fixture, which is exactly what
 * `tar xzf` does to the release dir.
 */
import type { SharedPathEntry } from '@ts-cloud/core'
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildActivateRelease,
  buildEnsureReleaseLayout,
  buildLinkSharedPaths,
  buildRollbackScript,
  releasePaths,
} from '../../src/drivers/shared/releases'

/** What a Stacks app on SQLite shares: the database file (`.env` always). */
const SHARED = ['.env', 'database/stacks.sqlite']

const DB_REL = 'database/stacks.sqlite'

/**
 * The deploy targets Linux, where `mv -T` replaces the destination symlink
 * instead of moving into the directory it points at. macOS ships BSD `mv`,
 * which has no `-T` at all, so these tests would fail on the developer's
 * machine for a reason that has nothing to do with the layout. Emulate it
 * non-atomically — atomicity is asserted by the string-level tests in
 * `releases.test.ts`; what these tests care about is where `current` ends up.
 */
const BSD_MV_SHIM = `if [ "$(uname)" = Darwin ]; then
mv() { case "$1" in -T|-Tf|-fT) shift; rm -rf "$2"; command mv "$1" "$2";; *) command mv "$@";; esac; }
fi`

function run(script: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', ['-c', `${BSD_MV_SHIM}\n${script}`], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * One deploy of `releaseId`: ensure the layout, "extract" the release (source +
 * migrations, never a `.sqlite` — the packager excludes those), link the shared
 * paths, flip `current`. Mirrors buildSiteDeployScript's ordering minus systemd.
 */
function deploy(base: string, releaseId: string, shared: readonly SharedPathEntry[] = SHARED) {
  const paths = releasePaths(base, releaseId)
  const script = [
    'set -euo pipefail',
    ...buildEnsureReleaseLayout(paths, shared),
    `rm -rf ${paths.release}`,
    `mkdir -p ${paths.release}/database/migrations`,
    `echo 'create table if not exists notes (id integer primary key, body text);' > ${paths.release}/database/migrations/0001.sql`,
    ...buildLinkSharedPaths(paths, shared),
    ...buildActivateRelease(paths),
  ].join('\n')
  const out = run(script)
  expect(out.stderr).toBe('')
  expect(out.status).toBe(0)
  return out
}

/** Migrate + insert a row through whatever `current` points at, as the app does. */
function writeRow(base: string, body: string): void {
  const db = new Database(join(base, 'current', DB_REL), { create: true })
  db.run('create table if not exists notes (id integer primary key, body text)')
  db.run('insert into notes (body) values (?)', [body])
  db.close()
}

/** Every note the live release can read, in insertion order. */
function readRows(base: string): string[] {
  const db = new Database(join(base, 'current', DB_REL), { readonly: true })
  const rows = db.query('select body from notes order by id').all() as { body: string }[]
  db.close()
  return rows.map(r => r.body)
}

function withBase(fn: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'tscloud-shared-state-'))
  try {
    fn(base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

describe('shared state survives a deploy', () => {
  it('keeps rows written to the database across the next release', () => {
    withBase((base) => {
      deploy(base, 'r1')
      writeRow(base, 'written on r1')

      deploy(base, 'r2')

      // The whole point: the new release serves the SAME database.
      expect(readRows(base)).toEqual(['written on r1'])
    })
  })

  it('serves the database from shared/, not from inside the release', () => {
    withBase((base) => {
      deploy(base, 'r1')
      const link = join(base, 'releases/r1', DB_REL)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(base, 'shared', DB_REL))
      // Shipped files in the same directory are untouched — only the database
      // file is linked out, so migrations still ride along with the release.
      expect(existsSync(join(base, 'releases/r1/database/migrations/0001.sql'))).toBe(true)
    })
  })

  it('adopts the live database the first time a box starts sharing it', () => {
    withBase((base) => {
      // A box deployed by the OLD code: a real database file inside the live
      // release, no shared/ at all.
      const legacy = join(base, 'releases/r0')
      mkdirSync(join(legacy, 'database'), { recursive: true })
      run(`ln -sfn ${legacy} ${base}/current`)
      const db = new Database(join(base, 'current', DB_REL), { create: true })
      db.run('create table notes (id integer primary key, body text)')
      db.run(`insert into notes (body) values ('production row')`)
      db.close()

      const out = deploy(base, 'r1')

      expect(out.stdout).toContain('adopted database/stacks.sqlite')
      // The production row survived the deploy that introduced sharing — the
      // upgrade itself must not be the last data-losing deploy.
      expect(readRows(base)).toEqual(['production row'])
    })
  })

  it('adopts the write-ahead log alongside the database', () => {
    withBase((base) => {
      const legacy = join(base, 'releases/r0')
      mkdirSync(join(legacy, 'database'), { recursive: true })
      run(`ln -sfn ${legacy} ${base}/current`)
      writeFileSync(join(legacy, DB_REL), 'main')
      writeFileSync(join(legacy, `${DB_REL}-wal`), 'wal')
      writeFileSync(join(legacy, `${DB_REL}-shm`), 'shm')

      deploy(base, 'r1')

      // A main file adopted without its WAL loses everything committed since
      // the last checkpoint.
      expect(existsSync(join(base, 'shared', `${DB_REL}-wal`))).toBe(true)
      expect(existsSync(join(base, 'shared', `${DB_REL}-shm`))).toBe(true)
    })
  })

  it('never re-adopts once shared, so a later deploy cannot clobber live data', () => {
    withBase((base) => {
      deploy(base, 'r1')
      writeRow(base, 'live')
      // A release that somehow carries its own copy must not win.
      writeFileSync(join(base, 'releases/r1/database/decoy.sqlite'), 'stale')

      deploy(base, 'r2')
      writeRow(base, 'also live')

      expect(readRows(base)).toEqual(['live', 'also live'])
    })
  })
})

/**
 * Two sites of one project (an app and its API) each install under their own
 * base, so `database/stacks.sqlite` used to mean a different file for each —
 * and only the site that migrates ever had a schema. Pointing both at one
 * target is what makes "same database" true by construction rather than by
 * everyone remembering to configure it.
 */
describe('sibling sites share one database', () => {
  /** `/var/www/<slug>-<site>` for each site, plus the project-level target. */
  function project(root: string) {
    const target = join(root, 'acme-shared', DB_REL)
    return {
      main: join(root, 'acme-main'),
      api: join(root, 'acme-api'),
      target,
      // Only the migrating site owns the file; the API just links at it.
      shared: (seed: boolean) => ['.env', { path: DB_REL, target, seed }],
    }
  }

  it('lets the API read what the app wrote', () => {
    withBase((root) => {
      const p = project(root)

      deploy(p.main, 'r1', p.shared(true))
      deploy(p.api, 'r1', p.shared(false))

      writeRow(p.main, 'written by the app')

      expect(readRows(p.api)).toEqual(['written by the app'])
      expect(readlinkSync(join(p.api, 'releases/r1', DB_REL))).toBe(p.target)
    })
  })

  it('survives a deploy of both sites', () => {
    withBase((root) => {
      const p = project(root)
      deploy(p.main, 'r1', p.shared(true))
      deploy(p.api, 'r1', p.shared(false))
      writeRow(p.main, 'before')

      deploy(p.main, 'r2', p.shared(true))
      deploy(p.api, 'r2', p.shared(false))

      expect(readRows(p.api)).toEqual(['before'])
    })
  })

  /**
   * The ordering hazard, and the reason a non-owner neither placeholds the
   * target nor links at one that does not exist yet: deploying the API first
   * would otherwise put an empty database exactly where the app's real data was
   * about to be adopted, and the adoption would then skip.
   */
  it('is not decided by which site deploys first', () => {
    withBase((root) => {
      const p = project(root)
      // The app has live, unshared data from an older deploy.
      const legacy = join(p.main, 'releases/r0')
      mkdirSync(join(legacy, 'database'), { recursive: true })
      run(`ln -sfn ${legacy} ${p.main}/current`)
      const db = new Database(join(legacy, DB_REL), { create: true })
      db.run('create table notes (id integer primary key, body text)')
      db.run(`insert into notes (body) values ('production row')`)
      db.close()

      // The API goes first: it must neither create the shared file nor leave a
      // dangling link its own service would materialize as an empty database.
      deploy(p.api, 'r1', p.shared(false))
      expect(existsSync(p.target)).toBe(false)
      expect(existsSync(join(p.api, 'releases/r1', DB_REL))).toBe(false)

      // The app's deploy adopts the real data, and the API picks it up from its
      // next deploy onward.
      deploy(p.main, 'r1', p.shared(true))
      deploy(p.api, 'r2', p.shared(false))

      expect(readRows(p.main)).toEqual(['production row'])
      expect(readRows(p.api)).toEqual(['production row'])
    })
  })
})

describe('rollback moves the code back, not the data', () => {
  it('relinks a pre-sharing release at the shared database before activating it', () => {
    withBase((base) => {
      // r0 predates sharing: it holds a real (stale) database of its own.
      const stale = join(base, 'releases/r0')
      mkdirSync(join(stale, 'database'), { recursive: true })
      const db = new Database(join(stale, DB_REL), { create: true })
      db.run('create table notes (id integer primary key, body text)')
      db.run(`insert into notes (body) values ('stale snapshot')`)
      db.close()

      deploy(base, 'r1')
      writeRow(base, 'current data')

      const out = run(['set -euo pipefail', ...buildRollbackScript(releasePaths(base, 'r0'), { to: 'r0' })].join('\n'))
      expect(out.status).toBe(0)

      // Rolled back to r0's code, still reading today's database.
      expect(readlinkSync(join(base, 'current'))).toBe(join(base, 'releases/r0'))
      expect(readRows(base)).toEqual(['current data'])
    })
  })

  it('relinks the previous release when no target is given', () => {
    withBase((base) => {
      deploy(base, 'r1')
      writeRow(base, 'from r1')
      deploy(base, 'r2')
      writeRow(base, 'from r2')

      const out = run(['set -uo pipefail', ...buildRollbackScript(releasePaths(base, 'unused'))].join('\n'))
      expect(out.status).toBe(0)
      expect(readlinkSync(join(base, 'current'))).toBe(join(base, 'releases/r1'))
      expect(readRows(base)).toEqual(['from r1', 'from r2'])
    })
  })

  it('is a no-op on a box with no shared-path manifest', () => {
    withBase((base) => {
      mkdirSync(join(base, 'releases/r0'), { recursive: true })
      mkdirSync(join(base, 'releases/r1'), { recursive: true })
      run(`ln -sfn ${base}/releases/r1 ${base}/current`)

      const out = run(['set -uo pipefail', ...buildRollbackScript(releasePaths(base, 'unused'))].join('\n'))
      expect(out.status).toBe(0)
      expect(readlinkSync(join(base, 'current'))).toBe(join(base, 'releases/r0'))
    })
  })
})
