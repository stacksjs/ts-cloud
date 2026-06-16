/**
 * Generate the per-site runtime services for a Forge-style PHP box: queue
 * workers / Horizon (systemd), the Laravel scheduler (cron), and arbitrary
 * daemons (systemd). Reconciled on every deploy so units track the config —
 * units no longer in the config are stopped and removed.
 *
 * Unit naming (so a site's units can be globbed for pruning):
 *   <slug>-<site>-queue-<i>.service
 *   <slug>-<site>-daemon-<slug-of-name>.service
 * Scheduler cron lives at /etc/cron.d/<slug>-<site>-scheduler.
 *
 * ExecStart commands target `<base>/current/...` (the active-release symlink),
 * so workers/daemons always run the live code; `queue:restart` (run by the
 * deploy's $RESTART_QUEUES macro) cycles them onto the new release.
 */
import type { DaemonConfig, QueueWorkerConfig, SiteConfig } from '@ts-cloud/core'
import { PANTRY_PROJECT_DIR } from './package-manager'

/** Shell that loads pantry's env (PATH + LD_LIBRARY_PATH) for php/composer. */
const PANTRY_ENV_EVAL = `eval "$(cd ${PANTRY_PROJECT_DIR} && pantry env 2>/dev/null)"`

/**
 * Wrap a command so a systemd unit / cron runs it inside pantry's environment
 * (php + its shared libs on PATH/LD_LIBRARY_PATH). systemd units have no shell
 * env, so the bare `php` and its libs are otherwise unresolved.
 */
function pantryExec(cmd: string): string {
  return `/bin/sh -lc '${PANTRY_ENV_EVAL}; exec ${cmd}'`
}

export interface SiteServicesOptions {
  slug: string
  siteName: string
  site: SiteConfig
  /** PHP version selecting the `phpX.Y` binary. @default '8.3' */
  phpVersion?: string
  /** Site base dir. @default `/var/www/<siteName>` */
  appBase?: string
}

/** Escape a string for safe use inside a POSIX/ERE regex character context. */
function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Lowercase-kebab slug for embedding a free-form name in a unit filename. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}

export function queueUnitName(slug: string, siteName: string, index: number): string {
  return `${slug}-${siteName}-queue-${index}`
}

export function daemonUnitName(slug: string, siteName: string, daemon: DaemonConfig, index: number): string {
  return `${slug}-${siteName}-daemon-${daemon.name ? slugify(daemon.name) : slugify(daemon.command).slice(0, 32) || String(index)}`
}

/** Build the `artisan queue:work`/`horizon` ExecStart for a worker. */
function queueExecStart(worker: QueueWorkerConfig, phpBin: string, artisan: string): string {
  if (worker.horizon)
    return `${phpBin} ${artisan} horizon`

  const flags = [
    worker.connection || 'default',
    `--queue=${worker.queue || 'default'}`,
    `--sleep=${worker.sleep ?? 3}`,
    `--tries=${worker.tries ?? 3}`,
    `--timeout=${worker.timeout ?? 60}`,
    `--memory=${worker.memory ?? 128}`,
  ]
  if (worker.maxJobs)
    flags.push(`--max-jobs=${worker.maxJobs}`)
  if (worker.maxTime)
    flags.push(`--max-time=${worker.maxTime}`)
  return `${phpBin} ${artisan} queue:work ${flags.join(' ')}`
}

/** A systemd unit file body. */
function systemdUnit(opts: {
  description: string
  workingDir: string
  execStart: string
  restart?: string
  stopWaitSecs?: number
  user?: string
}): string {
  const lines = [
    '[Unit]',
    `Description=${opts.description}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${opts.workingDir}`,
    `ExecStart=${opts.execStart}`,
    `Restart=${opts.restart || 'always'}`,
    'RestartSec=5',
  ]
  if (opts.user)
    lines.push(`User=${opts.user}`)
  if (typeof opts.stopWaitSecs === 'number')
    lines.push(`TimeoutStopSec=${opts.stopWaitSecs}`)
  lines.push('', '[Install]', 'WantedBy=multi-user.target')
  return `${lines.join('\n')}\n`
}

/** Emit the shell that writes + (re)starts a systemd unit. */
function writeUnitScript(name: string, body: string): string[] {
  return [
    `cat > /etc/systemd/system/${name}.service <<'TS_CLOUD_UNIT_EOF'`,
    body.replace(/\n$/, ''),
    'TS_CLOUD_UNIT_EOF',
  ]
}

