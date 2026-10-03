/**
 * Bounded, multi-tenant-safe disk retention for box hosts.
 *
 * One rule set, three triggers: the tail of every deploy, the failure path of a
 * deploy (a run that died partway is the one most likely to have left
 * something behind), and a systemd timer, so a box that stops deploying still
 * cleans. The rules are time-bounded, so none of them assumes a deploy just
 * finished.
 *
 * Current and rollback releases are out of scope: `buildPruneReleases` and
 * `keepReleases` own those. This only removes abandoned staging and temp
 * archives, the aged release artifact cache, aged package caches, unused
 * container images, old journals and operator-registered paths.
 */
import type { ComputeHostCleanupConfig, HostCleanupPathRule, HostCleanupRetention } from '@ts-cloud/core'

/**
 * Content-addressed release cache on a box host (Hetzner and ssh drivers).
 *
 * `uploadRelease` keeps one immutable `<sha256>.tar.gz` per distinct tarball so
 * the second and later sites of one deploy copy it locally instead of
 * re-uploading. Uploads land as `.<sha256>-<nonce>.tmp` and are renamed into
 * place once complete. Retention for both lives here, not in the upload path.
 */
export const HOST_ARTIFACT_CACHE_DIR = '/var/ts-cloud/artifacts'

/** Where the cleanup is installed on the host, shared by the timer and deploys. */
export const HOST_CLEANUP_SCRIPT_PATH = '/usr/local/bin/ts-cloud-host-cleanup.sh'
export const HOST_CLEANUP_UNIT = 'ts-cloud-host-cleanup'

const ALERT_STATE_PATH = '/var/lib/ts-cloud/host-cleanup.alert'

/** Fully resolved retention windows. */
export type ResolvedHostCleanupRetention = Required<HostCleanupRetention>

export const DEFAULT_HOST_CLEANUP_RETENTION: Readonly<ResolvedHostCleanupRetention> = Object.freeze({
  stagingMaxAgeMinutes: 60,
  // The cache's payoff is intra-deploy reuse (one upload, every other site
  // copies it seconds later), so two days keeps essentially all of its value.
  artifactMaxAgeDays: 2,
  artifactUploadMaxAgeMinutes: 60,
  bunCacheMaxAgeDays: 7,
  journalMaxAgeDays: 14,
  journalMaxSizeMb: 512,
  containerImageMaxAgeHours: 168,
})

/**
 * Windows at or above the high-water mark. The in-flight bounds (staging and
 * `.tmp` uploads) are deliberately not shortened: they protect a concurrent
 * deploy, and deleting its upload mid-transfer would turn disk pressure into a
 * failed release.
 */
export const DEFAULT_HOST_CLEANUP_ESCALATED: Readonly<HostCleanupRetention> = Object.freeze({
  artifactMaxAgeDays: 0,
  bunCacheMaxAgeDays: 1,
  journalMaxAgeDays: 3,
  journalMaxSizeMb: 256,
  containerImageMaxAgeHours: 24,
})

export const DEFAULT_HOST_CLEANUP_LOW_WATER_PERCENT = 50
export const DEFAULT_HOST_CLEANUP_HIGH_WATER_PERCENT = 85
export const DEFAULT_HOST_CLEANUP_SCHEDULE = 'daily'

/** The smallest in-flight bound accepted, in minutes. See {@link DEFAULT_HOST_CLEANUP_ESCALATED}. */
const MIN_IN_FLIGHT_MINUTES = 15

