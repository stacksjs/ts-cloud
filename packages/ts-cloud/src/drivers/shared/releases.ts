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
import type { SharedPathEntry } from '@ts-cloud/core'

/** Paths that are always shared across releases (Forge shares `.env` implicitly). */
export const DEFAULT_SHARED_PATHS: readonly string[] = ['storage', '.env']

/** Default number of past releases to retain for rollback. */
export const DEFAULT_KEEP_RELEASES = 4

/** Number of per-deploy output logs to keep on the box. */
export const DEFAULT_KEEP_DEPLOY_LOGS = 20

/** ts-cloud metadata dir for a site (deploy history + per-deploy logs). */
export function deployMetaDir(base: string): string {
  return `${base.replace(/\/+$/, '')}/.ts-cloud`
}

/** Append-only deploy history log path for a site. */
export function deployHistoryPath(base: string): string {
  return `${deployMetaDir(base)}/deploy-history.log`
}

/** Per-deploy output log path for a release. */
export function deployLogPath(base: string, releaseId: string): string {
  return `${deployMetaDir(base)}/deploys/${releaseId}.log`
}

/**
 * Manifest of the shared paths the last deploy declared, written on every deploy
 * so a rollback can relink them into an older release without knowing the site's
 * config. Lives beside the deploy history (outside `releases/`, so pruning a
 * release never takes it).
 */
export function sharedPathsManifestPath(base: string): string {
  return `${deployMetaDir(base)}/shared-paths`
}

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

/**
 * Is a shared path a regular file (placeheld with `touch`) rather than a
 * directory (`mkdir -p`)? Getting this wrong is quiet and nasty: a directory
 * touched as a file makes the app's first write fail on the box, long after the
 * deploy reported success.
 *
 * A file is either a known dotfile (`.env`, `.env.production`) or something
 * with an extension (`database.sqlite`). Everything else is a directory —
 * including dot-DIRECTORIES like `.ts-cloud`, which an earlier
 * "starts with a dot ⇒ file" rule misread.
 */
function isFileSharedPath(p: string): boolean {
  const name = p.split('/').pop() || p
  if (name === '.env' || name.startsWith('.env.')) return true
  return /\.[a-z0-9]+$/i.test(name)
}

/** The release-relative path an entry links, whichever form it takes. */
export function sharedPathOf(entry: SharedPathEntry): string {
  return typeof entry === 'string' ? entry : entry.path
}

/**
 * One entry per release-relative path, last declaration winning — so a site
 * that spells out `{ path: '.env', target: … }` overrides the implicit `.env`
 * rather than fighting it. A plain `new Set` cannot do this: two specs for the
 * same path are distinct objects.
 */
export function dedupeSharedPaths(entries: readonly SharedPathEntry[]): SharedPathEntry[] {
  const byPath = new Map<string, SharedPathEntry>()
  for (const entry of entries) byPath.set(sharedPathOf(entry), entry)
  return [...byPath.values()]
}

/** A shared path with its target and seeding rights resolved. */
interface ResolvedSharedPath {
  /** Release-relative path receiving the symlink. */
  path: string
  /** Absolute location the symlink points at. */
  target: string
  /** May this site create/seed the target? */
  seed: boolean
}

/**
 * Resolve a shared-path entry against a site's layout. A plain string is the
 * site-scoped form — `<base>/shared/<path>`, owned by this site alone. A spec
 * may point somewhere else entirely, which is how several sites of one project
 * share one file (see `SharedPathSpec`).
 */
function resolveSharedPath(paths: ReleasePaths, entry: SharedPathEntry): ResolvedSharedPath {
  if (typeof entry === 'string') return { path: entry, target: `${paths.shared}/${entry}`, seed: true }
  return {
    path: entry.path,
    target: entry.target ?? `${paths.shared}/${entry.path}`,
    seed: entry.seed !== false,
  }
}

