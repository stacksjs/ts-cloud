/**
 * Run an SFTP server on a box.
 *
 * AWS deploys get Transfer Family, which is a managed service with no box to
 * put anything on. Every other driver — Hetzner, local — provisions
 * [ts-sftp](https://github.com/stacksjs/ts-sftp) as a systemd unit instead, so
 * the same `infrastructure.sftp` config produces a working SFTP endpoint
 * whichever provider is behind it.
 *
 * Storage is a directory on the server. Bucket-backed storage is an AWS-only
 * option (see {@link assertSftpSupported}).
 */

import type { SftpConfig } from '@ts-cloud/core'

/** Where the server's own files live on the box. */
export const SFTP_CONFIG_DIR = '/etc/ts-sftp'
/** Where ts-sftp itself is installed. */
export const SFTP_INSTALL_DIR = '/opt/ts-sftp'
/** Default port. 2222 rather than 22, which sshd already owns. */
export const DEFAULT_SFTP_PORT = 2222

export interface SftpProvisionOptions {
  slug: string
  sftp: SftpConfig
}

/** The systemd unit name for a project's SFTP server. */
export function sftpUnitName(slug: string): string {
  return `${slug}-sftp`
}

/** The port the box serves SFTP on. */
export function sftpPort(sftp: SftpConfig): number {
  return sftp.port ?? DEFAULT_SFTP_PORT
}

/** The directory served to users. */
export function sftpRoot(options: SftpProvisionOptions): string {
  const storage = options.sftp.storage
  if (storage?.type === 'efs' && storage.path) return storage.path
  return `/var/sftp/${options.slug}`
}

/** Single-quote a value for safe embedding in a shell command. */
function quote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/**
 * Check that an SFTP config can be delivered by the given provider, and explain
 * the gap when it cannot. Bucket-backed storage needs S3 behind it, which only
 * the AWS path provides.
 */
export function assertSftpSupported(sftp: SftpConfig, provider: string): void {
  if (provider === 'aws') return

  const storage = sftp.storage
  const wantsBucket = storage?.type === 's3' || (!storage && !!sftp.bucket)
  if (wantsBucket) {
    throw new Error(
      `sftp: bucket-backed storage is only available on the aws provider (Transfer Family). `
      + `On ${provider}, use storage: { type: 'efs' } to serve a directory on the server.`,
    )
  }

  for (const [username, user] of Object.entries(sftp.users)) {
    if (!user.sshPublicKeys?.length)
      throw new Error(`sftp: user ${username} needs at least one SSH public key`)
  }
}

/**
 * Build the commands that install and run ts-sftp on the box. Idempotent: the
 * host key is generated once and kept, so a redeploy does not change the
 * fingerprint clients have pinned.
 */
export function buildSftpProvisionScript(options: SftpProvisionOptions): string[] {
  const { slug, sftp } = options
  const unit = sftpUnitName(slug)
  const root = sftpRoot(options)
  const port = sftpPort(sftp)
  const hostKey = `${SFTP_CONFIG_DIR}/host_key`
  const usersDir = `${SFTP_CONFIG_DIR}/users`
  const serviceUser = sftp.serviceUser ?? 'ts-sftp'

  const commands: string[] = [
    `# --- ts-sftp (${unit}) ---`,
    `id -u ${serviceUser} >/dev/null 2>&1 || useradd --system --home-dir ${quote(root)} --shell /usr/sbin/nologin ${serviceUser}`,
    'command -v bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun)',
    `mkdir -p ${quote(root)} ${SFTP_CONFIG_DIR} ${usersDir} ${SFTP_INSTALL_DIR}`,
    `chmod 750 ${SFTP_CONFIG_DIR}`,
    // Install into its own directory so the server's version is pinned
    // independently of anything the application depends on.
    `cd ${SFTP_INSTALL_DIR} && [ -f package.json ] || printf '{"name":"ts-sftp-host","private":true}' > package.json`,
    `cd ${SFTP_INSTALL_DIR} && bun add ts-sftp@${sftp.version ?? 'latest'} --no-save --production || bun add ts-sftp@${sftp.version ?? 'latest'}`,
    // Generate the host key once; keeping it means clients keep trusting the box.
    `[ -f ${hostKey} ] || bun ${SFTP_INSTALL_DIR}/node_modules/ts-sftp/dist/bin/cli.js keygen --out ${hostKey} --comment ${quote(`${slug}-sftp`)}`,
    `chmod 600 ${hostKey}`,
  ]

  const userFlags: string[] = []
  for (const [username, user] of Object.entries(sftp.users)) {
    const home = (user.homeDirectory ?? username).replace(/^\/+|\/+$/g, '')
    if (!home || home.split('/').includes('..')) throw new Error(`sftp: invalid homeDirectory for user ${username}`)

    const keysFile = `${usersDir}/${username}.pub`
    commands.push(
      `mkdir -p ${quote(`${root}/${home}`)}`,
      `printf '%s\\n' ${quote(user.sshPublicKeys.join('\n'))} > ${keysFile}`,
      `chmod 644 ${keysFile}`,
    )
    userFlags.push(`--user ${username}:${keysFile}`)
  }

  commands.push(
    `chown -R ${serviceUser}:${serviceUser} ${quote(root)} ${SFTP_CONFIG_DIR}`,
    // Unquoted heredoc so $BUN_BIN resolves to the interpreter's real path;
    // systemd needs an absolute ExecStart.
    'BUN_BIN=$(command -v bun)',
    `cat > /etc/systemd/system/${unit}.service <<TSCLOUD_SFTP_UNIT`,
    '[Unit]',
    'Description=ts-sftp file transfer server',
    'After=network.target',
    '',
    '[Service]',
    `User=${serviceUser}`,
    `ExecStart=\$BUN_BIN ${SFTP_INSTALL_DIR}/node_modules/ts-sftp/dist/bin/cli.js serve --root ${root} --host-key ${hostKey} --port ${port}${sftp.readOnly ? ' --read-only' : ''} ${userFlags.join(' ')}`,
    'Restart=always',
    'RestartSec=2',
    // The service only ever touches its own tree.
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    `ReadWritePaths=${root}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'TSCLOUD_SFTP_UNIT',
    'systemctl daemon-reload',
    `systemctl enable ${unit}.service`,
    `systemctl restart ${unit}.service`,
  )

  return commands
}

/** Ports the SFTP server needs open, for the firewall builders. */
export function sftpFirewallPorts(sftp: SftpConfig | undefined): number[] {
  return sftp ? [sftpPort(sftp)] : []
}
