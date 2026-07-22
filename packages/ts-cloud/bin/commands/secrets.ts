import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { SecretsManagerClient } from '../../src/aws/secrets-manager'
import { loadValidatedConfig } from './shared'

/**
 * Secrets are namespaced per project + environment (`{slug}/{env}/{key}`) so they
 * match the names the serverless deploy orchestrator resolves into Lambda env vars
 * (see ServerlessAppConfig.secrets).
 */
async function ctx(env?: string): Promise<{ region: string; prefix: string }> {
  const config = await loadValidatedConfig()
  const environment = env || 'production'
  return {
    region: config.environments?.[environment as 'production']?.region || config.project.region || 'us-east-1',
    prefix: `${config.project.slug}/${environment}`,
  }
}

export function registerSecretsCommands(app: CLI): void {
  app
    .command('secrets:list', 'List secrets for an environment')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (options?: { env?: string }) => {
      cli.header('Secrets')
      try {
        const { region, prefix } = await ctx(options?.env)
        const sm = new SecretsManagerClient(region)
        const { SecretList = [] } = await sm.listSecrets({
          Filters: [{ Key: 'name', Values: [`${prefix}/`] }],
          MaxResults: 100,
        })
        if (!SecretList.length) {
          cli.info(`No secrets found under ${prefix}/`)
          return
        }
        cli.table(
          ['Key', 'Last Changed'],
          SecretList.map((s) => [
            (s.Name ?? '').replace(`${prefix}/`, ''),
            (s as any).LastChangedDate ?? (s as any).LastAccessedDate ?? '-',
          ]),
        )
      } catch (error: any) {
        cli.error(`Failed to list secrets: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('secrets:set <key> <value>', 'Set (create or update) a secret')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (key: string, value: string, options?: { env?: string }) => {
      cli.header(`Setting secret ${key}`)
      const { region, prefix } = await ctx(options?.env)
      const sm = new SecretsManagerClient(region)
      const secretId = `${prefix}/${key}`
      const spinner = new cli.Spinner('Storing secret...')
      spinner.start()
      try {
        // Update if it exists, otherwise create.
        try {
          await sm.putSecretValue({ SecretId: secretId, SecretString: value })
        } catch {
          await sm.createSecret({ Name: secretId, SecretString: value })
        }
        spinner.succeed(`Secret ${key} stored (${secretId})`)
        cli.warn('Redeploy for the new value to take effect in running functions.')
      } catch (error: any) {
        spinner.fail(`Failed to store secret: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('secrets:get <key>', 'Reveal a secret value')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .action(async (key: string, options?: { env?: string }) => {
      try {
        const { region, prefix } = await ctx(options?.env)
        const sm = new SecretsManagerClient(region)
        const value = await sm.getSecretValue({ SecretId: `${prefix}/${key}` })
        cli.info(value.SecretString ?? '')
      } catch (error: any) {
        cli.error(`Failed to read secret: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('secrets:delete <key>', 'Delete a secret')
    .option('--env <environment>', 'Environment (production, staging, development)')
    .option('--force', 'Delete immediately without a recovery window')
    .action(async (key: string, options?: { env?: string; force?: boolean }) => {
      try {
        const { region, prefix } = await ctx(options?.env)
        const sm = new SecretsManagerClient(region)
        await sm.deleteSecret({ SecretId: `${prefix}/${key}`, ForceDeleteWithoutRecovery: options?.force })
        cli.success(`Secret ${key} deleted`)
      } catch (error: any) {
        cli.error(`Failed to delete secret: ${error.message}`)
        process.exitCode = 1
      }
    })
}