/**
 * Shell function that seeds `shared/<p>` from the currently-live release the
 * FIRST time a path becomes shared, so turning existing on-box state into
 * shared state does not throw that state away.
 *
 * Without it, the deploy that starts sharing a path creates an empty
 * placeholder, links it in, and the live copy dies with its release — for a
 * SQLite database that is every production row, silently, on one deploy. The
 * copy runs only when `shared/<p>` does not exist yet and the live release
 * holds a REAL file/dir there (a symlink means an earlier deploy already shared
 * it), so it is a one-time adoption, not a per-deploy overwrite.
 *
 * SQLite's `-wal`/`-shm` sidecars are copied alongside a shared file when they
 * exist: a main database file adopted without its write-ahead log loses every
 * transaction committed since the last checkpoint.
 */
function buildAdoptSharedPathFn(paths: ReleasePaths): string[] {
  return [
    'ts_cloud_adopt_shared() {',
    '  TS_CLOUD_SP="$1"',
    '  TS_CLOUD_DST="$2"',
    `  TS_CLOUD_SRC="${paths.current}/$TS_CLOUD_SP"`,
    // Already shared — nothing to adopt, and never overwrite live shared state.
    '  if [ -e "$TS_CLOUD_DST" ]; then return 0; fi',
    // A symlink is a previous deploy's link into shared/; a missing path has
    // nothing to save.
    '  if [ -L "$TS_CLOUD_SRC" ] || [ ! -e "$TS_CLOUD_SRC" ]; then return 0; fi',
    '  mkdir -p "$(dirname "$TS_CLOUD_DST")"',
    '  cp -a "$TS_CLOUD_SRC" "$TS_CLOUD_DST"',
    '  for TS_CLOUD_SIDECAR in -wal -shm; do',
    '    if [ -f "$TS_CLOUD_SRC$TS_CLOUD_SIDECAR" ]; then cp -a "$TS_CLOUD_SRC$TS_CLOUD_SIDECAR" "$TS_CLOUD_DST$TS_CLOUD_SIDECAR"; fi',
    '  done',
    '  echo "[ts-cloud] adopted $TS_CLOUD_SP from the live release into shared/ — it now survives deploys"',
    '  return 0',
    '}',
  ]
}

/**
 * Ensure the releases/ and shared/ skeleton exist, including the Laravel
 * `storage` tree and an empty shared `.env` so symlinks never dangle.
 *
 * Also adopts any pre-existing live copy of a newly-shared path (see
 * {@link buildAdoptSharedPathFn}) and records the shared-path list in
 * {@link sharedPathsManifestPath}, so {@link buildRollbackScript} can relink an
 * older release at the same shared state.
 */
export function buildEnsureReleaseLayout(
  paths: ReleasePaths,
  sharedPaths: readonly SharedPathEntry[] = DEFAULT_SHARED_PATHS,
): string[] {
  const lines = [`mkdir -p ${paths.releases} ${paths.shared}`, ...buildAdoptSharedPathFn(paths)]
  const resolved = sharedPaths.map(entry => resolveSharedPath(paths, entry))

  for (const { path: p, target, seed } of resolved) {
    // A site that does not own the target neither seeds nor placeholds it: the
    // owner's deploy creates it. Creating an empty file here would make the
    // owner's adoption a no-op and lose whatever it was holding.
    if (!seed) continue

    // Adopt BEFORE placeholding: `touch`/`mkdir -p` would create the empty
    // destination and make the adoption a no-op.
    lines.push(`ts_cloud_adopt_shared '${p}' '${target}'`)
    if (isFileSharedPath(p)) {
      // Files (e.g. .env, database.sqlite) — create an empty placeholder so the
      // release symlink resolves; real contents are written by the deploy step.
      lines.push(`mkdir -p "$(dirname ${target})"`, `touch ${target}`)
    } else if (p === 'storage') {
      // Laravel's storage skeleton, created once in shared/.
      lines.push(
        `mkdir -p ${target}/app/public`,
        `mkdir -p ${target}/framework/cache/data`,
        `mkdir -p ${target}/framework/sessions`,
        `mkdir -p ${target}/framework/testing`,
        `mkdir -p ${target}/framework/views`,
        `mkdir -p ${target}/logs`,
      )
    } else {
      lines.push(`mkdir -p ${target}`)
    }
  }

  // Record what is shared so a rollback can relink an older release (one that
  // may predate the path being shared, and so still holds a real file there).
  // `<path>\t<target>`, so a rollback relinks at the same target even when it
  // lives outside this site.
  const manifest = sharedPathsManifestPath(paths.base)
  lines.push(
    `mkdir -p ${deployMetaDir(paths.base)}`,
    `cat > ${manifest} <<'TS_CLOUD_SHARED_PATHS_EOF'`,
    ...resolved.map(entry => `${entry.path}\t${entry.target}`),
    'TS_CLOUD_SHARED_PATHS_EOF',
  )

  return lines
}

