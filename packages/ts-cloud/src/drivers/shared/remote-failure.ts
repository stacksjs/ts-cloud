/**
 * Turn per-instance remote-execution results into ONE operator-facing error.
 *
 * Both drivers used to collapse a failed remote run to a fixed sentence —
 * "One or more SSH deploy commands failed" — while the thing that explains the
 * failure (the remote command's stderr) sat right there in `perInstance`. The
 * operator was left with a deploy that had failed for no stated reason, and no
 * flag, not even `--verbose`, would print it: nothing had kept it.
 *
 * The remote output is already redacted where it is captured (the deploy script
 * embeds a here-document with the full runtime environment; see
 * `formatSshFailure`), so this only has to decide what is worth showing.
 */
import type { RemoteDeployInstanceResult } from '@ts-cloud/core'

const SSH_ERROR_OUTPUT_LIMIT = 8_000

function sshErrorOutput(value: unknown): string {
  const output = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : ''

  return (
    output
      // Remote deploy scripts contain a here-document with the complete runtime
      // environment. Never allow assignment values from command output into CI
      // logs, even when a shell or child process happens to echo the script.
      // Cover any shell-legal identifier: lowercase keys (`database_url=...`),
      // indented lines, and `export `-prefixed assignments leak just as badly.
      .replace(/(^|\n)(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=).*$/gm, '$1$2[redacted]')
      .replace(/encrypted:[A-Za-z0-9+/=]+/g, 'encrypted:[redacted]')
      .trim()
      .slice(-SSH_ERROR_OUTPUT_LIMIT)
  )
}

/**
 * The part of the deploy script bash refused to parse.
 *
 * A syntax error names a line number in a file that only ever existed on the
 * box, and the deploy deletes it on the way out, so the one thing needed to
 * understand the failure is the one thing nobody can look at. Without this you
 * are reduced to guessing which generated fragment is unbalanced, or to
 * reproducing the whole script by hand from its builders.
 *
 * Only a window around the reported line, and every `KEY="value"` line inside
 * it is redacted: the script carries the runtime environment, and a deploy
 * failure must not become the reason a database password is in a CI log.
 */
export function describeScriptSyntaxError(error: unknown, script: string): string {
  const stderr = sshErrorOutput((error as { stderr?: unknown })?.stderr)
  const match = /line (\d+): syntax error/.exec(stderr)
  if (!match)
    return ''

  const reported = Number(match[1])
  const lines = script.split('\n')
  const from = Math.max(1, reported - 12)
  const to = Math.min(lines.length, reported + 2)

  const window = lines.slice(from - 1, to).map((line, index) => {
    const number = from + index
    const safe = /^[A-Z_][A-Z0-9_]*=/.test(line) ? line.replace(/=.*/, '=<redacted>') : line
    return `  ${String(number).padStart(4)}${number === reported ? ' >' : '  '} ${safe}`
  })

  return [
    '',
    `The deploy script bash rejected is ${lines.length} lines; it stopped at ${reported}.`,
    ...window,
  ].join('\n')
}

/**
 * One operator-facing line (plus redacted output) for a failed ssh/scp child.
 *
 * Takes the shape Node's `execFileSync` error has (`status`, `signal`,
 * `stdout`, `stderr`) so a `Bun.spawn`-based transport only has to build the
 * same object. Never includes the command line: it carries the deploy script.
 */
export function formatSshFailure(error: unknown): string {
  const childError = error as { status?: number | null; signal?: string | null; stdout?: unknown; stderr?: unknown }
  const status = typeof childError?.status === 'number' ? ` (exit ${childError.status})` : ''
  const signal = childError?.signal ? ` (signal ${childError.signal})` : ''
  const output = [sshErrorOutput(childError?.stderr), sshErrorOutput(childError?.stdout)].filter(Boolean).join('\n')

  return `Remote SSH command failed${status}${signal}${output ? `\n${output}` : ''}`
}

/**
 * Print the lines a remote deploy script meant a human to read.
 *
 * The remote stdout has always been captured and then dropped on the floor,
 * which is why nothing the box says has ever reached a CI log: not the
 * memory-commitment report, not `migrate`, not `catalog:sync`. A deploy that
 * cannot tell you what it did on the box is one you have to SSH in to
 * understand, and by then you are debugging rather than reading.
 *
 * Only `[ts-cloud]`-prefixed lines are surfaced, and that restraint is
 * deliberate rather than tidy. The script fed to `bash -s` carries the runtime
 * environment here-document - database credentials, APP_KEY, provider tokens -
 * which is why {@link formatSshFailure} refuses to echo a failing command back.
 * Remote *stdout* is not the script, so it does not contain those secrets by
 * construction, but it is whatever arbitrary `preStart` commands chose to
 * print, and an app that logs its own config on boot would leak it here. An
 * explicit marker means ts-cloud only ever republishes lines ts-cloud wrote.
 */
export function surfaceRemoteNotices(output: string): void {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[ts-cloud]')) continue
    // eslint-disable-next-line no-console
    console.warn(trimmed)
  }
}

/** Longest remote output carried into the aggregate error, per instance. */
const PER_INSTANCE_LIMIT = 4_000

/** Instances beyond this are summarized as a count rather than quoted. */
const MAX_QUOTED_INSTANCES = 3

function clip(value: string): string {
  // Keep the TAIL: a failing script's last lines are the ones that name the
  // failure, while the head is setup noise.
  return value.length > PER_INSTANCE_LIMIT ? `…\n${value.slice(-PER_INSTANCE_LIMIT)}` : value
}

/**
 * Build the `error` for a {@link import('@ts-cloud/core').RemoteDeployResult}
 * whose run did not fully succeed. `summary` is the one-line what-failed (e.g.
 * "One or more SSH deploy commands failed"); the detail of each failing
 * instance is appended beneath it.
 */
export function summarizeRemoteFailures(
  perInstance: readonly RemoteDeployInstanceResult[],
  summary: string,
): string {
  const failed = perInstance.filter(item => item.status !== 'Success')
  if (failed.length === 0) return summary

  const quoted = failed.slice(0, MAX_QUOTED_INSTANCES).map((item) => {
    // Prefer the captured error (stderr + exit status); fall back to stdout,
    // which is where a script that reports its own failure and exits non-zero
    // without writing to stderr leaves the explanation.
    const detail = (item.error || item.output || '').trim()
    const head = `${item.instanceId}: ${item.status}`
    return detail ? `${head}\n${clip(detail)}` : head
  })

  const remaining = failed.length - quoted.length
  const more = remaining > 0 ? [`(+${remaining} more instance${remaining === 1 ? '' : 's'} failed)`] : []

  return [summary, ...quoted, ...more].join('\n')
}
