import { describe, expect, it } from 'bun:test'
import { buildSiteDeployScript } from './deploy-script'
import { inferSqliteSharedPath, sqliteSharedPaths, usesSqlite } from './sqlite-shared-path'

describe('inferSqliteSharedPath', () => {
  it('shares a release-relative sqlite file', () => {
    expect(inferSqliteSharedPath({ DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/stacks.sqlite' }))
      .toEqual({ path: 'database/stacks.sqlite' })
  })

  it('accepts the sqlite3 spelling and a leading ./', () => {
    expect(inferSqliteSharedPath({ DB_CONNECTION: 'SQLite3', DB_DATABASE: './database/app.sqlite' }))
      .toEqual({ path: 'database/app.sqlite' })
  })

  it('leaves a non-sqlite app alone', () => {
    expect(inferSqliteSharedPath({ DB_CONNECTION: 'pgsql', DB_DATABASE: 'loghq' })).toEqual({})
    expect(usesSqlite({ DB_CONNECTION: 'mysql' })).toBe(false)
  })

  /**
   * A path outside the release is not replaced by a deploy — it needs no
   * shared/ entry, and inventing one would symlink a path the app does not use.
   */
  it('leaves an absolute path alone', () => {
    expect(inferSqliteSharedPath({ DB_CONNECTION: 'sqlite', DB_DATABASE: '/var/data/app.sqlite' })).toEqual({})
  })

  it('refuses a path escaping the release', () => {
    expect(inferSqliteSharedPath({ DB_CONNECTION: 'sqlite', DB_DATABASE: '../shared/app.sqlite' })).toEqual({})
  })

  it('leaves an in-memory database alone', () => {
    expect(inferSqliteSharedPath({ DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' })).toEqual({})
  })

  /**
   * Guessing the filename would report the data as safe while sharing a path
   * the app may never write. Say what is unknown instead.
   */
  it('warns when the app is on sqlite but names no file', () => {
    const { path, warning } = inferSqliteSharedPath({ DB_CONNECTION: 'sqlite' })
    expect(path).toBeUndefined()
    expect(warning).toContain('DB_DATABASE')
  })

  it('does not duplicate a path the site already declares', () => {
    const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/app.sqlite' }
    expect(inferSqliteSharedPath(env, ['database/app.sqlite'])).toEqual({})
    // Including the spec form, which is how sibling sites share one database.
    expect(inferSqliteSharedPath(env, [{ path: 'database/app.sqlite', target: '/var/www/api/shared/db.sqlite' }]))
      .toEqual({})
    expect(sqliteSharedPaths(env, ['database/app.sqlite'])).toEqual([])
  })
})

describe('server-app deploy script', () => {
  const script = (env: Record<string, string>): string =>
    buildSiteDeployScript({
      siteName: 'app',
      slug: 'acme',
      artifactFetch: [],
      releaseId: 'rel1',
      execStart: '/usr/local/bin/bun run server.ts',
      envEntries: env,
      port: 3000,
    }).join('\n')

  /**
   * The failure this guards against: a SQLite file written inside the release
   * directory, which the NEXT deploy leaves behind in a pruned release.
   */
  it('shares the sqlite database without being told to', () => {
    const out = script({ DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/stacks.sqlite' })
    expect(out).toContain('/var/www/app/shared/database/stacks.sqlite')
    expect(out).toContain('ln -sfn /var/www/app/shared/database/stacks.sqlite /var/www/app/releases/rel1/database/stacks.sqlite')
  })

  it('records it in the shared-paths manifest, so a rollback relinks it', () => {
    const out = script({ DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/stacks.sqlite' })
    expect(out).toContain('database/stacks.sqlite\t/var/www/app/shared/database/stacks.sqlite')
  })

  it('adopts the live copy before placeholding it, so existing data is not lost', () => {
    const out = script({ DB_CONNECTION: 'sqlite', DB_DATABASE: 'database/stacks.sqlite' })
    const adopt = out.indexOf("ts_cloud_adopt_shared 'database/stacks.sqlite'")
    const touch = out.indexOf('touch /var/www/app/shared/database/stacks.sqlite')
    expect(adopt).toBeGreaterThan(-1)
    expect(touch).toBeGreaterThan(adopt)
  })

  it('adds nothing for a postgres app', () => {
    const out = script({ DB_CONNECTION: 'pgsql', DB_DATABASE: 'loghq' })
    expect(out).not.toContain('shared/loghq')
  })
})