/**
 * Take the site's deploy lock for the rest of the script.
 *
 * Two deploys of one site used to be free to run at the same time, and they
 * write to the same directories: the second one's `rm -rf releases/<id>` ran
 * against a tree the first was still extracting into, which fails with
 * "Directory not empty" — an error that reads like a permissions problem and
 * is really a race. It happens more easily than it sounds, because a deploy
 * whose *client* is interrupted keeps running on the box; the operator sees a
 * dead terminal and re-runs.
 *
 * `flock` on a descriptor held by the shell serializes them, and the lock is
 * released when the script exits however it exits. Waiting rather than failing
 * outright, because the common case is a retry that is only a few seconds
 * ahead of itself.
 */
export function buildDeployLock(paths: ReleasePaths, waitSeconds = 900): string[] {
  const lock = `${deployMetaDir(paths.base)}/deploy.lock`

  return [
    `mkdir -p "$(dirname ${lock})"`,
    `exec 9>${lock}`,
    `flock -w ${waitSeconds} 9 || { echo "[ts-cloud] another deploy of this site has held the lock for ${waitSeconds}s — refusing to race it" >&2; exit 1; }`,
  ]
}

/**
 * Clear the release directory, unless it is the one currently being served.
 *
 * Re-deploying a release id that is already live — the same commit twice, a
 * retry after an interrupted run — used to `rm -rf` the directory `current`
 * points at, so the site was serving a half-deleted tree until the new
 * extraction finished. The replacement is staged beside it and swapped in with
 * two renames, which is atomic enough that no request lands mid-swap.
 */
export function buildResetReleaseDir(paths: ReleasePaths): string[] {
  const staging = `${paths.release}.incoming`

  return [
    `rm -rf ${staging}`,
    `mkdir -p ${staging}`,
    ...buildIsReleaseLive(paths),
    'if [ "$TS_CLOUD_IS_LIVE" = "yes" ]; then',
    `  TS_CLOUD_STAGED=${staging}`,
    'else',
    `  rm -rf ${paths.release}`,
    `  mkdir -p ${paths.release}`,
    `  rmdir ${staging}`,
    `  TS_CLOUD_STAGED=${paths.release}`,
    'fi',
  ]
}

/**
 * Remove a half-built release if the deploy fails before it went live.
 *
 * The check has to run *when the trap fires*, not when it is armed. A deploy
 * arms this at the top and activates the release much later, so a value
 * computed up front says "not live" for the rest of the script — and a failure
 * in any step after activation would then delete the release the site had just
 * started serving. Both paths are resolved at that moment for the reason in
 * {@link buildIsReleaseLive}.
 */
