/**
 * Shared deploy script helpers for Forge-style compute deploys.
 */

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
  appDir?: string
  execStart: string
  envEntries: Record<string, string>
  port?: number
  /**
   * Commands run inside `appDir` after extraction + `.env` write, before the
   * systemd unit is (re)written and started. Typically dependency install
   * and/or build steps (e.g. `bun install --frozen-lockfile`, `bun run build`)
   * so the release tarball can omit `node_modules`.
   */
  preStartCommands?: string[]
}

/**
 * Build the remote shell commands that install/refresh a site on a compute target.
 */
export function buildSiteDeployScript(options: BuildSiteDeployScriptOptions): string[] {
  const {
    siteName,
    slug,
    artifactFetch,
    execStart,
    envEntries,
    port,
    preStartCommands = [],
  } = options
  const appDir = options.appDir ?? `/var/www/${siteName}`
  const serviceName = `${slug}-${siteName}.service`

  const envFile = Object.entries(envEntries)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join('\n')

  // preStart commands (install / build) run inside appDir. Bun auto-loads the
  // freshly written `.env` from the cwd, so build steps see the same config as
  // the running service without us fragile-sourcing the file in the shell.
  const preStart = preStartCommands.length > 0
    ? [`cd ${appDir}`, ...preStartCommands]
    : []

  return [
    'set -euo pipefail',
    ...artifactFetch,
    `mkdir -p ${appDir}`,
    `find ${appDir} -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +`,
    `tar xzf /tmp/${siteName}-release.tar.gz -C ${appDir}`,
    `cat > ${appDir}/.env <<'TS_CLOUD_ENV_EOF'`,
    envFile,
    'TS_CLOUD_ENV_EOF',
    `chmod 600 ${appDir}/.env`,
    ...preStart,
    `cat > /etc/systemd/system/${serviceName} <<'TS_CLOUD_UNIT_EOF'`,
    '[Unit]',
    `Description=${siteName} (managed by ts-cloud)`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${appDir}`,
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=5',
    `EnvironmentFile=${appDir}/.env`,
    ...(port ? [`Environment=PORT=${port}`] : []),
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'TS_CLOUD_UNIT_EOF',
    'systemctl daemon-reload',
    `systemctl enable ${serviceName}`,
    `systemctl restart ${serviceName}`,
    `systemctl is-active ${serviceName}`,
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
