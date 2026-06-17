/**
 * Zero-downtime atomic release management for Forge-style git deploys.
 *
 * Directory layout under a site's base (`/var/www/<site>`):
 *   releases/<id>/   one checkout per deploy
 *   shared/          files persisted across releases (storage, .env, …)
 *   current ->       symlink to the active release
 *
 * A deploy clones into `releases/<id>`, symlinks the shared paths in, runs the
 * deploy script, then atomically repoints `current`. Old releases are pruned
 * to a retention count for rollback. These map to Forge's deploy macros:
 *   $CREATE_RELEASE   → {@link buildEnsureReleaseLayout} + git clone + {@link buildLinkSharedPaths}
 *   $ACTIVATE_RELEASE → {@link buildActivateRelease} (+ {@link buildPruneReleases})
 */

/** Paths that are always shared across releases (Forge shares `.env` implicitly). */
export const DEFAULT_SHARED_PATHS: readonly string[] = ['storage', '.env']

/** Default number of past releases to retain for rollback. */
export const DEFAULT_KEEP_RELEASES = 4

export interface ReleasePaths {
  /** Site base directory (`/var/www/<site>`). */
  base: string
  /** Releases parent (`<base>/releases`). */
  releases: string
  /** Shared parent (`<base>/shared`). */
  shared: string
  /** Active-release symlink (`<base>/current`). */
  current: string
  /** This deploy's release dir (`<base>/releases/<id>`). */
  release: string
}

/** Resolve the standard release layout paths for a site + release id. */
export function releasePaths(base: string, releaseId: string): ReleasePaths {
  const root = base.replace(/\/+$/, '')
  return {
    base: root,
    releases: `${root}/releases`,
    shared: `${root}/shared`,
    current: `${root}/current`,
    release: `${root}/releases/${releaseId}`,
  }
}

/** A shared path is a regular file (linked as a file) when it looks like `.env` or has a dot-extension. */
function isFileSharedPath(p: string): boolean {
  const name = p.split('/').pop() || p
  return name.startsWith('.') || /\.[a-z0-9]+$/i.test(name)
}

/**
 * Ensure the releases/ and shared/ skeleton exist, including the Laravel
 * `storage` tree and an empty shared `.env` so symlinks never dangle.
 */
export function buildEnsureReleaseLayout(paths: ReleasePaths, sharedPaths: readonly string[] = DEFAULT_SHARED_PATHS): string[] {
  const lines = [
    `mkdir -p ${paths.releases} ${paths.shared}`,
  ]

  for (const p of sharedPaths) {
    if (isFileSharedPath(p)) {
      // Files (e.g. .env, database.sqlite) — create an empty placeholder so the
      // release symlink resolves; real contents are written by the deploy step.
      lines.push(`mkdir -p "$(dirname ${paths.shared}/${p})"`, `touch ${paths.shared}/${p}`)
    }
    else if (p === 'storage') {
      // Laravel's storage skeleton, created once in shared/.
      lines.push(
        `mkdir -p ${paths.shared}/storage/app/public`,
        `mkdir -p ${paths.shared}/storage/framework/cache/data`,
        `mkdir -p ${paths.shared}/storage/framework/sessions`,
        `mkdir -p ${paths.shared}/storage/framework/testing`,
        `mkdir -p ${paths.shared}/storage/framework/views`,
        `mkdir -p ${paths.shared}/storage/logs`,
      )
    }
    else {
      lines.push(`mkdir -p ${paths.shared}/${p}`)
    }
  }

  return lines
}

/**
 * Symlink every shared path from `shared/` into the freshly checked-out release,
 * replacing whatever the checkout shipped (e.g. the repo's empty `storage`).
 */
export function buildLinkSharedPaths(paths: ReleasePaths, sharedPaths: readonly string[] = DEFAULT_SHARED_PATHS): string[] {
  const lines: string[] = []
  for (const p of sharedPaths) {
    const target = `${paths.shared}/${p}`
    const link = `${paths.release}/${p}`
    lines.push(
      `rm -rf ${link}`,
      `mkdir -p "$(dirname ${link})"`,
      `ln -sfn ${target} ${link}`,
    )
  }
  return lines
}

/**
 * Atomically repoint `current` at the new release. Writes a temp symlink and
 * `mv -T`s it over `current` so there is no window where `current` is missing.
 */
export function buildActivateRelease(paths: ReleasePaths): string[] {
  return [
    `ln -sfn ${paths.release} ${paths.current}.tmp`,
    `mv -Tf ${paths.current}.tmp ${paths.current}`,
  ]
}

/**
 * Roll the active release back to a previous one (Forge-style rollback). With
 * `to` set, points `current` at `releases/<to>`; otherwise picks the most recent
 * release that isn't the one `current` resolves to. Atomic (temp symlink + `mv
 * -T`), and a no-op-safe guard fails loudly if the target is missing rather than
 * leaving `current` dangling. The caller appends the engine reload
 * (php-fpm/queues) — see {@link import('./laravel-deploy')}.
 */
export function buildRollbackScript(paths: ReleasePaths, options: { to?: string } = {}): string[] {
  if (options.to) {
    const target = `${paths.releases}/${options.to}`
    return [
      `[ -d ${target} ] || { echo "rollback target ${target} not found" >&2; exit 1; }`,
      `ln -sfn ${target} ${paths.current}.tmp`,
      `mv -Tf ${paths.current}.tmp ${paths.current}`,
    ]
  }
  return [
    `TS_CLOUD_CURRENT=$(readlink -f ${paths.current} 2>/dev/null || true)`,
    // Newest release dir whose real path differs from current = the prior deploy.
    `TS_CLOUD_PREV=$(ls -1dt ${paths.releases}/*/ 2>/dev/null | sed 's#/$##' | while read -r r; do `
    + '[ "$(readlink -f "$r")" != "$TS_CLOUD_CURRENT" ] && { echo "$r"; break; }; done)',
    '[ -n "$TS_CLOUD_PREV" ] || { echo "no previous release to roll back to" >&2; exit 1; }',
    `ln -sfn "$TS_CLOUD_PREV" ${paths.current}.tmp`,
    `mv -Tf ${paths.current}.tmp ${paths.current}`,
    'echo "rolled back to $TS_CLOUD_PREV"',
  ]
}

/**
 * Remove all but the newest `keep` releases (by mtime). `current` always points
 * at the newest, so it is never pruned.
 */
export function buildPruneReleases(paths: ReleasePaths, keep: number = DEFAULT_KEEP_RELEASES): string[] {
  const n = Math.max(1, keep)
  return [
    // Never delete whatever `current` resolves to, even if an older release's
    // mtime got bumped — losing the live release would take the site down.
    `TS_CLOUD_CURRENT=$(readlink -f ${paths.current} 2>/dev/null || true)`,
    // ls -1dt: dirs newest-first; keep the newest N; delete the rest except current.
    `ls -1dt ${paths.releases}/*/ 2>/dev/null | sed 's#/$##' | tail -n +${n + 1} | while read -r TS_CLOUD_OLD; do`,
    '  [ "$(readlink -f "$TS_CLOUD_OLD")" = "$TS_CLOUD_CURRENT" ] || rm -rf "$TS_CLOUD_OLD"',
    'done',
  ]
}