/** Path of the scheduler cron file for a site. */
export function schedulerCronPath(slug: string, siteName: string): string {
  return `/etc/cron.d/${slug}-${siteName}-scheduler`
}

/**
 * Build the full reconcile script: (re)write desired queue/daemon units +
 * scheduler cron, prune stale units for this site, and reload systemd.
 */
export function buildSiteServicesScript(options: SiteServicesOptions): string[] {
  const { slug, siteName, site } = options
  // pantry exposes a single `php` on PATH via `pantry env`; no versioned binary.
  const phpBin = 'php'
  const base = options.appBase ?? `/var/www/${siteName}`
  const current = `${base}/current`
  const artisan = `${current}/artisan`

  const out: string[] = []
  const desiredUnits: string[] = []

  // Queue workers — one systemd unit per process.
  const queues = site.queues || []
  queues.forEach((worker, qIndex) => {
    const processes = Math.max(1, worker.processes ?? 1)
    for (let p = 0; p < processes; p++) {
      const name = queueUnitName(slug, siteName, desiredUnits.length)
      desiredUnits.push(name)
      out.push(...writeUnitScript(name, systemdUnit({
        description: `${siteName} queue worker ${qIndex}.${p} (managed by ts-cloud)`,
        workingDir: current,
        execStart: pantryExec(queueExecStart(worker, phpBin, artisan)),
        stopWaitSecs: worker.stopWaitSecs ?? 90,
      })))
    }
  })

  // Daemons — one systemd unit per process.
  const daemons = site.daemons || []
  daemons.forEach((daemon, dIndex) => {
    const processes = Math.max(1, daemon.processes ?? 1)
    for (let p = 0; p < processes; p++) {
      const name = `${daemonUnitName(slug, siteName, daemon, dIndex)}-${p}`
      desiredUnits.push(name)
      out.push(...writeUnitScript(name, systemdUnit({
        description: `${siteName} daemon ${daemon.name || daemon.command} (managed by ts-cloud)`,
        workingDir: daemon.directory || current,
        execStart: pantryExec(daemon.command),
        restart: daemon.restart,
        user: daemon.user,
      })))
    }
  })

  // Prune systemd units for this site that are no longer desired, then reload
  // and (re)start the desired set.
  const desiredList = desiredUnits.map(n => `${n}.service`).join(' ')
  out.push(
    'systemctl daemon-reload',
    `TS_CLOUD_DESIRED="${desiredList}"`,
    // Escape regex metachars in slug/siteName and anchor to `.service` so a
    // sibling site whose name is a prefix (e.g. `app` vs `app-admin`) or a slug
    // with a `.`/`+` doesn't over-match and prune another site's units.
    `for unit in $(ls /etc/systemd/system/ 2>/dev/null | grep -E '^${reEscape(slug)}-${reEscape(siteName)}-(queue|daemon)-.*\\.service$' || true); do`,
    '  case " $TS_CLOUD_DESIRED " in',
    '    *" $unit "*) ;;',
    '    *) systemctl stop "$unit" 2>/dev/null || true; systemctl disable "$unit" 2>/dev/null || true; rm -f "/etc/systemd/system/$unit" ;;',
    '  esac',
    'done',
    'systemctl daemon-reload',
  )
  for (const name of desiredUnits) {
    out.push(`systemctl enable ${name}.service`, `systemctl restart ${name}.service`)
  }

  // Laravel scheduler — a cron.d entry running schedule:run every minute, or
  // removal of any prior entry when disabled.
  const cronPath = schedulerCronPath(slug, siteName)
  if (site.scheduler) {
    const cron = `* * * * * root cd ${current} && ${PANTRY_ENV_EVAL} && ${phpBin} artisan schedule:run >> /dev/null 2>&1\n`
    out.push(
      `cat > ${cronPath} <<'TS_CLOUD_CRON_EOF'`,
      cron.replace(/\n$/, ''),
      'TS_CLOUD_CRON_EOF',
      `chmod 644 ${cronPath}`,
    )
  }
  else {
    out.push(`rm -f ${cronPath}`)
  }

  return out
}

/** Whether a site declares any runtime services (avoids emitting an empty reconcile). */
export function siteHasServices(site: SiteConfig): boolean {
  return !!(site.queues?.length || site.daemons?.length || site.scheduler)
}
