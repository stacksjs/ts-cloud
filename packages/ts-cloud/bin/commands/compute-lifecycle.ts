import type { CLI } from '@stacksjs/clapp'
import { resolveCloudProvider } from '@ts-cloud/core'
import * as cli from '../../src/utils/cli'
import { createCloudDriver } from '../../src/drivers'
import { loadValidatedConfig } from './shared'

/**
 * Lifecycle commands for the lightweight single-server (Forge-style) compute
 * provisioned by `cloud deploy` when `compute.mode: 'server'`.
 */
export function registerComputeLifecycleCommands(app: CLI): void {
  app
    .command('destroy', 'Destroy the single-server compute (instance + firewall)')
    .option('--env <env>', 'Environment', { default: 'production' })
    .option('--force', 'Skip the confirmation prompt')
    .action(async (options?: { env?: string, force?: boolean }) => {
      cli.header('Destroy Compute')
      const config = await loadValidatedConfig()
      const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
      const provider = resolveCloudProvider(config)
      const driver = createCloudDriver({ config, provider })

      if (!driver.destroyCompute) {
        cli.error(`The ${provider} driver does not support compute teardown`)
        return
      }

      cli.warn(`This terminates the ${provider} server for ${config.project.slug}/${environment} and deletes its firewall.`)
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
        if (destroyed.length > 0)
          destroyed.forEach(d => cli.info(`  removed ${d}`))
        else
          cli.info('Nothing to destroy (no matching resources found)')
      }
      catch (error: any) {
        spinner.fail('Teardown failed')
        cli.error(error.message)
      }
    })
}
