import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { REMOTE_SCRIPT_RUNNER } from '../../src/drivers/shared/remote-exec'
import { describeScriptSyntaxError } from '../../src/drivers/hetzner/driver'

/**
 * A deploy script is delivered over stdin so its secrets never reach argv.
 * `bash -s` then reads the script from the SAME stdin the script's own commands
 * inherit, so the first command that reads stdin eats the rest of the deploy —
 * silently when the remainder happens to parse, and as `syntax error:
 * unexpected end of file` when it does not. Either way the deploy stops partway
 * through with nothing naming the cause.
 *
 * These run the runner the way the driver does: locally, with the script piped
 * in, since that is the whole behaviour under test.
 */
function runStaged(script: string): { stdout: string, status: number } {
  try {
    const stdout = execFileSync('bash', ['-c', REMOTE_SCRIPT_RUNNER], { encoding: 'utf8', input: script })
    return { stdout, status: 0 }
  }
  catch (error) {
    const e = error as { stdout?: string, status?: number }
    return { stdout: e.stdout ?? '', status: e.status ?? 1 }
  }
}

describe('remote script runner', () => {
  it('runs every line even when a command reads stdin', () => {
    const script = [
      'echo installed',
      // Stands in for anything that drains stdin: a package manager prompt, a
      // build tool, tar.
      'cat > /dev/null',
      'echo built',
      'for i in 1 2; do echo "restarted $i"; done',
      'echo activated',
    ].join('\n')

    const { stdout, status } = runStaged(script)

    expect(status).toBe(0)
    expect(stdout).toContain('installed')
    expect(stdout).toContain('built')
    expect(stdout).toContain('restarted 1')
    expect(stdout).toContain('restarted 2')
    expect(stdout).toContain('activated')
  })

  it('pins the failure it exists to prevent', () => {
    // The same script through `bash -s` loses everything after the reader.
    const script = 'echo installed\ncat > /dev/null\necho activated\n'
    const stdout = execFileSync('bash', ['-c', 'bash -s'], { encoding: 'utf8', input: script })

    expect(stdout).toContain('installed')
    expect(stdout).not.toContain('activated')
  })

  it('propagates the script exit code', () => {
    expect(runStaged('echo ok\nexit 7\n').status).toBe(7)
    expect(runStaged('echo ok\n').status).toBe(0)
    expect(runStaged('set -e\nfalse\necho unreachable\n').status).toBe(1)
  })

  it('leaves no staged script behind', () => {
    runStaged('echo ok\n')
    const leftovers = execFileSync('bash', ['-c', 'ls /tmp/ts-cloud-deploy.* 2>/dev/null | wc -l'], { encoding: 'utf8' })
    expect(leftovers.trim()).toBe('0')
  })
})

describe('describeScriptSyntaxError', () => {
  const script = [
    'echo one',
    'DB_PASSWORD="hunter2"',
    'if [ -f x ]; then',
    'echo two',
    'echo three',
  ].join('\n')

  it('shows the window around the line bash named', () => {
    const out = describeScriptSyntaxError({ stderr: '/tmp/x: line 5: syntax error: unexpected end of file' }, script)

    expect(out).toContain('is 5 lines; it stopped at 5')
    expect(out).toContain('if [ -f x ]; then')
    expect(out).toContain('echo three')
  })

  it('never prints an environment value', () => {
    const out = describeScriptSyntaxError({ stderr: '/tmp/x: line 5: syntax error: unexpected end of file' }, script)

    expect(out).toContain('DB_PASSWORD=<redacted>')
    expect(out).not.toContain('hunter2')
  })

  it('says nothing when the failure was not a syntax error', () => {
    expect(describeScriptSyntaxError({ stderr: 'connection refused' }, script)).toBe('')
  })
})
