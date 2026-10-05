/**
 * Shared deploy script helpers for Forge-style compute deploys.
 *
 * Both server-app and server-static sites deploy with **zero downtime** the same
 * way PHP/Laravel sites do (Envoyer-style): the artifact is unpacked into a fresh
 * `releases/<id>` directory, shared paths (`.env`) are symlinked in, and the
 * `current` symlink is repointed atomically (`mv -Tf`). The gateway serves the
 * site from `<base>/current`, so a static swap is instantaneous (no window where
 * the docroot is empty), and an app restart re-execs against the already-staged
 * release (no window where the code is half-replaced). Old releases are kept for
 * instant rollback. See {@link import('./releases')}.
 */
import type { SharedPathEntry, SiteLivenessConfig } from '@ts-cloud/core'
import type { ReleasePaths } from './releases'
import { formatEnvFile } from './env-file'
import { buildActivateRelease, buildDeployLock, buildRecordPreviousRelease, buildEnsureReleaseLayout, buildLinkSharedPaths, buildPromoteStagedRelease, buildPruneReleases, buildResetReleaseDir, buildStrandedReleaseTrap, dedupeSharedPaths, DEFAULT_KEEP_RELEASES, releasePaths, stxImageCacheDir } from './releases'
import { sqliteSharedPaths } from './sqlite-shared-path'

/** Extensions that mark the first token as something a runtime should be given. */
const MODULE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/

/**
 * Translate a `start` command into an absolute systemd ExecStart.
 *
 * Three shapes, because a site's entry point is not always a module:
 *
 *  1. `bun run server.ts` — a leading runtime word is swapped for its absolute
 *     path, which is where the runtime actually lives on the box.
 *  2. `dist/index.js` — a bare module gets the runtime put in front of it.
 *  3. `./buddy serve` — an EXECUTABLE in the release, run directly.
 *
 * The third used to be impossible: every start was prefixed with the runtime,
 * so pointing at a CLI wrapper — a shell script with a shebang, which is what
 * `./buddy` is — had systemd run `bun ./buddy serve`, and bun parsed the shell
 * as JavaScript. The service crash-looped on the wrapper's first line before
 * it ever bound its port, which reads as an application crash rather than as
 * the deploy handing the file to the wrong interpreter.
 *
 * That mattered because a project's CLI is the documented way to start it.
 * Without this an app had to keep a bundled JS entry point beside the CLI it
 * otherwise uses for everything, and keep the two in step by hand.
 *
 * `workingDirectory` is where a relative executable is resolved from —
 * systemd requires an absolute ExecStart and does NOT resolve one against
 * `WorkingDirectory`. Relative executables are left untouched without it,
 * rather than emitting a unit that fails to start.
 */
export function resolveExecStart(
  start: string,
  runtime: 'bun' | 'node' | 'deno',
  workingDirectory?: string,
): string {
  const bin =
    runtime === 'bun' ? '/usr/local/bin/bun' : runtime === 'deno' ? '/usr/local/bin/deno' : '/usr/local/bin/node'

  const command = start.trim()

  // 1. An explicit runtime word: swap it for the absolute binary.
  if (/^(?:bun|node|deno)\s+/.test(command))
    return `${bin} ${command.replace(/^(?:bun|node|deno)\s+/, '')}`

  const [first = '', ...rest] = command.split(/\s+/)

  // 3. Anything that is not a module is an executable, run as itself.
  if (first && !MODULE_EXTENSIONS.test(first)) {
    const executable = first.startsWith('/')
      ? first
      : workingDirectory && first.startsWith('./')
        ? `${workingDirectory.replace(/\/+$/, '')}/${first.replace(/^\.\//, '')}`
        : undefined

    if (executable)
      return [executable, ...rest].join(' ')
  }

  // 2. A module, or a relative executable with nowhere to resolve it from.
  return `${bin} ${command}`
}

/**
 * Stop the implicit per-template slice from silently capping the service.
 *
 * systemd puts an instantiated unit into a slice derived from its template
 * name: `acme-web@sha.service` lands in `system-acme\x2dweb.slice`, with no
 * `Slice=` anywhere in the unit and nothing in this file asking for it. The
 * memory ceilings that ARE in this file go on the service. Nothing ever wrote
 * to the slice, so whatever it happened to be holding was never reconciled.
 *
 * Two ways that bites, and both were observed on one shared box:
 *
 *  1. **Stale values outlive the config that set them.** A limit put on the
 *     slice once - by hand during an incident, or by an older release of this
 *     tool - stays there forever. The kernel enforces the MINIMUM down the
 *     hierarchy, so a slice holding 512M silently caps a service whose unit
 *     says 2G. Four tenants on that box were pinned that way, each reading
 *     `MemoryHigh=2G` in its own unit while actually living under 512M, and
 *     nothing in any repo said so.
 *
 *  2. **The cutover overlap doubles the tenant's footprint.** The whole point
 *     of the templated layout is that the old and new instances run at once on
 *     a SO_REUSEPORT socket. They share this slice. So a slice limit equal to
 *     the per-instance limit is guaranteed to be breached by every successful
 *     deploy - and a cgroup over `memory.high` is throttled in
 *     `mem_cgroup_handle_over_high`, which is uninterruptible sleep. A process
 *     there answers no requests AND no SIGTERM, so systemd waits out
 *     `TimeoutStopSec` while the replacement starts into the same over-budget
 *     slice and wedges in turn. That is an outage that repeats on every deploy
 *     and needs a SIGKILL by hand to clear.
 *
 * So the slice is reset to unlimited on every deploy and the service keeps the
 * only ceiling. That is the honest arrangement: `memoryHigh` in config means a
 * bound on one instance, one authority, visible in the repo. It also makes the
 * fix self-healing - a box carrying stale slice caps is corrected by its next
 * deploy rather than needing someone to find them.
 *
 * The slice name is read back from systemd rather than derived here, because
 * deriving it means reimplementing systemd's escaping (`-` becomes `\x2d`)
 * and being wrong about a name is how you reset the wrong cgroup. Units that
 * are not templated report `system.slice`, which is shared with every other
 * service on the box and is skipped explicitly.
 *
 * Both stores are written: a `--runtime` property in /run outranks the
 * persistent one in /etc, so setting only one leaves the other free to win.
 */
/**
 * Resolve `memoryHigh: 'auto'` against the box the deploy is landing on.
 *
 * The ceiling exists to contain ONE runaway, not to ration memory between
 * tenants, and those want different numbers. A fair share - RAM divided by the
 * number of units - sounds principled and is wrong: this box carries 43 units
 * on 15 GB, so an even split is 290 MB and would throttle healthy apps that
 * legitimately sit at 800 MB. The ceiling has to sit well ABOVE normal usage
 * and still be low enough that one leak cannot take the machine.
 *
 * So it is a fraction of the box: an eighth, floored at 512 MB and capped at
 * 4 GB. On the 15 GB host this was written for that resolves to ~1.9 GB, which
 * is what the old hard-coded 2G was doing - the point is that a 4 GB box now
 * gets 512 MB instead of a ceiling larger than the machine, and a 64 GB box
 * gets 4 GB instead of being pinned to a number chosen for someone else's
 * hardware.
 *
 * Computed on the target rather than at config time because that is the only
 * place the answer is known. An explicit `memoryHigh` always wins - this is a
 * default, not a policy - and it is written as a drop-in so the unit file
 * itself stays byte-identical across deploys and stays diffable.
 *
 * The report at the end is the other half. 43 units on that box declared 76 GB
 * of ceilings against 15 GB of RAM, 502 per cent committed, and nothing
 * anywhere said so: every unit looked reasonable on its own. Ceilings that sum
 * past the machine are not protection, they are arithmetic nobody did, so the
 * deploy now does it out loud.
 */
