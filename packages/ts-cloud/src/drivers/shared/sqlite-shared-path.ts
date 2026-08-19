/**
 * Infer the shared path for an app whose database is SQLite.
 *
 * A release directory is disposable: the next deploy is a NEW directory and the
 * old one is pruned. Anything the app writes and must keep therefore has to live
 * in `shared/` and be symlinked in (see {@link import('./releases')}). `.env` is
 * shared implicitly; everything else has to be declared in `site.sharedPaths`.
 *
 * A SQLite database is the one case ts-cloud can work out on its own, because
 * the connection and the file path are already in the environment it writes to
 * the box. Left undeclared, the file lands inside the release, and the deploy
 * after it starts the app on an empty database with no warning — the whole
 * dataset is one deploy from being orphaned inside a pruned release.
 *
 * So: read `DB_CONNECTION`/`DB_DATABASE` out of the site's resolved env, and
 * when they describe a release-relative SQLite file, share it automatically.
 * When they say SQLite but do not say where, say so loudly instead of guessing
 * a filename — a wrong guess would share a path the app never writes and leave
 * the real database exactly as exposed, while reporting that it is safe.
 */
import type { SharedPathEntry } from '@ts-cloud/core'
import { sharedPathOf } from './releases'

/**
 * `DB_CONNECTION` values that mean "a SQLite file on this box". Stacks and
 * Laravel both spell it `sqlite`; `sqlite3` shows up in hand-written configs
 * and PDO DSNs.
 */
const SQLITE_CONNECTIONS = new Set(['sqlite', 'sqlite3'])

/** In-memory databases have no file to keep — nothing to share, nothing to warn about. */
const IN_MEMORY = new Set([':memory:', 'memory'])

/** Is this site's resolved environment pointing at a SQLite database? */
export function usesSqlite(env: Record<string, string | undefined> | undefined): boolean {
  const connection = env?.DB_CONNECTION?.trim().toLowerCase()
  return connection != null && SQLITE_CONNECTIONS.has(connection)
}

/**
 * Normalize the configured database path to a release-relative one.
 *
 * Returns `undefined` when the path is not release-relative — absolute (it
 * already lives outside the release and survives on its own) or escaping the
 * release via `..` (which `shared/` cannot express, and which a symlink would
 * point somewhere surprising).
 */
function releaseRelativePath(value: string): string | undefined {
  const trimmed = value.trim().replace(/^\.\//, '')
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.startsWith('~')) return undefined
  if (trimmed.split('/').includes('..')) return undefined
  return trimmed.replace(/\/+$/, '')
}

export interface SqliteSharedPathInference {
  /**
   * Release-relative path to add to the site's shared paths. Absent when the
   * app is not on SQLite, the file already survives deploys, or the path could
   * not be determined.
   */
  path?: string
  /**
   * Why nothing could be inferred even though the app IS on SQLite — an
   * operator-facing sentence naming what to declare. Absent when there is
   * nothing to worry about.
   */
  warning?: string
}

/**
 * Work out whether a site's SQLite database needs to be added to its shared
 * paths, given the environment the deploy writes to the box and whatever the
 * site already declares.
 */
export function inferSqliteSharedPath(
  env: Record<string, string | undefined> | undefined,
  declared: readonly SharedPathEntry[] = [],
): SqliteSharedPathInference {
  if (!usesSqlite(env)) return {}

  const configured = env?.DB_DATABASE?.trim()
  // An in-memory database has no file to keep — nothing to share, and nothing
  // an operator could do about it if there were.
  if (configured && IN_MEMORY.has(configured.toLowerCase())) return {}

  if (!configured) {
    // An app can default its own database path internally (Stacks writes
    // `database/stacks.sqlite`), which the deploy never sees. Guessing that
    // filename would share a path the app may not use and report the data as
    // safe when it is not, so name the problem instead.
    return {
      warning:
        'DB_CONNECTION is sqlite but DB_DATABASE names no file, so ts-cloud cannot tell where the database lives. '
        + 'If it is written inside the release directory, the next deploy discards it. '
        + "Set DB_DATABASE, or list the file in the site's `sharedPaths`.",
    }
  }

  const relative = releaseRelativePath(configured)
  // Absolute (or `..`-escaping) paths are outside the release tree already —
  // a deploy replaces the release, not the filesystem around it.
  if (!relative) return {}

  // Already declared — the operator's own entry wins, including a
  // `SharedPathSpec` pointing at a database shared with a sibling site.
  if (declared.some(entry => sharedPathOf(entry) === relative)) return {}

  return { path: relative }
}

/**
 * The shared-path entries to append for a site's SQLite database — `[]` when
 * there is nothing to add. Kept separate from {@link inferSqliteSharedPath} so
 * script builders can splice it in without having to care about the warning,
 * which only the deploy driver can surface.
 */
export function sqliteSharedPaths(
  env: Record<string, string | undefined> | undefined,
  declared: readonly SharedPathEntry[] = [],
): SharedPathEntry[] {
  const { path } = inferSqliteSharedPath(env, declared)
  return path ? [path] : []
}
