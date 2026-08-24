import type { CLI } from '@stacksjs/clapp'
import type { CloudDriver, EnvironmentType } from '@ts-cloud/core'
import { resolveCloudProvider, resolveProjectStackName } from '@ts-cloud/core'
import * as cli from '../../src/utils/cli'
import { createCloudDriver } from '../../src/drivers'
import { buildDrainedSiteScanScript, formatDrainedSiteRefusal, parseDrainedSites } from '../../src/operations/drained-sites'
import { loadValidatedConfig } from './shared'

/** The flag that authorizes discarding a drained site's files. */
const DISCARD_FLAG = '--discard-drained-sites'

/**
 * Refuse a teardown that would take a moved site's rollback with it.
 *
 * Returns true when the destroy may proceed. Deliberately permissive about its
 * own failure: a box that cannot be reached, or a driver that cannot run remote
 * commands, produces a note rather than a block — this exists to stop a specific
 * silent loss, not to stand between an operator and an unreachable server they
 * are trying to get rid of.
 */
async function drainedSitesAllowTeardown(
  driver: CloudDriver,
  config: Awaited<ReturnType<typeof loadValidatedConfig>>,
  environment: EnvironmentType,
  discard: boolean,
): Promise<boolean> {
  if (discard) return true

  const slug = config.project.slug
  let output: string | undefined
  try {
    const targets = await driver.findComputeTargets({
      slug,
      environment,
      role: 'app',
      stackName: resolveProjectStackName(config, environment),
    })
    if (targets.length === 0) return true

    const result = await driver.runRemoteDeploy({
      targets,
      commands: buildDrainedSiteScanScript(slug),
      comment: `ts-cloud scan drained sites ${slug}`,
      tags: { Project: slug, Environment: environment, Role: 'app' },
    })
    if (!result.success) {
      cli.warn(`Could not check the server for moved-off site files: ${result.error || 'unknown error'}`)
      return true
    }
    output = result.perInstance.map((instance) => instance.output ?? '').join('\n')
  } catch (error) {
    cli.warn(`Could not check the server for moved-off site files: ${error instanceof Error ? error.message : String(error)}`)
    return true
  }

  const drained = parseDrainedSites(output)
  if (drained.length === 0) return true

  cli.error(formatDrainedSiteRefusal(drained, slug, DISCARD_FLAG))
  return false
}

/**
 * Lifecycle commands for the lightweight single-server (Forge-style) compute
 * provisioned by `cloud deploy` when `compute.mode: 'server'`.
 */
export function registerComputeLifecycleCommands(app: CLI): void {
  app
    .command('destroy', 'Destroy the single-server compute (instance + firewall)')
    .option('--env <env>', 'Environment', { default: 'production' })
    .option('--force', 'Skip the confirmation prompt')
    .option('--discard-drained-sites', 'Destroy even though a moved site left its rollback files here')
    .action(async (options?: { env?: string; force?: boolean; discardDrainedSites?: boolean }) => {
      cli.header('Destroy Compute')
      const config = await loadValidatedConfig()
      const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
      const provider = resolveCloudProvider(config)
      const driver = createCloudDriver({ config, provider })

      if (!driver.destroyCompute) {
        cli.error(`The ${provider} driver does not support compute teardown`)
        return
      }

      cli.warn(
        `This terminates the ${provider} server for ${config.project.slug}/${environment} and deletes its firewall.`,
      )

      // Checked BEFORE the prompt: an operator answering "yes" to a generic
      // irreversibility warning has not been told that a moved site's rollback
      // is sitting on this disk.
      if (!(await drainedSitesAllowTeardown(driver, config, environment, !!options?.discardDrainedSites))) {
        process.exitCode = 1
        return
      }

      if (!options?.force) {
        const ok = await cli.confirm('This is irreversible. Continue?', false)
        if (!ok) {
          cli.info('Cancelled')
          return
        }
      }

      const spinner = new cli.Spinner('Destroying compute...')
      spinner.start()
      try {
        const { destroyed } = await driver.destroyCompute({ config, environment })
        spinner.succeed('Compute destroyed')
        if (destroyed.length > 0) destroyed.forEach((d) => cli.info(`  removed ${d}`))
        else cli.info('Nothing to destroy (no matching resources found)')
      } catch (error: unknown) {
        spinner.fail('Teardown failed')
        cli.error(error instanceof Error ? error.message : String(error))
      }
    })
}
