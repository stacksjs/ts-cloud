/**
 * Generate the per-site runtime services for a server-app box: queue workers
 * (systemd), the app scheduler (cron), and arbitrary daemons (systemd).
 * Reconciled on every deploy so units track the config — units no longer in the
 * config are stopped and removed.
 *
 * HOW the scheduler + queue workers are invoked (Stacks/Bun vs Laravel/PHP) is
 * delegated to an {@link AppFrameworkDriver} selected by `site.framework`
 * (Stacks-first default). This file only owns unit/cron plumbing + pruning.
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
import type { SiteConfig } from '@ts-cloud/core'
import { getAppFrameworkDriver, resolveSiteFramework } from './app-frameworks'

export interface SiteServicesOptions {
  slug: string
  siteName: string
  site: SiteConfig
  /** PHP version selecting the `phpX.Y` binary (Laravel only). @default '8.3' */
  phpVersion?: string
  /** Site base dir. @default `/var/www/<siteName>` */
  appBase?: string
}

/** Escape a string for safe use inside a POSIX/ERE regex character context. */
function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Single-quote a value for safe embedding in a cron command (e.g. a URL). */
function cronQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/** Lowercase-kebab slug for embedding a free-form name in a unit filename. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  )
}

export function queueUnitName(slug: string, siteName: string, index: number): string {
  return `${slug}-${siteName}-queue-${index}`
}

export function daemonUnitName(
  slug: string,
  siteName: string,
  daemon: { name?: string; command: string },
  index: number,
): string {
  return `${slug}-${siteName}-daemon-${daemon.name ? slugify(daemon.name) : slugify(daemon.command).slice(0, 32) || String(index)}`
}

/** A systemd unit file body. */
function systemdUnit(opts: {
  description: string
  workingDir: string
  execStart: string
  restart?: string
  stopWaitSecs?: number
  user?: string
  environment?: Record<string, string>
}): string {
  const lines = [
    '[Unit]',
    `Description=${opts.description}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${opts.workingDir}`,
    ...Object.entries(opts.environment ?? {}).map(([k, v]) => `Environment="${k}=${v}"`),
    `ExecStart=${opts.execStart}`,
    `Restart=${opts.restart || 'always'}`,
    'RestartSec=5',
  ]
  if (opts.user) lines.push(`User=${opts.user}`)
  if (typeof opts.stopWaitSecs === 'number') lines.push(`TimeoutStopSec=${opts.stopWaitSecs}`)
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
  const base = options.appBase ?? `/var/www/${siteName}`
  const current = `${base}/current`
  const driver = getAppFrameworkDriver(resolveSiteFramework(site))
  const ctx = { current }

  const out: string[] = []
  const desiredUnits: string[] = []

  // Queue workers — one systemd unit per process. The framework driver builds
  // the worker command; the driver's exec wrapper supplies its runtime env.
  const queues = site.queues || []
  queues.forEach((worker, qIndex) => {
    const processes = Math.max(1, worker.processes ?? 1)
    for (let p = 0; p < processes; p++) {
      const name = queueUnitName(slug, siteName, desiredUnits.length)
      desiredUnits.push(name)
      out.push(
        ...writeUnitScript(
          name,
          systemdUnit({
            description: `${siteName} queue worker ${qIndex}.${p} (managed by ts-cloud)`,
            workingDir: current,
            execStart: driver.wrapExec(driver.queueWorkerCommand(worker, ctx)),
            environment: driver.execEnv,
            stopWaitSecs: worker.stopWaitSecs ?? 90,
          }),
        ),
      )
    }
  })

  // Daemons — one systemd unit per process, run under the framework's env.
  const daemons = site.daemons || []
  daemons.forEach((daemon, dIndex) => {
    const processes = Math.max(1, daemon.processes ?? 1)
    for (let p = 0; p < processes; p++) {
      const name = `${daemonUnitName(slug, siteName, daemon, dIndex)}-${p}`
      desiredUnits.push(name)
      out.push(
        ...writeUnitScript(
          name,
          systemdUnit({
            description: `${siteName} daemon ${daemon.name || daemon.command} (managed by ts-cloud)`,
            workingDir: daemon.directory || current,
            execStart: driver.wrapExec(daemon.command),
            environment: driver.execEnv,
            restart: daemon.restart,
            user: daemon.user,
          }),
        ),
      )
    }
  })

  // Scheduler. Stacks-style (`schedulerMode: 'daemon'`) is a single always-on
  // unit — `buddy schedule:run` holds in-process timers, so running it from cron
  // would spawn a new long-lived process every minute. Laravel-style (`'cron'`)
  // is emitted as a cron.d entry below instead.
  const scheduler = site.scheduler
  const schedulerEnabled = scheduler === true || (typeof scheduler === 'object' && scheduler !== null)
  const schedulerUnit = `${slug}-${siteName}-scheduler`
  if (schedulerEnabled && driver.schedulerMode === 'daemon') {
    desiredUnits.push(schedulerUnit)
    out.push(
      ...writeUnitScript(
        schedulerUnit,
        systemdUnit({
          description: `${siteName} scheduler (managed by ts-cloud)`,
          workingDir: current,
          execStart: driver.wrapExec(driver.schedulerCommand(ctx)),
          environment: driver.execEnv,
        }),
      ),
    )
  }

  // Prune systemd units for this site that are no longer desired, then reload
  // and (re)start the desired set.
  const desiredList = desiredUnits.map((n) => `${n}.service`).join(' ')
  out.push(
    'systemctl daemon-reload',
    `TS_CLOUD_DESIRED="${desiredList}"`,
    // Escape regex metachars in slug/siteName and anchor to `.service` so a
    // sibling site whose name is a prefix (e.g. `app` vs `app-admin`) or a slug
    // with a `.`/`+` doesn't over-match and prune another site's units.
    `for unit in $(ls /etc/systemd/system/ 2>/dev/null | grep -E '^${reEscape(slug)}-${reEscape(siteName)}-((queue|daemon)-.*|scheduler)\\.service$' || true); do`,
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

  // Laravel-style scheduler: a cron.d entry running `schedule:run` every minute.
  // A heartbeat URL (healthchecks.io / Oh Dear style) is pinged only after a
  // successful run so the monitor alerts if the scheduler stops. Any stale cron
  // is removed when the scheduler is off or runs as a daemon (handled above).
  const cronPath = schedulerCronPath(slug, siteName)
  if (schedulerEnabled && driver.schedulerMode === 'cron') {
    const heartbeat = typeof scheduler === 'object' && scheduler !== null ? scheduler : undefined
    let command = `${driver.schedulerCommand(ctx)} >> /dev/null 2>&1`
    if (heartbeat?.heartbeatUrl) {
      const method = heartbeat.heartbeatMethod || 'GET'
      const methodFlag = method === 'GET' ? '' : `-X ${method} `
      // Ping only on success (&&); -f fails on HTTP errors, -m caps the request.
      command += ` && curl -fsS -m 10 ${methodFlag}${cronQuote(heartbeat.heartbeatUrl)} >/dev/null 2>&1`
    }
    // cron treats `%` as a newline in the command field — escape any in the URL.
    const cron = `* * * * * root ${command}\n`.replace(/%/g, '\\%')
    out.push(
      `cat > ${cronPath} <<'TS_CLOUD_CRON_EOF'`,
      cron.replace(/\n$/, ''),
      'TS_CLOUD_CRON_EOF',
      `chmod 644 ${cronPath}`,
    )
  } else {
    out.push(`rm -f ${cronPath}`)
  }

  return out
}

/** Whether a site declares any runtime services (avoids emitting an empty reconcile). */
export function siteHasServices(site: SiteConfig): boolean {
  return !!(site.queues?.length || site.daemons?.length || site.scheduler)
}
