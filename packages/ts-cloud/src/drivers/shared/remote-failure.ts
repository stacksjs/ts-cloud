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
