/**
 * Shared deploy script helpers for Forge-style compute deploys.
 *
 * Both server-app and server-static sites deploy with **zero downtime** the same
 * way PHP/Laravel sites do (Envoyer-style): the artifact is unpacked into a fresh
 * `releases/<id>` directory, shared paths (`.env`) are symlinked in, and the
 * `current` symlink is repointed atomically (`mv -Tf`). The gateway serves the
 * site from `<base>/current`, so a static swap is instantaneous (no window where
 * the docroot is empty), and an app restart re-execs against the already-staged
 * release (no window where the code is half-replaced). Old releases are kept for
 * instant rollback. See {@link import('./releases')}.
 */
import type { SharedPathEntry } from '@ts-cloud/core'
import { formatEnvFile } from './env-file'
import { buildActivateRelease, buildDeployLock, buildEnsureReleaseLayout, buildLinkSharedPaths, buildPromoteStagedRelease, buildPruneReleases, buildResetReleaseDir, buildStrandedReleaseTrap, dedupeSharedPaths, DEFAULT_KEEP_RELEASES, releasePaths } from './releases'
import { sqliteSharedPaths } from './sqlite-shared-path'

/**
 * Translate a `start` command (e.g. "bun run server.ts") into an absolute
 * systemd ExecStart by swapping the leading runtime word for its absolute path.
 */
export function resolveExecStart(start: string, runtime: 'bun' | 'node' | 'deno'): string {
  const bin =
    runtime === 'bun' ? '/usr/local/bin/bun' : runtime === 'deno' ? '/usr/local/bin/deno' : '/usr/local/bin/node'
  const args = start.replace(/^(bun|node|deno)\s+/, '')
  return `${bin} ${args}`
}

export interface BuildSiteDeployScriptOptions {
  siteName: string
  slug: string
  /** How the remote host obtains the release tarball */
  artifactFetch: string[]
  /** Site base dir holding `releases/`, `shared/`, `current`. Default `/var/www/<site>`. */
  appDir?: string
  /** Unique id for this release dir (typically the commit sha). */
  releaseId: string
  execStart: string
  envEntries: Record<string, string>
  port?: number
  /** Past releases to keep for rollback. @default {@link DEFAULT_KEEP_RELEASES} */
  keepReleases?: number
  /**
   * Commands run inside the new release dir after extraction + `.env` link,
   * before the `current` symlink is repointed and the service restarted.
   * Typically dependency install and/or build steps (e.g.
   * `bun install --frozen-lockfile`, `bun run build`) so the tarball can omit
   * `node_modules`.
   */
  preStartCommands?: string[]
  /**
   * Extra paths kept in `shared/` and symlinked into each release, so they
   * survive a deploy. `.env` is always shared; anything the app WRITES and must
   * keep (a state directory, a database file) has to be listed here or the next
   * release silently starts from empty.
   *
   * A `SharedPathSpec` entry points somewhere other than this site's own
   * `shared/` — how several sites of one project share one file.
   */
  sharedPaths?: readonly SharedPathEntry[]
  /**
   * True zero-downtime cutover for ported sites: the new release runs as its
   * own systemd instance (`<slug>-<site>@<releaseId>`) that binds the same
   * port via SO_REUSEPORT while the old instance still serves, must pass a
   * health gate, and only then is the old instance stopped. A release that
   * crashes on boot fails the deploy with the old release still serving.
   *
   * Requires the app to bind with `reusePort` (Stacks' server does in
   * production). Defaults to true when `port` is set; portless sites
   * (queue workers, schedulers) always use the stop/start flow because two
   * overlapping instances would double-process their work.
   */
  zeroDowntime?: boolean
  /**
   * HTTP path polled on `127.0.0.1:<port>` as part of the health gate (e.g.
   * `/health`). Optional — without it the gate is "the instance stays
   * active for {@link BuildSiteDeployScriptOptions.healthGateSeconds}".
   */
  healthCheckPath?: string
  /**
   * Seconds the new instance must stay active (and, with
   * {@link BuildSiteDeployScriptOptions.healthCheckPath}, respond 2xx/3xx)
   * before the old instance is stopped.
   * @default 5
   */
  healthGateSeconds?: number
  /**
   * systemd `MemoryHigh` for the app unit. See {@link SiteConfig.memoryHigh}.
   * @default '2G'
   */
  memoryHigh?: string
  /** systemd `MemoryMax` for the app unit. Unset by default. */
  memoryMax?: string
  /**
   * systemd `CPUWeight` for the unit — relative CPU share under contention.
   *
   * Everything on a shared box competes for the same eight cores, and not
   * everything on it matters equally: the gateway every tenant is served
   * through should outrank a batch scanner, and a monitoring dashboard should
   * outrank neither. Left unset the kernel gives every unit the same weight,
   * so a background job saturating the CPU degrades the serving path just as
   * much as it degrades itself.
   *
   * Unset by default: a box with one workload has nothing to prioritise, and
   * inventing a hierarchy where none was asked for is its own surprise.
   */
  cpuWeight?: number
  /** systemd `IOWeight` — the same idea for disk bandwidth. Unset by default. */
  ioWeight?: number
  /** systemd `TasksMax` — cap on threads/processes. Unset by default. */
  tasksMax?: number
  /**
   * systemd `TimeoutStopSec` — how long a unit may take to shut down before
   * systemd escalates from SIGTERM to SIGKILL.
   *
   * Worth raising for a worker that drains on SIGTERM. systemd's default is 90
   * seconds, which is generous for a server and far too short for a job that
   * finishes the shard in its hands before letting go: it gets killed
   * mid-write instead, which is precisely the outcome the drain exists to
   * avoid. A trail-ingest worker on a shared box was SIGKILLed exactly that
   * way while logging `finishing current shard`.
   *
   * Unset by default — systemd's own default is right for anything that can
   * stop immediately, and a long stop timeout on a service that hangs is a
   * deploy that waits for it.
   */
  stopTimeout?: string
}

