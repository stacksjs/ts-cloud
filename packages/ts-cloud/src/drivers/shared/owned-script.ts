import { remoteScriptRunner } from './remote-exec'

export interface OwnedScriptOptions {
  sudo?: boolean
  timeoutSeconds?: number
  /** A silent or disconnected controller loses its attempt. @default 30 */
  leaseSeconds?: number
}

const HEARTBEAT = 'ts-cloud-alive\n'
const HEARTBEAT_MS = 1000
const OUTPUT_LIMIT = 256 * 1024 * 1024

async function collectOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  let head = 0
  for await (const chunk of stream) {
    chunks.push(chunk)
    size += chunk.byteLength
    while (size > OUTPUT_LIMIT && head < chunks.length) {
      const first = chunks[head]!
      const excess = size - OUTPUT_LIMIT
      if (first.byteLength <= excess) {
        chunks[head++] = new Uint8Array(0)
        size -= first.byteLength
      } else {
        chunks[head] = first.slice(excess)
        size -= excess
      }
    }
    if (head > 1024) {
      chunks.splice(0, head)
      head = 0
    }
  }
  return Buffer.concat(chunks.slice(head)).toString('utf8')
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * Stage the payload before starting a dedicated process group. The remaining
 * input is a controller lease, never the script's stdin. EOF and a missed
 * renewal both stop only this attempt, including ordinary descendants.
 *
 * Supervision runs inside sudo, so it can signal root children. The worker's
 * group is allocated by Bash job control; no host-wide PID/name lookup or
 * service stop is involved. The normal exit path also reaps leftover children.
 */
