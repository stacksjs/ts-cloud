/**
 * Lightweight server monitoring + resource alerts, mirroring Forge's server
 * metrics and notifications.
 *
 * Dependency-free: a small shell collector reads load average, memory, swap,
 * disk, uptime, network throughput, and per-service TCP health, then writes a
 * JSON snapshot to {@link METRICS_PATH} every minute via a systemd timer. The
 * ts-cloud UI (and any operator tooling) reads that file for at-a-glance health.
 *
 * When alert thresholds are configured (CPU load per core, memory %, disk %),
 * the collector calls the on-box `ts-cloud-notify` helper on each OK→alert
 * transition (and once more on recovery), so channels aren't spammed every
 * minute the box stays hot.
 */
import type { ComputeMonitoringConfig } from '@ts-cloud/core'

/** Where the metrics snapshot is written. */
export const METRICS_PATH = '/var/lib/ts-cloud/metrics.json'

/** Tracks OK/alert state so notifications fire only on transitions. */
const ALERT_STATE_PATH = '/var/lib/ts-cloud/alert-state'

/**
 * Running bandwidth accounting: last sample, plus day- and month-to-date totals.
 *
 * `/proc/net/dev` only offers counters since boot, so a snapshot of them answers
 * no useful question — it has no rate, it silently resets on reboot, and it can
 * never be compared against a monthly allowance. Keeping the previous sample
 * here lets the collector turn those counters into a rate and accumulate real
 * period totals that survive both reboots and counter wraps.
 */
const BANDWIDTH_STATE_PATH = '/var/lib/ts-cloud/bandwidth-state'

/** Tracks the bandwidth-budget alert separately so it can't be reset by a load spike. */
const BANDWIDTH_ALERT_STATE_PATH = '/var/lib/ts-cloud/bandwidth-alert-state'

/** Default alert thresholds (overridable via {@link ComputeMonitoringConfig}). */
const DEFAULT_CPU_LOAD_PER_CORE = 2
const DEFAULT_MEM_PERCENT = 90
const DEFAULT_DISK_PERCENT = 90
/** Warn at this share of the monthly bandwidth allowance, when one is configured. */
const DEFAULT_BANDWIDTH_PERCENT = 80

/** TCP services the collector probes for health (name → localhost port). */
const SERVICE_PROBES: ReadonlyArray<readonly [string, number]> = [
  ['nginx', 80],
  ['https', 443],
  ['phpFpm', 9074],
  ['mysql', 3306],
  ['postgres', 5432],
  ['redis', 6379],
  ['meilisearch', 7700],
  ['typesense', 8108],
  ['smtp', 25],
]

/** Resolve `{ enabled, thresholds }` from the (boolean | object) monitoring config. */
function resolveMonitoring(monitoring: boolean | ComputeMonitoringConfig = true): {
  enabled: boolean
  cpuLoadPerCore: number
  memPercent: number
  diskPercent: number
  bandwidthTb: number
  bandwidthPercent: number
} {
  const obj = typeof monitoring === 'object' ? monitoring : {}
  const enabled = typeof monitoring === 'boolean' ? monitoring : monitoring.enabled !== false
  const bandwidthTb = Number(obj.alerts?.bandwidthTb ?? 0)
  return {
    enabled,
    cpuLoadPerCore: obj.alerts?.cpuLoadPerCore ?? DEFAULT_CPU_LOAD_PER_CORE,
    memPercent: obj.alerts?.memPercent ?? DEFAULT_MEM_PERCENT,
    diskPercent: obj.alerts?.diskPercent ?? DEFAULT_DISK_PERCENT,
    bandwidthTb: Number.isFinite(bandwidthTb) && bandwidthTb > 0 ? bandwidthTb : 0,
    bandwidthPercent: obj.alerts?.bandwidthPercent ?? DEFAULT_BANDWIDTH_PERCENT,
  }
}

/**
 * Build the commands that install the metrics collector + systemd timer.
 * Accepts `true`/`false` or a {@link ComputeMonitoringConfig} (with alert
 * thresholds). Idempotent. Returns `[]` when disabled.
 */
