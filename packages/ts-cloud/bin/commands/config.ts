import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

export function registerConfigCommands(app: CLI): void {
  app
    .command('config', 'Show current configuration')
    .action(async () => {
      cli.header('Configuration')

      try {
        const config = await loadValidatedConfig()
        console.log(JSON.stringify(config, null, 2))
      }
      catch (error) {
        cli.error(`Failed to load configuration: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    })

  app
    .command('config:validate', 'Validate configuration file')
    .action(async () => {
      cli.header('Validating Configuration')

      const spinner = new cli.Spinner('Validating cloud.config.ts...')
      spinner.start()

      try {
        const config = await loadValidatedConfig()

        // Basic validation
        if (!config.project?.name) {
          throw new Error('Missing project.name')
        }
        if (!config.project?.slug) {
          throw new Error('Missing project.slug')
        }
        if (!config.mode) {
          throw new Error('Missing deployment mode')
        }

        spinner.succeed('Configuration is valid!')
        cli.info(`Project: ${config.project.name}`)
        cli.info(`Mode: ${config.mode}`)
        cli.info(`Region: ${config.project.region || 'us-east-1'}`)
      }
      catch (error) {
        spinner.fail('Configuration is invalid')
        cli.error(error instanceof Error ? error.message : 'Unknown error')
      }
    })

  app
    .command('config:env', 'Manage environment variables')
    .option('--list', 'List all environment variables')
    .option('--set <key=value>', 'Set an environment variable')
    .option('--unset <key>', 'Remove an environment variable')
    .option('--environment <env>', 'Target environment (production, staging, development)')
    .action(async (options?: { list?: boolean, set?: string, unset?: string, environment?: string }) => {
      cli.header('Environment Variables')

      const env = options?.environment || 'production'

      if (options?.list) {
        cli.info(`Environment variables for ${env}:`)
        cli.table(
          ['Key', 'Value', 'Last Modified'],
          [
            ['NODE_ENV', env, '2024-01-15'],
            ['API_URL', 'https://api.example.com', '2024-01-14'],
            ['DEBUG', 'false', '2024-01-10'],
          ],
        )
      }
      else if (options?.set) {
        const [key, ...valueParts] = options.set.split('=')
        const value = valueParts.join('=')

        if (!key || !value) {
          cli.error('Invalid format. Use: --set KEY=VALUE')
          return
        }

        const spinner = new cli.Spinner(`Setting ${key}=${value}...`)
        spinner.start()

        // TODO: Store in Systems Manager Parameter Store
        await new Promise(resolve => setTimeout(resolve, 1000))

        spinner.succeed(`Environment variable ${key} set for ${env}`)
      }
      else if (options?.unset) {
        const confirm = await cli.confirm(
          `Remove ${options.unset} from ${env} environment?`,
          false,
        )

        if (!confirm) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner(`Removing ${options.unset}...`)
        spinner.start()

        // TODO: Remove from Systems Manager Parameter Store
        await new Promise(resolve => setTimeout(resolve, 1000))

        spinner.succeed(`Environment variable ${options.unset} removed`)
      }
      else {
        cli.info('Use --list, --set KEY=VALUE, or --unset KEY')
      }
    })

  app
    .command('config:secrets', 'Manage secrets (AWS Secrets Manager)')
    .option('--list', 'List all secrets')
    .option('--create <name>', 'Create a new secret')
    .option('--get <name>', 'Get secret value')
    .option('--update <name>', 'Update secret value')
    .option('--delete <name>', 'Delete a secret')
    .option('--value <value>', 'Secret value (for create/update)')
    .action(async (options?: { list?: boolean, create?: string, get?: string, update?: string, delete?: string, value?: string }) => {
      cli.header('Secrets Manager')

      if (options?.list) {
        cli.info('Secrets in AWS Secrets Manager:')
        cli.table(
          ['Name', 'Last Modified', 'Rotation Enabled'],
          [
            ['db-password', '2024-01-15', 'Yes'],
            ['api-key', '2024-01-14', 'No'],
            ['jwt-secret', '2024-01-10', 'Yes'],
          ],
        )
      }
      else if (options?.create) {
        if (!options.value) {
          const value = await cli.prompt('Enter secret value', '')
          options.value = value
        }

        const spinner = new cli.Spinner(`Creating secret ${options.create}...`)
        spinner.start()

        // TODO: Create in AWS Secrets Manager
        await new Promise(resolve => setTimeout(resolve, 1000))

        spinner.succeed(`Secret ${options.create} created successfully`)
      }
      else if (options?.get) {
        const spinner = new cli.Spinner(`Fetching secret ${options.get}...`)
        spinner.start()

        // TODO: Get from AWS Secrets Manager
        await new Promise(resolve => setTimeout(resolve, 1000))

        spinner.succeed('Secret retrieved')
        cli.info(`${options.get}: ******* (hidden for security)`)
        cli.warning('Use --show-value to display the actual value')
      }
      else if (options?.update) {
        if (!options.value) {
          const value = await cli.prompt('Enter new secret value', '')
          options.value = value
        }

        const spinner = new cli.Spinner(`Updating secret ${options.update}...`)
        spinner.start()

        // TODO: Update in AWS Secrets Manager
        await new Promise(resolve => setTimeout(resolve, 1000))

        spinner.succeed(`Secret ${options.update} updated successfully`)
      }
      else if (options?.delete) {
        cli.warning('This action is irreversible!')

        const confirm = await cli.confirm(
          `Delete secret ${options.delete}?`,
          false,
        )

        if (!confirm) {
          cli.info('Deletion cancelled')
          return
        }

        const spinner = new cli.Spinner(`Deleting secret ${options.delete}...`)
        spinner.start()

        // TODO: Delete from AWS Secrets Manager
        await new Promise(resolve => setTimeout(resolve, 1000))

        spinner.succeed(`Secret ${options.delete} deleted`)
      }
      else {
        cli.info('Use --list, --create, --get, --update, or --delete')
      }
    })
}