/**
 * Build the remote shell commands that install/refresh a server-app site on a
 * compute target with an atomic release (Envoyer-style): unpack into
 * `releases/<id>`, link the shared `.env`, build, then cut over.
 *
 * The cutover has two modes:
 * - **zero-downtime** (default for ported sites): the new release starts as a
 *   templated systemd instance that shares the port via SO_REUSEPORT with the
 *   still-running old instance, must pass a health gate, and only then does
 *   the old instance stop — no dropped connections, and a crash-on-boot
 *   release fails the deploy with the old one still serving.
 * - **restart** (portless sites, or `zeroDowntime: false`): the classic flip
 *   `current` + `systemctl restart` — correct for workers/schedulers where two
 *   overlapping instances would double-process work.
 */
export function buildSiteDeployScript(options: BuildSiteDeployScriptOptions): string[] {
  const {
    siteName,
    slug,
    artifactFetch,
    releaseId,
    execStart,
    envEntries,
    port,
    keepReleases = DEFAULT_KEEP_RELEASES,
    preStartCommands = [],
    healthCheckPath,
    healthGateSeconds = 5,
    // A shared box runs many tenants. Without a limit, one that leaks fills
    // memory and then swap, and the kernel's OOM killer starts choosing
    // victims box-wide — a leak in one app takes every other tenant down with
    // it, which is exactly how a 15G host was lost to a single service that
    // had grown to 3.2G. `MemoryHigh` squeezes the offender's own cgroup
    // first. Soft by default and generous on purpose: it throttles and
    // reclaims rather than killing, so it cannot turn a heavy-but-healthy app
    // into a restart loop. Set `memoryMax` per site once its ceiling is known.
    memoryHigh = '2G',
    memoryMax,
    cpuWeight,
    ioWeight,
    tasksMax,
    stopTimeout,
  } = options
  // Emitted into both unit shapes below, so a site's declared priority does not
  // depend on whether it happens to have a port.
  const qosDirectives = [
    ...(cpuWeight != null ? [`CPUWeight=${cpuWeight}`] : []),
    ...(ioWeight != null ? [`IOWeight=${ioWeight}`] : []),
    ...(tasksMax != null ? [`TasksMax=${tasksMax}`] : []),
    ...(stopTimeout ? [`TimeoutStopSec=${stopTimeout}`] : []),
  ]
  const zeroDowntime = options.zeroDowntime ?? port != null
  const base = options.appDir ?? `/var/www/${siteName}`
  const paths = releasePaths(base, releaseId)
  const unitBase = `${slug}-${siteName}`
  const serviceName = `${unitBase}.service`
  const tarball = releaseTarballTmpPath(slug, siteName, releaseId)
  // `.env` is always shared; a site adds anything else it writes and must keep.
  // A SQLite database is added for it: the deploy already knows the connection
  // and the file path from the env it is about to write, and an undeclared
  // SQLite file inside the release is discarded by the NEXT deploy.
  const declaredSharedPaths = options.sharedPaths ?? []
  const sharedPaths = dedupeSharedPaths([
    '.env',
    ...declaredSharedPaths,
    ...sqliteSharedPaths(envEntries, declaredSharedPaths),
  ])

  const envFile = formatEnvFile(envEntries)

  // preStart (install / build) runs inside the NEW release dir. Bun auto-loads
  // the linked `.env` from the cwd, so build steps see the same config as the
  // running service. The release isn't live yet, so a slow build never affects
  // the currently-serving release.
  const preStart = preStartCommands.length > 0 ? [`cd ${paths.release}`, ...preStartCommands] : []

  const stageRelease = [
    'set -euo pipefail',
    // Serialize deploys of this site before touching anything (see
    // buildDeployLock): a second deploy racing the first is how a release dir
    // gets `rm -rf`'d while it is still being extracted into.
    ...buildDeployLock(paths),
    // A failed deploy must not strand its half-built release dir: rollback
    // picks the newest non-current dir and would activate this never-activated
    // (broken) release. On any failure before activation, remove it.
    buildStrandedReleaseTrap(paths),
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, sharedPaths),
    // Unpack this deploy into its own release dir. When that id is the one
    // being served — the same commit deployed twice, a retry after an
    // interrupted run — it is staged beside the live tree and swapped in
    // below, rather than deleted out from under the running service.
    ...buildResetReleaseDir(paths),
    `tar xzf ${tarball} -C "$TS_CLOUD_STAGED"`,
    // Drop the staged tarball once extracted — don't leave a world-readable
    // copy of the release (or a stale one for a later deploy to trip over).
    `rm -f ${tarball}`,
    // Persist the .env in shared/ (survives releases) and link it into the release.
    `cat > ${paths.shared}/.env <<'TS_CLOUD_ENV_EOF'`,
    envFile,
    'TS_CLOUD_ENV_EOF',
    `chmod 600 ${paths.shared}/.env`,
    // The DEPLOY owns the port (systemd `Environment=PORT` below is authoritative).
    // Strip any committed PORT* from the app's env files so it can never leak
    // back in: a scaffold's `.env.production` PORT=3000 otherwise makes a tenant
    // app bind :3000 and SO_REUSEPORT-round-robin with the box owner's app on the
    // shared box — the "stacksjs.com intermittently served another site" bug.
    // Bun natively loads `.env`/`.env.<mode>`, so strip every env file here, not
    // just the shared one.
    ...buildPromoteStagedRelease(paths),
    // `envEntries` is the authoritative, already-resolved runtime environment.
    // Remove deploy-time env files from the artifact before linking shared/.env:
    // Bun loads `.env.production` after `.env`, so committed ciphertext otherwise
    // overrides the decrypted values even though the deploy generated a correct
    // shared file. Examples remain available as documentation.
    `find ${paths.release} -maxdepth 1 \\( -type f -o -type l \\) -name '.env*' ! -name '.env.example' ! -name '*.example' -delete`,
    `sed -i -E '/^[[:space:]]*(PORT|PORT_BACKEND|PORT_ADMIN|PORT_FRONTEND)[[:space:]]*=/d' ${paths.shared}/.env 2>/dev/null || true`,
    ...buildLinkSharedPaths(paths, sharedPaths),
    ...preStart,
  ]

  if (zeroDowntime && port != null) {
    const instance = `${unitBase}@${releaseId}.service`
    const gatePath = healthCheckPath
      ? healthCheckPath.startsWith('/')
        ? healthCheckPath
        : `/${healthCheckPath}`
      : null

    // On gate failure the new instance is stopped and the deploy exits 1 —
    // `current` has NOT been flipped and the old instance never stopped, so
    // the box keeps serving the previous release untouched.
    const failGate = `{ echo "[ts-cloud] release ${releaseId} failed its health gate — previous release keeps serving" >&2; journalctl -u ${instance} -n 50 --no-pager >&2 || true; systemctl stop ${instance} 2>/dev/null || true; exit 1; }`

    return [
      ...stageRelease,
      // Templated unit: each release runs as its own instance pinned to its
      // release dir (%i), so old + new can overlap on the same SO_REUSEPORT
      // port during the cutover.
      `cat > /etc/systemd/system/${unitBase}@.service <<'TS_CLOUD_UNIT_EOF'`,
      '[Unit]',
      `Description=${siteName} release %i (managed by ts-cloud)`,
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${paths.releases}/%i`,
      `ExecStart=${execStart}`,
      'Restart=always',
      'RestartSec=5',
      'MemoryAccounting=true',
      ...(memoryHigh ? [`MemoryHigh=${memoryHigh}`] : []),
      ...(memoryMax ? [`MemoryMax=${memoryMax}`] : []),
      ...qosDirectives,
      `EnvironmentFile=${paths.releases}/%i/.env`,
      `Environment=PORT=${port}`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'TS_CLOUD_UNIT_EOF',
      'systemctl daemon-reload',
      // Remember what is serving right now — retired only after the gate.
      `TS_CLOUD_OLD_UNITS=$(systemctl list-units --plain --no-legend --type=service "${unitBase}@*.service" 2>/dev/null | awk '{print $1}' | grep -v "^${instance}\$" || true)`,
      // Migration from the pre-templated layout: a release started before
      // SO_REUSEPORT support can't share its port, so the very first
      // zero-downtime deploy does one last stop-then-start cutover.
      `if [ -f /etc/systemd/system/${serviceName} ] && systemctl is-active --quiet ${serviceName}; then echo "[ts-cloud] retiring pre-zero-downtime unit ${serviceName} (one-time restart cutover)"; systemctl stop ${serviceName}; fi`,
      // `restart` starts an inactive new-SHA instance just like `start`, but it
      // also refreshes an already-active same-SHA instance after its release
      // directory and EnvironmentFile were atomically replaced. A plain start
      // is a no-op in that retry case and strands the process in a deleted cwd.
      `systemctl restart ${instance}`,
      // Health gate (attempt 1): the instance must stay active for the whole
      // window (a crash-on-boot lands in activating/auto-restart and fails
      // is-active). When the app binds SO_REUSEPORT the new release overlaps
      // the old on the shared port and this passes straight through — true
      // zero downtime.
      `TS_CLOUD_GATE_OK=1; for TS_CLOUD_I in $(seq 1 ${Math.max(1, healthGateSeconds)}); do sleep 1; systemctl is-active --quiet ${instance} || { TS_CLOUD_GATE_OK=0; break; }; done`,
      // Self-heal: if the new release could NOT stay up alongside the old one
      // (typically because the app does not bind SO_REUSEPORT, so the old
      // instance still held the port), retire the previous instances now and
      // restart the new one. That trades a brief (~RestartSec) blip for a
      // working deploy instead of a hard failure; a genuinely broken release
      // still fails the retry gate and leaves the old release in place.
      `if [ "\$TS_CLOUD_GATE_OK" -ne 1 ]; then echo "[ts-cloud] release ${releaseId} could not overlap the previous release (no SO_REUSEPORT?) — retiring old instances and retrying" >&2; for TS_CLOUD_RU in \${TS_CLOUD_OLD_UNITS}; do systemctl stop "\$TS_CLOUD_RU" 2>/dev/null || true; done; systemctl restart ${instance}; for TS_CLOUD_I in $(seq 1 ${Math.max(1, healthGateSeconds)}); do sleep 1; systemctl is-active --quiet ${instance} || ${failGate}; done; fi`,
      // … and, when configured, answer 2xx/3xx on the health path. (With both
      // instances on the port the probe may hit either — combined with the
      // is-active window that still catches dead-new and dead-port alike.)
      ...(gatePath ? [`curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:${port}${gatePath}" || ${failGate}`] : []),
      // Promote: flip `current` (tooling + gateway reference), persist across
      // boots, then retire whatever served the previous release.
      ...buildActivateRelease(paths),
      `systemctl enable ${instance} 2>/dev/null || true`,
      `for TS_CLOUD_U in \${TS_CLOUD_OLD_UNITS}; do systemctl stop "\$TS_CLOUD_U" 2>/dev/null || true; systemctl disable "\$TS_CLOUD_U" 2>/dev/null || true; done`,
      // The port is only knowable once the old instances are gone.
      //
      // `is-active` says a process is running, not that it is listening, and
      // the two come apart exactly here: a server that swallows its own bind
      // error keeps its process alive with no socket. During the overlap
      // window the old instance still holds the port, so the gate above sees a
      // healthy unit and a served port and promotes — and retiring the old
      // instance then leaves the port dark. That is how a deploy of
      // theopentimes' broadcast service passed every check and still answered
      // 502 (`Failed to start server. Is port ${port} in use?`, unit `active`).
      //
      // A restart now lands on a free port, so the self-heal is the same one
      // the overlap failure already uses. Only a release that cannot bind an
      // uncontended port fails here, and that is worth failing on.
      `TS_CLOUD_LISTENING=0; for TS_CLOUD_I in $(seq 1 ${Math.max(1, healthGateSeconds)}); do if ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .; then TS_CLOUD_LISTENING=1; break; fi; sleep 1; done`,
      `if [ "\$TS_CLOUD_LISTENING" -ne 1 ]; then echo "[ts-cloud] nothing is listening on ${port} after retiring the previous release — restarting ${instance} on the now-free port" >&2; systemctl restart ${instance}; for TS_CLOUD_I in $(seq 1 ${Math.max(1, healthGateSeconds)}); do if ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .; then TS_CLOUD_LISTENING=1; break; fi; sleep 1; done; fi`,
      `if [ "\$TS_CLOUD_LISTENING" -ne 1 ]; then echo "[ts-cloud] ${instance} is active but never bound ${port}" >&2; journalctl -u ${instance} -n 50 --no-pager >&2 || true; exit 1; fi`,
      // Drop enabled-but-stopped instances from older deploys and the legacy
      // non-templated unit so only the live release starts at boot. The glob
      // also matches the TEMPLATE file (`<base>@.service`) — never disable it:
      // disabling a template removes every instance's enablement symlink,
      // including the one for the release enabled above (nothing would start
      // at boot).
      // Brace-group the grep so `|| true` guards only the grep (an empty match
      // list makes grep exit 1, which would otherwise fail the deploy under
      // `set -euo pipefail` at the very last step, after the release is live).
      `systemctl list-unit-files --plain --no-legend "${unitBase}@*.service" 2>/dev/null | awk '{print $1}' | { grep -v -e "^${instance}\$" -e "^${unitBase}@\\.service\$" || true; } | while read -r TS_CLOUD_U; do systemctl disable "\$TS_CLOUD_U" 2>/dev/null || true; done`,
      `if [ -f /etc/systemd/system/${serviceName} ]; then systemctl disable ${serviceName} 2>/dev/null || true; rm -f /etc/systemd/system/${serviceName}; systemctl daemon-reload; fi`,
      ...buildPruneReleases(paths, keepReleases),
    ]
  }

  return [
    ...stageRelease,
    // The unit references the stable `current` symlink, so it's identical every
    // deploy — restart re-execs against whatever `current` points at.
    `cat > /etc/systemd/system/${serviceName} <<'TS_CLOUD_UNIT_EOF'`,
    '[Unit]',
    `Description=${siteName} (managed by ts-cloud)`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${paths.current}`,
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=5',
    // Same ceilings as the zero-downtime path above. Leaving them out here
    // meant a portless site — every worker, scheduler and dashboard — could
    // not express a memory limit in config at all, so the only way to bound
    // one was `systemctl set-property` on the box. That is how a dashboard
    // ended up pinned under a hand-typed MemoryHigh of 256M while it needed
    // 311M: throttled 180,379 times, invisible to the repo, and surviving
    // every deploy because nothing in config had an opinion to overwrite it.
    'MemoryAccounting=true',
    ...(memoryHigh ? [`MemoryHigh=${memoryHigh}`] : []),
    ...(memoryMax ? [`MemoryMax=${memoryMax}`] : []),
    ...qosDirectives,
    `EnvironmentFile=${paths.current}/.env`,
    ...(port ? [`Environment=PORT=${port}`] : []),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'TS_CLOUD_UNIT_EOF',
    'systemctl daemon-reload',
    `systemctl enable ${serviceName}`,
    // Atomically promote the new release, THEN restart so the service comes up on it.
    ...buildActivateRelease(paths),
    `systemctl restart ${serviceName}`,
    `systemctl is-active ${serviceName}`,
    ...buildPruneReleases(paths, keepReleases),
  ]
}

export interface BuildStaticSiteDeployScriptOptions {
  siteName: string
  /** Project slug — namespaces the staged tarball on shared boxes. */
  slug?: string
  /** How the remote host obtains the release tarball */
  artifactFetch: string[]
  /** Site base dir holding `releases/`, `current`. Default `/var/www/<site>`. */
  appDir?: string
  /** Unique id for this release dir (typically the commit sha). */
  releaseId: string
  /** Past releases to keep for rollback. @default {@link DEFAULT_KEEP_RELEASES} */
  keepReleases?: number
  /**
   * Commands run inside the new release dir after extraction — e.g. build the
   * docs/blog on the box itself (`bun install`, `bun run docs:build`) when the
   * tarball ships source rather than a pre-built site.
   */
  preStartCommands?: string[]
}

/**
 * Build the remote shell commands that install/refresh a STATIC site on a
 * compute target with a **zero-downtime atomic release** (Envoyer-style). Unlike
 * {@link buildSiteDeployScript}, there is no systemd service: the artifact is
 * unpacked into `releases/<id>` and `current` is repointed atomically, so the
 * docroot is never empty mid-deploy. The gateway serves `<base>/current` (rpx +
 * tlsx), which ts-cloud points at the symlink. Old releases are pruned.
 */
export function buildStaticSiteDeployScript(options: BuildStaticSiteDeployScriptOptions): string[] {
  const { siteName, artifactFetch, releaseId, keepReleases = DEFAULT_KEEP_RELEASES, preStartCommands = [] } = options
  const base = options.appDir ?? `/var/www/${siteName}`
  const paths = releasePaths(base, releaseId)
  const tarball = releaseTarballTmpPath(options.slug, siteName, releaseId)

  const preStart = preStartCommands.length > 0 ? [`cd ${paths.release}`, ...preStartCommands] : []

  return [
    'set -euo pipefail',
    ...buildDeployLock(paths),
    // Same stranded-release guard as buildSiteDeployScript: never let a failed
    // deploy leave a release rollback could activate.
    buildStrandedReleaseTrap(paths),
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, []),
    // Same staging rule as buildSiteDeployScript: never delete the tree the
    // docroot currently points at.
    ...buildResetReleaseDir(paths),
    `tar xzf ${tarball} -C "$TS_CLOUD_STAGED"`,
    ...buildPromoteStagedRelease(paths),
    // Drop the staged tarball once extracted (see buildSiteDeployScript).
    `rm -f ${tarball}`,
    ...preStart,
    // Promote atomically — the docroot (`current`) is never empty during the swap.
    ...buildActivateRelease(paths),
    ...buildPruneReleases(paths, keepReleases),
  ]
}

/**
 * Box-local staging path for the uploaded release tarball. Namespaced by
 * project slug + site + release id so two projects sharing a box (or two
 * overlapping deploys of one site) never clobber each other's tarball between
 * the fetch and the extract — the flat `/tmp/<site>-release.tar.gz` layout
 * cross-contaminated releases on shared boxes.
 */
export function releaseTarballTmpPath(slug: string | undefined, siteName: string, releaseId: string): string {
  const parts = [slug, siteName, releaseId].filter(Boolean).join('-')
  return `/tmp/${parts}-release.tar.gz`
}

export function buildAwsArtifactFetch(bucket: string, key: string, region: string, destPath: string): string[] {
  return [`aws s3 cp "s3://${bucket}/${key}" ${destPath} --region ${region}`]
}

export function buildLocalArtifactFetch(localPath: string, destPath: string): string[] {
  return [
    // The Hetzner upload path is a staging area, not release history. Consume
    // the tarball so every successful deploy removes its upload immediately.
    // Active and rollback releases live separately under /var/www.
    `mv "${localPath}" ${destPath}`,
  ]
}

/**
 * Bounded, multi-tenant-safe host maintenance run after a successful deploy.
 * Current and rollback releases are deliberately out of scope: their retention
 * is managed by buildPruneReleases. This only removes abandoned staging/temp
 * archives, aged package caches, unused container images, and old journals.
 */
export function buildHostCleanupScript(): string[] {
  return [
    'echo "[ts-cloud] host cleanup (disk before): $(df -h / | tail -1)"',
    // One hour protects concurrent deploys on a shared box while bounding
    // uploads stranded by failed or cancelled deploys.
    'find /var/ts-cloud/staging -xdev -maxdepth 1 -type f -mmin +60 -delete 2>/dev/null || true',
    'find /tmp -xdev -maxdepth 1 -type f -name "*-release.tar.gz" -mmin +60 -delete 2>/dev/null || true',
    // Retained releases contain installed dependencies; these are only
    // download caches. Keep a week to avoid unnecessary network churn.
    'find /root/.bun/install/cache -xdev -type f -mtime +7 -delete 2>/dev/null || true',
    'find /root/.bun/install/cache -xdev -depth -type d -empty -delete 2>/dev/null || true',
    'journalctl --vacuum-time=14d --vacuum-size=512M >/dev/null 2>&1 || true',
    // Only unused, week-old images qualify. Daemon-less hosts skip this.
    'if command -v docker >/dev/null 2>&1; then docker image prune --all --force --filter "until=168h" >/dev/null 2>&1 || true; fi',
    'if command -v podman >/dev/null 2>&1; then podman image prune --all --force --filter "until=168h" >/dev/null 2>&1 || true; fi',
    'if command -v apt-get >/dev/null 2>&1; then apt-get clean >/dev/null 2>&1 || true; fi',
    'echo "[ts-cloud] host cleanup (disk after): $(df -h / | tail -1)"',
  ]
}