export interface ResolvedHostCleanupConfig {
  enabled: boolean
  timer: boolean
  schedule: string
  retention: ResolvedHostCleanupRetention
  /** `null` when pressure awareness is off: every rule runs with `retention`. */
  pressure: null | {
    lowWaterPercent: number
    highWaterPercent: number
    escalated: ResolvedHostCleanupRetention
  }
  paths: HostCleanupPathRule[]
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function assertWholeNumber(name: string, value: number, min = 0): void {
  if (!Number.isInteger(value) || value < min)
    throw new Error(`hostCleanup: ${name} must be a whole number >= ${min} (got ${value})`)
}

function validateRetention(prefix: string, retention: ResolvedHostCleanupRetention): void {
  for (const [key, value] of Object.entries(retention)) assertWholeNumber(`${prefix}.${key}`, value)
  assertWholeNumber(`${prefix}.stagingMaxAgeMinutes`, retention.stagingMaxAgeMinutes, MIN_IN_FLIGHT_MINUTES)
  assertWholeNumber(`${prefix}.artifactUploadMaxAgeMinutes`, retention.artifactUploadMaxAgeMinutes, MIN_IN_FLIGHT_MINUTES)
  assertWholeNumber(`${prefix}.journalMaxSizeMb`, retention.journalMaxSizeMb, 1)
}

function validatePathRule(rule: HostCleanupPathRule, index: number): void {
  const where = `hostCleanup.paths[${index}]`
  const path = rule.path?.replace(/\/+$/, '') ?? ''
  if (!path.startsWith('/') || path === '' || /[\s'"`$\\]/.test(path) || path.split('/').includes('..'))
    throw new Error(`${where}.path must be an absolute directory with no spaces, quotes or '..' (got ${JSON.stringify(rule.path)})`)
  if (path === '/var/www' || path.startsWith('/var/www/'))
    throw new Error(`${where}.path must not be under /var/www: releases are pruned by keepReleases`)
  if (!rule.pattern || /^[*?]+$/.test(rule.pattern) || rule.pattern.includes('/') || /[\n'"`]/.test(rule.pattern))
    throw new Error(`${where}.pattern must be a file-name glob naming something, not a bare wildcard (got ${JSON.stringify(rule.pattern)})`)
  assertWholeNumber(`${where}.maxAgeDays`, rule.maxAgeDays)
  if (rule.type !== undefined && rule.type !== 'file' && rule.type !== 'directory')
    throw new Error(`${where}.type must be 'file' or 'directory'`)
}

/**
 * Resolve `compute.hostCleanup` to concrete values, filling defaults and
 * rejecting values that would make the generated shell unsafe. Throws on an
 * invalid config, which surfaces before anything reaches a host.
 */
export function resolveHostCleanupConfig(config?: boolean | ComputeHostCleanupConfig): ResolvedHostCleanupConfig {
  const options: ComputeHostCleanupConfig = typeof config === 'object' && config !== null ? config : {}
  const enabled = config !== false
  const retention: ResolvedHostCleanupRetention = { ...DEFAULT_HOST_CLEANUP_RETENTION, ...stripUndefined(options.retention) }
  validateRetention('hostCleanup.retention', retention)

  let pressure: ResolvedHostCleanupConfig['pressure'] = null
  if (options.pressure !== false) {
    const p = typeof options.pressure === 'object' ? options.pressure : {}
    const lowWaterPercent = p.lowWaterPercent ?? DEFAULT_HOST_CLEANUP_LOW_WATER_PERCENT
    const highWaterPercent = p.highWaterPercent ?? DEFAULT_HOST_CLEANUP_HIGH_WATER_PERCENT
    assertWholeNumber('hostCleanup.pressure.lowWaterPercent', lowWaterPercent)
    assertWholeNumber('hostCleanup.pressure.highWaterPercent', highWaterPercent, 1)
    if (highWaterPercent > 100 || lowWaterPercent >= highWaterPercent)
      throw new Error(`hostCleanup.pressure: need 0 <= lowWaterPercent < highWaterPercent <= 100 (got ${lowWaterPercent} and ${highWaterPercent})`)
    const requested = { ...DEFAULT_HOST_CLEANUP_ESCALATED, ...stripUndefined(p.escalated) }
    // Escalation only ever tightens: a window configured tighter than the
    // escalated default must not get looser when the disk fills.
    const escalated = Object.fromEntries(
      (Object.keys(retention) as Array<keyof ResolvedHostCleanupRetention>).map(key => [
        key,
        Math.min(retention[key], requested[key] ?? retention[key]),
      ]),
    ) as ResolvedHostCleanupRetention
    validateRetention('hostCleanup.pressure.escalated', escalated)
    pressure = { lowWaterPercent, highWaterPercent, escalated }
  }

  const schedule = options.schedule ?? DEFAULT_HOST_CLEANUP_SCHEDULE
  if (!/^[\w*:,./~ -]+$/.test(schedule))
    throw new Error(`hostCleanup.schedule must be a systemd OnCalendar expression (got ${JSON.stringify(schedule)})`)

  const paths = options.paths ?? []
  paths.forEach(validatePathRule)

  return { enabled, timer: enabled && options.timer !== false, schedule, retention, pressure, paths }
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Shell variable holding each window, so one rule list serves every tier. */
const WINDOW_VARS: Record<keyof ResolvedHostCleanupRetention, string> = {
  stagingMaxAgeMinutes: 'TS_CLOUD_HC_STAGING_MIN',
  artifactMaxAgeDays: 'TS_CLOUD_HC_ARTIFACT_DAYS',
  artifactUploadMaxAgeMinutes: 'TS_CLOUD_HC_UPLOAD_MIN',
  bunCacheMaxAgeDays: 'TS_CLOUD_HC_BUN_DAYS',
  journalMaxAgeDays: 'TS_CLOUD_HC_JOURNAL_DAYS',
  journalMaxSizeMb: 'TS_CLOUD_HC_JOURNAL_MB',
  containerImageMaxAgeHours: 'TS_CLOUD_HC_IMAGE_HOURS',
}

/** `VAR=value` assignments for every window, on one line. */
function assignWindows(retention: ResolvedHostCleanupRetention): string {
  return (Object.keys(WINDOW_VARS) as Array<keyof ResolvedHostCleanupRetention>)
    .map(key => `${WINDOW_VARS[key]}=${retention[key]}`)
    .join(' ')
}

const v = (key: keyof ResolvedHostCleanupRetention): string => `"\$${WINDOW_VARS[key]}"`

/** Rules cheap enough to run on every pass: shallow `find`s and journald. */
function cheapRules(paths: HostCleanupPathRule[]): string[] {
  return [
    // The staging bound protects concurrent deploys on a shared box while
    // bounding uploads stranded by failed or cancelled deploys.
    `find /var/ts-cloud/staging -xdev -maxdepth 1 -type f -mmin +${v('stagingMaxAgeMinutes')} -delete 2>/dev/null || true`,
    `find /tmp -xdev -maxdepth 1 -type f -name "*-release.tar.gz" -mmin +${v('stagingMaxAgeMinutes')} -delete 2>/dev/null || true`,
    // Completed artifacts past their window (stacksjs/ts-cloud#194: a week of
    // tarballs grew one 140-site box's cache to 23 GB).
    `find ${HOST_ARTIFACT_CACHE_DIR} -xdev -maxdepth 1 -type f -name "*.tar.gz" -mtime +${v('artifactMaxAgeDays')} -delete 2>/dev/null || true`,
    // Uploads that died before their rename. `.tmp` never matches the rule
    // above, so these used to leak forever. An upload still in flight is
    // younger than the bound and is never deleted out from under its scp.
    `find ${HOST_ARTIFACT_CACHE_DIR} -xdev -maxdepth 1 -type f -name ".*.tmp" -mmin +${v('artifactUploadMaxAgeMinutes')} -delete 2>/dev/null || true`,
    ...paths.map(pathRule),
    `journalctl --vacuum-time=${v('journalMaxAgeDays')}d --vacuum-size=${v('journalMaxSizeMb')}M >/dev/null 2>&1 || true`,
  ]
}

function pathRule(rule: HostCleanupPathRule): string {
  const dir = shellQuote(rule.path.replace(/\/+$/, ''))
  const name = shellQuote(rule.pattern)
  return rule.type === 'directory'
    ? `find ${dir} -xdev -mindepth 1 -maxdepth 1 -type d -name ${name} -mtime +${rule.maxAgeDays} -exec rm -rf -- {} + 2>/dev/null || true`
    : `find ${dir} -xdev -mindepth 1 -maxdepth 1 -type f -name ${name} -mtime +${rule.maxAgeDays} -delete 2>/dev/null || true`
}

/** Rules that walk large trees or call out to daemons. Skipped when there is room. */
function heavyRules(): string[] {
  return [
    // Retained releases contain installed dependencies; these are only
    // download caches.
    `find /root/.bun/install/cache -xdev -type f -mtime +${v('bunCacheMaxAgeDays')} -delete 2>/dev/null || true`,
    'find /root/.bun/install/cache -xdev -depth -type d -empty -delete 2>/dev/null || true',
    // Only unused images past the window qualify. Daemon-less hosts skip this.
    `if command -v docker >/dev/null 2>&1; then docker image prune --all --force --filter "until=${'$'}{${WINDOW_VARS.containerImageMaxAgeHours}}h" >/dev/null 2>&1 || true; fi`,
    `if command -v podman >/dev/null 2>&1; then podman image prune --all --force --filter "until=${'$'}{${WINDOW_VARS.containerImageMaxAgeHours}}h" >/dev/null 2>&1 || true; fi`,
    'if command -v apt-get >/dev/null 2>&1; then apt-get clean >/dev/null 2>&1 || true; fi',
  ]
}

/** Root-filesystem usage as a bare integer, or `-1` when it cannot be read. */
function readDiskPercent(variable: string): string[] {
  return [
    `${variable}="$(df -P / 2>/dev/null | awk 'NR==2 {sub(/%/, "", $5); print $5}' || true)"`,
    `case "\$${variable}" in ''|*[!0-9]*) ${variable}=-1 ;; esac`,
  ]
}

/**
 * The cleanup itself, as shell lines safe to splice into a `set -euo pipefail`
 * script: every command tolerates failure and every variable is assigned
 * before it is read. Contains no here-documents.
 *
 * With pressure awareness on (the default) it reads root-filesystem usage
 * first and picks a tier: `light` below the low-water mark (cheap rules only),
 * `pressure` at or above the high-water mark (every rule, escalated windows,
 * a warning), and `normal` in between or when usage cannot be read. Every run
 * ends with one machine-readable `[ts-cloud] host-cleanup {...}` line.
 */
export function buildHostCleanupScript(config?: boolean | ComputeHostCleanupConfig): string[] {
  const { retention, pressure, paths } = resolveHostCleanupConfig(config)
  const before = 'echo "[ts-cloud] host cleanup (disk before): $(df -h / | tail -1)"'
  const after = 'echo "[ts-cloud] host cleanup (disk after): $(df -h / | tail -1)"'

  if (!pressure)
    return [before, assignWindows(retention), ...cheapRules(paths), ...heavyRules(), after]

  const { lowWaterPercent: low, highWaterPercent: high, escalated } = pressure
  return [
    before,
    ...readDiskPercent('TS_CLOUD_HC_BEFORE'),
    'TS_CLOUD_HC_TIER=normal',
    assignWindows(retention),
    `if [ "$TS_CLOUD_HC_BEFORE" -ge 0 ] && [ "$TS_CLOUD_HC_BEFORE" -lt ${low} ]; then`,
    '  TS_CLOUD_HC_TIER=light',
    `  echo "[ts-cloud] host cleanup: / at \${TS_CLOUD_HC_BEFORE}% (under ${low}%), skipping cache and image pruning"`,
    `elif [ "$TS_CLOUD_HC_BEFORE" -ge ${high} ]; then`,
    '  TS_CLOUD_HC_TIER=pressure',
    `  ${assignWindows(escalated)}`,
    `  echo "[ts-cloud] warning: / at \${TS_CLOUD_HC_BEFORE}% (at or above ${high}%), host cleanup is using shortened retention windows" >&2`,
    'fi',
    ...cheapRules(paths),
    'if [ "$TS_CLOUD_HC_TIER" != light ]; then',
    ...heavyRules().map(line => `  ${line}`),
    'fi',
    after,
    ...readDiskPercent('TS_CLOUD_HC_AFTER'),
    `echo "[ts-cloud] host-cleanup {\\"event\\":\\"host-cleanup\\",\\"tier\\":\\"$TS_CLOUD_HC_TIER\\",\\"diskBeforePercent\\":$TS_CLOUD_HC_BEFORE,\\"diskAfterPercent\\":$TS_CLOUD_HC_AFTER,\\"lowWaterPercent\\":${low},\\"highWaterPercent\\":${high}}"`,
    // Cleaning could not bring the disk back under the mark: that needs a
    // human. Notify once per transition (and once on recovery), like the
    // monitoring alerts, so a box deploying ten times a day does not page ten
    // times a day.
    'mkdir -p /var/lib/ts-cloud 2>/dev/null || true',
    `TS_CLOUD_HC_PREV="$(cat ${ALERT_STATE_PATH} 2>/dev/null || echo ok)"`,
    `if [ "$TS_CLOUD_HC_AFTER" -ge ${high} ]; then`,
    `  echo "[ts-cloud] warning: / still at \${TS_CLOUD_HC_AFTER}% after host cleanup (high-water ${high}%); something outside ts-cloud's retention rules is filling the disk" >&2`,
    `  if [ "$TS_CLOUD_HC_PREV" != alert ] && [ -x /usr/local/bin/ts-cloud-notify ]; then /usr/local/bin/ts-cloud-notify "⚠️ $(hostname): / at \${TS_CLOUD_HC_AFTER}% after host cleanup (high-water ${high}%)" >/dev/null 2>&1 || true; fi`,
    `  echo alert > ${ALERT_STATE_PATH} 2>/dev/null || true`,
    'else',
    `  if [ "$TS_CLOUD_HC_PREV" = alert ] && [ -x /usr/local/bin/ts-cloud-notify ]; then /usr/local/bin/ts-cloud-notify "✅ $(hostname): / back under ${high}% after host cleanup (\${TS_CLOUD_HC_AFTER}%)" >/dev/null 2>&1 || true; fi`,
    `  echo ok > ${ALERT_STATE_PATH} 2>/dev/null || true`,
    'fi',
  ]
}

/**
 * The standalone script the timer and every deploy run. It takes a lock so a
 * timer run and a deploy (or two deploys on a shared box) never prune at once;
 * the loser skips rather than waits, since the winner is doing the same work.
 */
export function buildHostCleanupExecutable(config?: boolean | ComputeHostCleanupConfig): string[] {
  return [
    '#!/usr/bin/env bash',
    '# Managed by ts-cloud: rewritten on every deploy. Configure compute.hostCleanup instead of editing.',
    'set -uo pipefail',
    'TS_CLOUD_HC_LOCK=/run/lock/ts-cloud-host-cleanup.lock',
    '[ -d /run/lock ] || TS_CLOUD_HC_LOCK=/tmp/ts-cloud-host-cleanup.lock',
    'if command -v flock >/dev/null 2>&1 && exec 9>"$TS_CLOUD_HC_LOCK"; then',
    '  if ! flock -n 9; then echo "[ts-cloud] host cleanup already running; skipping"; exit 0; fi',
    'fi',
    ...buildHostCleanupScript(config),
    'exit 0',
  ]
}

/**
 * Write `path` from `lines` through a here-document, replacing it only when the
 * content changed. `changedVar` is set to 1 on a change, so a caller can skip
 * `daemon-reload` on the common no-op deploy. The rename is atomic, so a run
 * already executing the old file keeps reading its own inode.
 */
function writeIfChanged(path: string, lines: string[], delimiter: string, mode: string, changedVar?: string): string[] {
  return [
    `cat > ${path}.ts-cloud-new <<'${delimiter}' || true`,
    ...lines,
    delimiter,
    `if [ -s ${path}.ts-cloud-new ] && ! cmp -s ${path}.ts-cloud-new ${path}; then chmod ${mode} ${path}.ts-cloud-new && mv -f ${path}.ts-cloud-new ${path}${changedVar ? ` && ${changedVar}=1` : ''} || true; else rm -f ${path}.ts-cloud-new; fi`,
  ]
}

/**
 * Install (or update, or remove) the cleanup script and its systemd timer.
 * Idempotent: an unchanged deploy rewrites nothing and reloads nothing. Every
 * line tolerates failure, so it can run inside a deploy that already
 * succeeded, in cloud-init, or on a host without systemd.
 */
export function buildHostCleanupInstallScript(config?: boolean | ComputeHostCleanupConfig): string[] {
  const resolved = resolveHostCleanupConfig(config)
  const unit = `/etc/systemd/system/${HOST_CLEANUP_UNIT}`
  const removeTimer = [
    `if [ -f ${unit}.timer ]; then`,
    `  systemctl disable --now ${HOST_CLEANUP_UNIT}.timer >/dev/null 2>&1 || true`,
    `  rm -f ${unit}.timer ${unit}.service`,
    '  systemctl daemon-reload >/dev/null 2>&1 || true',
    'fi',
  ]

  if (!resolved.enabled)
    return [...removeTimer, `rm -f ${HOST_CLEANUP_SCRIPT_PATH}`]

  const executable = writeIfChanged(HOST_CLEANUP_SCRIPT_PATH, buildHostCleanupExecutable(config), 'TS_CLOUD_HOST_CLEANUP_EOF', '755')
  if (!resolved.timer)
    return [...executable, ...removeTimer]

  return [
    ...executable,
    'TS_CLOUD_HC_UNITS_CHANGED=0',
    'if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then',
    ...writeIfChanged(`${unit}.service`, [
      '[Unit]',
      'Description=ts-cloud host cleanup (bounded disk retention)',
      'After=local-fs.target',
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${HOST_CLEANUP_SCRIPT_PATH}`,
      // Cleanup is never urgent enough to compete with the sites on the box.
      'Nice=19',
      'IOSchedulingClass=idle',
    ], 'TS_CLOUD_HOST_CLEANUP_SVC_EOF', '644', 'TS_CLOUD_HC_UNITS_CHANGED'),
    ...writeIfChanged(`${unit}.timer`, [
      '[Unit]',
      'Description=Run ts-cloud host cleanup on a schedule, independent of deploys',
      '',
      '[Timer]',
      `OnCalendar=${resolved.schedule}`,
      // Spread a fleet's runs so boxes sharing storage do not prune in lockstep.
      'RandomizedDelaySec=1h',
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
    ], 'TS_CLOUD_HOST_CLEANUP_TMR_EOF', '644', 'TS_CLOUD_HC_UNITS_CHANGED'),
    '  if [ "$TS_CLOUD_HC_UNITS_CHANGED" -eq 1 ]; then systemctl daemon-reload >/dev/null 2>&1 || true; fi',
    `  systemctl enable --now ${HOST_CLEANUP_UNIT}.timer >/dev/null 2>&1 || true`,
    'fi',
  ]
}

/**
 * What a deploy runs: install or refresh the cleanup and its timer, then run it
 * once now. Empty when `hostCleanup: false`, except for removing a timer an
 * earlier deploy installed.
 */
export function buildHostCleanupDeployScript(config?: boolean | ComputeHostCleanupConfig): string[] {
  const install = buildHostCleanupInstallScript(config)
  if (!resolveHostCleanupConfig(config).enabled) return install
  return [
    ...install,
    `if [ -x ${HOST_CLEANUP_SCRIPT_PATH} ]; then ${HOST_CLEANUP_SCRIPT_PATH} < /dev/null || echo "[ts-cloud] warning: host cleanup exited $?" >&2; fi`,
  ]
}
