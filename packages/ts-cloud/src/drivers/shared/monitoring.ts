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

/** Default alert thresholds (overridable via {@link ComputeMonitoringConfig}). */
const DEFAULT_CPU_LOAD_PER_CORE = 2
const DEFAULT_MEM_PERCENT = 90
const DEFAULT_DISK_PERCENT = 90

/** TCP services the collector probes for health (name → localhost port). */
const SERVICE_PROBES: ReadonlyArray<readonly [string, number]> = [
  ['nginx', 80],
  ['phpFpm', 9074],
  ['mysql', 3306],
  ['postgres', 5432],
  ['redis', 6379],
  ['meilisearch', 7700],
]

/** Resolve `{ enabled, thresholds }` from the (boolean | object) monitoring config. */
function resolveMonitoring(monitoring: boolean | ComputeMonitoringConfig = true): {
  enabled: boolean
  cpuLoadPerCore: number
  memPercent: number
  diskPercent: number
} {
  const obj = typeof monitoring === 'object' ? monitoring : {}
  const enabled = typeof monitoring === 'boolean' ? monitoring : monitoring.enabled !== false
  return {
    enabled,
    cpuLoadPerCore: obj.alerts?.cpuLoadPerCore ?? DEFAULT_CPU_LOAD_PER_CORE,
    memPercent: obj.alerts?.memPercent ?? DEFAULT_MEM_PERCENT,
    diskPercent: obj.alerts?.diskPercent ?? DEFAULT_DISK_PERCENT,
  }
}

/**
 * Build the commands that install the metrics collector + systemd timer.
 * Accepts `true`/`false` or a {@link ComputeMonitoringConfig} (with alert
 * thresholds). Idempotent. Returns `[]` when disabled.
 */
export function buildMonitoringScript(monitoring: boolean | ComputeMonitoringConfig = true): string[] {
  const { enabled, cpuLoadPerCore, memPercent, diskPercent } = resolveMonitoring(monitoring)
  if (!enabled) return []

  // Per-service health probes via bash /dev/tcp (no nc/curl dependency).
  const probeLines = SERVICE_PROBES.map(([name, port]) => `SVC_${name.toUpperCase()}=$(probe ${port})`)
  const servicesJson = SERVICE_PROBES.map(([name]) => `"${name}":"$SVC_${name.toUpperCase()}"`).join(',')

  return [
    'mkdir -p /var/lib/ts-cloud',
    "cat > /usr/local/bin/ts-cloud-metrics.sh <<'TS_CLOUD_METRICS_EOF'",
    '#!/bin/bash',
    'set -uo pipefail',
    "LOAD=$(cut -d' ' -f1 /proc/loadavg)",
    'CPUS=$(nproc)',
    "MEM_TOTAL=$(free -m | awk '/^Mem:/{print $2}')",
    "MEM_USED=$(free -m | awk '/^Mem:/{print $3}')",
    "SWAP_TOTAL=$(free -m | awk '/^Swap:/{print $2}')",
    "SWAP_USED=$(free -m | awk '/^Swap:/{print $3}')",
    'DISK_PCT=$(df -P / | awk \'NR==2{gsub("%","",$5); print $5}\')',
    "UPTIME_SEC=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)",
    // Network throughput: cumulative rx/tx bytes across non-loopback interfaces.
    "RX_BYTES=$(awk -F'[: ]+' 'NR>2 && $2!=\"lo\"{rx+=$3} END{print rx+0}' /proc/net/dev)",
    "TX_BYTES=$(awk -F'[: ]+' 'NR>2 && $2!=\"lo\"{tx+=$11} END{print tx+0}' /proc/net/dev)",
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
    '{"load":$LOAD,"cpus":$CPUS,"memTotalMb":$MEM_TOTAL,"memUsedMb":$MEM_USED,"memUsedPct":$MEM_PCT,"swapTotalMb":$SWAP_TOTAL,"swapUsedMb":$SWAP_USED,"diskUsedPct":$DISK_PCT,"uptimeSec":$UPTIME_SEC,"network":{"rxBytes":$RX_BYTES,"txBytes":$TX_BYTES},"services":{' +
      servicesJson +
      '}}',
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
    'TS_CLOUD_METRICS_EOF',
    'chmod +x /usr/local/bin/ts-cloud-metrics.sh',
    // systemd service + timer (every minute).
    "cat > /etc/systemd/system/ts-cloud-metrics.service <<'TS_CLOUD_METRICS_SVC_EOF'",
    '[Unit]',
    'Description=ts-cloud metrics collector',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/local/bin/ts-cloud-metrics.sh',
    'TS_CLOUD_METRICS_SVC_EOF',
    "cat > /etc/systemd/system/ts-cloud-metrics.timer <<'TS_CLOUD_METRICS_TMR_EOF'",
    '[Unit]',
    'Description=Run ts-cloud metrics collector every minute',
    '',
    '[Timer]',
    'OnBootSec=60',
    'OnUnitActiveSec=60',
    '',
    '[Install]',
    'WantedBy=timers.target',
    'TS_CLOUD_METRICS_TMR_EOF',
    'systemctl daemon-reload',
    'systemctl enable ts-cloud-metrics.timer',
    'systemctl start ts-cloud-metrics.timer',
  ]
}
