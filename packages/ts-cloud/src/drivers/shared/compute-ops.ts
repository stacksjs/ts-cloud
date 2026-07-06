/**
 * Forge-style operational commands for a provisioned compute fleet, run over
 * the active driver (SSH/SSM): roll a site back to a previous release, read a
 * site's deployment history, and run a reusable server recipe across servers.
 *
 * Each finds the project's targets via the driver, builds a small shell script
 * with the shared generators, and runs it on every box — mirroring how
 * {@link import('./compute-deploy').deploySiteRelease} drives a deploy.
 */
import type { CloudDriver, DatabaseConfig, EnvironmentType, RemoteDeployInstanceResult } from '@ts-cloud/core'
import { buildBackupRestoreScript } from './backups'
import { PANTRY_PROJECT_DIR } from './package-manager'
import { buildRollbackScript, deployHistoryPath, releasePaths } from './releases'
import { buildServerRecipeScript } from './server-recipes'

export interface ComputeOpsLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  step(message: string): void
  success(message: string): void
}

const noopLogger: ComputeOpsLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  step: () => {},
  success: () => {},
}

export interface ComputeOpsContext {
  driver: CloudDriver
  slug: string
  environment: EnvironmentType
  /** Target role label. @default 'app' */
  role?: string
  logger?: ComputeOpsLogger
}

export interface ComputeOpsResult {
  success: boolean
  error?: string
  perInstance?: RemoteDeployInstanceResult[]
}

/** Resolve targets for an op, returning a clear error when the fleet is empty. */
async function findTargets(ctx: ComputeOpsContext) {
  const targets = await ctx.driver.findComputeTargets({
    slug: ctx.slug,
    environment: ctx.environment,
    role: ctx.role || 'app',
  })
  return targets
}

/**
 * Roll a site back to a previous release (Forge-style). With `to`, points
 * `current` at `releases/<to>`; otherwise the most recent prior release. After
 * flipping the symlink, php-fpm is restarted and queue workers are signalled so
 * they pick up the rolled-back code.
 */
export async function rollbackComputeSite(
  ctx: ComputeOpsContext,
  options: { siteName: string, to?: string },
): Promise<ComputeOpsResult> {
  const logger = ctx.logger || noopLogger
  const targets = await findTargets(ctx)
  if (targets.length === 0)
    return { success: false, error: `No '${ctx.role || 'app'}' servers found for ${ctx.slug}/${ctx.environment}.` }

  const appBase = `/var/www/${options.siteName}`
  const paths = releasePaths(appBase, options.to || 'unused')
  const commands = [
    'set -uo pipefail',
    // unitBase lets the rollback swap the running templated release instance
    // (zero-downtime layout); legacy single-unit sites just get a restart.
    ...buildRollbackScript(paths, { ...(options.to ? { to: options.to } : {}), unitBase: `${ctx.slug}-${options.siteName}` }),
    // Pick up the rolled-back code: restart php-fpm + signal queue workers.
    `(cd ${PANTRY_PROJECT_DIR} && pantry restart php-fpm) 2>/dev/null || true`,
    `(cd ${paths.current} && eval "$(cd ${PANTRY_PROJECT_DIR} && pantry env 2>/dev/null)" && php artisan queue:restart) 2>/dev/null || true`,
  ]

  logger.step(`Rolling back ${options.siteName}${options.to ? ` to ${options.to}` : ' to the previous release'} on ${targets.length} server(s)...`)
  const result = await ctx.driver.runRemoteDeploy({
    targets,
    commands,
    comment: `ts-cloud rollback ${ctx.slug}/${options.siteName}`,
    tags: { Project: ctx.slug, Environment: ctx.environment, Role: ctx.role || 'app' },
  })
  if (!result.success)
    logger.error(`Rollback failed: ${result.error || 'unknown error'}`)
  else
    logger.success(`Rolled back ${options.siteName}.`)
  return { success: result.success, error: result.error, perInstance: result.perInstance }
}