export function buildStrandedReleaseTrap(paths: ReleasePaths): string {
  const live = `TS_CLOUD_TRAP_LIVE="$(readlink -f ${paths.current} 2>/dev/null || true)"`
  const target = `TS_CLOUD_TRAP_TARGET="$(readlink -f ${paths.release} 2>/dev/null || echo ${paths.release})"`
  const body = `if [ $? -ne 0 ]; then ${live}; ${target}; [ "$TS_CLOUD_TRAP_LIVE" = "$TS_CLOUD_TRAP_TARGET" ] || rm -rf ${paths.release}; fi`

  return `trap '${body}' EXIT`
}

/**
 * Set `TS_CLOUD_IS_LIVE` to "yes" when `current` resolves to this release.
 *
 * Both sides are resolved before comparing. Comparing a resolved `current`
 * against the literal release path looks equivalent and is not: one symlinked
 * ancestor anywhere above the site — `/var/www` moved onto a data volume, a
 * `/tmp` that is really `/private/tmp` — makes the two spellings differ, the
 * guard misses, and the branch it was guarding deletes the directory the site
 * is being served from.
 */
export function buildIsReleaseLive(paths: ReleasePaths): string[] {
  return [
    `TS_CLOUD_LIVE_PATH="$(readlink -f ${paths.current} 2>/dev/null || true)"`,
    `TS_CLOUD_RELEASE_PATH="$(readlink -f ${paths.release} 2>/dev/null || echo ${paths.release})"`,
    'if [ -n "$TS_CLOUD_LIVE_PATH" ] && [ "$TS_CLOUD_LIVE_PATH" = "$TS_CLOUD_RELEASE_PATH" ]; then TS_CLOUD_IS_LIVE=yes; else TS_CLOUD_IS_LIVE=no; fi',
  ]
}

/**
 * Move a staged release into place, if it was staged (see
 * {@link buildResetReleaseDir}). A no-op when the deploy extracted directly.
 */
export function buildPromoteStagedRelease(paths: ReleasePaths): string[] {
  const staging = `${paths.release}.incoming`

  // Plain `mv`, not `mv -T`: both destinations are removed first, so there is
  // no directory for `mv` to move *into* and the rename is unambiguous. `-T`
  // would say the same thing but is GNU-only, which silently makes this
  // untestable anywhere with a BSD userland.
  return [
    `if [ "$TS_CLOUD_STAGED" = "${staging}" ]; then`,
    `  rm -rf ${paths.release}.previous`,
    `  mv ${paths.release} ${paths.release}.previous`,
    `  mv ${staging} ${paths.release}`,
    `  rm -rf ${paths.release}.previous`,
    'fi',
  ]
}

/**
 * Seed an as-yet-empty shared FILE from the copy the incoming release shipped.
 *
 * {@link buildAdoptSharedPathFn} rescues state from the release that is
 * currently live, which covers a path that becomes shared on an existing site.
 * It cannot cover a site's FIRST deploy: there is no live release to adopt
 * from, so the layout step leaves a zero-byte placeholder and the link below
 * would replace the artifact's real file with it — an app shipping a seeded
 * SQLite database would come up empty on the very deploy that created it.
 *
 * Narrow on purpose: only a regular, non-empty file in the release, and only
 * when the shared target is still zero bytes (what a placeholder looks like,
 * and what no real SQLite database ever is — a database with any schema in it
 * is at least one page). It can therefore only ever put content where there
 * was none.
 */
function buildSeedSharedFromRelease(link: string, target: string): string[] {
  return [
    `if [ -f ${link} ] && [ ! -L ${link} ] && [ -s ${link} ] && [ ! -s ${target} ]; then`,
    `  cp -a ${link} ${target}`,
    `  echo "[ts-cloud] seeded shared/ from the release's own copy of the file"`,
    'fi',
  ]
}

/**
 * Symlink every shared path from `shared/` into the freshly checked-out release,
 * replacing whatever the checkout shipped (e.g. the repo's empty `storage`).
 */
