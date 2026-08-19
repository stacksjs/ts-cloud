/**
 * Minimal SSH/scp helpers for driving a freshly-provisioned box from a deploy
 * script, plus wait loops for the boot milestones every provider shares
 * (sshd accepting connections, cloud-init finished).
 *
 * Uses the system `ssh`/`scp` binaries via Bun.spawn — no keys or agents are
 * managed here; pass `identityFile` or rely on the ambient SSH config.
 */

export interface RemoteExecOptions {
  /** SSH user. @default 'root' */
  user?: string
  /** Private key passed as `ssh -i`. Omit to use the ambient SSH config/agent. */
  identityFile?: string
  /** SSH `ConnectTimeout` in seconds. @default 10 */
  connectTimeoutSec?: number
}

export interface RemoteExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * The ssh/scp CLI arguments implied by {@link RemoteExecOptions}. Host key
 * checking is disabled because these helpers target freshly-created servers
 * whose host keys cannot be known in advance.
 */
export function buildSshArgs(options: RemoteExecOptions = {}): string[] {
  const args: string[] = []
  if (options.identityFile) args.push('-i', options.identityFile)
  args.push(
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-o',
    `ConnectTimeout=${options.connectTimeoutSec ?? 10}`,
  )
  return args
}

/** Run a command on the host over SSH, capturing exit code and output. */
export async function sshExec(
  host: string,
  command: string,
  options: RemoteExecOptions = {},
): Promise<RemoteExecResult> {
  const proc = Bun.spawn(['ssh', ...buildSshArgs(options), `${options.user ?? 'root'}@${host}`, command], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, stdout, stderr }
}

/** Like {@link sshExec}, but throws on non-zero exit and returns stdout. */
export async function sshExecOrThrow(host: string, command: string, options: RemoteExecOptions = {}): Promise<string> {
  const result = await sshExec(host, command, options)
  if (result.code !== 0)
    throw new Error(
      `ssh \`${command}\` on ${host} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    )
  return result.stdout
}

/** Copy local files into a directory on the host via scp. */
export async function scpUpload(
  host: string,
  localPaths: string[],
  remoteDir: string,
  options: RemoteExecOptions = {},
): Promise<void> {
  const proc = Bun.spawn(
    ['scp', ...buildSshArgs(options), ...localPaths, `${options.user ?? 'root'}@${host}:${remoteDir}`],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`scp to ${host}:${remoteDir} failed (${code}): ${stderr.trim()}`)
  }
}

export interface WaitOptions extends RemoteExecOptions {
  /** Give up after this long. */
  timeoutMs?: number
  /** Delay between attempts. @default 5000 */
  pollIntervalMs?: number
}

/** Poll until sshd accepts the connection (box booted + key authorized). */
export async function waitForSsh(host: string, options: WaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 180_000
  const pollIntervalMs = options.pollIntervalMs ?? 5000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await sshExec(host, 'echo ready', options)
    if (r.code === 0 && r.stdout.includes('ready')) return
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`SSH not ready on ${host} after ${timeoutMs}ms`)
}

/**
 * Poll `cloud-init status` until it reports done. Throws when cloud-init
 * reports an error so a broken first boot fails the deploy instead of
 * surfacing later as missing packages.
 */
export async function waitForCloudInit(host: string, options: WaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 300_000
  const pollIntervalMs = options.pollIntervalMs ?? 5000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await sshExec(host, 'cloud-init status 2>/dev/null || echo unknown', options)
    if (r.stdout.includes('status: done')) return
    if (r.stdout.includes('status: error'))
      throw new Error(`cloud-init reported an error on ${host}; check /var/log/cloud-init-output.log`)
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`cloud-init did not finish on ${host} after ${timeoutMs}ms`)
}
