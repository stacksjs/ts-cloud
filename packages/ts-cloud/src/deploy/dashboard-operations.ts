/**
 * Generalized server operations for the management cockpit: service lifecycle
 * (restart/reload/start/stop/enable/disable), deployment rollback, scheduled
 * backup run + database restore, worker restart, and scheduler run-now.
 *
 * The catalog is derived purely from the cloud config + live server data (so it
 * is trivially unit-testable); the runner dispatches each operation over the
 * active driver (SSH/SSM), reusing the shared compute-ops builders.
 */
import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { createCloudDriver } from '../drivers'
import { BACKUP_RUNNER_PATH } from '../drivers/shared/backups'
import { restoreDatabaseBackup, rollbackComputeSite } from '../drivers/shared/compute-ops'
import { PANTRY_PROJECT_DIR } from '../drivers/shared/package-manager'
import { resolveSiteKind } from './site-target'

const SERVICE_VERBS = ['restart', 'reload', 'start', 'stop', 'enable', 'disable'] as const
type ServiceVerb = (typeof SERVICE_VERBS)[number]

export type OperationGroup = 'service' | 'deploy' | 'backup' | 'worker' | 'scheduler'

export interface DashboardOperation {
  id: string
  label: string
  group: OperationGroup
  target: string
  mutates: boolean
  /** Token the operator must type to run a mutating operation. */
  confirm: string
  /** Destructive operations rendered with a danger affordance. */
  danger?: boolean
}

export interface DashboardOperationResult {
  operation: string
  command?: string
  ok: boolean
  stdout?: string
  stderr?: string
  error?: string
}

const MAX_OUTPUT_BYTES = 64 * 1024

function clampOutput(output: string): string {
  return output.length <= MAX_OUTPUT_BYTES ? output : `${output.slice(0, MAX_OUTPUT_BYTES)}\n\n[output truncated]`
}

/** Guard systemd unit names so an operation id can never inject shell. */
export function isSafeSystemdUnit(value: string): boolean {
  return /^[A-Za-z0-9_.@:-]+$/.test(value)
}

function isSafeSiteName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Build the full operation catalog from config + live server data. Pure: every
 * operation that appears here is runnable by {@link runDashboardOperation}.
 */
export function buildDashboardOperations(config: CloudConfig, data: Record<string, any>): DashboardOperation[] {
  const ops: DashboardOperation[] = []

  // Service lifecycle for each reported (and shell-safe) unit.
  const services = data.servicesDetail ?? data.services ?? []
  for (const service of services) {
    const name = String(service?.name ?? '')
    if (!name || !isSafeSystemdUnit(name))
      continue
    for (const verb of SERVICE_VERBS) {
      ops.push({
        id: `${verb}:${name}`,
        label: `${capitalize(verb)} ${name}`,
        group: 'service',
        target: name,
        mutates: true,
        confirm: name,
        danger: verb === 'stop' || verb === 'disable',
      })
    }
  }

  // Rollback for release-based sites (server-app / server-php keep releases/).
  for (const [name, site] of Object.entries(config.sites ?? {})) {
    if (!site || !isSafeSiteName(name))
      continue
    const kind = resolveSiteKind(site)
    if (kind === 'server-app' || kind === 'server-php')
      ops.push({ id: `rollback:${name}`, label: `Rollback ${name}`, group: 'deploy', target: name, mutates: true, confirm: name, danger: true })
  }

  // Worker restart (graceful queue:restart) per site that runs workers.
  const workerSites = new Set<string>()
  for (const worker of data.workers ?? []) {
    const site = String(worker?.name ?? '').split(':')[0]
    if (site && isSafeSiteName(site))
      workerSites.add(site)
  }
  for (const site of workerSites)
    ops.push({ id: `worker:restart:${site}`, label: `Restart workers (${site})`, group: 'worker', target: site, mutates: true, confirm: site })

  // Scheduler run-now per site that declares a scheduler.
  for (const [name, site] of Object.entries(config.sites ?? {})) {
    if (!site || !isSafeSiteName(name))
      continue
    if ((site as any).scheduler || (site as any).schedule)
      ops.push({ id: `scheduler:run:${name}`, label: `Run scheduler (${name})`, group: 'scheduler', target: name, mutates: true, confirm: name })
  }

  // Backups: run-now always when scheduled backups are configured; restore only
  // when there is an app database to restore into.
  const backups = (config.infrastructure?.compute as any)?.backups
  if (backups?.enabled) {
    ops.push({ id: 'backup:run', label: 'Run backup now', group: 'backup', target: 'backup', mutates: true, confirm: 'backup' })
    if (config.infrastructure?.appDatabase)
      ops.push({ id: 'backup:restore', label: 'Restore latest DB backup', group: 'backup', target: 'database', mutates: true, confirm: 'restore', danger: true })
  }

  return ops
}

