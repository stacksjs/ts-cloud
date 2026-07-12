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
 * leaving `current` dangling.
 *
 * With `unitBase` set (e.g. `myapp-api`), the script also swaps the running
 * systemd release instance for sites deployed zero-downtime style (templated
 * `<unitBase>@<releaseId>` units pinned to their release dirs): it starts the
 * instance for the rolled-back release — overlapping on the SO_REUSEPORT port —
 * then stops the newer one, so even the rollback itself is zero-downtime. Sites
 * on the legacy single unit just get a restart. The caller appends any engine
 * reload (php-fpm/queues) — see {@link import('./laravel-deploy')}.
 */
export function buildRollbackScript(paths: ReleasePaths, options: { to?: string, unitBase?: string } = {}): string[] {
  const flip = options.to
    ? [
        `[ -d ${paths.releases}/${options.to} ] || { echo "rollback target ${paths.releases}/${options.to} not found" >&2; exit 1; }`,
        `ln -sfn ${paths.releases}/${options.to} ${paths.current}.tmp`,
        `mv -Tf ${paths.current}.tmp ${paths.current}`,
      ]
    : [
        `TS_CLOUD_CURRENT=$(readlink -f ${paths.current} 2>/dev/null || true)`,
        // Newest release dir whose real path differs from current = the prior deploy.
        `TS_CLOUD_PREV=$(ls -1dt ${paths.releases}/*/ 2>/dev/null | sed 's#/$##' | while read -r r; do `
        + '[ "$(readlink -f "$r")" != "$TS_CLOUD_CURRENT" ] && { echo "$r"; break; }; done)',
        '[ -n "$TS_CLOUD_PREV" ] || { echo "no previous release to roll back to" >&2; exit 1; }',
        `ln -sfn "$TS_CLOUD_PREV" ${paths.current}.tmp`,
        `mv -Tf ${paths.current}.tmp ${paths.current}`,
        'echo "rolled back to $TS_CLOUD_PREV"',
      ]

  if (!options.unitBase)
    return flip

  const unitBase = options.unitBase
  return [
    ...flip,
    // Which release does `current` resolve to now? Its dir name is the
    // templated instance id.
    `TS_CLOUD_RB_ID=$(basename "$(readlink -f ${paths.current})")`,
    // Zero-downtime layout: start the rolled-back release's instance alongside
    // the current one (SO_REUSEPORT), then retire everything else.
    `if [ -f /etc/systemd/system/${unitBase}@.service ]; then `
    + `systemctl start "${unitBase}@\${TS_CLOUD_RB_ID}.service"; sleep 2; `
    + `systemctl is-active --quiet "${unitBase}@\${TS_CLOUD_RB_ID}.service" || { echo "rolled-back release failed to start" >&2; exit 1; }; `
    + `systemctl enable "${unitBase}@\${TS_CLOUD_RB_ID}.service" 2>/dev/null || true; `
    + `systemctl list-units --plain --no-legend --type=service "${unitBase}@*.service" 2>/dev/null | awk '{print $1}' | grep -v "^${unitBase}@\${TS_CLOUD_RB_ID}.service\$" | while read -r TS_CLOUD_U; do systemctl stop "\$TS_CLOUD_U" 2>/dev/null || true; systemctl disable "\$TS_CLOUD_U" 2>/dev/null || true; done; `
    + `elif [ -f /etc/systemd/system/${unitBase}.service ]; then systemctl restart ${unitBase}.service; fi`,
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