export function buildAutoMemoryHigh(unitFile: string): string[] {
  return [
    // An eighth of RAM, in MB, clamped. `/proc/meminfo` is in kB.
    `TS_CLOUD_MEM_MB=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)`,
    'TS_CLOUD_HIGH_MB=$((TS_CLOUD_MEM_MB / 8))',
    '[ "$TS_CLOUD_HIGH_MB" -lt 512 ] && TS_CLOUD_HIGH_MB=512',
    '[ "$TS_CLOUD_HIGH_MB" -gt 4096 ] && TS_CLOUD_HIGH_MB=4096',
    `mkdir -p /etc/systemd/system/${unitFile}.d`,
    `printf '# Written by ts-cloud: memoryHigh resolved from this box.\n# An eighth of %sMB RAM. Set memoryHigh in config to override.\n[Service]\nMemoryAccounting=true\nMemoryHigh=%sM\n' "$TS_CLOUD_MEM_MB" "$TS_CLOUD_HIGH_MB" > /etc/systemd/system/${unitFile}.d/50-ts-cloud-memory.conf`,
    'systemctl daemon-reload',
    `echo "[ts-cloud] memoryHigh=auto resolved to \${TS_CLOUD_HIGH_MB}M (one eighth of \${TS_CLOUD_MEM_MB}M)"`,
    ...buildCommitmentReport(),
  ]
}

/**
 * Take back what the box decided, once config has decided instead.
 *
 * The `auto` drop-in is written to `<unit>.d/50-ts-cloud-memory.conf`, and a
 * drop-in overrides the unit file. So a site that ran on `auto` and LATER
 * declared `memoryHigh` got its new value written into the unit file and kept
 * running on the old automatic one: wildloop's ingest worker declared 1G/1536M
 * and ran at the 1951M a deploy months earlier had resolved, above its own
 * MemoryMax. An explicit value has to remove the drop-in, not just stop
 * writing it.
 *
 * `high` / `max` also clear `systemctl set-property` overrides for the
 * limits config now declares. Those land in `system.control/<unit>.d/` (and
 * `/run/...` for `--runtime`), outrank the unit file the same way, and are
 * how a hand-tuned box keeps a ceiling nobody can see in the repo. Only for a
 * plain unit: set-property on a templated release instance names that one
 * instance, which the next deploy replaces anyway.
 *
 * Reloads systemd only when something was actually removed.
 */
export function buildClearAutoMemoryHigh(
  unitFile: string,
  clear: { auto?: boolean, high?: boolean, max?: boolean } = { auto: true },
): string[] {
  const stale = clear.auto === false ? [] : [`/etc/systemd/system/${unitFile}.d/50-ts-cloud-memory.conf`]
  for (const root of ['/etc/systemd/system.control', '/run/systemd/system.control']) {
    if (clear.high)
      stale.push(`${root}/${unitFile}.d/50-MemoryHigh.conf`)
    if (clear.max)
      stale.push(`${root}/${unitFile}.d/50-MemoryMax.conf`)
  }
  if (stale.length === 0)
    return []
  return [
    'TS_CLOUD_MEM_CLEARED=0',
    ...stale.map(file => `if [ -f ${file} ]; then rm -f ${file}; TS_CLOUD_MEM_CLEARED=1; echo "[ts-cloud] removed ${file}: memory limits now come from config"; fi`),
    'if [ "$TS_CLOUD_MEM_CLEARED" = 1 ]; then systemctl daemon-reload; fi',
  ]
}

/**
 * Say what the box has now been promised, so oversubscription is visible.
 *
 * Sums `memory.high` across every service cgroup and compares it to RAM. It
 * only ever prints - refusing a deploy over a number this crude would be worse
 * than the problem, since a soft ceiling is a guard rather than a reservation
 * and being committed past 100 per cent is normal and fine. What is not fine
 * is being at 500 per cent and nobody knowing.
 */
export function buildCommitmentReport(): string[] {
  return [
    // Leaf `.service` cgroups only. A glob that also matched slice directories
    // would count a slice AND every service inside it, and a warning that
    // overstates is worse than none - the first person to check it stops
    // believing the next one. This total does include infrastructure services
    // (clamav, postgres) alongside app units, which is correct: they are
    // claiming the same RAM.
    `TS_CLOUD_COMMIT=$(for f in /sys/fs/cgroup/system.slice/*.service/memory.high /sys/fs/cgroup/system.slice/*.slice/*.service/memory.high; do [ -f "$f" ] || continue; v=$(cat "$f" 2>/dev/null); [ "$v" = "max" ] && continue; echo "$v"; done | awk '{s+=$1} END {print int(s/1048576)}')`,
    `TS_CLOUD_RAM=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)`,
    `if [ -n "$TS_CLOUD_COMMIT" ] && [ "$TS_CLOUD_COMMIT" -gt 0 ] && [ "$TS_CLOUD_RAM" -gt 0 ]; then`
    + ` TS_CLOUD_PCT=$((TS_CLOUD_COMMIT * 100 / TS_CLOUD_RAM));`
    + ` if [ "$TS_CLOUD_PCT" -gt 300 ]; then echo "[ts-cloud] WARNING: services on this box declare \${TS_CLOUD_COMMIT}M of MemoryHigh against \${TS_CLOUD_RAM}M of RAM (\${TS_CLOUD_PCT}% committed). Soft ceilings, so this is not fatal - but no ceiling can protect the box once enough of them are drawn on at once.";`
    + ` else echo "[ts-cloud] memory commitment: \${TS_CLOUD_COMMIT}M declared against \${TS_CLOUD_RAM}M RAM (\${TS_CLOUD_PCT}%)"; fi; fi`,
  ]
}

export function buildSliceReconcile(instance: string): string[] {
  return [
    `TS_CLOUD_SLICE=$(systemctl show ${instance} -p Slice --value 2>/dev/null || true)`,
    // `system.slice` is the box-wide default and belongs to every tenant.
    'if [ -n "$TS_CLOUD_SLICE" ] && [ "$TS_CLOUD_SLICE" != "system.slice" ]; then'
    + ' systemctl set-property --runtime "$TS_CLOUD_SLICE" MemoryHigh=infinity MemoryMax=infinity 2>/dev/null || true;'
    + ' systemctl set-property "$TS_CLOUD_SLICE" MemoryHigh=infinity MemoryMax=infinity 2>/dev/null || true;'
    + ' fi',
  ]
}

/**
 * Liveness probe settings for a ported site - the same shape as
 * `SiteConfig.liveness`. See {@link LIVENESS_DEFAULTS} for unset fields.
 */
export type LivenessOptions = SiteLivenessConfig

export const LIVENESS_DEFAULTS = {
  path: '/',
  intervalSeconds: 60,
  failuresBeforeRestart: 3,
  timeoutSeconds: 10,
  startupGraceSeconds: 600,
  maxBackoffSeconds: 3600,
  /** The wait before the second consecutive restart; it doubles from there. */
  backoffBaseSeconds: 300,
} as const

function wholeSeconds(value: number | undefined, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback
}

/**
 * Shell that installs a recurring liveness check for one ported service.
 *
 * Three files: a check script, a oneshot service that runs it, and a timer.
 * The script resolves the unit to probe at run time rather than baking in a
 * release id, so it keeps working after the next deploy replaces the instance.
 *
 * `curl` without `-f`: any HTTP response means the process is answering, and a
 * 404 on `/` is a routing opinion, not a wedged event loop. Only a refused
 * connection or no response within `timeoutSeconds` counts against it. A
 * timeout has to count - a wedged process still has its port bound and the
 * kernel still accepts into its backlog, so "connects but never answers" is
 * exactly the failure this exists for - which is why the budget is generous
 * rather than why timeouts are forgiven.
 *
 * A restart needs N consecutive failures, counted in a file under /run, so a
 * single slow moment cannot bounce a healthy service; the counter resets on the
 * first good response. flock keeps two ticks from overlapping.
 *
 * **Startup grace.** A check against a unit younger than `startupGraceSeconds`
 * is not counted. Without it the probe turned a slow boot into an outage loop:
 * a release whose image warm-up kept its main thread busy for minutes after
 * binding was restarted three minutes into each boot, three times running.
 * Every restart threw the warm-up away and began it again, so visitors saw
 * nine minutes of 502s from a release that would have been healthy in five.
 * The age is the unit's own `ActiveEnterTimestampMonotonic` against
 * `/proc/uptime`, which a restart resets, with the main PID's elapsed time as
 * the fallback.
 *
 * **Back-off.** Restarts the probe itself issued are remembered with the time
 * of the last one. The second in a row waits at least five minutes after the
 * first and each later one doubles, capped at `maxBackoffSeconds`, so a
 * release that can never come up is restarted a handful of times and then
 * about hourly, not every few minutes forever. The streak is forgotten once
 * the service answers with no probe restart in the last `maxBackoffSeconds`,
 * and a deploy starts it afresh. Every held-off restart says so in the
 * journal under the `<unit>-liveness` tag.
 */
