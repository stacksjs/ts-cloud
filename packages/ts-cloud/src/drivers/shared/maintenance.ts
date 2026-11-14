/**
 * Automatic unattended security/system updates, mirroring Forge's scheduled
 * maintenance. Installs `unattended-upgrades` and enables the daily APT
 * auto-update timers so security patches land without manual intervention.
 *
 * It also takes service restarts away from the package run. Ubuntu's
 * needrestart, called by APT after every upgrade, restarts every service that
 * maps an upgraded library in ONE `systemctl restart` command. On a box that
 * hosts many apps a libc update therefore restarts all of them at the same
 * second: every tenant is down together and the box thrashes while they all
 * boot. needrestart is set to list only, and a daily timer restarts what it
 * lists one service at a time, waiting for each to come up and for load to
 * settle before the next.
 */

export const STAGGERED_RESTART_SCRIPT_PATH = '/usr/local/sbin/ts-cloud-staggered-restart'
export const STAGGERED_RESTART_UNIT = 'ts-cloud-staggered-restart'
export const NEEDRESTART_CONF_PATH = '/etc/needrestart/conf.d/50-ts-cloud-staggered.conf'

/**
 * Units a restart would cut the operator or the box itself off from. These are
 * the ones needrestart itself defers; they pick up new libraries at the next
 * reboot.
 */
const NEVER_RESTART = [
  'dbus',
  'systemd-logind',
  'getty@',
  'serial-getty@',
  'user@',
  'docker',
  'containerd',
  'unattended-upgrades',
  'apt-daily',
  'cloud-',
  'network',
  'NetworkManager',
  'emergency',
  'rescue',
  STAGGERED_RESTART_UNIT,
]

/**
 * The standalone script the timer runs. Safe to run by hand; `--dry-run`
 * prints what it would restart and touches nothing.
 */
export function buildStaggeredRestartExecutable(): string[] {
  return [
    '#!/bin/bash',
    '# Written by ts-cloud. Restarts the services needrestart lists, one at a time.',
    'set -u',
    'DRY=0',
    '[ "${1:-}" = "--dry-run" ] && DRY=1',
    'PAUSE="${TS_CLOUD_RESTART_PAUSE:-15}"',
    'SETTLE_LIMIT="${TS_CLOUD_RESTART_SETTLE_LIMIT:-300}"',
    'command -v needrestart >/dev/null 2>&1 || { echo "[ts-cloud] staggered restart: needrestart is not installed"; exit 0; }',
    'exec 9>/run/ts-cloud-staggered-restart.lock',
    'flock -n 9 || { echo "[ts-cloud] staggered restart: another run holds the lock"; exit 0; }',
    'CPUS="$(nproc 2>/dev/null || echo 1)"',
    `SKIP='^(${NEVER_RESTART.join('|')})'`,
    'load_settled() {',
    '  local load',
    '  load="$(cut -d. -f1 /proc/loadavg 2>/dev/null || echo 0)"',
    '  [ "$load" -lt "$CPUS" ]',
    '}',
    'mapfile -t SERVICES < <(needrestart -b -r l 2>/dev/null | sed -n "s/^NEEDRESTART-SVC: //p")',
    'RESTARTED=0; SKIPPED=0; FAILED=0',
    'for svc in "${SERVICES[@]}"; do',
    '  if [[ "$svc" =~ $SKIP ]]; then',
    '    SKIPPED=$((SKIPPED + 1))',
    '    continue',
    '  fi',
    '  if [ "$DRY" = 1 ]; then',
    '    echo "[ts-cloud] staggered restart: would restart $svc"',
    '    RESTARTED=$((RESTARTED + 1))',
    '    continue',
    '  fi',
    '  waited=0',
    '  while ! load_settled && [ "$waited" -lt "$SETTLE_LIMIT" ]; do sleep 5; waited=$((waited + 5)); done',
    '  echo "[ts-cloud] staggered restart: restarting $svc"',
    '  if ! systemctl restart "$svc"; then',
    '    echo "[ts-cloud] staggered restart: $svc failed to restart" >&2',
    '    FAILED=$((FAILED + 1))',
    '    continue',
    '  fi',
    '  up=0',
    '  for _ in $(seq 1 30); do',
    '    if systemctl is-active --quiet "$svc"; then up=1; break; fi',
    '    sleep 2',
    '  done',
    '  if [ "$up" = 1 ]; then',
    '    RESTARTED=$((RESTARTED + 1))',
    '  else',
    '    echo "[ts-cloud] staggered restart: $svc is not active after its restart" >&2',
    '    FAILED=$((FAILED + 1))',
    '  fi',
    '  sleep "$PAUSE"',
    'done',
    'echo "[ts-cloud] staggered-restart {\\"event\\":\\"staggered-restart\\",\\"dryRun\\":$DRY,\\"restarted\\":$RESTARTED,\\"skipped\\":$SKIPPED,\\"failed\\":$FAILED}"',
    'if [ "$FAILED" -gt 0 ] && [ -x /usr/local/bin/ts-cloud-notify ]; then',
    '  /usr/local/bin/ts-cloud-notify "$(hostname): $FAILED service(s) did not come back after a library-update restart" >/dev/null 2>&1 || true',
    'fi',
    '[ "$FAILED" -eq 0 ]',
  ]
}