export function buildMonitoringScript(monitoring: boolean | ComputeMonitoringConfig = true): string[] {
  const { enabled, cpuLoadPerCore, memPercent, diskPercent, bandwidthTb, bandwidthPercent } = resolveMonitoring(monitoring)
  if (!enabled) return []

  // Providers quote allowances in decimal TB, and so do their overage bills.
  const bandwidthBudgetBytes = Math.round(bandwidthTb * 1000 ** 4)

  // Per-service health probes via bash /dev/tcp (no nc/curl dependency).
  const probeLines = SERVICE_PROBES.map(([name, port]) => `SVC_${name.toUpperCase()}=$(probe ${port})`)
  const servicesJson = SERVICE_PROBES.map(([name]) => `"${name}":"$SVC_${name.toUpperCase()}"`).join(',')

  return [
    // sysstat keeps CPU/RAM/swap history locally, so server:monitoring and the
    // dashboard can explain the last few hours instead of showing one snapshot.
    'if ! command -v sadf >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq sysstat; fi',
    'systemctl enable --now sysstat.service 2>/dev/null || true',
    'mkdir -p /var/lib/ts-cloud',
    `cat > /usr/local/bin/ts-cloud-metrics.sh <<'TS_CLOUD_METRICS_EOF'`,
    '#!/bin/bash',
    'set -uo pipefail',
    `LOAD=$(cut -d' ' -f1 /proc/loadavg)`,
    'CPUS=$(nproc)',
    `read MEM_TOTAL MEM_USED SWAP_TOTAL SWAP_USED <<EOF
$(free -m | awk '/^Mem:/{total=$2; used=$3} /^Swap:/{print total, used, $2, $3}')
EOF`,
    'DISK_PCT=$(df -P / | awk \'NR==2{gsub("%","",$5); print $5}\')',
    `UPTIME_SEC=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)`,
    // Network throughput: cumulative rx/tx bytes across non-loopback interfaces.
    `RX_BYTES=$(awk -F'[: ]+' 'NR>2 && $2!="lo"{rx+=$3} END{print rx+0}' /proc/net/dev)`,
    `TX_BYTES=$(awk -F'[: ]+' 'NR>2 && $2!="lo"{tx+=$11} END{print tx+0}' /proc/net/dev)`,
    'NOW_EPOCH=$(date -u +%s); TODAY=$(date -u +%Y-%m-%d); MONTH=$(date -u +%Y-%m)',
    // Turn the since-boot counters into a rate and into period totals.
    //
    // Everything hinges on the delta against the previous sample, and there are
    // two ways that delta lies: a reboot (or counter wrap) makes the current
    // reading smaller than the last one, and a first run has nothing to compare
    // against. Both are treated as "no measurable traffic this tick" rather than
    // being counted as a huge burst, which is what a naive subtraction would do
    // to the month's total on every single reboot.
    `if [ -r ${BANDWIDTH_STATE_PATH} ]; then . ${BANDWIDTH_STATE_PATH}; fi`,
    'PREV_EPOCH=${PREV_EPOCH:-0}; PREV_RX=${PREV_RX:-0}; PREV_TX=${PREV_TX:-0}',
    'DAY_KEY=${DAY_KEY:-$TODAY}; MONTH_KEY=${MONTH_KEY:-$MONTH}',
    'DAY_RX=${DAY_RX:-0}; DAY_TX=${DAY_TX:-0}; MONTH_RX=${MONTH_RX:-0}; MONTH_TX=${MONTH_TX:-0}',
    'ELAPSED=$(( NOW_EPOCH - PREV_EPOCH ))',
    'if [ "$PREV_EPOCH" -le 0 ] || [ "$ELAPSED" -le 0 ] || [ "$RX_BYTES" -lt "$PREV_RX" ] || [ "$TX_BYTES" -lt "$PREV_TX" ]; then',
    '  DELTA_RX=0; DELTA_TX=0; ELAPSED=0',
    'else',
    '  DELTA_RX=$(( RX_BYTES - PREV_RX )); DELTA_TX=$(( TX_BYTES - PREV_TX ))',
    'fi',
    // Roll the period buckets before adding, so the first tick of a new day or
    // month starts from zero instead of inheriting the previous period.
    'if [ "$DAY_KEY" != "$TODAY" ]; then DAY_KEY=$TODAY; DAY_RX=0; DAY_TX=0; fi',
    'if [ "$MONTH_KEY" != "$MONTH" ]; then MONTH_KEY=$MONTH; MONTH_RX=0; MONTH_TX=0; fi',
    'DAY_RX=$(( DAY_RX + DELTA_RX )); DAY_TX=$(( DAY_TX + DELTA_TX ))',
    'MONTH_RX=$(( MONTH_RX + DELTA_RX )); MONTH_TX=$(( MONTH_TX + DELTA_TX ))',
    'if [ "$ELAPSED" -gt 0 ]; then RX_RATE=$(( DELTA_RX / ELAPSED )); TX_RATE=$(( DELTA_TX / ELAPSED )); else RX_RATE=0; TX_RATE=0; fi',
    `cat > ${BANDWIDTH_STATE_PATH}.tmp <<BWSTATE`,
    'PREV_EPOCH=$NOW_EPOCH',
    'PREV_RX=$RX_BYTES',
    'PREV_TX=$TX_BYTES',
    'RX_RATE=$RX_RATE',
    'TX_RATE=$TX_RATE',
    'DAY_KEY=$DAY_KEY',
    'DAY_RX=$DAY_RX',
    'DAY_TX=$DAY_TX',
    'MONTH_KEY=$MONTH_KEY',
    'MONTH_RX=$MONTH_RX',
    'MONTH_TX=$MONTH_TX',
    'BWSTATE',
    `mv -f ${BANDWIDTH_STATE_PATH}.tmp ${BANDWIDTH_STATE_PATH}`,
    // Per-service TCP health (up/down) without extra tooling. The connection is
    // opened + closed inside the subshell; success ⇒ up.
    'probe(){ (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null && echo up || echo down; }',
    ...probeLines,
    // Default every numeric to a literal so a missing reading can't emit invalid
    // JSON (e.g. `"load":,`) and break every reader for that minute.
    'LOAD=${LOAD:-0}; CPUS=${CPUS:-1}; MEM_TOTAL=${MEM_TOTAL:-0}; MEM_USED=${MEM_USED:-0}',
    'SWAP_TOTAL=${SWAP_TOTAL:-0}; SWAP_USED=${SWAP_USED:-0}; DISK_PCT=${DISK_PCT:-0}',
    'UPTIME_SEC=${UPTIME_SEC:-0}; RX_BYTES=${RX_BYTES:-0}; TX_BYTES=${TX_BYTES:-0}',
    'MEM_PCT=$(( MEM_TOTAL > 0 ? MEM_USED * 100 / MEM_TOTAL : 0 ))',
    // Write atomically (temp + rename) so a reader never sees a half-written file.
    `cat > ${METRICS_PATH}.tmp <<JSON`,
    '{"load":$LOAD,"cpus":$CPUS,"memTotalMb":$MEM_TOTAL,"memUsedMb":$MEM_USED,"memUsedPct":$MEM_PCT,"swapTotalMb":$SWAP_TOTAL,"swapUsedMb":$SWAP_USED,"diskUsedPct":$DISK_PCT,"uptimeSec":$UPTIME_SEC,'
      + '"network":{"rxBytes":$RX_BYTES,"txBytes":$TX_BYTES,"rxBytesPerSec":$RX_RATE,"txBytesPerSec":$TX_RATE,'
      + '"dayKey":"$DAY_KEY","rxBytesToday":$DAY_RX,"txBytesToday":$DAY_TX,'
      + `"monthKey":"$MONTH_KEY","rxBytesMonth":$MONTH_RX,"txBytesMonth":$MONTH_TX,"budgetBytes":${bandwidthBudgetBytes}},"services":{`
      + servicesJson
      + '}}',
    'JSON',
    `mv -f ${METRICS_PATH}.tmp ${METRICS_PATH}`,
    // Resource alerts: notify on OK→alert transition (and once on recovery).
    'ALERTS=""',
    `if awk -v l="$LOAD" -v c="$CPUS" -v t=${cpuLoadPerCore} 'BEGIN{exit !(c>0 && l/c > t)}'; then ALERTS="$ALERTS load=$LOAD/${cpuLoadPerCore}xCPU"; fi`,
    `if [ "\${MEM_PCT:-0}" -ge ${memPercent} ]; then ALERTS="$ALERTS mem=\${MEM_PCT}%"; fi`,
    `if [ "\${DISK_PCT:-0}" -ge ${diskPercent} ]; then ALERTS="$ALERTS disk=\${DISK_PCT}%"; fi`,
    `PREV=$(cat ${ALERT_STATE_PATH} 2>/dev/null || echo ok)`,
    'if [ -n "$ALERTS" ]; then',
    '  if [ "$PREV" != alert ] && [ -x /usr/local/bin/ts-cloud-notify ]; then /usr/local/bin/ts-cloud-notify "⚠️ $(hostname): resource alert —$ALERTS" || true; fi',
    `  echo alert > ${ALERT_STATE_PATH}`,
    'else',
    '  if [ "$PREV" = alert ] && [ -x /usr/local/bin/ts-cloud-notify ]; then /usr/local/bin/ts-cloud-notify "✅ $(hostname): resource usage back to normal" || true; fi',
    `  echo ok > ${ALERT_STATE_PATH}`,
    'fi',
    // Bandwidth budget: a separate alert with its own state, because it moves on
    // a monthly timescale. Folding it into the resource alert would let a load
    // spike clear it, and the whole point is to hear about the allowance before
    // the provider's overage mail does. Skipped entirely when no budget is set.
    ...(bandwidthBudgetBytes > 0
      ? [
          'BW_TOTAL=$(( MONTH_RX + MONTH_TX ))',
          `BW_PCT=$(( BW_TOTAL * 100 / ${bandwidthBudgetBytes} ))`,
          `BW_PREV=$(cat ${BANDWIDTH_ALERT_STATE_PATH} 2>/dev/null || echo ok)`,
          `if [ "$BW_PCT" -ge ${bandwidthPercent} ]; then`,
          `  if [ "$BW_PREV" != alert ] && [ -x /usr/local/bin/ts-cloud-notify ]; then /usr/local/bin/ts-cloud-notify "⚠️ $(hostname): bandwidth at \${BW_PCT}% of the ${bandwidthTb} TB monthly allowance (\$MONTH_KEY)" || true; fi`,
          `  echo alert > ${BANDWIDTH_ALERT_STATE_PATH}`,
          'else',
          `  if [ "$BW_PREV" = alert ] && [ -x /usr/local/bin/ts-cloud-notify ]; then /usr/local/bin/ts-cloud-notify "✅ $(hostname): bandwidth back under the monthly allowance (\${BW_PCT}%)" || true; fi`,
          `  echo ok > ${BANDWIDTH_ALERT_STATE_PATH}`,
          'fi',
        ]
      : []),
    'TS_CLOUD_METRICS_EOF',
    'chmod +x /usr/local/bin/ts-cloud-metrics.sh',
    // systemd service + timer (every minute).
    `cat > /etc/systemd/system/ts-cloud-metrics.service <<'TS_CLOUD_METRICS_SVC_EOF'`,
    '[Unit]',
    'Description=ts-cloud metrics collector',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/local/bin/ts-cloud-metrics.sh',
    'TS_CLOUD_METRICS_SVC_EOF',
    `cat > /etc/systemd/system/ts-cloud-metrics.timer <<'TS_CLOUD_METRICS_TMR_EOF'`,
    '[Unit]',
    'Description=Run ts-cloud metrics collector every minute',
    '',
    '[Timer]',
    'OnCalendar=*-*-* *:*:00',
    'AccuracySec=1s',
    'RandomizedDelaySec=5s',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    'TS_CLOUD_METRICS_TMR_EOF',
    'systemctl daemon-reload',
    'systemctl enable --now ts-cloud-metrics.timer',
    'systemctl start ts-cloud-metrics.service',
  ]
}