export function buildLivenessUnits(options: {
  unitBase: string
  /** systemd unit to restart. A `<base>@*.service` glob resolves at run time. */
  unitPattern: string
  port: number
} & LivenessOptions): string[] {
  const { unitBase, unitPattern, port } = options
  const path = options.path && options.path.startsWith('/') ? options.path : LIVENESS_DEFAULTS.path
  const interval = wholeSeconds(options.intervalSeconds, LIVENESS_DEFAULTS.intervalSeconds, 10)
  const failures = wholeSeconds(options.failuresBeforeRestart, LIVENESS_DEFAULTS.failuresBeforeRestart, 1)
  const timeout = wholeSeconds(options.timeoutSeconds, LIVENESS_DEFAULTS.timeoutSeconds, 1)
  const grace = wholeSeconds(options.startupGraceSeconds, LIVENESS_DEFAULTS.startupGraceSeconds, 0)
  const maxBackoff = wholeSeconds(options.maxBackoffSeconds, LIVENESS_DEFAULTS.maxBackoffSeconds, 0)
  const backoffBase = Math.min(LIVENESS_DEFAULTS.backoffBaseSeconds, maxBackoff)
  const script = `/usr/local/sbin/${unitBase}-liveness`
  const state = `/run/${unitBase}-liveness`
  const tag = `${unitBase}-liveness`
  const target = `127.0.0.1:${port}${path}`
  const templated = unitPattern.includes('@*')

  const resolveUnit = templated
    ? `TS_CLOUD_UNIT=$(systemctl list-units --plain --no-legend --type=service '${unitPattern}' 2>/dev/null | awk '{print $1}' | head -1)`
    : `TS_CLOUD_UNIT=${unitPattern}`

  // Every line below is emitted at column 0 or with a literal indent that is
  // part of the script body; nothing is re-indented after the fact, because a
  // shifted heredoc terminator silently swallows the rest of the deploy.
  return [
    `cat > ${script} <<'TS_CLOUD_LIVENESS_EOF'`,
    '#!/bin/sh',
    `# Liveness check for ${unitBase}, written by ts-cloud on every deploy.`,
    `# Settings: interval=${interval}s timeout=${timeout}s failures=${failures} startup-grace=${grace}s max-backoff=${maxBackoff}s`,
    'set -eu',
    `TS_CLOUD_STATE=${state}`,
    'exec 9>"$TS_CLOUD_STATE.lock"',
    'flock -n 9 || exit 0',
    resolveUnit,
    '[ -n "$TS_CLOUD_UNIT" ] || exit 0',
    // A unit systemd itself considers down is its own problem: Restart=always
    // is already handling it, and restarting here would fight that.
    'systemctl is-active --quiet "$TS_CLOUD_UNIT" || exit 0',
    'TS_CLOUD_RC=0',
    `curl -s -o /dev/null --max-time ${timeout} "http://${target}" || TS_CLOUD_RC=$?`,
    'if [ "$TS_CLOUD_RC" -eq 0 ]; then',
    '  rm -f "$TS_CLOUD_STATE.fail"',
    '  if [ -f "$TS_CLOUD_STATE.restarts" ]; then',
    '    TS_CLOUD_LAST=$(awk \'{print $2}\' "$TS_CLOUD_STATE.restarts" 2>/dev/null || true)',
    '    case "$TS_CLOUD_LAST" in \'\'|*[!0-9]*) TS_CLOUD_LAST=0 ;; esac',
    `    [ $(($(date +%s) - TS_CLOUD_LAST)) -lt ${maxBackoff} ] || rm -f "$TS_CLOUD_STATE.restarts"`,
    '  fi',
    '  exit 0',
    'fi',
    'case "$TS_CLOUD_RC" in',
    '  7) TS_CLOUD_WHY=\'connection refused\' ;;',
    `  28) TS_CLOUD_WHY='no response within ${timeout}s' ;;`,
    '  *) TS_CLOUD_WHY="curl exit $TS_CLOUD_RC" ;;',
    'esac',
    // Startup grace: how long has this unit been up?
    'TS_CLOUD_SINCE=$(systemctl show "$TS_CLOUD_UNIT" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || true)',
    'TS_CLOUD_UPTIME=$(cut -d\' \' -f1 /proc/uptime 2>/dev/null || true)',
    'TS_CLOUD_AGE=$(awk -v up="$TS_CLOUD_UPTIME" -v since="$TS_CLOUD_SINCE" \'BEGIN { if (since + 0 > 0 && up + 0 > 0) print int(up - since / 1000000); else print -1 }\')',
    'case "$TS_CLOUD_AGE" in \'\'|*[!0-9-]*) TS_CLOUD_AGE=-1 ;; esac',
    'if [ "$TS_CLOUD_AGE" -lt 0 ]; then',
    '  TS_CLOUD_PID=$(systemctl show "$TS_CLOUD_UNIT" -p MainPID --value 2>/dev/null || true)',
    '  case "$TS_CLOUD_PID" in \'\'|0|*[!0-9]*) ;; *) TS_CLOUD_AGE=$(ps -o etimes= -p "$TS_CLOUD_PID" 2>/dev/null | tr -d \' \' || true) ;; esac',
    '  case "$TS_CLOUD_AGE" in \'\'|*[!0-9]*) TS_CLOUD_AGE=-1 ;; esac',
    'fi',
    `if [ "$TS_CLOUD_AGE" -ge 0 ] && [ "$TS_CLOUD_AGE" -lt ${grace} ]; then`,
    '  rm -f "$TS_CLOUD_STATE.fail"',
    `  logger -t ${tag} "$TS_CLOUD_UNIT is \${TS_CLOUD_AGE}s old, inside its ${grace}s startup grace; not counting this failed check on ${target} ($TS_CLOUD_WHY)"`,
    '  exit 0',
    'fi',
    'TS_CLOUD_FAILS=$(cat "$TS_CLOUD_STATE.fail" 2>/dev/null || echo 0)',
    'case "$TS_CLOUD_FAILS" in \'\'|*[!0-9]*) TS_CLOUD_FAILS=0 ;; esac',
    'TS_CLOUD_FAILS=$((TS_CLOUD_FAILS + 1))',
    'echo "$TS_CLOUD_FAILS" > "$TS_CLOUD_STATE.fail"',
    `if [ "$TS_CLOUD_FAILS" -lt ${failures} ]; then`,
    `  logger -t ${tag} "check $TS_CLOUD_FAILS of ${failures} failed on ${target} ($TS_CLOUD_WHY)"`,
    '  exit 0',
    'fi',
    // Back-off: restarts this probe issued in a row, and when the last was.
    'TS_CLOUD_NOW=$(date +%s)',
    'TS_CLOUD_STREAK=0',
    'TS_CLOUD_LAST=0',
    '[ ! -f "$TS_CLOUD_STATE.restarts" ] || read -r TS_CLOUD_STREAK TS_CLOUD_LAST < "$TS_CLOUD_STATE.restarts" || true',
    'case "$TS_CLOUD_STREAK" in \'\'|*[!0-9]*) TS_CLOUD_STREAK=0 ;; esac',
    'case "$TS_CLOUD_LAST" in \'\'|*[!0-9]*) TS_CLOUD_LAST=0 ;; esac',
    'if [ "$TS_CLOUD_STREAK" -gt 0 ]; then',
    `  TS_CLOUD_WAIT=${backoffBase}`,
    '  TS_CLOUD_I=1',
    `  while [ "$TS_CLOUD_I" -lt "$TS_CLOUD_STREAK" ] && [ "$TS_CLOUD_WAIT" -lt ${maxBackoff} ]; do TS_CLOUD_WAIT=$((TS_CLOUD_WAIT * 2)); TS_CLOUD_I=$((TS_CLOUD_I + 1)); done`,
    `  [ "$TS_CLOUD_WAIT" -le ${maxBackoff} ] || TS_CLOUD_WAIT=${maxBackoff}`,
    '  TS_CLOUD_ELAPSED=$((TS_CLOUD_NOW - TS_CLOUD_LAST))',
    '  if [ "$TS_CLOUD_ELAPSED" -lt "$TS_CLOUD_WAIT" ]; then',
    `    logger -t ${tag} "holding off: $TS_CLOUD_STREAK liveness restart(s) in a row have not brought $TS_CLOUD_UNIT back; next restart allowed in $((TS_CLOUD_WAIT - TS_CLOUD_ELAPSED))s ($TS_CLOUD_WHY on ${target})"`,
    '    exit 0',
    '  fi',
    'fi',
    'TS_CLOUD_STREAK=$((TS_CLOUD_STREAK + 1))',
    `logger -t ${tag} "no HTTP response on ${target} after $TS_CLOUD_FAILS checks ($TS_CLOUD_WHY); restarting $TS_CLOUD_UNIT (liveness restart $TS_CLOUD_STREAK in a row)"`,
    'echo "$TS_CLOUD_STREAK $TS_CLOUD_NOW" > "$TS_CLOUD_STATE.restarts"',
    'rm -f "$TS_CLOUD_STATE.fail"',
    'systemctl restart "$TS_CLOUD_UNIT"',
    'TS_CLOUD_LIVENESS_EOF',
    `chmod +x ${script}`,
    // A deploy is a new release: it starts with no failures held against it
    // and no restart streak inherited from the one it replaced.
    `rm -f ${state}.fail ${state}.restarts`,
    `cat > /etc/systemd/system/${unitBase}-liveness.service <<'TS_CLOUD_UNIT_EOF'`,
    '[Unit]',
    `Description=Liveness check for ${unitBase} (managed by ts-cloud)`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${script}`,
    'TS_CLOUD_UNIT_EOF',
    `cat > /etc/systemd/system/${unitBase}-liveness.timer <<'TS_CLOUD_UNIT_EOF'`,
    '[Unit]',
    `Description=Run the ${unitBase} liveness check every ${interval}s`,
    '',
    '[Timer]',
    `OnUnitActiveSec=${interval}s`,
    `OnBootSec=${interval}s`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    'TS_CLOUD_UNIT_EOF',
    'systemctl daemon-reload',
    `systemctl enable --now ${unitBase}-liveness.timer >/dev/null 2>&1 || true`,
  ]
}

/**
 * How long the post-cutover health probe keeps asking before it gives up.
 *
 * 20 attempts, 3s apart, each allowed 5s — about a minute and a half at worst.
 * Long enough for a cold start on a loaded shared box, short enough that a
 * release which never answers still fails the deploy rather than hanging it.
 */
const HEALTH_GATE_ATTEMPTS = 20
const HEALTH_GATE_ATTEMPT_INTERVAL = 3
const HEALTH_GATE_ATTEMPT_TIMEOUT = 5

/**
 * How long to wait for the new release to take the port, separately from how
 * long to wait for it to answer.
 *
 * These are different waits. Once a server is listening it answers more or
 * less at once, so the response poll above is generous already. Getting to
 * listening is open-ended: a server that binds late on purpose does its whole
 * startup first, and that work is measured on a shared box under whatever load
 * its co-tenants are applying. One site's image pass took 13s on a laptop and
 * over 66s there, which is a perfectly good release that could not deploy.
 *
 * 60 attempts, 3s apart: three minutes. The liveness probe leaves a unit that
 * young alone (its startup grace is ten minutes by default), so the two cannot
 * fight each other over the same slow start.
 */
const HEALTH_GATE_BIND_ATTEMPTS = 60

export interface ZeroDowntimeCutoverOptions {
  paths: ReleasePaths
  /** `<slug>-<site>`; instances are `<unitBase>@<releaseId>.service`. */
  unitBase: string
  releaseId: string
  port: number
  /** Path the release must answer 2xx/3xx on, with its leading slash. */
  healthCheckPath?: string | null
  /** Seconds the new instance must stay active before it is trusted. @default 5 */
  healthGateSeconds?: number
}

/**
 * Bring a release up beside the one serving, prove it, then retire the old one,
 * and put the old one back if anything at any point says the new one is wrong.
 *
 * The rule this exists to keep: **a deploy never leaves a site with nothing
 * serving it.** Every failure leaves through `ts_cloud_restore_previous`, which
 * stops the new instance, points `current` back at the release it pointed at
 * before, and starts the instances that were serving. Some of those exits
 * happen before the old instances were touched and the restore is a no-op for
 * them; the ones after cutover are why it exists.
 *
 * Three failures used to end with the site dark:
 *
 * - **A release that crashes on boot was treated as one that could not share
 *   the port.** The first gate saw the new instance die, assumed the old one
 *   was holding the port without SO_REUSEPORT, stopped the old one to make
 *   room, and retried. The retry crashed the same way and the deploy exited
 *   with neither release running. A wildloop API release whose import failed
 *   at start-up took every `/api` route down that way until the previous
 *   instance was started by hand. Making room is now only tried when the new
 *   instance's own log says the port was taken, and if the retry still fails
 *   the previous instances are started again before the deploy exits.
 * - **A release that bound, then failed after the old instance was retired**
 *   exited 1 with `current` already flipped and the old instance stopped.
 * - **The response probe during the overlap can be answered by the old
 *   instance**, so a release that serves errors could pass it. The probe runs
 *   again once the new instance is alone on the port, and a failure there
 *   restores the previous release instead of leaving the errors live.
 */
export function buildZeroDowntimeCutover(options: ZeroDowntimeCutoverOptions): string[] {
  const { paths, unitBase, releaseId, port } = options
  const instance = `${unitBase}@${releaseId}.service`
  const serviceName = `${unitBase}.service`
  const gateSeconds = Math.max(1, options.healthGateSeconds ?? 5)
  const gatePath = options.healthCheckPath
    ? options.healthCheckPath.startsWith('/') ? options.healthCheckPath : `/${options.healthCheckPath}`
    : null
  const probe = gatePath
    ? `curl -sf -o /dev/null --max-time ${HEALTH_GATE_ATTEMPT_TIMEOUT} "http://127.0.0.1:${port}${gatePath}"`
    : null
  const fail = (why: string) => `{ echo "[ts-cloud] release ${releaseId} ${why}" >&2; ts_cloud_restore_previous; exit 1; }`

  return [
    // What is serving right now, and where `current` points: both are what a
    // failure anywhere below puts back.
    `TS_CLOUD_OLD_UNITS=$(systemctl list-units --plain --no-legend --type=service "${unitBase}@*.service" 2>/dev/null | awk '{print $1}' | grep -v "^${instance}\$" || true)`,
    `TS_CLOUD_PREV_CURRENT="$(readlink ${paths.current} 2>/dev/null || true)"`,
    'TS_CLOUD_LEGACY_STOPPED=0',
    'ts_cloud_restore_previous() {',
    `  journalctl -u ${instance} -n 50 --no-pager >&2 || true`,
    `  systemctl stop ${instance} 2>/dev/null || true`,
    `  systemctl disable ${instance} 2>/dev/null || true`,
    `  if [ -n "$TS_CLOUD_PREV_CURRENT" ] && [ -d "$TS_CLOUD_PREV_CURRENT" ]; then ln -sfn "$TS_CLOUD_PREV_CURRENT" ${paths.current}.tmp && mv -Tf ${paths.current}.tmp ${paths.current}; fi`,
    '  for TS_CLOUD_RU in ${TS_CLOUD_OLD_UNITS}; do systemctl enable "$TS_CLOUD_RU" 2>/dev/null || true; systemctl start "$TS_CLOUD_RU" 2>/dev/null || true; done',
    `  if [ "$TS_CLOUD_LEGACY_STOPPED" -eq 1 ]; then systemctl start ${serviceName} 2>/dev/null || true; fi`,
    `  if [ -n "$TS_CLOUD_OLD_UNITS" ] || [ "$TS_CLOUD_LEGACY_STOPPED" -eq 1 ]; then echo "[ts-cloud] previous release restored and serving" >&2; else echo "[ts-cloud] there was no previous release to restore" >&2; fi`,
    '}',
    // Migration from the pre-templated layout: a release started before
    // SO_REUSEPORT support can't share its port, so the very first
    // zero-downtime deploy does one last stop-then-start cutover.
    `if [ -f /etc/systemd/system/${serviceName} ] && systemctl is-active --quiet ${serviceName}; then echo "[ts-cloud] retiring pre-zero-downtime unit ${serviceName} (one-time restart cutover)"; systemctl stop ${serviceName}; TS_CLOUD_LEGACY_STOPPED=1; fi`,
    // `restart` starts an inactive new-SHA instance just like `start`, but it
    // also refreshes an already-active same-SHA instance after its release
    // directory and EnvironmentFile were atomically replaced. A plain start
    // is a no-op in that retry case and strands the process in a deleted cwd.
    'TS_CLOUD_STARTED_AT="@$(date +%s)"',
    `systemctl restart ${instance}`,
    // Gate 1: the instance must stay active for the whole window. A crash on
    // boot lands in activating/auto-restart and fails is-active.
    `TS_CLOUD_GATE_OK=1; for TS_CLOUD_I in $(seq 1 ${gateSeconds}); do sleep 1; systemctl is-active --quiet ${instance} || { TS_CLOUD_GATE_OK=0; break; }; done`,
    // Only a release that could not take the port is worth making room for,
    // and only its own log can say so. Anything else is a broken release,
    // and the old instances were never touched.
    `if [ "$TS_CLOUD_GATE_OK" -ne 1 ]; then`,
    `  if journalctl -u ${instance} --since "$TS_CLOUD_STARTED_AT" -o cat --no-pager 2>/dev/null | grep -iE 'EADDRINUSE|address already in use|port [0-9]+ (is )?in use|Failed to start server' >/dev/null; then`,
    `    echo "[ts-cloud] release ${releaseId} could not share :${port} with the previous release (no SO_REUSEPORT?) — retiring it and retrying" >&2`,
    '    for TS_CLOUD_RU in ${TS_CLOUD_OLD_UNITS}; do systemctl stop "$TS_CLOUD_RU" 2>/dev/null || true; done',
    `    systemctl restart ${instance}`,
    `    for TS_CLOUD_I in $(seq 1 ${gateSeconds}); do sleep 1; systemctl is-active --quiet ${instance} || ${fail('failed its health gate on the free port')}; done`,
    '  else',
    `    ${fail('crashed on start — the previous release was never stopped')}`,
    '  fi',
    'fi',
    // `grep >/dev/null`, never `grep -q`, after a pipe throughout: under
    // `pipefail` a `grep -q` that matches early exits, the writer dies of
    // SIGPIPE, and the pipeline fails although it matched. Running the cutover
    // against a box whose `ss` writes a line at a time failed every gate.
    // Gate 2: the NEW instance is on the port itself. During the overlap the
    // previous release still listens, so the probe below cannot tell them
    // apart; asking whose PID holds the socket can. Where listener PIDs cannot
    // be read, this says so and leaves the probes to do the work.
    `if ss -ltnpH "sport = :${port}" >/dev/null 2>&1; then`,
    '  TS_CLOUD_BOUND=0',
    `  for TS_CLOUD_I in $(seq 1 ${HEALTH_GATE_BIND_ATTEMPTS}); do`,
    `    TS_CLOUD_NEW_PID="$(systemctl show -p MainPID --value ${instance} 2>/dev/null || true)"`,
    `    if [ -n "$TS_CLOUD_NEW_PID" ] && [ "$TS_CLOUD_NEW_PID" != "0" ] && ss -ltnpH "sport = :${port}" 2>/dev/null | grep "pid=$TS_CLOUD_NEW_PID," >/dev/null; then TS_CLOUD_BOUND=1; break; fi`,
    `    systemctl is-active --quiet ${instance} || break`,
    `    sleep ${HEALTH_GATE_ATTEMPT_INTERVAL}`,
    '  done',
    `  [ "$TS_CLOUD_BOUND" -eq 1 ] || ${fail(`never took :${port}`)}`,
    'else',
    `  echo "[ts-cloud] cannot read listener PIDs on this host — the response probes run without the bind check" >&2`,
    'fi',
    // Gate 3: answer on the health path. Polled, because a release that is
    // slow to warm on a loaded shared box is not a broken one.
    ...(probe
      ? [
          `TS_CLOUD_HEALTHY=0; for TS_CLOUD_I in $(seq 1 ${HEALTH_GATE_ATTEMPTS}); do if ${probe}; then TS_CLOUD_HEALTHY=1; break; fi; sleep ${HEALTH_GATE_ATTEMPT_INTERVAL}; done`,
          `[ "$TS_CLOUD_HEALTHY" -eq 1 ] || ${fail(`never answered ${gatePath}`)}`,
        ]
      : []),
    // Promote: flip `current`, persist across boots, retire the previous release.
    ...buildActivateRelease(paths),
    `systemctl enable ${instance} 2>/dev/null || true`,
    'for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}; do systemctl stop "$TS_CLOUD_U" 2>/dev/null || true; systemctl disable "$TS_CLOUD_U" 2>/dev/null || true; done',
    // The port is only knowable once the old instances are gone: `is-active`
    // says a process runs, not that it listens, and a server that swallows its
    // bind error stays active with no socket. A restart lands on the now-free
    // port; one that still cannot bind restores the previous release.
    `TS_CLOUD_LISTENING=0; for TS_CLOUD_I in $(seq 1 ${gateSeconds}); do if ss -ltnH "sport = :${port}" 2>/dev/null | grep . >/dev/null; then TS_CLOUD_LISTENING=1; break; fi; sleep 1; done`,
    `if [ "$TS_CLOUD_LISTENING" -ne 1 ]; then echo "[ts-cloud] nothing is listening on ${port} after retiring the previous release — restarting ${instance} on the now-free port" >&2; systemctl restart ${instance}; for TS_CLOUD_I in $(seq 1 ${gateSeconds}); do if ss -ltnH "sport = :${port}" 2>/dev/null | grep . >/dev/null; then TS_CLOUD_LISTENING=1; break; fi; sleep 1; done; fi`,
    `[ "$TS_CLOUD_LISTENING" -eq 1 ] || ${fail(`is active but never bound :${port}`)}`,
    // Gate 4: the same probe, now that only the new release can answer it.
    ...(probe
      ? [
          `TS_CLOUD_HEALTHY=0; for TS_CLOUD_I in $(seq 1 ${HEALTH_GATE_ATTEMPTS}); do if ${probe}; then TS_CLOUD_HEALTHY=1; break; fi; sleep ${HEALTH_GATE_ATTEMPT_INTERVAL}; done`,
          `[ "$TS_CLOUD_HEALTHY" -eq 1 ] || ${fail(`stopped answering ${gatePath} once it served alone`)}`,
        ]
      : []),
    // The release this one replaced, by name, for `deploy:rollback`.
    ...buildRecordPreviousRelease(paths),
    // Drop enabled-but-stopped instances from older deploys and the legacy
    // non-templated unit so only the live release starts at boot. Never the
    // TEMPLATE file (`<base>@.service`): disabling it removes every instance's
    // enablement, including the one just enabled. Brace-group the grep so
    // `|| true` guards only it (an empty match exits 1 under pipefail).
    `systemctl list-unit-files --plain --no-legend "${unitBase}@*.service" 2>/dev/null | awk '{print $1}' | { grep -v -e "^${instance}\$" -e "^${unitBase}@\\.service\$" || true; } | while read -r TS_CLOUD_U; do systemctl disable "$TS_CLOUD_U" 2>/dev/null || true; done`,
    `if [ -f /etc/systemd/system/${serviceName} ]; then systemctl disable ${serviceName} 2>/dev/null || true; rm -f /etc/systemd/system/${serviceName}; systemctl daemon-reload; fi`,
  ]
}

export interface BuildSiteDeployScriptOptions {
  siteName: string
  slug: string
  /** How the remote host obtains the release tarball */
  artifactFetch: string[]
  /** Site base dir holding `releases/`, `shared/`, `current`. Default `/var/www/<site>`. */
  appDir?: string
  /** Unique id for this release dir (typically the commit sha). */
  releaseId: string
  execStart: string
  envEntries: Record<string, string>
  port?: number
  /** Past releases to keep for rollback. @default {@link DEFAULT_KEEP_RELEASES} */
  keepReleases?: number
  /**
   * Commands run inside the new release dir after extraction + `.env` link,
   * before the `current` symlink is repointed and the service restarted.
   * Typically dependency install and/or build steps (e.g.
   * `bun install --frozen-lockfile`, `bun run build`) so the tarball can omit
   * `node_modules`.
   */
  preStartCommands?: string[]
  /**
   * Extra paths kept in `shared/` and symlinked into each release, so they
   * survive a deploy. `.env` is always shared; anything the app WRITES and must
   * keep (a state directory, a database file) has to be listed here or the next
   * release silently starts from empty.
   *
   * A `SharedPathSpec` entry points somewhere other than this site's own
   * `shared/` — how several sites of one project share one file.
   */
  sharedPaths?: readonly SharedPathEntry[]
  /**
   * True zero-downtime cutover for ported sites: the new release runs as its
   * own systemd instance (`<slug>-<site>@<releaseId>`) that binds the same
   * port via SO_REUSEPORT while the old instance still serves, must pass a
   * health gate, and only then is the old instance stopped. A release that
   * crashes on boot fails the deploy with the old release still serving.
   *
   * Requires the app to bind with `reusePort` (Stacks' server does in
   * production). Defaults to true when `port` is set; portless sites
   * (queue workers, schedulers) always use the stop/start flow because two
   * overlapping instances would double-process their work.
   */
  zeroDowntime?: boolean
  /**
   * HTTP path polled on `127.0.0.1:<port>` as part of the health gate (e.g.
   * `/health`). Optional — without it the gate is "the instance stays
   * active for {@link BuildSiteDeployScriptOptions.healthGateSeconds}".
   */
  healthCheckPath?: string
  /**
   * Seconds the new instance must stay active (and, with
   * {@link BuildSiteDeployScriptOptions.healthCheckPath}, respond 2xx/3xx)
   * before the old instance is stopped.
   * @default 5
   */
  healthGateSeconds?: number
  /**
   * Recurring liveness check for a ported site: a timer that asks the service
   * for an HTTP response and restarts it when it stops answering.
   *
   * `Restart=always` only covers a process that EXITS. A process that is alive
   * and no longer serving is invisible to systemd: it reports `active`, the
   * port stays bound, and connections pile up in the accept backlog. One app
   * on a shared box sat like that for eight days with `active (running)` and
   * 46 queued connections, and nothing anywhere noticed.
   *
   * The probe is an HTTP request rather than a listener check for that exact
   * reason — `ss` would have called the wedged process healthy.
   *
   * A unit younger than `startupGraceSeconds` is never restarted, and
   * consecutive restarts back off, so a slow boot cannot become a restart
   * loop. See {@link buildLivenessUnits}.
   *
   * Set `false` to opt out (a service that legitimately answers nothing on its
   * port, or one where a restart is more dangerous than an outage).
   * @default enabled, `/` every 60s with a 10s timeout, restart after 3
   * consecutive failures once the unit is 10 minutes old
   */
  liveness?: false | LivenessOptions
  /**
   * systemd `MemoryHigh` for the app unit. See {@link SiteConfig.memoryHigh}.
   * @default '2G'
   */
  memoryHigh?: string
  /** systemd `MemoryMax` for the app unit. Unset by default. */
  memoryMax?: string
  /**
   * systemd `CPUWeight` for the unit — relative CPU share under contention.
   *
   * Everything on a shared box competes for the same eight cores, and not
   * everything on it matters equally: the gateway every tenant is served
   * through should outrank a batch scanner, and a monitoring dashboard should
   * outrank neither. Left unset the kernel gives every unit the same weight,
   * so a background job saturating the CPU degrades the serving path just as
   * much as it degrades itself.
   *
   * Unset by default: a box with one workload has nothing to prioritise, and
   * inventing a hierarchy where none was asked for is its own surprise.
   */
  cpuWeight?: number
  /** systemd `IOWeight` — the same idea for disk bandwidth. Unset by default. */
  ioWeight?: number
  /** systemd `TasksMax` — cap on threads/processes. Unset by default. */
  tasksMax?: number
  /**
   * systemd `TimeoutStopSec` — how long a unit may take to shut down before
   * systemd escalates from SIGTERM to SIGKILL.
   *
   * Worth raising for a worker that drains on SIGTERM. systemd's default is 90
   * seconds, which is generous for a server and far too short for a job that
   * finishes the shard in its hands before letting go: it gets killed
   * mid-write instead, which is precisely the outcome the drain exists to
   * avoid. A trail-ingest worker on a shared box was SIGKILLed exactly that
   * way while logging `finishing current shard`.
   *
   * Unset by default — systemd's own default is right for anything that can
   * stop immediately, and a long stop timeout on a service that hangs is a
   * deploy that waits for it.
   */
  stopTimeout?: string
}

/**
 * Build the remote shell commands that install/refresh a server-app site on a
 * compute target with an atomic release (Envoyer-style): unpack into
 * `releases/<id>`, link the shared `.env`, build, then cut over.
 *
 * The cutover has two modes:
 * - **zero-downtime** (default for ported sites): the new release starts as a
 *   templated systemd instance that shares the port via SO_REUSEPORT with the
 *   still-running old instance, must pass a health gate, and only then does
 *   the old instance stop — no dropped connections, and a crash-on-boot
 *   release fails the deploy with the old one still serving.
 * - **restart** (portless sites, or `zeroDowntime: false`): the classic flip
 *   `current` + `systemctl restart` — correct for workers/schedulers where two
 *   overlapping instances would double-process work.
 */
export function buildSiteDeployScript(options: BuildSiteDeployScriptOptions): string[] {
  const {
    siteName,
    slug,
    artifactFetch,
    releaseId,
    execStart,
    envEntries,
    port,
    keepReleases = DEFAULT_KEEP_RELEASES,
    preStartCommands = [],
    healthCheckPath,
    healthGateSeconds = 5,
    liveness,
    /*
     * A shared box runs many tenants. Without a limit, one that leaks fills
     * memory and then swap, and the kernel's OOM killer starts choosing
     * victims box-wide — a leak in one app takes every other tenant down with
     * it, which is exactly how a 15G host was lost to a single service that
     * had grown to 3.2G. `MemoryHigh` squeezes the offender's own cgroup
     * first. Soft on purpose: it throttles and reclaims rather than killing,
     * so it cannot turn a heavy-but-healthy app into a restart loop. Set
     * `memoryMax` per site once its ceiling is known.
     *
     * `'auto'` rather than a constant, because the right ceiling is a property
     * of the BOX and this file cannot know which box it is being deployed to.
     * A flat 2G is generous on a 15G host and larger than the whole machine on
     * a 2G one. See {@link buildAutoMemoryHigh} for what auto resolves to and
     * why it is a fraction rather than a fair share.
     */
    memoryHigh = 'auto',
    memoryMax,
    cpuWeight,
    ioWeight,
    tasksMax,
    stopTimeout,
  } = options
  // Emitted into both unit shapes below, so a site's declared priority does not
  // depend on whether it happens to have a port.
  const qosDirectives = [
    ...(cpuWeight != null ? [`CPUWeight=${cpuWeight}`] : []),
    ...(ioWeight != null ? [`IOWeight=${ioWeight}`] : []),
    ...(tasksMax != null ? [`TasksMax=${tasksMax}`] : []),
    ...(stopTimeout ? [`TimeoutStopSec=${stopTimeout}`] : []),
  ]
  const zeroDowntime = options.zeroDowntime ?? port != null
  const base = options.appDir ?? `/var/www/${siteName}`
  const paths = releasePaths(base, releaseId)
  const unitBase = `${slug}-${siteName}`
  const serviceName = `${unitBase}.service`
  const tarball = releaseTarballTmpPath(slug, siteName, releaseId)
  // `.env` is always shared; a site adds anything else it writes and must keep.
  // A SQLite database is added for it: the deploy already knows the connection
  // and the file path from the env it is about to write, and an undeclared
  // SQLite file inside the release is discarded by the NEXT deploy.
  const declaredSharedPaths = options.sharedPaths ?? []
  const sharedPaths = dedupeSharedPaths([
    '.env',
    ...declaredSharedPaths,
    ...sqliteSharedPaths(envEntries, declaredSharedPaths),
  ])

  const envFile = formatEnvFile(envEntries)

  // preStart (install / build) runs inside the NEW release dir. Bun auto-loads
  // the linked `.env` from the cwd, so build steps see the same config as the
  // running service. The release isn't live yet, so a slow build never affects
  // the currently-serving release.
  const preStart = preStartCommands.length > 0 ? [`cd ${paths.release}`, ...preStartCommands] : []

  const stageRelease = [
    'set -euo pipefail',
    // Serialize deploys of this site before touching anything (see
    // buildDeployLock): a second deploy racing the first is how a release dir
    // gets `rm -rf`'d while it is still being extracted into.
    ...buildDeployLock(paths),
    // A failed deploy must not strand its half-built release dir: rollback
    // picks the newest non-current dir and would activate this never-activated
    // (broken) release. On any failure before activation, remove it.
    buildStrandedReleaseTrap(paths),
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, sharedPaths),
    // Unpack this deploy into its own release dir. When that id is the one
    // being served — the same commit deployed twice, a retry after an
    // interrupted run — it is staged beside the live tree and swapped in
    // below, rather than deleted out from under the running service.
    ...buildResetReleaseDir(paths),
    `tar xzf ${tarball} -C "$TS_CLOUD_STAGED"`,
    // Drop the staged tarball once extracted — don't leave a world-readable
    // copy of the release (or a stale one for a later deploy to trip over).
    `rm -f ${tarball}`,
    // Persist the .env in shared/ (survives releases) and link it into the release.
    `cat > ${paths.shared}/.env <<'TS_CLOUD_ENV_EOF'`,
    envFile,
    'TS_CLOUD_ENV_EOF',
    `chmod 600 ${paths.shared}/.env`,
    // The DEPLOY owns the port (systemd `Environment=PORT` below is authoritative).
    // Strip any committed PORT* from the app's env files so it can never leak
    // back in: a scaffold's `.env.production` PORT=3000 otherwise makes a tenant
    // app bind :3000 and SO_REUSEPORT-round-robin with the box owner's app on the
    // shared box — the "stacksjs.com intermittently served another site" bug.
    // Bun natively loads `.env`/`.env.<mode>`, so strip every env file here, not
    // just the shared one.
    ...buildPromoteStagedRelease(paths),
    // `envEntries` is the authoritative, already-resolved runtime environment.
    // Remove deploy-time env files from the artifact before linking shared/.env:
    // Bun loads `.env.production` after `.env`, so committed ciphertext otherwise
    // overrides the decrypted values even though the deploy generated a correct
    // shared file. Examples remain available as documentation.
    `find ${paths.release} -maxdepth 1 \\( -type f -o -type l \\) -name '.env*' ! -name '.env.example' ! -name '*.example' -delete`,
    `sed -i -E '/^[[:space:]]*(PORT|PORT_BACKEND|PORT_ADMIN|PORT_FRONTEND)[[:space:]]*=/d' ${paths.shared}/.env 2>/dev/null || true`,
    ...buildLinkSharedPaths(paths, sharedPaths),
    ...preStart,
  ]

  if (zeroDowntime && port != null) {
    const instance = `${unitBase}@${releaseId}.service`
    const gatePath = healthCheckPath
      ? healthCheckPath.startsWith('/')
        ? healthCheckPath
        : `/${healthCheckPath}`
      : null

    return [
      ...stageRelease,
      // Templated unit: each release runs as its own instance pinned to its
      // release dir (%i), so old + new can overlap on the same SO_REUSEPORT
      // port during the cutover.
      `cat > /etc/systemd/system/${unitBase}@.service <<'TS_CLOUD_UNIT_EOF'`,
      '[Unit]',
      `Description=${siteName} release %i (managed by ts-cloud)`,
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${paths.releases}/%i`,
      `ExecStart=${execStart}`,
      'Restart=always',
      'RestartSec=5',
      'MemoryAccounting=true',
      // `auto` is resolved on the box and lands in a drop-in below, so the
      // unit file stays byte-identical across deploys and remains diffable.
      ...(memoryHigh && memoryHigh !== 'auto' ? [`MemoryHigh=${memoryHigh}`] : []),
      ...(memoryMax ? [`MemoryMax=${memoryMax}`] : []),
      ...qosDirectives,
      `EnvironmentFile=${paths.releases}/%i/.env`,
      `Environment=PORT=${port}`,
      `Environment=STX_IMAGE_CACHE_DIR=${stxImageCacheDir(paths)}`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'TS_CLOUD_UNIT_EOF',
      'systemctl daemon-reload',
      ...(memoryHigh === 'auto'
        ? buildAutoMemoryHigh(`${unitBase}@.service`)
        : [...buildClearAutoMemoryHigh(`${unitBase}@.service`), ...buildCommitmentReport()]),
      ...buildSliceReconcile(instance),
      ...buildZeroDowntimeCutover({ paths, unitBase, releaseId, port, healthCheckPath: gatePath, healthGateSeconds }),
      ...buildPruneReleases(paths, keepReleases),
      // The deploy gate proves this release came up. Nothing after today
      // proves it is still answering, which is what the timer below is for.
      ...(liveness === false
        ? []
        : buildLivenessUnits({
            ...liveness,
            unitBase,
            unitPattern: `${unitBase}@*.service`,
            port,
            path: liveness?.path ?? healthCheckPath,
          })),
    ]
  }

  return [
    ...stageRelease,
    // The unit references the stable `current` symlink, so it's identical every
    // deploy — restart re-execs against whatever `current` points at.
    `cat > /etc/systemd/system/${serviceName} <<'TS_CLOUD_UNIT_EOF'`,
    '[Unit]',
    `Description=${siteName} (managed by ts-cloud)`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${paths.current}`,
    `ExecStart=${execStart}`,
    'Restart=always',
    'RestartSec=5',
    // Same ceilings as the zero-downtime path above. Leaving them out here
    // meant a portless site — every worker, scheduler and dashboard — could
    // not express a memory limit in config at all, so the only way to bound
    // one was `systemctl set-property` on the box. That is how a dashboard
    // ended up pinned under a hand-typed MemoryHigh of 256M while it needed
    // 311M: throttled 180,379 times, invisible to the repo, and surviving
    // every deploy because nothing in config had an opinion to overwrite it.
    'MemoryAccounting=true',
    ...(memoryHigh && memoryHigh !== 'auto' ? [`MemoryHigh=${memoryHigh}`] : []),
    ...(memoryMax ? [`MemoryMax=${memoryMax}`] : []),
    ...qosDirectives,
    `EnvironmentFile=${paths.current}/.env`,
    ...(port ? [`Environment=PORT=${port}`] : []),
    `Environment=STX_IMAGE_CACHE_DIR=${stxImageCacheDir(paths)}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'TS_CLOUD_UNIT_EOF',
    'systemctl daemon-reload',
    // Whatever config declares outranks a hand-set override of the same limit;
    // the box-resolved drop-in only goes when memoryHigh stops being `auto`.
    ...buildClearAutoMemoryHigh(serviceName, { auto: memoryHigh !== 'auto', high: memoryHigh !== 'auto', max: Boolean(memoryMax) }),
    ...(memoryHigh === 'auto' ? buildAutoMemoryHigh(serviceName) : buildCommitmentReport()),
    `systemctl enable ${serviceName}`,
    // Where `current` pointed, so a release that cannot stay up goes back to it.
    `TS_CLOUD_PREV_CURRENT="$(readlink ${paths.current} 2>/dev/null || true)"`,
    // Atomically promote the new release, THEN restart so the service comes up on it.
    ...buildActivateRelease(paths),
    `systemctl restart ${serviceName}`,
    // A worker or scheduler cannot overlap its previous release, so it is
    // judged after the restart: it must stay active for the gate window. One
    // check straight after `restart` passed a release that crashed a second
    // later, and the restart loop that followed was the live release. A
    // failure puts `current` back and restarts the previous release.
    `for TS_CLOUD_I in $(seq 1 ${Math.max(1, healthGateSeconds)}); do sleep 1; systemctl is-active --quiet ${serviceName} || { echo "[ts-cloud] release ${releaseId} of ${serviceName} did not stay up — restoring the previous release" >&2; journalctl -u ${serviceName} -n 50 --no-pager >&2 || true; if [ -n "$TS_CLOUD_PREV_CURRENT" ] && [ -d "$TS_CLOUD_PREV_CURRENT" ] && [ "$(readlink -f "$TS_CLOUD_PREV_CURRENT")" != "$(readlink -f ${paths.release})" ]; then ln -sfn "$TS_CLOUD_PREV_CURRENT" ${paths.current}.tmp && mv -Tf ${paths.current}.tmp ${paths.current}; systemctl restart ${serviceName} || true; fi; exit 1; }; done`,
    ...buildRecordPreviousRelease(paths),
    ...buildPruneReleases(paths, keepReleases),
    // Only a ported service can be probed over HTTP. A worker or scheduler has
    // no port to ask, so it gets no timer rather than a check that would call
    // every one of them dead.
    ...(liveness === false || !port
      ? []
      : buildLivenessUnits({
          ...liveness,
          unitBase,
          unitPattern: serviceName,
          port,
          path: liveness?.path ?? healthCheckPath,
        })),
  ]
}