export function buildLinkSharedPaths(
  paths: ReleasePaths,
  sharedPaths: readonly SharedPathEntry[] = DEFAULT_SHARED_PATHS,
): string[] {
  const lines: string[] = []
  for (const entry of sharedPaths) {
    const { path: p, target, seed } = resolveSharedPath(paths, entry)
    const link = `${paths.release}/${p}`
    const relink = [`rm -rf ${link}`, `mkdir -p "$(dirname ${link})"`, `ln -sfn ${target} ${link}`]

    // A site that owns the target always links: the layout step just created it.
    if (seed) {
      // `.env` is excluded: the deploy writes the shared one itself, and the
      // release's own env files are deleted before this runs.
      if (p !== '.env' && isFileSharedPath(p)) lines.push(...buildSeedSharedFromRelease(link, target))
      lines.push(...relink)
      continue
    }

    // A site that does NOT own the target links only once the target exists.
    // Linking at a target the owner has not created yet leaves a dangling
    // symlink, and an app that opens it CREATES the file — an empty database
    // sitting exactly where the owner was going to seed the real one, which
    // then finds the target present and skips. Until the owner has deployed,
    // this site keeps whatever the release shipped.
    lines.push(`if [ -e ${target} ]; then`, ...relink.map(l => `  ${l}`), 'fi')
  }
  return lines
}

/**
 * The same links as {@link buildLinkSharedPaths}, but for a release that is
 * already on disk and a shared-path list read from the box's manifest rather
 * than from config. `releaseExpr` is a shell expression for the release dir.
 *
 * Used by rollback: a release cut before a path became shared still holds its
 * own real copy there, so activating it would quietly swap the live state (the
 * database) for that release's stale snapshot. A no-op on a box with no
 * manifest — one that has never deployed a shared path.
 */
export function buildRelinkSharedPaths(paths: ReleasePaths, releaseExpr: string): string[] {
  const manifest = sharedPathsManifestPath(paths.base)
  return [
    `if [ -f ${manifest} ]; then`,
    // `<path>\t<target>`. A manifest written before targets existed has no tab,
    // in which case the target is this site's own shared/<path>.
    '  while IFS="\t" read -r TS_CLOUD_SP TS_CLOUD_TGT; do',
    '    [ -n "$TS_CLOUD_SP" ] || continue',
    `    [ -n "$TS_CLOUD_TGT" ] || TS_CLOUD_TGT="${paths.shared}/$TS_CLOUD_SP"`,
    '    [ -e "$TS_CLOUD_TGT" ] || continue',
    `    rm -rf ${releaseExpr}/"$TS_CLOUD_SP"`,
    `    mkdir -p "$(dirname ${releaseExpr}/"$TS_CLOUD_SP")"`,
    `    ln -sfn "$TS_CLOUD_TGT" ${releaseExpr}/"$TS_CLOUD_SP"`,
    `  done < ${manifest}`,
    'fi',
  ]
}

/**
 * Atomically repoint `current` at the new release. Writes a temp symlink and
 * `mv -T`s it over `current` so there is no window where `current` is missing.
 */
export function buildActivateRelease(paths: ReleasePaths): string[] {
  return [`ln -sfn ${paths.release} ${paths.current}.tmp`, `mv -Tf ${paths.current}.tmp ${paths.current}`]
}

/**
 * Roll the active release back to a previous one (Forge-style rollback). With
 * `to` set, points `current` at `releases/<to>`; otherwise picks the most recent
 * release that isn't the one `current` resolves to. Atomic (temp symlink + `mv
 * -T`), and a no-op-safe guard fails loudly if the target is missing rather than
 * leaving `current` dangling.
 *
 * Before the flip, every shared path recorded on the box is relinked into the
 * target release ({@link buildRelinkSharedPaths}) so a rollback moves the CODE
 * back without moving the DATA back — a release cut before a path became shared
 * still carries its own copy, and going live with it would silently swap the
 * database for a stale snapshot.
 *
 * With `unitBase` set (e.g. `myapp-api`), the script also swaps the running
 * systemd release instance for sites deployed zero-downtime style (templated
 * `<unitBase>@<releaseId>` units pinned to their release dirs): it starts the
 * instance for the rolled-back release — overlapping on the SO_REUSEPORT port —
 * then stops the newer one, so even the rollback itself is zero-downtime. Sites
 * on the legacy single unit just get a restart. The caller appends any engine
 * reload (php-fpm/queues) — see {@link import('./laravel-deploy')}.
 */