/**
 * Read a site's on-box deployment history (the log written by
 * {@link import('./releases').buildDeployHistoryHeader}). Returns the per-server
 * output so the caller can print the most recent deploys.
 */
export async function getComputeDeployHistory(
  ctx: ComputeOpsContext,
  options: { siteName: string, limit?: number },
): Promise<ComputeOpsResult> {
  const targets = await findTargets(ctx)
  if (targets.length === 0)
    return { success: false, error: `No '${ctx.role || 'app'}' servers found for ${ctx.slug}/${ctx.environment}.` }

  const history = deployHistoryPath(`/var/www/${options.siteName}`)
  const limit = Math.max(1, options.limit ?? 20)
  const commands = [
    `[ -f ${history} ] && tail -n ${limit} ${history} || echo "no deploy history for ${options.siteName}"`,
  ]
  const result = await ctx.driver.runRemoteDeploy({
    targets,
    commands,
    comment: `ts-cloud deploy:history ${ctx.slug}/${options.siteName}`,
    tags: { Project: ctx.slug, Environment: ctx.environment, Role: ctx.role || 'app' },
  })
  return { success: result.success, error: result.error, perInstance: result.perInstance }
}

/**
 * Run a reusable server recipe (a bash script) across the project's servers as
 * a chosen user (Forge's Recipes). The recipe runs through a login shell so
 * pantry's env is loaded; output is captured per server.
 */
export async function runComputeRecipe(
  ctx: ComputeOpsContext,
  options: { name: string, script: string[], user?: string },
): Promise<ComputeOpsResult> {
  const logger = ctx.logger || noopLogger
  const targets = await findTargets(ctx)
  if (targets.length === 0)
    return { success: false, error: `No '${ctx.role || 'app'}' servers found for ${ctx.slug}/${ctx.environment}.` }

  logger.step(`Running recipe '${options.name}' as ${options.user || 'root'} on ${targets.length} server(s)...`)
  const result = await ctx.driver.runRemoteDeploy({
    targets,
    commands: buildServerRecipeScript({ name: options.name, script: options.script, user: options.user }),
    comment: `ts-cloud recipe ${options.name}`,
    tags: { Project: ctx.slug, Environment: ctx.environment, Role: ctx.role || 'app' },
  })
  if (!result.success)
    logger.error(`Recipe '${options.name}' failed: ${result.error || 'unknown error'}`)
  else
    logger.success(`Recipe '${options.name}' completed.`)
  return { success: result.success, error: result.error, perInstance: result.perInstance }
}

/**
 * Restore a database from a ts-backups dump on the box (Forge's backup restore).
 * Runs the restore on the project's servers; with no `from`, the newest matching
 * dump is used. Returns per-server output.
 */
export async function restoreDatabaseBackup(
  ctx: ComputeOpsContext,
  options: { database: DatabaseConfig | undefined, from?: string },
): Promise<ComputeOpsResult> {
  const logger = ctx.logger || noopLogger
  if (!options.database?.name)
    return { success: false, error: 'No appDatabase configured to restore.' }
  const targets = await findTargets(ctx)
  if (targets.length === 0)
    return { success: false, error: `No '${ctx.role || 'app'}' servers found for ${ctx.slug}/${ctx.environment}.` }

  logger.step(`Restoring database '${options.database.name}'${options.from ? ` from ${options.from}` : ' from the latest backup'} on ${targets.length} server(s)...`)
  const result = await ctx.driver.runRemoteDeploy({
    targets,
    commands: buildBackupRestoreScript(options.database, { from: options.from }),
    comment: `ts-cloud db:restore ${ctx.slug}/${options.database.name}`,
    tags: { Project: ctx.slug, Environment: ctx.environment, Role: ctx.role || 'app' },
  })
  if (!result.success)
    logger.error(`Restore failed: ${result.error || 'unknown error'}`)
  else
    logger.success(`Restored ${options.database.name}.`)
  return { success: result.success, error: result.error, perInstance: result.perInstance }
}
