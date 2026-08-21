/**
 * Keep self-updating binaries current on a box.
 *
 * A tool that ships as a GitHub release and knows how to replace itself
 * (`<binary> upgrade`) still needs something to *call* it on a schedule. Every
 * project was writing that something by hand — a systemd service, a timer, an
 * env file, a daemon-reload — into its own `userData`. That is boilerplate the
 * framework should own: it is identical everywhere except for the binary path
 * and the unit to restart, and both of those are already config.
 *
 * So `compute.appUpdates` takes the two facts that differ and renders the rest:
 *
 * ```ts
 * compute: {
 *   appUpdates: [{ service: 'mail', binary: '/opt/mail/mail-server' }],
 * }
 * ```
 *
 * Safety is delegated, deliberately. This module schedules; it does not swap
 * binaries. The tool's own `upgrade` command is responsible for skipping when
 * it is already current (so a daily tick does not restart a live service for
 * nothing), for refusing to move backwards, and for rolling back if the new
 * binary will not start. A tool without those properties should not be listed
 * here.
 */

import type { ComputeAppUpdateTarget } from '@ts-cloud/core'

/** Where the per-target pause switch lives. */
export function appUpdateEnvPath(service: string): string {
  return `/etc/ts-cloud/${service}-upgrade.env`
}

/** Unit basename for a target's updater. */
export function appUpdateUnitBase(service: string): string {
  return `${service}-upgrade`
}

/**
 * Render the provisioning lines for every configured target. Returns `[]` when
 * nothing is configured, matching every other builder in this directory, so the
 * caller can splat it unconditionally.
 */
export function buildAppUpdatesScript(targets?: ComputeAppUpdateTarget[]): string[] {
  if (!targets || targets.length === 0)
    return []

  const lines: string[] = ['mkdir -p /etc/ts-cloud']
  // Enables are collected separately so a single `daemon-reload` can run after
  // every unit file is on disk — reloading before the writes would leave
  // systemd enabling units it has not read.
  const enables: string[] = []

  for (const target of targets) {
    if (target.enabled === false)
      continue
    if (!target.service || !target.binary)
      continue

    const {
      service,
      binary,
      command = 'upgrade',
      channel = 'stable',
      schedule = 'daily',
      randomizedDelay = '4h',
      args = [],
    } = target

    const unitBase = appUpdateUnitBase(service)
    const envPath = appUpdateEnvPath(service)
    // The tool is told which unit to restart and which file to replace, so a
    // binary invoked from anywhere still acts on the right install.
    const flags = [
      `--path ${binary}`,
      `--service ${service}`,
      ...(channel === 'canary' ? ['--canary'] : []),
      ...args,
    ].join(' ')

    lines.push(
      // An env file rather than a flag so an operator can pause updates on one
      // box without a redeploy, and without disabling the unit (which a later
      // provisioning run would just re-enable).
      `if [ ! -f ${envPath} ]; then`,
      `  cat > ${envPath} <<'TS_CLOUD_APPUPD_ENV_EOF'`,
      '# Set to false to pause automatic updates without disabling the timer.',
      'ENABLED=true',
      '# Extra flags appended to the update command.',
      'ARGS=',
      'TS_CLOUD_APPUPD_ENV_EOF',
      'fi',
      `chmod 644 ${envPath}`,
      `cat > /etc/systemd/system/${unitBase}.service <<'TS_CLOUD_APPUPD_SVC_EOF'`,
      '[Unit]',
      `Description=Check for and install ${service} updates`,
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=oneshot',
      `EnvironmentFile=-${envPath}`,
      `ExecStart=/bin/sh -c 'if [ "\${ENABLED:-true}" != "true" ]; then echo "auto-update disabled via ${envPath}"; exit 0; fi; exec ${binary} ${command} ${flags} $ARGS'`,
      'TS_CLOUD_APPUPD_SVC_EOF',
      `cat > /etc/systemd/system/${unitBase}.timer <<'TS_CLOUD_APPUPD_TMR_EOF'`,
      '[Unit]',
      `Description=Scheduled ${service} update check`,
      '',
      '[Timer]',
      `OnCalendar=${schedule}`,
      // Spread the release-API call across the window so a fleet does not
      // stampede the same endpoint at midnight, and Persistent so a box that
      // was off still checks once it is back.
      `RandomizedDelaySec=${randomizedDelay}`,
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
      'TS_CLOUD_APPUPD_TMR_EOF',
    )
    enables.push(`systemctl enable --now ${unitBase}.timer`)
  }

  if (enables.length === 0)
    return []

  return [...lines, 'systemctl daemon-reload', ...enables]
}