export function buildRollbackScript(paths: ReleasePaths, options: { to?: string; unitBase?: string } = {}): string[] {
  const flip = options.to
    ? [
        `[ -d ${paths.releases}/${options.to} ] || { echo "rollback target ${paths.releases}/${options.to} not found" >&2; exit 1; }`,
        // Point the target release at the CURRENT shared state before it goes
        // live: a release cut before a path was shared still holds its own real
        // copy, and activating that would swap live data for a stale snapshot.
        ...buildRelinkSharedPaths(paths, `${paths.releases}/${options.to}`),
        `ln -sfn ${paths.releases}/${options.to} ${paths.current}.tmp`,
        `mv -Tf ${paths.current}.tmp ${paths.current}`,
      ]
    : [
        `TS_CLOUD_CURRENT=$(readlink -f ${paths.current} 2>/dev/null || true)`,
        // Newest release dir whose real path differs from current = the prior deploy.
        `TS_CLOUD_PREV=$(ls -1dt ${paths.releases}/*/ 2>/dev/null | sed 's#/$##' | while read -r r; do ` +
          '[ "$(readlink -f "$r")" != "$TS_CLOUD_CURRENT" ] && { echo "$r"; break; }; done)',
        '[ -n "$TS_CLOUD_PREV" ] || { echo "no previous release to roll back to" >&2; exit 1; }',
        ...buildRelinkSharedPaths(paths, '"$TS_CLOUD_PREV"'),
        `ln -sfn "$TS_CLOUD_PREV" ${paths.current}.tmp`,
        `mv -Tf ${paths.current}.tmp ${paths.current}`,
        'echo "rolled back to $TS_CLOUD_PREV"',
      ]

  if (!options.unitBase) return flip

  const unitBase = options.unitBase
  return [
    ...flip,
    // Which release does `current` resolve to now? Its dir name is the
    // templated instance id.
    `TS_CLOUD_RB_ID=$(basename "$(readlink -f ${paths.current})")`,
    // Zero-downtime layout: start the rolled-back release's instance alongside
    // the current one (SO_REUSEPORT), then retire everything else.
    `if [ -f /etc/systemd/system/${unitBase}@.service ]; then ` +
      `systemctl start "${unitBase}@\${TS_CLOUD_RB_ID}.service"; sleep 2; ` +
      `systemctl is-active --quiet "${unitBase}@\${TS_CLOUD_RB_ID}.service" || { echo "rolled-back release failed to start" >&2; exit 1; }; ` +
      `systemctl enable "${unitBase}@\${TS_CLOUD_RB_ID}.service" 2>/dev/null || true; ` +
      `systemctl list-units --plain --no-legend --type=service "${unitBase}@*.service" 2>/dev/null | awk '{print $1}' | { grep -v "^${unitBase}@\${TS_CLOUD_RB_ID}.service\$" || true; } | while read -r TS_CLOUD_U; do systemctl stop "\$TS_CLOUD_U" 2>/dev/null || true; systemctl disable "\$TS_CLOUD_U" 2>/dev/null || true; done; ` +
      `elif [ -f /etc/systemd/system/${unitBase}.service ]; then systemctl restart ${unitBase}.service; fi`,
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

/** Owner marker recording which project a site's base dir belongs to. */
export function siteOwnerPath(base: string): string {
  return `${deployMetaDir(base)}/owner`
}

/**
 * Guard a site's base dir against cross-project deploys on a shared box
 * (`attachTo`): the first deploy stamps `<base>/.ts-cloud/owner` with the
 * project slug; a later deploy whose slug differs fails loudly instead of
 * silently overwriting another tenant's releases. Two projects can only trip
 * this by deriving the same site key (e.g. both claiming the same domain),
 * which is a config conflict the operator must resolve — not one deploys
 * should paper over. Emitted before anything mutates the dir.
 */
export function buildSiteOwnerGuard(base: string, slug: string): string[] {
  const owner = siteOwnerPath(base)
  return [
    `if [ -f "${owner}" ]; then`,
    `  TS_CLOUD_OWNER=$(cat "${owner}")`,
    `  if [ "$TS_CLOUD_OWNER" != "${slug}" ]; then`,
    `    echo "[ts-cloud] REFUSING deploy: ${base} belongs to project '$TS_CLOUD_OWNER', not '${slug}'. Another project on this box derives the same site key — give one of them a distinct site name/domain, or remove ${owner} to transfer ownership." >&2`,
    '    exit 1',
    '  fi',
    'else',
    `  mkdir -p "$(dirname "${owner}")"`,
    `  printf '%s\\n' "${slug}" > "${owner}"`,
    'fi',
  ]
}

export interface DeployHistoryOptions {
  /** This deploy's release id. */
  releaseId: string
  /** Commit SHA being deployed (recorded in the history line). */
  commit?: string
  /** Branch being deployed. */
  branch?: string
  /** Per-deploy logs to retain. @default {@link DEFAULT_KEEP_DEPLOY_LOGS} */
  keepLogs?: number
}

/**
 * Header lines that record deployment history + capture per-deploy output
 * (Forge's deployment log). Emitted near the top of the deploy script: it tees
 * all stdout/stderr to `<base>/.ts-cloud/deploys/<releaseId>.log` and installs
 * an EXIT trap that appends a `<ts>\t<releaseId>\t<commit>\t<status>` line to
 * `<base>/.ts-cloud/deploy-history.log` — so both successful and failed deploys
 * are recorded (the trap reads `$?`). Requires bash (the deploy script already
 * uses `set -euo pipefail`).
 */
export function buildDeployHistoryHeader(base: string, options: DeployHistoryOptions): string[] {
  const meta = deployMetaDir(base)
  const log = deployLogPath(base, options.releaseId)
  const history = deployHistoryPath(base)
  const keepLogs = Math.max(1, options.keepLogs ?? DEFAULT_KEEP_DEPLOY_LOGS)
  const commit = options.commit || ''
  const branch = options.branch || ''
  return [
    `mkdir -p ${meta}/deploys`,
    // Tee every line to the per-deploy log while still streaming to the driver.
    `exec > >(tee -a ${log}) 2>&1`,
    `echo "[ts-cloud] deploy ${options.releaseId} commit=${commit} branch=${branch} starting $(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    // Record outcome on exit (success or failure) via $?.
    'ts_cloud_record_deploy() {',
    '  TS_CLOUD_RC=$?',
    '  if [ "$TS_CLOUD_RC" -eq 0 ]; then TS_CLOUD_ST=success; else TS_CLOUD_ST=failed; fi',
    `  printf '%s\\t%s\\t%s\\t%s\\trc=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${options.releaseId}" "${commit}" "$TS_CLOUD_ST" "$TS_CLOUD_RC" >> ${history}`,
    '}',
    'trap ts_cloud_record_deploy EXIT',
    // Keep only the most recent N per-deploy logs.
    `ls -1t ${meta}/deploys/*.log 2>/dev/null | tail -n +${keepLogs + 1} | while read -r TS_CLOUD_OLDLOG; do rm -f "$TS_CLOUD_OLDLOG"; done`,
  ]
}