export interface BuildStaticSiteDeployScriptOptions {
  siteName: string
  /** Project slug — namespaces the staged tarball on shared boxes. */
  slug?: string
  /** How the remote host obtains the release tarball */
  artifactFetch: string[]
  /** Site base dir holding `releases/`, `current`. Default `/var/www/<site>`. */
  appDir?: string
  /** Unique id for this release dir (typically the commit sha). */
  releaseId: string
  /** Past releases to keep for rollback. @default {@link DEFAULT_KEEP_RELEASES} */
  keepReleases?: number
  /**
   * Commands run inside the new release dir after extraction — e.g. build the
   * docs/blog on the box itself (`bun install`, `bun run docs:build`) when the
   * tarball ships source rather than a pre-built site.
   */
  preStartCommands?: string[]
}

/**
 * Build the remote shell commands that install/refresh a STATIC site on a
 * compute target with a **zero-downtime atomic release** (Envoyer-style). Unlike
 * {@link buildSiteDeployScript}, there is no systemd service: the artifact is
 * unpacked into `releases/<id>` and `current` is repointed atomically, so the
 * docroot is never empty mid-deploy. The gateway serves `<base>/current` (rpx +
 * tlsx), which ts-cloud points at the symlink. Old releases are pruned.
 */
export function buildStaticSiteDeployScript(options: BuildStaticSiteDeployScriptOptions): string[] {
  const { siteName, artifactFetch, releaseId, keepReleases = DEFAULT_KEEP_RELEASES, preStartCommands = [] } = options
  const base = options.appDir ?? `/var/www/${siteName}`
  const paths = releasePaths(base, releaseId)
  const tarball = releaseTarballTmpPath(options.slug, siteName, releaseId)

  const preStart = preStartCommands.length > 0 ? [`cd ${paths.release}`, ...preStartCommands] : []

  return [
    'set -euo pipefail',
    ...buildDeployLock(paths),
    // Same stranded-release guard as buildSiteDeployScript: never let a failed
    // deploy leave a release rollback could activate.
    buildStrandedReleaseTrap(paths),
    ...artifactFetch,
    ...buildEnsureReleaseLayout(paths, []),
    // Same staging rule as buildSiteDeployScript: never delete the tree the
    // docroot currently points at.
    ...buildResetReleaseDir(paths),
    `tar xzf ${tarball} -C "$TS_CLOUD_STAGED"`,
    ...buildPromoteStagedRelease(paths),
    // Drop the staged tarball once extracted (see buildSiteDeployScript).
    `rm -f ${tarball}`,
    ...preStart,
    // Promote atomically — the docroot (`current`) is never empty during the swap.
    ...buildActivateRelease(paths),
    ...buildPruneReleases(paths, keepReleases),
  ]
}

