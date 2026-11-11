/**
 * A child process as a live stream, and the argv that reaches it over SSH.
 *
 * Everything else in `runtime/` runs a command to completion and returns its
 * output: a deploy step, a `docker inspect`, a bounded log read. An
 * interactive tool cannot work that way. It pipes a script to a runner over
 * stdin and shows what comes back while it is still coming back, and it tails
 * a log that never ends. Both need the process itself, not its transcript.
 *
 * Two rules hold for every command built here:
 *
 *  - **argv, never a command line.** A local command is spawned from an array,
 *    so nothing in it is ever read by a shell. A remote one cannot avoid a
 *    shell (sshd hands the command to the login shell), so each argument is
 *    single-quoted on its own and the pieces are joined, which is the same
 *    guarantee by other means: a pod name, a path or a filter can contain any
 *    byte and still arrive as one argument.
 *  - **stdin is the payload, not the command.** The script being run travels
 *    over stdin and never appears in argv, on either side, so it is not in the
 *    process table and not in a shell history.
 *
 * Chunks carry the `stream` and `data` of {@link RuntimeStreamChunk}, so a
 * stream from here drops straight into a {@link RuntimeStreamRegistry} with
 * {@link pumpProcessStream} when a reconnectable buffer is wanted.
 */
import type { SshTransportOptions } from '../drivers/shared/ssh-transport'
import type { RuntimeStreamChunk, RuntimeStreamRegistry, RuntimeStreamSnapshot } from './streams'
import { buildSshArgsFor } from '../drivers/shared/ssh-transport'

/** One piece of output: which pipe it came from, and the text. */
export type ProcessStreamChunk = Pick<RuntimeStreamChunk, 'stream' | 'data'>

export interface ProcessExit {
  code: number
  signal?: string | null
}

/** Everything a finished process wrote, for the callers that want a transcript after all. */
export interface ProcessOutput extends ProcessExit {
  stdout: string
  stderr: string
}

/** The write end of a process's stdin, when it was opened with `stdin: 'pipe'`. */
export interface ProcessStdin {
  write(data: string | Uint8Array): void
  /** Close stdin. A runner reading a script from stdin starts only after this. */
  end(): Promise<void>
}

/**
 * A running process. Iterate it for output as it arrives; `exited` settles
 * when the process is gone and both pipes are drained.
 *
 * Single consumer: iterating twice splits the chunks between the two loops.
 */
export interface ProcessStream extends AsyncIterable<ProcessStreamChunk> {
  /** The exact argv that was spawned. */
  readonly command: readonly string[]
  /** Present only for `stdin: 'pipe'`. */
  readonly stdin?: ProcessStdin
  readonly exited: Promise<ProcessExit>
  kill(signal?: NodeJS.Signals | number): void
  /** Drain the stream and return what it wrote. */
  collect(): Promise<ProcessOutput>
}

/**
 * What stdin is connected to:
 *  - omitted: closed (`/dev/null`), so a command that reads stdin sees EOF;
 *  - a string or bytes: written, then closed;
 *  - a `ReadableStream`: piped through until it ends;
 *  - `'pipe'`: left open for {@link ProcessStream.stdin}.
 */
export type ProcessStdinSource = string | Uint8Array | ReadableStream<Uint8Array> | 'pipe'

export interface SpawnProcessOptions {
  stdin?: ProcessStdinSource
  /** Kills the process when aborted. */
  signal?: AbortSignal
  /** Environment for the child. Unset: this process's environment as it is now. */
  env?: Record<string, string | undefined>
  cwd?: string
}

/** Spawns `command` and returns it as a stream. Injectable so adapters test without a binary. */
export type ProcessSpawner = (command: readonly string[], options?: SpawnProcessOptions) => ProcessStream

interface Waiter {
  resolve: (result: IteratorResult<ProcessStreamChunk>) => void
}

