/**
 * SSH transport for a host ts-cloud did not create.
 *
 * The cloud drivers reach a box they just provisioned: the provider API is
 * what identifies it, so they disable host-key checking and forget the key
 * (`StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null`). A
 * bring-your-own host has no API vouching for it, and it is exactly the kind
 * of machine that sits behind a router on a hostname anyone on the LAN can
 * claim. So this transport can PIN: on first contact it records the host key
 * in a known_hosts file of its own (under the state directory, not the
 * operator's `~/.ssh/known_hosts`) and refuses a different key ever after.
 *
 * Everything else is the Hetzner driver's transport, made injectable: keepalive
 * so a dead socket fails loudly instead of wedging the deploy, scripts fed
 * over stdin so secrets never reach argv or the process table, scp retried
 * because a re-upload is idempotent.
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { resolveStatePath } from '@ts-cloud/core'
import { describeScriptSyntaxError, formatSshFailure } from './remote-failure'
import { remoteScriptRunner } from './remote-exec'

export type SshHostKeyPolicy = 'pin' | 'accept-new' | 'insecure'

export interface SshTransportOptions {
  user: string
  /** @default 22 */
  port?: number
  /** Private key passed as `-i`. */
  identityFile: string
  /**
   * `'insecure'` disables host-key checking (the cloud drivers' behaviour).
   * Otherwise the policy plus the known_hosts file it reads and writes.
   */
  hostKey: 'insecure' | { policy: 'pin' | 'accept-new'; knownHostsFile: string }
  /** @default 30 */
  connectTimeoutSec?: number
  /**
   * How a script is executed on the host once it arrives over stdin. Defaults
   * to {@link remoteScriptRunner} without sudo; `exec` can pick the sudo
   * variant per call.
   */
  runner?: string
}

export interface SshExecOptions {
  /**
   * Run the script through `sudo -n`. Unset: the transport's configured
   * runner. A deploy user that is not root needs it for everything except
   * the preflight, which must run as the user to find out whether sudo works.
   */
  sudo?: boolean
}

export interface SshHostKeyResult {
  /** `SHA256:...`, empty when the key could not be learned (insecure policy, scan failed). */
  fingerprint: string
  /** True when this call is what recorded the key. */
  pinnedNow: boolean
}

export interface SshTransport {
  /** Run `script` on `host`; resolves with stdout, rejects with a redacted failure. */
  exec(host: string, script: string, options?: SshExecOptions): Promise<string>
  /** Copy one local file to `remotePath` on `host`. */
  scp(host: string, localPath: string, remotePath: string): Promise<void>
  /** Whether sshd on `host` accepts a connection right now. */
  probe(host: string): Promise<boolean>
  /** Learn (and, when pinning, record) the host key before the first real command. */
  ensureHostKey(host: string): Promise<SshHostKeyResult>
}

export interface CommandResult {
  code: number
  signal?: string | null
  stdout: string
  stderr: string
}

/** Runs a command; `input`, when given, is piped to stdin. Injectable for tests. */
export type CommandRunner = (command: string[], input?: string) => Promise<CommandResult>

/** Output cap for ssh/scp children: large enough for verbose tar extraction. */
const OUTPUT_LIMIT = 1024 * 1024 * 256