/**
 * Box-local staging path for the uploaded release tarball. Namespaced by
 * project slug + site + release id so two projects sharing a box (or two
 * overlapping deploys of one site) never clobber each other's tarball between
 * the fetch and the extract — the flat `/tmp/<site>-release.tar.gz` layout
 * cross-contaminated releases on shared boxes.
 */
export function releaseTarballTmpPath(slug: string | undefined, siteName: string, releaseId: string): string {
  const parts = [slug, siteName, releaseId].filter(Boolean).join('-')
  return `/tmp/${parts}-release.tar.gz`
}

export function buildAwsArtifactFetch(bucket: string, key: string, region: string, destPath: string): string[] {
  return [`aws s3 cp "s3://${bucket}/${key}" ${destPath} --region ${region}`]
}

export function buildLocalArtifactFetch(localPath: string, destPath: string): string[] {
  return [
    // The Hetzner upload path is a staging area, not release history. Consume
    // the tarball so every successful deploy removes its upload immediately.
    // Active and rollback releases live separately under /var/www.
    `mv "${localPath}" ${destPath}`,
  ]
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Publish a completed upload into the artifact cache, then stage this deploy's
 * copy. The `chmod` precedes the rename, so a cached artifact is never
 * world-readable and never visible half-written.
 */
export function buildPublishUploadScript(uploadPath: string, cachedPath: string, stagingPath: string): string {
  return [
    'set -euo pipefail',
    `chmod 600 ${quoteShellArg(uploadPath)}`,
    `mv -f -- ${quoteShellArg(uploadPath)} ${quoteShellArg(cachedPath)}`,
    `cp -- ${quoteShellArg(cachedPath)} ${quoteShellArg(stagingPath)}`,
  ].join('\n')
}

/** Remove a failed upload's temp file. Never fails: it runs on an error path. */
export function buildDiscardUploadScript(uploadPath: string): string {
  return `rm -f -- ${quoteShellArg(uploadPath)} 2>/dev/null || true`
}

// Host cleanup moved to its own module when it grew a timer, disk-pressure
// tiers and configuration (stacksjs/ts-cloud#195). Re-exported so existing
// imports from this module keep working.
export { buildHostCleanupScript, HOST_ARTIFACT_CACHE_DIR } from './host-cleanup'