/** {@link ProcessSpawner} on `Bun.spawn`. */
export const spawnProcessStream: ProcessSpawner = (command, options = {}) => {
  if (command.length === 0 || !command[0]) throw new Error('Cannot spawn an empty command')
  const input = options.stdin
  const child = Bun.spawn([...command], {
    stdin:
      input === undefined
        ? 'ignore'
        : input === 'pipe'
          ? 'pipe'
          : typeof input === 'string'
            ? Buffer.from(input)
            : input,
    stdout: 'pipe',
    stderr: 'pipe',
    // Always explicit. Bun resolves the executable against the PATH it was
    // started with unless an env is passed, so a host that corrects PATH after
    // launch (a desktop app started from the Dock has almost none) would
    // otherwise never find a binary the user's shell finds.
    env: options.env ?? process.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  })

  const queue: ProcessStreamChunk[] = []
  const waiters: Waiter[] = []
  let open = 2

  const push = (chunk: ProcessStreamChunk) => {
    const waiter = waiters.shift()
    if (waiter) waiter.resolve({ value: chunk, done: false })
    else queue.push(chunk)
  }
  const finish = () => {
    if (--open > 0) return
    for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
  }
  const read = async (source: ReadableStream<Uint8Array>, stream: 'stdout' | 'stderr') => {
    // One decoder per pipe, streaming, so a multi-byte character split across
    // two reads is not turned into two replacement characters.
    const decoder = new TextDecoder()
    try {
      for await (const bytes of source) {
        const data = decoder.decode(bytes, { stream: true })
        if (data) push({ stream, data })
      }
      const tail = decoder.decode()
      if (tail) push({ stream, data: tail })
    } catch {
      // A killed child tears its pipes down mid-read; the exit code reports it.
    } finally {
      finish()
    }
  }
  const drained = Promise.all([
    read(child.stdout as ReadableStream<Uint8Array>, 'stdout'),
    read(child.stderr as ReadableStream<Uint8Array>, 'stderr'),
  ])

  const kill = (signal?: NodeJS.Signals | number) => {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
  const onAbort = () => kill()
  if (options.signal) {
    if (options.signal.aborted) kill()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  const exited: Promise<ProcessExit> = child.exited.then(async (code) => {
    await drained
    options.signal?.removeEventListener('abort', onAbort)
    return { code, signal: child.signalCode }
  })

  const sink = input === 'pipe' ? (child.stdin as unknown as { write: (data: string | Uint8Array) => unknown; end: () => unknown; flush?: () => unknown }) : undefined
  const stdin: ProcessStdin | undefined = sink
    ? {
        write(data) {
          sink.write(data)
          sink.flush?.()
        },
        async end() {
          await sink.end()
        },
      }
    : undefined

  const stream: ProcessStream = {
    command: [...command],
    ...(stdin ? { stdin } : {}),
    exited,
    kill,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ProcessStreamChunk>> {
          const chunk = queue.shift()
          if (chunk) return Promise.resolve({ value: chunk, done: false })
          if (open === 0) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiters.push({ resolve }))
        },
        return(): Promise<IteratorResult<ProcessStreamChunk>> {
          // Leaving the loop early means nobody is reading: stop the process
          // rather than let it fill a pipe nobody drains.
          kill()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
    async collect() {
      let stdout = ''
      let stderr = ''
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr') stderr += chunk.data
        else stdout += chunk.data
      }
      return { ...(await exited), stdout, stderr }
    },
  }
  return stream
}

/**
 * Quote one argument for a POSIX shell. Everything is single-quoted, including
 * values that would be safe bare: one rule with no exceptions is the one that
 * cannot be wrong about a character.
 */
export function shellQuoteArg(value: string): string {
  if (value.includes('\0')) throw new Error('A shell argument cannot contain a NUL byte')
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `argv` as one command line a POSIX shell parses back into exactly `argv`. */
export function shellQuoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('Cannot quote an empty command')
  return argv.map(shellQuoteArg).join(' ')
}

const ENV_NAME = /^[A-Z_]\w*$/i

export interface RemoteCommandOptions {
  /** Directory the command runs in, e.g. a site's `current` release. */
  cwd?: string
  /** Variables set for the command only. Names are validated; values are quoted. */
  env?: Record<string, string>
  /** Run through `sudo -n`. */
  sudo?: boolean
}

/**
 * The command line sshd receives for `argv`: an optional `cd`, then `exec`
 * with the quoted arguments, so the remote shell is replaced by the command
 * and a closed connection takes the command with it.
 */
export function buildRemoteCommandLine(argv: readonly string[], options: RemoteCommandOptions = {}): string {
  const env = Object.entries(options.env ?? {}).map(([name, value]) => {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name: ${name}`)
    return `${name}=${shellQuoteArg(value)}`
  })
  const command = [
    'exec',
    ...(options.sudo ? ['sudo', '-n'] : []),
    ...(env.length > 0 ? ['env', ...env] : []),
    shellQuoteArgv(argv),
  ].join(' ')
  return options.cwd ? `cd ${shellQuoteArg(options.cwd)} && ${command}` : command
}

/** Where a command runs when it is not this machine. */
export interface SshVia {
  host: string
  /** Build with `interactiveSshOptions()` for a checked host key. */
  ssh: SshTransportOptions
}

/**
 * The local argv that runs `argv` on `via.host`: `ssh -T <transport options>
 * user@host '<quoted command>'`.
 *
 * `-T` because a pseudo-terminal would merge stderr into stdout and rewrite
 * line endings, and nothing here is a terminal. The transport options are the
 * deploy transport's own ({@link buildSshArgsFor}), `BatchMode=yes` included,
 * so a host that wants a password fails at once instead of prompting into a
 * pipe.
 */
export function buildSshCommand(via: SshVia, argv: readonly string[], options: RemoteCommandOptions = {}): string[] {
  return ['ssh', ...buildSshArgsFor(via.ssh, via.host, ['-T']), buildRemoteCommandLine(argv, options)]
}

export interface RunRemoteCommandOptions extends RemoteCommandOptions {
  /** What the remote command reads on stdin: the script to run. */
  stdin?: ProcessStdinSource
  signal?: AbortSignal
  spawn?: ProcessSpawner
}

/**
 * Run `argv` on a remote host and stream it. Pass the script as `stdin`:
 * `streamSshCommand(via, ['bun', 'run', '-'], { cwd: site.appPath, stdin: code })`.
 *
 * `cwd`, `env` and `sudo` describe the REMOTE command; the local ssh inherits
 * this process's environment.
 */
export function streamSshCommand(via: SshVia, argv: readonly string[], options: RunRemoteCommandOptions = {}): ProcessStream {
  const { spawn = spawnProcessStream, stdin, signal, ...remote } = options
  return spawn(buildSshCommand(via, argv, remote), { stdin, signal })
}

/**
 * Feed a {@link ProcessStream} into a {@link RuntimeStreamRegistry} entry and
 * close the entry when the process ends: `complete` on exit 0, `failed`
 * otherwise. Cancelling the registry entry kills the process.
 */
export async function pumpProcessStream(
  registry: RuntimeStreamRegistry,
  streamId: string,
  child: ProcessStream,
): Promise<RuntimeStreamSnapshot | undefined> {
  const signal = registry.signal(streamId)
  const onAbort = () => child.kill()
  if (signal?.aborted) child.kill()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of child) registry.append(streamId, chunk.data, chunk.stream)
    const exit = await child.exited
    if (signal?.aborted) return registry.close(streamId, 'cancelled')
    return exit.code === 0
      ? registry.close(streamId, 'complete')
      : registry.close(streamId, 'failed', exit.signal ? `killed by ${exit.signal}` : `exited ${exit.code}`)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