/**
 * Stop needrestart restarting everything at once, and install the timer that
 * restarts services one at a time instead. Idempotent.
 */
export function buildStaggeredRestartInstallScript(): string[] {
  const unit = `/etc/systemd/system/${STAGGERED_RESTART_UNIT}`
  return [
    'mkdir -p /etc/needrestart/conf.d',
    `cat > ${NEEDRESTART_CONF_PATH} <<'TS_CLOUD_NEEDRESTART_EOF'`,
    '# Written by ts-cloud. List services that need a restart; never restart',
    `# them from the package run. ${STAGGERED_RESTART_UNIT}.timer restarts them one at a time.`,
    `$nrconf{restart} = 'l';`,
    'TS_CLOUD_NEEDRESTART_EOF',
    `cat > ${STAGGERED_RESTART_SCRIPT_PATH} <<'TS_CLOUD_STAGGERED_EOF'`,
    ...buildStaggeredRestartExecutable(),
    'TS_CLOUD_STAGGERED_EOF',
    `chmod 755 ${STAGGERED_RESTART_SCRIPT_PATH}`,
    `cat > ${unit}.service <<'TS_CLOUD_STAGGERED_UNIT_EOF'`,
    '[Unit]',
    'Description=Restart services that map upgraded libraries, one at a time (ts-cloud)',
    'After=network.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${STAGGERED_RESTART_SCRIPT_PATH}`,
    'TimeoutStartSec=4h',
    'TS_CLOUD_STAGGERED_UNIT_EOF',
    `cat > ${unit}.timer <<'TS_CLOUD_STAGGERED_TIMER_EOF'`,
    '[Unit]',
    'Description=Daily staggered service restarts after library updates (ts-cloud)',
    '',
    '[Timer]',
    // apt-daily-upgrade runs at 06:00 with up to an hour of random delay.
    'OnCalendar=*-*-* 07:30:00',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    'TS_CLOUD_STAGGERED_TIMER_EOF',
    'systemctl daemon-reload 2>/dev/null || true',
    `systemctl enable --now ${STAGGERED_RESTART_UNIT}.timer >/dev/null 2>&1 || true`,
  ]
}

/**
 * Build the commands that enable automatic security updates. Idempotent.
 * Returns `[]` when disabled.
 */
export function buildAutoUpdatesScript(enabled: boolean = true): string[] {
  if (!enabled) return []

  return [
    'export DEBIAN_FRONTEND=noninteractive',
    `dpkg-query -W -f='\${Status}' unattended-upgrades 2>/dev/null | grep -q 'ok installed' || apt-get install -y unattended-upgrades`,
    // Enable the periodic update/upgrade APT timers.
    `cat > /etc/apt/apt.conf.d/20auto-upgrades <<'TS_CLOUD_AUTOUPD_EOF'`,
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
    'APT::Periodic::Download-Upgradeable-Packages "1";',
    'APT::Periodic::AutocleanInterval "7";',
    'TS_CLOUD_AUTOUPD_EOF',
    'systemctl enable --now unattended-upgrades 2>/dev/null || true',
    ...buildStaggeredRestartInstallScript(),
  ]
}