export const runCommand: CommandRunner = async (command, input) => {
  const child = Bun.spawn(command, {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return {
    code,
    signal: child.signalCode,
    stdout: stdout.slice(-OUTPUT_LIMIT),
    stderr: stderr.slice(-OUTPUT_LIMIT),
  }
}

/**
 * Host-key options for a box the provider API identifies: never check, never
 * remember. Byte-for-byte what the Hetzner driver passes.
 */
export const SSH_INSECURE_HOST_KEY_OPTS: readonly string[] = [
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'LogLevel=ERROR',
]

/**
 * Keepalive + connect timeout for every ssh/scp. Without these a connection
 * that stalls mid-transfer (a flaky network, an sshd hiccup) hangs the deploy
 * FOREVER. ServerAlive probes abort a silent connection after ~60s (15s x 4)
 * so the transfer fails loudly (and, for scp, is retried) instead of wedging.
 */
export const SSH_KEEPALIVE_OPTS: readonly string[] = [
  '-o',
  'ConnectTimeout=30',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
]

function hostKeyOpts(options: SshTransportOptions): string[] {
  if (options.hostKey === 'insecure') return [...SSH_INSECURE_HOST_KEY_OPTS]
  return [
    '-o',
    `StrictHostKeyChecking=${options.hostKey.policy === 'pin' ? 'yes' : 'accept-new'}`,
    '-o',
    `UserKnownHostsFile=${options.hostKey.knownHostsFile}`,
    '-o',
    'LogLevel=ERROR',
  ]
}

function keepaliveOpts(options: SshTransportOptions): string[] {
  const opts = [...SSH_KEEPALIVE_OPTS]
  if (options.connectTimeoutSec !== undefined) opts[1] = `ConnectTimeout=${options.connectTimeoutSec}`
  return opts
}

/**
 * The `ssh` arguments (everything after the binary, ending in `user@host`)
 * for `options`. `extra` is spliced in before the destination so a caller can
 * add a one-off `-o`. Pure, for tests.
 */
export function buildSshArgsFor(options: SshTransportOptions, host: string, extra: string[] = []): string[] {
  return [
    '-i',
    options.identityFile,
    '-p',
    String(options.port ?? 22),
    ...hostKeyOpts(options),
    ...keepaliveOpts(options),
    '-o',
    'BatchMode=yes',
    ...extra,
    `${options.user}@${host}`,
  ]
}

/** The `scp` arguments for copying `localPath` to `host:remotePath`. Pure, for tests. */
export function buildScpArgsFor(options: SshTransportOptions, host: string, localPath: string, remotePath: string): string[] {
  return [
    '-i',
    options.identityFile,
    '-P',
    String(options.port ?? 22),
    ...hostKeyOpts(options),
    ...keepaliveOpts(options),
    '-o',
    'BatchMode=yes',
    localPath,
    `${options.user}@${host}:${remotePath}`,
  ]
}

/** `SHA256:...` fingerprint of a base64 host key, as `ssh-keygen -l` prints it. */
export function sshHostKeyFingerprint(key: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`
}

export interface ScannedHostKey {
  algorithm: string
  key: string
}

/**
 * Ask the host for its ed25519 key with `ssh-keyscan`. Bounded (`-T 10`) so an
 * unreachable host fails in seconds rather than at the TCP timeout.
 */
export async function scanHostKey(host: string, port: number = 22, run: CommandRunner = runCommand): Promise<ScannedHostKey> {
  const result = await run(['ssh-keyscan', '-T', '10', '-p', String(port), '-t', 'ed25519', host])
  const fields = result.stdout
    .split('\n')
    .find((line) => line && !line.startsWith('#'))
    ?.trim()
    .split(/\s+/)
  if (result.code !== 0 || !fields?.[1] || !fields[2])
    throw new Error(`SSH host-key scan failed: ${result.stderr.trim() || 'no key returned'}`)
  return { algorithm: fields[1], key: fields[2] }
}

/** The host field ssh looks up in known_hosts: `host` on port 22, `[host]:port` otherwise. */
export function knownHostsToken(host: string, port: number = 22): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** The known_hosts entry recorded for `host` (one line, no trailing newline). */
export function knownHostsLine(host: string, port: number, key: ScannedHostKey): string {
  return `${knownHostsToken(host, port)} ${key.algorithm} ${key.key}`
}

/**
 * The recorded key for `host`, or null when the file has no plain entry for
 * it. Hashed entries (`|1|...`) cannot be matched and are ignored, which is
 * fine: this transport only ever writes plain ones.
 */
export function findKnownHostKey(content: string, host: string, port: number = 22): ScannedHostKey | null {
  const token = knownHostsToken(host, port)
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('@')) continue
    const [hosts, algorithm, key] = line.split(/\s+/)
    if (!hosts || !algorithm || !key) continue
    if (hosts.split(',').includes(token)) return { algorithm, key }
  }
  return null
}

/** Where the ssh driver keeps the host keys it pinned: `<stateDir>/ssh/known_hosts`. */
export function sshKnownHostsPath(cwd: string = process.cwd()): string {
  return resolveStatePath(cwd, 'ssh', 'known_hosts')
}

export interface SystemSshTransportDeps {
  run?: CommandRunner
  scan?: typeof scanHostKey
  readKnownHosts?: (file: string) => Promise<string>
  appendKnownHosts?: (file: string, line: string) => Promise<void>
}

async function readKnownHostsFile(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function appendKnownHostsFile(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${line}\n`, { mode: 0o600 })
}

/** {@link SshTransport} on the system `ssh`, `scp` and `ssh-keyscan` binaries. */
export class SystemSshTransport implements SshTransport {
  private readonly run: CommandRunner
  private readonly scan: typeof scanHostKey
  private readonly readKnownHosts: (file: string) => Promise<string>
  private readonly appendKnownHosts: (file: string, line: string) => Promise<void>

  constructor(
    private readonly options: SshTransportOptions,
    deps: SystemSshTransportDeps = {},
  ) {
    this.run = deps.run ?? runCommand
    this.scan = deps.scan ?? scanHostKey
    this.readKnownHosts = deps.readKnownHosts ?? readKnownHostsFile
    this.appendKnownHosts = deps.appendKnownHosts ?? appendKnownHostsFile
  }

  /** The runner a script is fed to; see {@link SshExecOptions.sudo}. */
  runnerFor(options: SshExecOptions = {}): string {
    if (options.sudo !== undefined) return remoteScriptRunner({ sudo: options.sudo })
    return this.options.runner ?? remoteScriptRunner()
  }

  async exec(host: string, script: string, options: SshExecOptions = {}): Promise<string> {
    const result = await this.run(['ssh', ...buildSshArgsFor(this.options, host), this.runnerFor(options)], script)
    if (result.code !== 0) {
      const failure = { status: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr }
      // Never forward the command line: it is the deploy script, secrets and all.
      throw new Error(`${formatSshFailure(failure)}${describeScriptSyntaxError(failure, script)}`)
    }
    return result.stdout
  }

  async scp(host: string, localPath: string, remotePath: string): Promise<void> {
    const command = ['scp', ...buildScpArgsFor(this.options, host, localPath, remotePath)]
    // scp overwrites its destination, so a re-upload is idempotent and a single
    // dropped connection should not fail a whole deploy.
    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await this.run(command)
      if (result.code === 0) return
      if (attempt === attempts)
        throw new Error(formatSshFailure({ status: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr }))
    }
  }

  async probe(host: string): Promise<boolean> {
    const result = await this.run(['ssh', ...buildSshArgsFor(this.options, host, ['-o', 'ConnectTimeout=5']), 'true'])
    return result.code === 0
  }

  async ensureHostKey(host: string): Promise<SshHostKeyResult> {
    const port = this.options.port ?? 22
    if (this.options.hostKey === 'insecure') {
      // Nothing is checked, but the fingerprint is still worth showing.
      try {
        return { fingerprint: sshHostKeyFingerprint((await this.scan(host, port, this.run)).key), pinnedNow: false }
      } catch {
        return { fingerprint: '', pinnedNow: false }
      }
    }

    const { policy, knownHostsFile } = this.options.hostKey
    const known = findKnownHostKey(await this.readKnownHosts(knownHostsFile), host, port)
    if (known) return { fingerprint: sshHostKeyFingerprint(known.key), pinnedNow: false }

    const scanned = await this.scan(host, port, this.run)
    if (policy === 'pin') {
      await this.appendKnownHosts(knownHostsFile, knownHostsLine(host, port, scanned))
      return { fingerprint: sshHostKeyFingerprint(scanned.key), pinnedNow: true }
    }
    // accept-new: ssh itself records the key on first contact.
    return { fingerprint: sshHostKeyFingerprint(scanned.key), pinnedNow: false }
  }
}
