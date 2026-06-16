/**
 * Lightweight server monitoring, mirroring Forge's basic server metrics.
 *
 * Dependency-free: a small shell collector reads load average, memory, and
 * disk usage and writes a JSON snapshot to `/var/lib/ts-cloud/metrics.json`
 * every minute via a systemd timer. The ts-cloud UI (and any operator tooling)
 * can read that file for at-a-glance server health.
 */

/** Where the metrics snapshot is written. */
export const METRICS_PATH = '/var/lib/ts-cloud/metrics.json'

/**
 * Build the commands that install the metrics collector + systemd timer.
 * Idempotent. Returns `[]` when disabled.
 */
export function buildMonitoringScript(enabled: boolean = true): string[] {
  if (!enabled)
    return []

  return [
    'mkdir -p /var/lib/ts-cloud',
    // Collector: emit a compact JSON snapshot of load/mem/disk.
    'cat > /usr/local/bin/ts-cloud-metrics.sh <<\'TS_CLOUD_METRICS_EOF\'',
    '#!/bin/bash',
    'set -euo pipefail',
    'LOAD=$(cut -d\' \' -f1 /proc/loadavg)',
    'MEM_TOTAL=$(free -m | awk \'/^Mem:/{print $2}\')',
    'MEM_USED=$(free -m | awk \'/^Mem:/{print $3}\')',
    'DISK_PCT=$(df -P / | awk \'NR==2{gsub("%","",$5); print $5}\')',
    'CPUS=$(nproc)',
    'cat > ' + METRICS_PATH + ' <<JSON',
    '{"load":$LOAD,"cpus":$CPUS,"memTotalMb":$MEM_TOTAL,"memUsedMb":$MEM_USED,"diskUsedPct":$DISK_PCT}',
    'JSON',
    'TS_CLOUD_METRICS_EOF',
    'chmod +x /usr/local/bin/ts-cloud-metrics.sh',
    // systemd service + timer (every minute).
    'cat > /etc/systemd/system/ts-cloud-metrics.service <<\'TS_CLOUD_METRICS_SVC_EOF\'',
    '[Unit]',
    'Description=ts-cloud metrics collector',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/local/bin/ts-cloud-metrics.sh',
    'TS_CLOUD_METRICS_SVC_EOF',
    'cat > /etc/systemd/system/ts-cloud-metrics.timer <<\'TS_CLOUD_METRICS_TMR_EOF\'',
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