export function ownedScriptRunner(options: OwnedScriptOptions = {}): string {
  remoteScriptRunner(options) // Validate the existing deadline contract before spawning.
  const lease = options.leaseSeconds ?? 30
  if (!Number.isSafeInteger(lease) || lease < 2)
    throw new Error('Remote controller leaseSeconds must be a safe integer of at least 2')
  const supervisor = [
    'set -e',
    'ts_cloud_dir=$1',
    'ts_cloud_worker=',
    'ts_cloud_watcher=',
    'ts_cloud_deadline_watcher=',
    'ts_cloud_group_verified=0',
    'ts_cloud_has_children() {',
    '  ts_cloud_processes=$(ps -A -o pid=,pgid=,stat=) || return 0',
    '  while read -r ts_cloud_pid ts_cloud_pgid ts_cloud_state; do',
    '    if [ "$ts_cloud_pgid" = "$ts_cloud_worker" ] && [ "$ts_cloud_pid" != "$ts_cloud_worker" ]; then',
    '      case $ts_cloud_state in Z*) ;; *) return 0;; esac',
    '    fi',
    '  done <<< "$ts_cloud_processes"',
    '  return 1',
    '}',
    'ts_cloud_stop_group() {',
    '  [ -n "$ts_cloud_worker" ] || return 0',
    '  if [ "$ts_cloud_group_verified" != 1 ]; then',
    // This is only the unreleased gate process; no payload or descendant has
    // started. It cannot trap a signal and wait forever during admission.
    '    kill -KILL "$ts_cloud_worker" 2>/dev/null || true',
    '    wait "$ts_cloud_worker" 2>/dev/null || true',
    '    return 0',
    '  fi',
    '  kill -TERM -- "-$ts_cloud_worker" 2>/dev/null || return 0',
    '  for ts_cloud_grace in 1 2 3 4 5; do',
    '    if ! ts_cloud_has_children; then',
    '      printf "finish\\n" >&6',
    '      wait "$ts_cloud_worker" 2>/dev/null || true',
    '      ts_cloud_worker=',
    '      return 0',
    '    fi',
    '    sleep 1',
    '  done',
    '  kill -KILL -- "-$ts_cloud_worker" 2>/dev/null || true',
    '  wait "$ts_cloud_worker" 2>/dev/null || true',
    '  ts_cloud_worker=',
    '}',
    'ts_cloud_cleanup() {',
    '  trap - EXIT HUP INT TERM',
    '  if [ -n "$ts_cloud_watcher" ]; then',
    '    kill -TERM "$ts_cloud_watcher" 2>/dev/null || true',
    '    wait "$ts_cloud_watcher" 2>/dev/null || true',
    '  fi',
    '  if [ -n "$ts_cloud_deadline_watcher" ]; then',
    '    printf "finish\\n" >&7',
    '    wait "$ts_cloud_deadline_watcher" 2>/dev/null || true',
    '  fi',
    '  ts_cloud_stop_group',
    '  rm -f "$ts_cloud_dir/script" "$ts_cloud_dir/cancelled" "$ts_cloud_dir/timed-out" "$ts_cloud_dir/start" "$ts_cloud_dir/result" "$ts_cloud_dir/finish" "$ts_cloud_dir/deadline"',
    '}',
    'trap ts_cloud_cleanup EXIT',
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    ...(options.timeoutSeconds === undefined ? [] : [
      "if ! timeout --version 2>/dev/null | grep -q 'GNU coreutils'; then",
      "  printf '%s\\n' 'Remote deployment deadlines require GNU coreutils timeout on the host' >&2",
      '  exit 125',
      'fi',
    ]),
    'exec 3<&0',
    'mkfifo "$ts_cloud_dir/start" "$ts_cloud_dir/result" "$ts_cloud_dir/finish" "$ts_cloud_dir/deadline"',
    'exec 4<> "$ts_cloud_dir/start"',
    'exec 5<> "$ts_cloud_dir/result"',
    'exec 6<> "$ts_cloud_dir/finish"',
    'exec 7<> "$ts_cloud_dir/deadline"',
    'set -m',
    // The anchor retains the group ID until cleanup finishes. Reaping the
    // payload first would let its PID/group ID be recycled before a later
    // descendant cleanup signal. Only the supervisor releases this anchor.
    `bash -c ${quote(`trap ':' TERM HUP INT; IFS= read -r ts_cloud_start < "$1/start"; [ "$ts_cloud_start" = start ] || exit 125; bash "$1/script"; ts_cloud_status=$?; printf '%s\\n' "$ts_cloud_status" > "$1/result"; IFS= read -r ts_cloud_finish < "$1/finish"`)} -- "$ts_cloud_dir" 3<&- 4>&- 5>&- 6>&- 7>&- < /dev/null &`,
    'ts_cloud_worker=$!',
    'set +m',
    'ts_cloud_group=$(ps -o pgid= -p "$ts_cloud_worker" | tr -d " ")',
    '[ "$ts_cloud_group" = "$ts_cloud_worker" ] || { printf "%s\\n" "Cannot establish deployment process ownership" >&2; exit 125; }',
    'ts_cloud_group_verified=1',
    'printf "start\\n" >&4',
    'exec 4>&-',
    ...(options.timeoutSeconds === undefined ? [] : [
      // Use GNU timeout as a host timer, not around the payload: its own
      // process group would otherwise escape the attempt's ownership group.
      '(',
      '  trap - EXIT HUP INT TERM',
      '  set +e',
      `  timeout --kill-after=5s ${options.timeoutSeconds}s bash -c 'IFS= read -r ts_cloud_wakeup <&7'`,
      '  ts_cloud_deadline_status=$?',
      '  if [ "$ts_cloud_deadline_status" = 124 ] || [ "$ts_cloud_deadline_status" = 137 ]; then',
      '    : > "$ts_cloud_dir/timed-out" 2>/dev/null || true',
      '    printf "124\\n" >&5',
      '  fi',
      ') &',
      'ts_cloud_deadline_watcher=$!',
    ]),
    '(',
    '  trap - EXIT HUP INT TERM',
    `  while IFS= read -r -t ${lease} ts_cloud_renewal <&3; do`,
    '    [ "$ts_cloud_renewal" = ts-cloud-alive ] || break',
    '  done',
    '  : > "$ts_cloud_dir/cancelled" 2>/dev/null || true',
    '  printf "125\\n" >&5',
    ') &',
    'ts_cloud_watcher=$!',
    'IFS= read -r ts_cloud_status <&5',
    'if [ -f "$ts_cloud_dir/cancelled" ]; then',
    "  printf '%s\\n' 'Remote deployment controller lease ended; cancelled this attempt' >&2",
    '  exit 125',
    'fi',
    'if [ -f "$ts_cloud_dir/timed-out" ]; then',
    "  printf '%s\\n' 'Remote deployment deadline exceeded; stopped this attempt' >&2",
    '  exit 124',
    'fi',
    'exit "$ts_cloud_status"',
  ].join('\n')
  return [
    'set -e',
    'umask 077',
    'ts_cloud_dir=$(mktemp -d /tmp/ts-cloud-owned.XXXXXXXX)',
    'trap \'rm -rf "$ts_cloud_dir"\' EXIT',
    'IFS= read -r ts_cloud_size',
    "case $ts_cloud_size in ''|*[!0-9]*) exit 125;; esac",
    'head -c "$ts_cloud_size" > "$ts_cloud_dir/script"',
    '[ "$(wc -c < "$ts_cloud_dir/script" | tr -d " ")" = "$ts_cloud_size" ] || exit 125',
    `${options.sudo ? 'sudo -n -H ' : ''}bash -c ${quote(supervisor)} -- "$ts_cloud_dir"`,
  ].join('\n')
}

/** Keep the lease pipe open and renewable until the remote supervisor exits. */
export async function runLeasedCommand(command: string[], script: string): Promise<{
  code: number
  signal: string | null
  stdout: string
  stderr: string
}> {
  const child = Bun.spawn(command, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  let timer: ReturnType<typeof setInterval> | undefined
  let completed = false
  try {
    child.stdin.write(`${Buffer.byteLength(script)}\n`)
    child.stdin.write(script)
    child.stdin.write(HEARTBEAT)
    await child.stdin.flush()
    timer = setInterval(() => {
      try {
        child.stdin.write(HEARTBEAT)
        Promise.resolve(child.stdin.flush()).catch(() => {})
      } catch { /* Remote completion can close stdin before its exit arrives. */ }
    }, HEARTBEAT_MS)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, collectOutput(child.stdout), collectOutput(child.stderr),
    ])
    completed = true
    return { code, signal: child.signalCode, stdout, stderr }
  } finally {
    clearInterval(timer)
    try { child.stdin.end() } catch {}
    if (!completed) child.kill('SIGTERM')
  }
}
