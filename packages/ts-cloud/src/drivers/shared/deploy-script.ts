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
import { formatEnvFile } from './env-file'
import {
  buildActivateRelease,
  buildEnsureReleaseLayout,
  buildLinkSharedPaths,
  buildPruneReleases,
  DEFAULT_KEEP_RELEASES,
  releasePaths,
} from './releases'

/**
 * Translate a `start` command (e.g. "bun run server.ts") into an absolute
 * systemd ExecStart by swapping the leading runtime word for its absolute path.
 */
export function resolveExecStart(start: string, runtime: 'bun' | 'node' | 'deno'): string {
  const bin = runtime === 'bun'
    ? '/usr/local/bin/bun'
    : runtime === 'deno'
      ? '/usr/local/bin/deno'
      : '/usr/local/bin/node'
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
   */
  sharedPaths?: readonly string[]
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
  } = options
  const zeroDowntime = options.zeroDowntime ?? port != null
  const base = options.appDir ?? `/var/www/${siteName}`
  const paths = releasePaths(base, releaseId)
  const unitBase = `${slug}-${siteName}`
  const serviceName = `${unitBase}.service`
  const tarball = releaseTarballTmpPath(slug, siteName, releaseId)
  // `.env` is always shared; a site adds anything else it writes and must keep.
  const sharedPaths = [...new Set(['.env', ...(options.sharedPaths ?? [])])]

  const envFile = formatEnvFile(envEntries)

  // preStart (install / build) runs inside the NEW release dir. Bun auto-loads
  // the linked `.env` from the cwd, so build steps see the same config as the
  // running service. The release isn't live yet, so a slow build never affects
  // the currently-serving release.
  const preStart = preStartCommands.length > 0
    ? [`cd ${paths.release}`, ...preStartCommands]
    : []

  const stageRelease = [
    'set -euo pipefail',
    // A failed deploy must not strand its half-built release dir: rollback
    // picks the newest non-current dir and would activate this never-activated
    // (broken) release. On any failure before activation, remove it.
    `trap 'if [ \$? -ne 0 ] && [ "\$(readlink -f ${paths.current} 2>/dev/null || true)" != "${paths.release}" ]; then rm -rf ${paths.release}; fi' EXIT`,
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, sharedPaths),
    // Unpack this deploy into its own release dir (never touches the live one).
    `rm -rf ${paths.release}`,
    `mkdir -p ${paths.release}`,
    `tar xzf ${tarball} -C ${paths.release}`,
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
    `for TS_CLOUD_ENV in ${paths.shared}/.env ${paths.release}/.env ${paths.release}/.env.*; do [ -f "$TS_CLOUD_ENV" ] && sed -i -E '/^[[:space:]]*(PORT|PORT_BACKEND|PORT_ADMIN|PORT_FRONTEND)[[:space:]]*=/d' "$TS_CLOUD_ENV" 2>/dev/null || true; done`,
    ...buildLinkSharedPaths(paths, sharedPaths),
    ...preStart,
  ]

  if (zeroDowntime && port != null) {
    const instance = `${unitBase}@${releaseId}.service`
    const gatePath = healthCheckPath
      ? (healthCheckPath.startsWith('/') ? healthCheckPath : `/${healthCheckPath}`)
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
      `systemctl start ${instance}`,
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
      ...(gatePath
        ? [`curl -sf -o /dev/null --max-time 10 "http://127.0.0.1:${port}${gatePath}" || ${failGate}`]
        : []),
      // Promote: flip `current` (tooling + gateway reference), persist across
      // boots, then retire whatever served the previous release.
      ...buildActivateRelease(paths),
      `systemctl enable ${instance} 2>/dev/null || true`,
      `for TS_CLOUD_U in \${TS_CLOUD_OLD_UNITS}; do systemctl stop "\$TS_CLOUD_U" 2>/dev/null || true; systemctl disable "\$TS_CLOUD_U" 2>/dev/null || true; done`,
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

  const preStart = preStartCommands.length > 0
    ? [`cd ${paths.release}`, ...preStartCommands]
    : []

  return [
    'set -euo pipefail',
    // Same stranded-release guard as buildSiteDeployScript: never let a failed
    // deploy leave a release rollback could activate.
    `trap 'if [ \$? -ne 0 ] && [ "\$(readlink -f ${paths.current} 2>/dev/null || true)" != "${paths.release}" ]; then rm -rf ${paths.release}; fi' EXIT`,
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, []),
    `rm -rf ${paths.release}`,
    `mkdir -p ${paths.release}`,
    `tar xzf ${tarball} -C ${paths.release}`,
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
  return [
    `aws s3 cp "s3://${bucket}/${key}" ${destPath} --region ${region}`,
  ]
}

export function buildLocalArtifactFetch(localPath: string, destPath: string): string[] {
  return [
    `cp "${localPath}" ${destPath}`,
  ]
}
