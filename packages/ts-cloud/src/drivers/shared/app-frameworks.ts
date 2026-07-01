/**
 * App-framework drivers.
 *
 * ts-cloud runs a site's background work — the scheduler, queue workers, and
 * daemons — as systemd units / cron on the box. HOW those are invoked differs
 * per app framework: Stacks (Bun, `buddy …`) vs Laravel (PHP, `artisan …`), and
 * the runtime environment a systemd/cron process needs differs too (bun on PATH
 * vs pantry's php env). This module isolates those differences behind one small
 * driver so the reconciler (`app-services.ts`) stays framework-agnostic.
 *
 * Stacks-first: `getAppFrameworkDriver()` defaults to the Stacks driver.
 */
import type { QueueWorkerConfig, SiteConfig } from '@ts-cloud/core'
import { PANTRY_PROJECT_DIR } from './package-manager'

export type FrameworkId = 'stacks' | 'laravel'

/** PHP-oriented site `type`s that imply the Laravel/PHP driver. */
const PHP_SITE_TYPES = new Set(['laravel', 'php', 'statamic', 'wordpress'])

/**
 * Resolve which framework driver a site uses. An explicit `framework` wins; a
 * PHP-oriented `type` (laravel/php/statamic/wordpress) implies Laravel for
 * backward compatibility; everything else uses the Stacks-first default.
 */
export function resolveSiteFramework(site: Pick<SiteConfig, 'framework' | 'type'>): FrameworkId {
  if (site.framework)
    return site.framework
  if (site.type && PHP_SITE_TYPES.has(site.type))
    return 'laravel'
  return 'stacks'
}

export interface FrameworkExecContext {
  /** The active-release directory (`/var/www/<site>/current`). */
  current: string
}

export interface AppFrameworkDriver {
  readonly id: FrameworkId
  /**
   * Wrap a command for a systemd unit / cron entry. Prefer a BARE command +
   * {@link AppFrameworkDriver.execEnv} (like the app's own service) so starting
   * a long-lived unit over SSH doesn't hold the deploy channel open; only wrap
   * in a shell when the env must be computed at runtime (e.g. Laravel/pantry).
   */
  wrapExec: (command: string) => string
  /** Static `Environment=` vars for a unit (systemd inherits no shell env). */
  readonly execEnv?: Record<string, string>
  /**
   * How the app scheduler runs:
   *  - `'cron'`   → `schedule:run` is one-shot; run it every minute via cron (Laravel).
   *  - `'daemon'` → `schedule:run` is long-lived (holds in-process timers); run it
   *                 as a single always-on systemd unit (Stacks).
   */
  readonly schedulerMode: 'cron' | 'daemon'
  /**
   * The scheduler command WITHOUT output redirection. For `'cron'` it is run
   * from cron and sets up its own cwd/env; for `'daemon'` it becomes a unit's
   * ExecStart (systemd supplies WorkingDirectory), so no `cd` is needed.
   */
  schedulerCommand: (ctx: FrameworkExecContext) => string
  /** `ExecStart` for a single queue-worker process. */
  queueWorkerCommand: (worker: QueueWorkerConfig, ctx: FrameworkExecContext) => string
}

/** Loads pantry's env (PATH + LD_LIBRARY_PATH) so bare `php`/`composer` resolve. */
const PANTRY_ENV_EVAL = `eval "$(cd ${PANTRY_PROJECT_DIR} && pantry env 2>/dev/null)"`

/** The ts-cloud-installed bun (see ubuntu-bootstrap) + the Stacks CLI entry. */
const BUN_BIN = '/usr/local/bin/bun'
const STACKS_CLI = 'storage/framework/core/buddy/src/cli.ts'

/**
 * Stacks (Bun) — the default. bun lives at an absolute path installed by the box
 * bootstrap, so units use a BARE ExecStart (no shell wrapper) + `Environment=`
 * for PATH/BUN_INSTALL — matching the app's own service. This matters: wrapping
 * a long-lived unit in `/bin/sh -lc` makes `systemctl restart` over SSH hold the
 * deploy channel open and hang the deploy.
 */
export const stacksDriver: AppFrameworkDriver = {
  id: 'stacks',
  wrapExec: command => command,
  execEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', BUN_INSTALL: '/root/.bun' },
  // `buddy schedule:run` stays alive (in-process timers) → one always-on unit.
  // systemd sets WorkingDirectory to the release dir, so the CLI path is relative.
  schedulerMode: 'daemon',
  schedulerCommand: () => `${BUN_BIN} ${STACKS_CLI} schedule:run`,
  queueWorkerCommand: (worker, { current }) => {
    const flags = [
      `--queue=${worker.queue || 'default'}`,
      `--sleep=${worker.sleep ?? 3}`,
      `--tries=${worker.tries ?? 3}`,
      `--timeout=${worker.timeout ?? 60}`,
    ]
    return `${BUN_BIN} ${current}/${STACKS_CLI} queue:work ${flags.join(' ')}`
  },
}

/** Laravel (PHP / Artisan) — the original Forge-style behavior, now a driver. */
export const laravelDriver: AppFrameworkDriver = {
  id: 'laravel',
  wrapExec: command => `/bin/sh -lc '${PANTRY_ENV_EVAL}; exec ${command}'`,
  // `php artisan schedule:run` is one-shot → run it every minute from cron.
  schedulerMode: 'cron',
  schedulerCommand: ({ current }) => `cd ${current} && ${PANTRY_ENV_EVAL} && php artisan schedule:run`,
  queueWorkerCommand: (worker, { current }) => {
    const artisan = `${current}/artisan`
    if (worker.horizon)
      return `php ${artisan} horizon`
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
    return `php ${artisan} queue:work ${flags.join(' ')}`
  },
}

const DRIVERS: Record<FrameworkId, AppFrameworkDriver> = {
  stacks: stacksDriver,
  laravel: laravelDriver,
}

/** Resolve the app-framework driver for a site. Stacks-first default. */
export function getAppFrameworkDriver(framework?: FrameworkId): AppFrameworkDriver {
  return DRIVERS[framework as FrameworkId] ?? stacksDriver
}