export function resolveDashboardOperation(id: string, config: CloudConfig, data: Record<string, any>): DashboardOperation | undefined {
  return buildDashboardOperations(config, data).find(op => op.id === id)
}

function serviceCommand(verb: ServiceVerb, target: string): string[] {
  const check = verb === 'enable' || verb === 'disable'
    ? `systemctl is-enabled ${target} 2>/dev/null || true`
    : `systemctl is-active ${target} 2>/dev/null || true`
  return ['set -o pipefail', `systemctl ${verb} ${target}`, check]
}

function pantryEnvEval(): string {
  return `eval "$(cd ${PANTRY_PROJECT_DIR} && pantry env 2>/dev/null)"`
}

function siteArtisanCommand(site: string, artisan: string): string[] {
  const current = `/var/www/${site}/current`
  return [
    'set -uo pipefail',
    `[ -d ${current} ] || { echo "site ${site} has no current release" >&2; exit 1; }`,
    `cd ${current} && ${pantryEnvEval()} && php artisan ${artisan}`,
  ]
}

function backupRunCommand(): string[] {
  return [
    'set -uo pipefail',
    `[ -x ${BACKUP_RUNNER_PATH} ] || { echo "scheduled backups are not provisioned on this server" >&2; exit 1; }`,
    BACKUP_RUNNER_PATH,
  ]
}

function fromComputeOps(id: string, command: string, r: { success: boolean, error?: string, perInstance?: Array<{ output?: string, error?: string }> }): DashboardOperationResult {
  return {
    operation: id,
    command,
    ok: r.success,
    stdout: clampOutput(r.perInstance?.[0]?.output ?? ''),
    stderr: clampOutput(r.perInstance?.[0]?.error ?? r.error ?? ''),
  }
}

/**
 * Run an operation over the active driver. Rollback + DB restore delegate to the
 * shared compute-ops; the rest run a single bounded remote script on the app
 * target. Returns a structured result (never throws on a remote failure).
 */
export interface RunOperationOptions {
  /** For rollback: the release id to roll back to (omit for the previous release). */
  to?: string
}

export async function runDashboardOperation(
  config: CloudConfig,
  environment: EnvironmentType,
  operation: DashboardOperation,
  options: RunOperationOptions = {},
): Promise<DashboardOperationResult> {
  const slug = config.project.slug
  let driver: ReturnType<typeof createCloudDriver>
  try {
    driver = createCloudDriver({ config })
  }
  catch (error: any) {
    return { operation: operation.id, ok: false, error: `Could not initialize the cloud driver: ${error?.message ?? error}` }
  }

  const ctx = { driver, slug, environment, role: 'app' as const }

  if (operation.group === 'deploy') {
    const to = options.to && /^[A-Za-z0-9._-]+$/.test(options.to) ? options.to : undefined
    const r = await rollbackComputeSite(ctx, { siteName: operation.target, to })
    return fromComputeOps(operation.id, `rollback ${operation.target}${to ? ` → ${to}` : ''}`, r)
  }
  if (operation.id === 'backup:restore') {
    const r = await restoreDatabaseBackup(ctx, { database: config.infrastructure?.appDatabase })
    return fromComputeOps(operation.id, 'db restore', r)
  }

  const targets = await driver.findComputeTargets({ slug, environment, role: 'app' })
  if (!targets.length)
    return { operation: operation.id, ok: false, error: 'No app server target was found for this environment.' }

  let commands: string[]
  let command: string
  if (operation.group === 'service') {
    const [verb, ...rest] = operation.id.split(':')
    commands = serviceCommand(verb as ServiceVerb, rest.join(':'))
    command = `systemctl ${verb} ${operation.target}`
  }
  else if (operation.group === 'worker') {
    commands = siteArtisanCommand(operation.target, 'queue:restart')
    command = `queue:restart (${operation.target})`
  }
  else if (operation.group === 'scheduler') {
    commands = siteArtisanCommand(operation.target, 'schedule:run')
    command = `schedule:run (${operation.target})`
  }
  else if (operation.id === 'backup:run') {
    commands = backupRunCommand()
    command = 'ts-cloud backup'
  }
  else {
    return { operation: operation.id, ok: false, error: 'Unknown operation.' }
  }

  const result = await driver.runRemoteDeploy({
    targets: [targets[0]],
    commands,
    comment: `ts-cloud dashboard:${operation.id}`,
    tags: { Project: slug, Environment: environment, Role: 'app' },
  })
  return {
    operation: operation.id,
    command,
    ok: result.success,
    stdout: clampOutput(result.perInstance?.[0]?.output ?? ''),
    stderr: clampOutput(result.perInstance?.[0]?.error ?? result.error ?? ''),
  }
}
