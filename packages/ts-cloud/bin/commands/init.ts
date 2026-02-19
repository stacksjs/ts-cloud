import type { CLI } from '@stacksjs/clapp'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import * as cli from '../../src/utils/cli'

export function registerInitCommands(app: CLI): void {
  app
    .command('init', 'Initialize a new ts-cloud project')
    .option('--mode <mode>', 'Deployment mode: server, serverless, or hybrid')
    .option('--name <name>', 'Project name')
    .option('--region <region>', 'AWS Region')
    .action(async (options?: { mode?: string, name?: string, region?: string }) => {
      cli.header('Initializing ts-cloud Project')

      // Check if already initialized
      if (existsSync('cloud.config.ts')) {
        const overwrite = await cli.confirm('cloud.config.ts already exists. Overwrite?', false)
        if (!overwrite) {
          cli.info('Initialization cancelled')
          return
        }
      }

      // Get project name
      const projectName = options?.name || await cli.prompt('Project name', 'my-app')

      // Get deployment mode
      const mode = options?.mode || await cli.select(
        'Select deployment mode',
        ['serverless', 'server', 'hybrid'],
      )

      // Get AWS region
      const region = options?.region || await cli.select(
        'Select AWS region',
        ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'],
      )

      // Create cloud.config.ts
      const spinner = new cli.Spinner('Creating configuration file...')
      spinner.start()

      const configContent = `import { defineConfig } from 'ts-cloud-types'

export default defineConfig({
  project: {
    name: '${projectName}',
    slug: '${projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}',
    region: '${region}',
  },
  mode: '${mode}',
  environments: {
    production: {
      enabled: true,
    },
    staging: {
      enabled: true,
    },
    development: {
      enabled: true,
    },
  },
  infrastructure: {
    // Add your infrastructure configuration here
  },
})
`

      await writeFile('cloud.config.ts', configContent)
      spinner.succeed('Created cloud.config.ts')

      // Create .gitignore
      if (!existsSync('.gitignore')) {
        await writeFile('.gitignore', `.env
.env.*
node_modules/
dist/
cloudformation/
*.log
.DS_Store
`)
        cli.success('Created .gitignore')
      }

      // Create cloudformation directory
      if (!existsSync('cloudformation')) {
        await mkdir('cloudformation', { recursive: true })
        cli.success('Created cloudformation/ directory')
      }

      cli.box(`ts-cloud project initialized!

Next steps:
  1. Edit cloud.config.ts to configure your infrastructure
  2. Run 'cloud generate' to create CloudFormation templates
  3. Run 'cloud deploy' to deploy your infrastructure`, 'green')
    })

  app
    .command('init:server', 'Initialize server-based (EC2) project')
    .action(async () => {
      cli.header('Initializing Server-Based Project')
      // Delegate to init with mode
      await app.parse(['init', '--mode', 'server'])
    })

  app
    .command('init:serverless', 'Initialize serverless (Fargate/Lambda) project')
    .action(async () => {
      cli.header('Initializing Serverless Project')
      await app.parse(['init', '--mode', 'serverless'])
    })

  app
    .command('init:hybrid', 'Initialize hybrid project')
    .action(async () => {
      cli.header('Initializing Hybrid Project')
      await app.parse(['init', '--mode', 'hybrid'])
    })
}
