/**
 * A persistent shell session for the dashboard's web terminal. Spawns an
 * interactive shell on the host the dashboard runs on (in box mode that is the
 * provisioned server, matching Forge's web SSH) and streams its output back
 * through `onData`. Input is written to the shell's stdin.
 *
 * This is a line-oriented shell over pipes, not a full PTY: cwd and environment
 * persist across commands and long-running output streams, but curses-style
 * full-screen programs (vim, htop) are not supported. It is gated behind the
 * dashboard's Basic auth like every other control surface.
 */

export interface TerminalSession {
  /** Write raw input (typically a command line ending in \n) to the shell. */
  write: (data: string) => void
  /** Terminate the shell and release the streams. */
  close: () => void
}

export interface TerminalSessionOptions {
  shell?: string
  cwd?: string
  onExit?: (code: number | null) => void
}

export function createTerminalSession(onData: (chunk: string) => void, options: TerminalSessionOptions = {}): TerminalSession {
  const shell = options.shell || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  const proc = Bun.spawn([shell, '-i'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: options.cwd,
    env: { ...process.env, TERM: 'xterm-256color', PS1: '\\w $ ' },
  })

  const decoder = new TextDecoder()
  const pump = async (stream: ReadableStream<Uint8Array> | undefined): Promise<void> => {
    if (!stream)
      return
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done)
          break
        if (value)
          onData(decoder.decode(value))
      }
    }
    catch { /* stream closed */ }
  }
  void pump(proc.stdout as any)
  void pump(proc.stderr as any)
  if (options.onExit)
    proc.exited.then(code => options.onExit!(code)).catch(() => {})

  return {
    write(data: string) {
      try {
        proc.stdin.write(data)
        proc.stdin.flush()
      }
      catch { /* shell gone */ }
    },
    close() {
      try {
        proc.stdin.end()
      }
      catch { /* already closed */ }
      try {
        proc.kill()
      }
      catch { /* already dead */ }
    },
  }
}
