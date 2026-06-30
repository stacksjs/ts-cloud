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
}

/**
 * Build the remote shell commands that install/refresh a server-app site on a
 * compute target with a **zero-downtime atomic release** (Envoyer-style): unpack
 * into `releases/<id>`, link the shared `.env`, build, then atomically repoint
 * `current` and restart the systemd service (which runs from `current`). Old
 * releases are pruned for rollback.
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
  } = options
  const base = options.appDir ?? `/var/www/${siteName}`
  const paths = releasePaths(base, releaseId)
  const serviceName = `${slug}-${siteName}.service`
  const sharedPaths = ['.env']

  const envFile = formatEnvFile(envEntries)

  // preStart (install / build) runs inside the NEW release dir. Bun auto-loads
  // the linked `.env` from the cwd, so build steps see the same config as the
  // running service. The release isn't live yet, so a slow build never affects
  // the currently-serving release.
  const preStart = preStartCommands.length > 0
    ? [`cd ${paths.release}`, ...preStartCommands]
    : []

  return [
    'set -euo pipefail',
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, sharedPaths),
    // Unpack this deploy into its own release dir (never touches the live one).
    `rm -rf ${paths.release}`,
    `mkdir -p ${paths.release}`,
    `tar xzf /tmp/${siteName}-release.tar.gz -C ${paths.release}`,
    // Persist the .env in shared/ (survives releases) and link it into the release.
    `cat > ${paths.shared}/.env <<'TS_CLOUD_ENV_EOF'`,
    envFile,
    'TS_CLOUD_ENV_EOF',
    `chmod 600 ${paths.shared}/.env`,
    ...buildLinkSharedPaths(paths, sharedPaths),
    ...preStart,
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

  const preStart = preStartCommands.length > 0
    ? [`cd ${paths.release}`, ...preStartCommands]
    : []

  return [
    'set -euo pipefail',
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, []),
    `rm -rf ${paths.release}`,
    `mkdir -p ${paths.release}`,
    `tar xzf /tmp/${siteName}-release.tar.gz -C ${paths.release}`,
    ...preStart,
    // Promote atomically — the docroot (`current`) is never empty during the swap.
    ...buildActivateRelease(paths),
    ...buildPruneReleases(paths, keepReleases),
  ]
}

export function buildAwsArtifactFetch(bucket: string, key: string, region: string, siteName: string): string[] {
  return [
    `aws s3 cp "s3://${bucket}/${key}" /tmp/${siteName}-release.tar.gz --region ${region}`,
  ]
}

export function buildLocalArtifactFetch(localPath: string, siteName: string): string[] {
  return [
    `cp "${localPath}" /tmp/${siteName}-release.tar.gz`,
  ]
}
