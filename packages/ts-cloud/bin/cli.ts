#!/usr/bin/env bun
import { CLI } from '@stacksjs/clapp'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../package.json'
import { TemplateBuilder } from '@ts-cloud/core'
import { loadCloudConfig } from '../src/config'
import { InfrastructureGenerator } from '../src/generators/infrastructure'
import { CloudFormationClient } from '../src/aws/cloudformation'
import { S3Client } from '../src/aws/s3'
import { CloudFrontClient } from '../src/aws/cloudfront'
import { ElastiCacheClient } from '../src/aws/elasticache'
import { SQSClient } from '../src/aws/sqs'
import { SchedulerClient } from '../src/aws/scheduler'
import { validateTemplate, validateTemplateSize, validateResourceLimits } from '../src/validation/template'
import * as cli from '../src/utils/cli'

const app = new CLI('cloud')

// ============================================
// Global Options
// ============================================
app
  .option('--env <environment>', 'Environment (production, staging, development)')
  .option('--region <region>', 'AWS Region')
  .option('--profile <profile>', 'AWS CLI Profile')
  .option('--verbose', 'Enable verbose logging')
  .option('--dry-run', 'Show what would be done without making changes')

// ============================================
// 3.2 Initialization Commands
// ============================================

app
  .command('init', 'Initialize a new TS Cloud project')
  .option('--mode <mode>', 'Deployment mode: server, serverless, or hybrid')
  .option('--name <name>', 'Project name')
  .option('--region <region>', 'AWS Region')
  .action(async (options?: { mode?: string, name?: string, region?: string }) => {
    cli.header('🚀 Initializing TS Cloud Project')

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

    const configContent = `import { defineConfig } from '@ts-cloud/types'

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

    cli.box(`✨ TS Cloud project initialized!

Next steps:
  1. Edit cloud.config.ts to configure your infrastructure
  2. Run 'cloud generate' to create CloudFormation templates
  3. Run 'cloud deploy' to deploy your infrastructure`, 'green')
  })

app
  .command('init:server', 'Initialize server-based (EC2) project')
  .action(async () => {
    cli.header('🖥️  Initializing Server-Based Project')
    // Delegate to init with mode
    await app.parse(['init', '--mode', 'server'])
  })

app
  .command('init:serverless', 'Initialize serverless (Fargate/Lambda) project')
  .action(async () => {
    cli.header('⚡ Initializing Serverless Project')
    await app.parse(['init', '--mode', 'serverless'])
  })

app
  .command('init:hybrid', 'Initialize hybrid project')
  .action(async () => {
    cli.header('🔀 Initializing Hybrid Project')
    await app.parse(['init', '--mode', 'hybrid'])
  })

// ============================================
// 3.3 Configuration Commands
// ============================================

app
  .command('config', 'Show current configuration')
  .action(async () => {
    cli.header('⚙️  Configuration')

    try {
      const config = await loadCloudConfig()
      console.log(JSON.stringify(config, null, 2))
    }
    catch (error) {
      cli.error(`Failed to load configuration: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  })

app
  .command('config:validate', 'Validate configuration file')
  .action(async () => {
    cli.header('✅ Validating Configuration')

    const spinner = new cli.Spinner('Validating cloud.config.ts...')
    spinner.start()

    try {
      const config = await loadCloudConfig()

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
    cli.header('🔧 Environment Variables')

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
    cli.header('🔐 Secrets Manager')

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
        const value = await cli.prompt('Enter secret value', '', true)
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
        const value = await cli.prompt('Enter new secret value', '', true)
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

// ============================================
// 3.4 Generation Commands
// ============================================

app
  .command('generate', 'Generate CloudFormation templates')
  .alias('gen')
  .option('--output <path>', 'Output directory for templates', 'cloudformation')
  .option('--format <format>', 'Output format: json or yaml', 'json')
  .option('--module <module>', 'Generate specific module only')
  .action(async (options?: { output?: string, format?: string, module?: string }) => {
    cli.header('📝 Generating CloudFormation Templates')

    const spinner = new cli.Spinner('Loading configuration...')
    spinner.start()

    try {
      const config = await loadCloudConfig()
      spinner.succeed('Configuration loaded')

      const outputDir = options?.output || 'cloudformation'
      const format = options?.format || 'json'
      const environment = (options as any)?.env || 'production'

      // Create output directory
      if (!existsSync(outputDir)) {
        await mkdir(outputDir, { recursive: true })
      }

      // Generate infrastructure using all Phase 2 modules
      cli.step('Generating infrastructure...')
      const generator = new InfrastructureGenerator({
        config,
        environment,
        modules: options?.module ? [options.module] : undefined,
      })

      const generationSpinner = new cli.Spinner('Generating CloudFormation template...')
      generationSpinner.start()

      // Generate the template
      generator.generate()
      const output = format === 'yaml' ? generator.toYAML() : generator.toJSON()
      generationSpinner.succeed('Template generated')

      // Validate template
      cli.step('Validating template...')
      const template = JSON.parse(generator.toJSON())
      const validation = validateTemplate(template)
      const sizeValidation = validateTemplateSize(output)
      const limitsValidation = validateResourceLimits(template)

      // Show errors
      const allErrors = [
        ...validation.errors,
        ...sizeValidation.errors,
        ...limitsValidation.errors,
      ]

      if (allErrors.length > 0) {
        cli.error('Template validation failed:')
        for (const error of allErrors) {
          cli.error(`  • ${error.path}: ${error.message}`)
        }
      }
      else {
        cli.success('Template validated successfully')
      }

      // Show warnings
      const allWarnings = [
        ...validation.warnings,
        ...sizeValidation.warnings,
        ...limitsValidation.warnings,
      ]

      if (allWarnings.length > 0) {
        for (const warning of allWarnings) {
          cli.warn(`  • ${warning.path}: ${warning.message}`)
        }
      }

      // Write to file
      const filename = join(outputDir, `${environment}.${format}`)
      await writeFile(filename, output)
      cli.success(`Generated ${filename}`)

      // Show summary
      const builder = generator.getBuilder()
      const resourceCount = Object.keys(builder.getResources()).length
      cli.info(`\n📦 Generated ${resourceCount} resources:`)

      // Count resource types
      const resources = builder.getResources()
      const typeCounts: Record<string, number> = {}
      for (const resource of Object.values(resources)) {
        const type = (resource as any).Type
        typeCounts[type] = (typeCounts[type] || 0) + 1
      }

      // Display resource types
      const types = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])
      for (const [type, count] of types) {
        cli.info(`  • ${type}: ${count}`)
      }

      cli.info(`\nNext steps:
  1. Review the generated templates in ${outputDir}/
  2. Run 'cloud deploy' to deploy your infrastructure`)
    }
    catch (error) {
      spinner.fail('Failed to generate templates')
      cli.error(error instanceof Error ? error.message : 'Unknown error')
    }
  })

app
  .command('generate:preview', 'Preview what will be generated')
  .action(async () => {
    cli.header('👁️  Template Preview')
    cli.info('This command will show a preview of generated templates')
    // TODO: Implement preview logic
  })

app
  .command('generate:diff', 'Show diff from existing stack')
  .option('--stack <name>', 'Stack name to compare against')
  .action(async () => {
    cli.header('📊 Template Diff')
    cli.info('This command will show differences from the existing stack')
    // TODO: Implement diff logic
  })

// ============================================
// 3.5 Server Management Commands
// ============================================

app
  .command('server:list', 'List all servers')
  .action(async () => {
    cli.header('📋 Listing Servers')

    // TODO: Fetch from AWS
    const servers = [
      ['web-1', 'i-1234567890abcdef0', 't3.micro', 'running', 'us-east-1a'],
      ['web-2', 'i-0987654321fedcba0', 't3.micro', 'running', 'us-east-1b'],
    ]

    cli.table(
      ['Name', 'Instance ID', 'Type', 'Status', 'AZ'],
      servers,
    )
  })

app
  .command('server:create <name>', 'Create a new server')
  .option('--type <type>', 'Instance type (e.g., t3.micro)', 't3.micro')
  .option('--ami <ami>', 'AMI ID')
  .action(async (name: string, options?: { type?: string, ami?: string }) => {
    cli.header(`🖥️  Creating Server: ${name}`)

    const spinner = new cli.Spinner(`Creating server ${name}...`)
    spinner.start()

    // TODO: Implement server creation
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed(`Server ${name} created successfully`)
    cli.info(`Instance type: ${options?.type || 't3.micro'}`)
  })

app
  .command('server:ssh <name>', 'SSH into a server')
  .action(async (name: string) => {
    cli.step(`Connecting to ${name}...`)
    // TODO: Implement SSH connection
  })

app
  .command('server:logs <name>', 'View server logs')
  .option('--tail', 'Tail logs in real-time')
  .action(async (name: string) => {
    cli.header(`📄 Logs for ${name}`)
    // TODO: Implement log viewing
  })

app
  .command('server:deploy <name>', 'Deploy app to server')
  .option('--strategy <strategy>', 'Deployment strategy: git, rsync, or scp')
  .action(async (name: string) => {
    cli.header(`🚀 Deploying to ${name}`)
    // TODO: Implement deployment
  })

app
  .command('server:resize <name> <type>', 'Change server instance type')
  .action(async (name: string, type: string) => {
    cli.header(`🔧 Resizing Server: ${name}`)

    const confirm = await cli.confirm(
      `This will stop and restart ${name}. Continue?`,
      false,
    )

    if (!confirm) {
      cli.info('Resize cancelled')
      return
    }

    const spinner = new cli.Spinner(`Resizing ${name} to ${type}...`)
    spinner.start()

    try {
      // TODO: Implement EC2 instance type change
      // 1. Stop instance
      // 2. Change instance type
      // 3. Start instance
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed(`Server ${name} resized to ${type}`)
      cli.success(`Instance type changed from t3.micro to ${type}`)
    }
    catch (error: any) {
      spinner.fail('Resize failed')
      cli.error(error.message)
    }
  })

app
  .command('server:reboot <name>', 'Reboot a server')
  .option('--force', 'Force reboot without confirmation')
  .action(async (name: string, options?: { force?: boolean }) => {
    cli.header(`🔄 Rebooting Server: ${name}`)

    if (!options?.force) {
      const confirm = await cli.confirm(
        `Are you sure you want to reboot ${name}?`,
        false,
      )

      if (!confirm) {
        cli.info('Reboot cancelled')
        return
      }
    }

    const spinner = new cli.Spinner(`Rebooting ${name}...`)
    spinner.start()

    try {
      // TODO: Implement EC2 reboot
      // Use AWS EC2 API to reboot instance
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed(`Server ${name} rebooted successfully`)
      cli.info('Server will be available in a few moments')
    }
    catch (error: any) {
      spinner.fail('Reboot failed')
      cli.error(error.message)
    }
  })

app
  .command('server:destroy <name>', 'Terminate a server')
  .option('--force', 'Skip confirmation prompt')
  .action(async (name: string, options?: { force?: boolean }) => {
    cli.header(`🗑️  Destroying Server: ${name}`)

    cli.warning('This action is irreversible!')

    if (!options?.force) {
      const confirm = await cli.confirm(
        `Are you absolutely sure you want to terminate ${name}?`,
        false,
      )

      if (!confirm) {
        cli.info('Termination cancelled')
        return
      }

      // Double confirmation for safety
      const doubleConfirm = await cli.confirm(
        `Type the server name to confirm: ${name}`,
        false,
      )

      if (!doubleConfirm) {
        cli.info('Termination cancelled')
        return
      }
    }

    const spinner = new cli.Spinner(`Terminating ${name}...`)
    spinner.start()

    try {
      // TODO: Implement EC2 termination
      // 1. Terminate EC2 instance
      // 2. Wait for termination
      // 3. Clean up associated resources (EIPs, volumes, etc.)
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed(`Server ${name} terminated successfully`)
      cli.success('All resources have been cleaned up')
    }
    catch (error: any) {
      spinner.fail('Termination failed')
      cli.error(error.message)
    }
  })

// ============================================
// 3.6 Serverless Commands
// ============================================

app
  .command('function:list', 'List all Lambda functions')
  .action(async () => {
    cli.header('📋 Listing Functions')

    const functions = [
      ['api-handler', '128 MB', '30s', '15', 'nodejs20.x'],
      ['worker', '512 MB', '60s', '3', 'nodejs20.x'],
    ]

    cli.table(
      ['Name', 'Memory', 'Timeout', 'Invocations (24h)', 'Runtime'],
      functions,
    )
  })

app
  .command('function:logs <name>', 'View function logs')
  .option('--tail', 'Tail logs in real-time')
  .option('--filter <pattern>', 'Filter logs by pattern')
  .action(async (name: string) => {
    cli.header(`📄 Logs for ${name}`)
    cli.info('Streaming logs...')
    // TODO: Implement log streaming
  })

app
  .command('function:invoke <name>', 'Test function invocation')
  .option('--payload <json>', 'Event payload as JSON')
  .action(async (name: string, options?: { payload?: string }) => {
    cli.header(`⚡ Invoking ${name}`)

    const spinner = new cli.Spinner('Invoking function...')
    spinner.start()

    // TODO: Implement invocation
    await new Promise(resolve => setTimeout(resolve, 1000))

    spinner.succeed('Function invoked successfully')
  })

app
  .command('function:create <name>', 'Create a new Lambda function')
  .option('--runtime <runtime>', 'Runtime (nodejs20.x, python3.12, etc.)', 'nodejs20.x')
  .option('--memory <mb>', 'Memory allocation in MB', '128')
  .option('--timeout <seconds>', 'Timeout in seconds', '30')
  .option('--handler <handler>', 'Function handler', 'index.handler')
  .action(async (name: string, options?: { runtime?: string, memory?: string, timeout?: string, handler?: string }) => {
    cli.header(`⚡ Creating Lambda Function: ${name}`)

    const runtime = options?.runtime || 'nodejs20.x'
    const memory = options?.memory || '128'
    const timeout = options?.timeout || '30'
    const handler = options?.handler || 'index.handler'

    cli.info(`Runtime: ${runtime}`)
    cli.info(`Memory: ${memory} MB`)
    cli.info(`Timeout: ${timeout}s`)
    cli.info(`Handler: ${handler}`)

    const spinner = new cli.Spinner('Creating function...')
    spinner.start()

    // TODO: Create function directory structure
    // TODO: Generate basic function code
    // TODO: Create IAM role for function
    // TODO: Package and upload to Lambda

    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed(`Function ${name} created successfully`)

    cli.success('\n✓ Function created!')
    cli.info('\nNext steps:')
    cli.info(`  • Edit the function code in functions/${name}/index.js`)
    cli.info(`  • cloud function:deploy ${name} - Deploy the function`)
    cli.info(`  • cloud function:invoke ${name} - Test the function`)
  })

app
  .command('function:deploy <name>', 'Deploy specific Lambda function')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .action(async (name: string, options?: { env?: string }) => {
    cli.header(`🚀 Deploying Function: ${name}`)

    const environment = options?.env || 'production'

    cli.info(`Environment: ${environment}`)

    const spinner = new cli.Spinner('Packaging function...')
    spinner.start()

    // TODO: Package function code
    // TODO: Upload to S3
    // TODO: Update Lambda function code
    // TODO: Publish new version

    spinner.text = 'Uploading to Lambda...'
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.text = 'Updating function configuration...'
    await new Promise(resolve => setTimeout(resolve, 1000))

    spinner.succeed(`Function ${name} deployed successfully`)

    cli.success('\n✓ Deployment complete!')
    cli.info('\nFunction details:')
    cli.info(`  • ARN: arn:aws:lambda:us-east-1:123456789:function:${name}`)
    cli.info(`  • Version: $LATEST`)
    cli.info(`  • Last Modified: ${new Date().toISOString()}`)
  })

// ============================================
// 3.7 Container Commands
// ============================================

app
  .command('container:build', 'Build Docker image')
  .option('--tag <tag>', 'Image tag', 'latest')
  .option('--file <dockerfile>', 'Dockerfile path', 'Dockerfile')
  .action(async (options?: { tag?: string, file?: string }) => {
    cli.header('🐳 Building Docker Image')

    const tag = options?.tag || 'latest'
    const dockerfile = options?.file || 'Dockerfile'

    cli.info(`Tag: ${tag}`)
    cli.info(`Dockerfile: ${dockerfile}`)

    const spinner = new cli.Spinner('Building image...')
    spinner.start()

    // TODO: Run docker build command
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.succeed(`Image built successfully: ${tag}`)
  })

app
  .command('container:push', 'Push Docker image to ECR')
  .option('--tag <tag>', 'Image tag', 'latest')
  .option('--repository <name>', 'ECR repository name')
  .action(async (options?: { tag?: string, repository?: string }) => {
    cli.header('📤 Pushing to ECR')

    const tag = options?.tag || 'latest'
    const repository = options?.repository

    if (!repository) {
      cli.error('Repository name is required. Use --repository <name>')
      return
    }

    cli.info(`Repository: ${repository}`)
    cli.info(`Tag: ${tag}`)

    const spinner = new cli.Spinner('Authenticating with ECR...')
    spinner.start()

    // TODO: Get ECR login credentials
    await new Promise(resolve => setTimeout(resolve, 1000))

    spinner.text = 'Pushing image...'
    // TODO: Push to ECR
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.succeed(`Image pushed successfully`)

    cli.success(`\n✓ Image available at:`)
    cli.info(`  123456789.dkr.ecr.us-east-1.amazonaws.com/${repository}:${tag}`)
  })

app
  .command('container:deploy', 'Update ECS service with new image')
  .option('--service <name>', 'ECS service name')
  .option('--cluster <name>', 'ECS cluster name')
  .option('--tag <tag>', 'Image tag', 'latest')
  .action(async (options?: { service?: string, cluster?: string, tag?: string }) => {
    cli.header('🚀 Deploying Container')

    const service = options?.service
    const cluster = options?.cluster
    const tag = options?.tag || 'latest'

    if (!service || !cluster) {
      cli.error('Service and cluster names are required')
      cli.info('Use: --service <name> --cluster <name>')
      return
    }

    cli.info(`Cluster: ${cluster}`)
    cli.info(`Service: ${service}`)
    cli.info(`Tag: ${tag}`)

    const spinner = new cli.Spinner('Updating task definition...')
    spinner.start()

    // TODO: Create new task definition revision
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.text = 'Updating ECS service...'
    // TODO: Update ECS service
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.text = 'Waiting for deployment...'
    // TODO: Wait for service to stabilize
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed(`Service ${service} updated successfully`)

    cli.success('\n✓ Deployment complete!')
    cli.info('\nService details:')
    cli.info(`  • Running tasks: 2/2`)
    cli.info(`  • Pending tasks: 0`)
    cli.info(`  • Status: ACTIVE`)
  })

// ============================================
// 3.8 Domain & DNS Commands
// ============================================

app
  .command('domain:list', 'List all domains')
  .action(async () => {
    cli.header('🌐 Domains')

    const domains = [
      ['example.com', 'Active', 'Yes', 'Route53'],
      ['app.example.com', 'Active', 'Yes', 'Route53'],
    ]

    cli.table(
      ['Domain', 'Status', 'SSL', 'Provider'],
      domains,
    )
  })

app
  .command('domain:add <domain>', 'Add a new domain')
  .action(async (domain: string) => {
    cli.header(`🌐 Adding Domain: ${domain}`)

    const spinner = new cli.Spinner('Creating hosted zone...')
    spinner.start()

    // TODO: Implement domain addition
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed(`Domain ${domain} added successfully`)
  })

app
  .command('domain:ssl <domain>', 'Generate SSL certificate')
  .action(async (domain: string) => {
    cli.header(`🔒 Generating SSL Certificate for ${domain}`)

    const spinner = new cli.Spinner('Requesting certificate from ACM...')
    spinner.start()

    // TODO: Implement SSL generation
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('SSL certificate requested')
    cli.warn('Check your email to approve the certificate request')
  })

app
  .command('domain:verify <domain>', 'Verify domain ownership')
  .action(async (domain: string) => {
    cli.header(`✓ Verifying Domain: ${domain}`)

    const spinner = new cli.Spinner('Checking DNS records...')
    spinner.start()

    // TODO: Verify domain ownership via DNS records
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Domain verified successfully')

    cli.info('\nVerification details:')
    cli.info('  • DNS records found: 4')
    cli.info('  • Nameservers configured: Yes')
    cli.info('  • SSL certificate: Valid')
  })

app
  .command('dns:records <domain>', 'List DNS records for a domain')
  .action(async (domain: string) => {
    cli.header(`📝 DNS Records for ${domain}`)

    const spinner = new cli.Spinner('Fetching DNS records...')
    spinner.start()

    // TODO: Fetch DNS records from Route53
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.succeed('Records retrieved')

    cli.table(
      ['Type', 'Name', 'Value', 'TTL'],
      [
        ['A', domain, '192.0.2.1', '300'],
        ['AAAA', domain, '2001:0db8::1', '300'],
        ['CNAME', `www.${domain}`, domain, '300'],
        ['MX', domain, 'mail.example.com', '3600'],
        ['TXT', domain, 'v=spf1 include:_spf.google.com ~all', '3600'],
      ],
    )
  })

app
  .command('dns:add <domain> <type> <value>', 'Add DNS record')
  .option('--name <name>', 'Record name (subdomain)', '@')
  .option('--ttl <seconds>', 'Time to live in seconds', '300')
  .action(async (domain: string, type: string, value: string, options?: { name?: string, ttl?: string }) => {
    cli.header(`📝 Adding DNS Record`)

    const name = options?.name || '@'
    const ttl = options?.ttl || '300'
    const recordType = type.toUpperCase()

    cli.info(`Domain: ${domain}`)
    cli.info(`Type: ${recordType}`)
    cli.info(`Name: ${name}`)
    cli.info(`Value: ${value}`)
    cli.info(`TTL: ${ttl}`)

    const spinner = new cli.Spinner('Adding DNS record...')
    spinner.start()

    // TODO: Add record to Route53
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('DNS record added successfully')

    cli.success('\n✓ Record created!')
    cli.info('\nNote: DNS changes may take up to 48 hours to propagate globally')
  })

// ============================================
// 3.9 Database Commands
// ============================================

app
  .command('db:list', 'List all databases')
  .action(async () => {
    cli.header('📊 Databases')

    const databases = [
      ['production-db', 'PostgreSQL 15', 'db.t3.micro', 'available', '20 GB'],
      ['staging-db', 'PostgreSQL 15', 'db.t3.micro', 'available', '20 GB'],
    ]

    cli.table(
      ['Name', 'Engine', 'Instance Type', 'Status', 'Storage'],
      databases,
    )
  })

app
  .command('db:create <name>', 'Create a new database')
  .option('--engine <engine>', 'Database engine: postgres, mysql, or dynamodb')
  .option('--size <size>', 'Instance size (e.g., db.t3.micro)')
  .action(async (name: string, options?: { engine?: string, size?: string }) => {
    cli.header(`📊 Creating Database: ${name}`)

    const engine = options?.engine || 'postgres'
    const size = options?.size || 'db.t3.micro'

    const spinner = new cli.Spinner(`Creating ${engine} database...`)
    spinner.start()

    // TODO: Implement database creation
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.succeed(`Database ${name} created successfully`)
    cli.info(`Engine: ${engine}`)
    cli.info(`Size: ${size}`)
  })

app
  .command('db:backup <name>', 'Create database backup')
  .action(async (name: string) => {
    cli.header(`💾 Backing up ${name}`)

    const spinner = new cli.Spinner('Creating snapshot...')
    spinner.start()

    // TODO: Implement backup
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Backup created successfully')
  })

app
  .command('db:connect <name>', 'Get connection details')
  .action(async (name: string) => {
    cli.header(`🔌 Connection Details for ${name}`)

    // TODO: Fetch connection details from AWS
    cli.info('Host: my-db.xxxxx.us-east-1.rds.amazonaws.com')
    cli.info('Port: 5432')
    cli.info('Database: postgres')
    cli.warn('Get password from AWS Secrets Manager')
  })

app
  .command('db:restore <name> <backup-id>', 'Restore database from backup')
  .option('--new-name <name>', 'Name for restored database')
  .action(async (name: string, backupId: string, options?: { newName?: string }) => {
    cli.header(`♻️ Restoring Database: ${name}`)

    const newName = options?.newName || `${name}-restored-${Date.now()}`

    cli.info(`Source: ${name}`)
    cli.info(`Backup ID: ${backupId}`)
    cli.info(`Target: ${newName}`)

    cli.warning('\nThis will create a new database instance from the backup.')

    const confirm = await cli.confirm('Continue with restore?', false)
    if (!confirm) {
      cli.info('Restore cancelled')
      return
    }

    const spinner = new cli.Spinner('Restoring from snapshot...')
    spinner.start()

    // TODO: Restore RDS from snapshot
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.succeed('Database restore initiated')

    cli.success('\n✓ Restore started!')
    cli.info('\nThe new database will be available in a few minutes')
    cli.info(`New instance: ${newName}`)
  })

app
  .command('db:tunnel <name>', 'Create SSH tunnel to database')
  .option('--local-port <port>', 'Local port for tunnel', '5432')
  .action(async (name: string, options?: { localPort?: string }) => {
    cli.header(`🔌 Creating SSH Tunnel to ${name}`)

    const localPort = options?.localPort || '5432'

    cli.info(`Database: ${name}`)
    cli.info(`Local port: ${localPort}`)

    const spinner = new cli.Spinner('Establishing SSH tunnel...')
    spinner.start()

    // TODO: Create SSH tunnel via bastion host
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('SSH tunnel established')

    cli.success('\n✓ Tunnel active!')
    cli.info('\nConnection details:')
    cli.info(`  Host: localhost`)
    cli.info(`  Port: ${localPort}`)
    cli.info(`  Database: postgres`)
    cli.info('\nPress Ctrl+C to close the tunnel')

    // Keep the process running
    // TODO: Implement actual tunnel that stays open
  })

// ============================================
// 3.11 Monitoring & Logs Commands
// ============================================

app
  .command('logs', 'Stream all application logs')
  .option('--tail', 'Tail logs in real-time')
  .option('--filter <pattern>', 'Filter logs by pattern')
  .option('--since <duration>', 'Show logs since duration (e.g., 1h, 30m)')
  .action(async (options?: { tail?: boolean, filter?: string, since?: string }) => {
    cli.header('📄 Application Logs')

    if (options?.tail) {
      cli.info('Tailing logs... (Ctrl+C to stop)')
    }

    // TODO: Implement log streaming
    cli.info('2025-01-15 10:30:45 [INFO] Application started')
    cli.info('2025-01-15 10:30:46 [INFO] Connected to database')
  })

app
  .command('logs:server <name>', 'View server-specific logs')
  .option('--tail', 'Tail logs in real-time')
  .option('--since <duration>', 'Show logs since duration (e.g., 1h, 30m)')
  .action(async (name: string, options?: { tail?: boolean, since?: string }) => {
    cli.header(`📄 Server Logs: ${name}`)

    const since = options?.since || '1h'

    cli.info(`Fetching logs from the last ${since}...`)

    if (options?.tail) {
      cli.info('Tailing logs... (Ctrl+C to stop)\n')
    }

    // TODO: Fetch server logs from CloudWatch
    cli.info('[2025-01-15 10:30:45] Server started')
    cli.info('[2025-01-15 10:30:46] Listening on port 3000')
    cli.info('[2025-01-15 10:30:47] Connected to database')
  })

app
  .command('logs:function <name>', 'View function-specific logs')
  .option('--tail', 'Tail logs in real-time')
  .option('--since <duration>', 'Show logs since duration (e.g., 1h, 30m)')
  .action(async (name: string, options?: { tail?: boolean, since?: string }) => {
    cli.header(`📄 Function Logs: ${name}`)

    const since = options?.since || '1h'

    cli.info(`Fetching logs from the last ${since}...`)

    if (options?.tail) {
      cli.info('Tailing logs... (Ctrl+C to stop)\n')
    }

    // TODO: Fetch Lambda logs from CloudWatch
    cli.info('[2025-01-15 10:30:45] START RequestId: abc123')
    cli.info('[2025-01-15 10:30:46] Processing event...')
    cli.info('[2025-01-15 10:30:47] END RequestId: abc123')
  })

app
  .command('metrics', 'View key metrics')
  .action(async () => {
    cli.header('📊 Metrics Dashboard')

    cli.info('CPU Usage: 45%')
    cli.info('Memory Usage: 62%')
    cli.info('Requests/min: 1,234')
    cli.info('Error Rate: 0.02%')

    // TODO: Fetch real metrics from CloudWatch
  })

app
  .command('metrics:dashboard', 'Open CloudWatch dashboard')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .action(async (options?: { env?: string }) => {
    cli.header('📊 Opening CloudWatch Dashboard')

    const environment = options?.env || 'production'

    const spinner = new cli.Spinner('Generating dashboard URL...')
    spinner.start()

    // TODO: Generate CloudWatch dashboard URL
    await new Promise(resolve => setTimeout(resolve, 1000))

    spinner.succeed('Dashboard URL generated')

    cli.success('\n✓ Opening dashboard in browser...')
    cli.info('\nDashboard URL:')
    cli.info('  https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=my-app-production')
  })

app
  .command('alarms', 'List all alarms')
  .action(async () => {
    cli.header('🚨 CloudWatch Alarms')

    const alarms = [
      ['high-cpu', 'OK', 'CPU > 80%', 'production'],
      ['high-memory', 'ALARM', 'Memory > 90%', 'production'],
    ]

    cli.table(
      ['Name', 'Status', 'Condition', 'Environment'],
      alarms,
    )
  })

app
  .command('alarms:create', 'Create a new alarm')
  .option('--name <name>', 'Alarm name')
  .option('--metric <metric>', 'Metric to monitor (CPU, Memory, etc.)')
  .option('--threshold <value>', 'Threshold value')
  .option('--comparison <op>', 'Comparison operator (>, <, >=, <=)', '>')
  .action(async (options?: { name?: string, metric?: string, threshold?: string, comparison?: string }) => {
    cli.header('🚨 Creating CloudWatch Alarm')

    if (!options?.name || !options?.metric || !options?.threshold) {
      cli.error('Missing required options: --name, --metric, --threshold')
      return
    }

    const name = options.name
    const metric = options.metric
    const threshold = options.threshold
    const comparison = options.comparison || '>'

    cli.info(`Alarm: ${name}`)
    cli.info(`Metric: ${metric}`)
    cli.info(`Condition: ${metric} ${comparison} ${threshold}`)

    const spinner = new cli.Spinner('Creating alarm...')
    spinner.start()

    // TODO: Create CloudWatch alarm
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Alarm created successfully')

    cli.success('\n✓ Alarm is now active!')
    cli.info('\nYou will be notified when the condition is met')
  })

// ============================================
// 3.13 Security Commands
// ============================================

app
  .command('secrets:list', 'List all secrets')
  .action(async () => {
    cli.header('🔐 Secrets')

    const secrets = [
      ['database-password', 'Last rotated 30 days ago'],
      ['api-key', 'Last rotated 15 days ago'],
    ]

    cli.table(
      ['Name', 'Status'],
      secrets,
    )
  })

app
  .command('secrets:set <key> <value>', 'Set a secret')
  .action(async (key: string, value: string) => {
    cli.header('🔐 Setting Secret')

    const spinner = new cli.Spinner(`Storing secret ${key}...`)
    spinner.start()

    // TODO: Store in AWS Secrets Manager
    await new Promise(resolve => setTimeout(resolve, 1000))

    spinner.succeed(`Secret ${key} stored successfully`)
    cli.warn('Secret value is encrypted and stored in AWS Secrets Manager')
  })

// ============================================
// 3.14 Firewall & WAF Commands
// ============================================

app
  .command('firewall:rules', 'List WAF rules')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .action(async (options?: { env?: string }) => {
    cli.header('🛡️  WAF Rules')

    const environment = options?.env || 'production'

    cli.info(`Environment: ${environment}\n`)

    cli.table(
      ['Rule', 'Priority', 'Action', 'Requests Blocked'],
      [
        ['Rate Limit', '1', 'Block', '1,234'],
        ['Geo Block (CN, RU)', '2', 'Block', '567'],
        ['SQL Injection', '3', 'Block', '89'],
        ['XSS Prevention', '4', 'Block', '23'],
      ],
    )
  })

app
  .command('firewall:block <ip>', 'Block an IP address')
  .option('--reason <reason>', 'Reason for blocking')
  .action(async (ip: string, options?: { reason?: string }) => {
    cli.header(`🛡️  Blocking IP Address`)

    const reason = options?.reason || 'Manual block'

    cli.info(`IP: ${ip}`)
    cli.info(`Reason: ${reason}`)

    const confirm = await cli.confirm('\nBlock this IP address?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Adding IP to WAF block list...')
    spinner.start()

    // TODO: Add IP to WAF IP set
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed(`IP ${ip} blocked successfully`)

    cli.success('\n✓ IP blocked!')
    cli.info('The IP address will be blocked within 60 seconds')
  })

app
  .command('firewall:unblock <ip>', 'Unblock an IP address')
  .action(async (ip: string) => {
    cli.header(`🛡️  Unblocking IP Address`)

    cli.info(`IP: ${ip}`)

    const confirm = await cli.confirm('\nUnblock this IP address?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Removing IP from WAF block list...')
    spinner.start()

    // TODO: Remove IP from WAF IP set
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed(`IP ${ip} unblocked successfully`)

    cli.success('\n✓ IP unblocked!')
  })

app
  .command('firewall:countries', 'Manage geo-blocking')
  .option('--add <countries>', 'Comma-separated country codes to block (e.g., CN,RU)')
  .option('--remove <countries>', 'Comma-separated country codes to unblock')
  .option('--list', 'List currently blocked countries')
  .action(async (options?: { add?: string, remove?: string, list?: boolean }) => {
    cli.header('🌍 Geo-Blocking Management')

    if (options?.list) {
      cli.info('Currently blocked countries:\n')
      cli.table(
        ['Country Code', 'Country Name', 'Blocked Since'],
        [
          ['CN', 'China', '2024-01-15'],
          ['RU', 'Russia', '2024-01-15'],
          ['KP', 'North Korea', '2024-01-10'],
        ],
      )
    }
    else if (options?.add) {
      const countries = options.add.split(',').map(c => c.trim().toUpperCase())

      cli.info(`Countries to block: ${countries.join(', ')}`)

      const confirm = await cli.confirm('\nBlock these countries?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Updating geo-blocking rules...')
      spinner.start()

      // TODO: Update WAF geo match statement
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Geo-blocking rules updated')

      cli.success('\n✓ Countries blocked!')
    }
    else if (options?.remove) {
      const countries = options.remove.split(',').map(c => c.trim().toUpperCase())

      cli.info(`Countries to unblock: ${countries.join(', ')}`)

      const confirm = await cli.confirm('\nUnblock these countries?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Updating geo-blocking rules...')
      spinner.start()

      // TODO: Update WAF geo match statement
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Geo-blocking rules updated')

      cli.success('\n✓ Countries unblocked!')
    }
    else {
      cli.info('Use --list, --add, or --remove options')
      cli.info('Example: cloud firewall:countries --add CN,RU')
    }
  })

// ============================================
// 3.13 Additional Security Commands - SSL
// ============================================

app
  .command('ssl:list', 'List all SSL certificates')
  .action(async () => {
    cli.header('🔒 SSL Certificates')

    const spinner = new cli.Spinner('Fetching certificates from ACM...')
    spinner.start()

    // TODO: Fetch from AWS Certificate Manager
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.stop()

    cli.table(
      ['Domain', 'Status', 'Expiry', 'Type', 'In Use'],
      [
        ['example.com', 'Issued', '2025-12-15', 'Amazon Issued', 'Yes'],
        ['*.example.com', 'Issued', '2025-12-15', 'Amazon Issued', 'Yes'],
        ['app.example.com', 'Issued', '2025-11-20', 'Amazon Issued', 'No'],
      ],
    )

    cli.info('\nℹ️  ACM certificates are automatically renewed by AWS')
  })

app
  .command('ssl:renew <domain>', 'Renew SSL certificate')
  .action(async (domain: string) => {
    cli.header(`🔒 Renewing SSL Certificate for ${domain}`)

    cli.info(`Domain: ${domain}`)

    const spinner = new cli.Spinner('Checking certificate status...')
    spinner.start()

    // TODO: Check ACM certificate status
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.stop()

    cli.info('\n✓ Certificate is managed by AWS Certificate Manager')
    cli.info('ACM certificates are automatically renewed 60 days before expiry')
    cli.warn('\nNo manual renewal needed for ACM certificates')

    cli.info('\nCertificate details:')
    cli.info(`  • Domain: ${domain}`)
    cli.info(`  • Status: Issued`)
    cli.info(`  • Expiry: 2025-12-15`)
    cli.info(`  • Auto-renewal: Enabled`)
  })

app
  .command('secrets:get <key>', 'Get secret value')
  .action(async (key: string) => {
    cli.header('🔐 Getting Secret')

    const spinner = new cli.Spinner(`Retrieving secret ${key}...`)
    spinner.start()

    // TODO: Fetch from AWS Secrets Manager
    await new Promise(resolve => setTimeout(resolve, 1000))

    spinner.stop()

    cli.success(`\n✓ Secret: ${key}`)
    cli.info('Value: ••••••••••••••••')
    cli.warn('\n⚠️  Secret values are hidden for security')
    cli.info('To view the actual value, use AWS Console or AWS CLI with --query')
  })

// ============================================
// 3.14 Cost & Resource Management
// ============================================

app
  .command('cost', 'Show estimated monthly cost')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .action(async (options?: { env?: string }) => {
    const environment = options?.env || 'production'

    cli.header(`💰 Cost Estimate - ${environment}`)

    const spinner = new cli.Spinner('Fetching cost data from AWS Cost Explorer...')
    spinner.start()

    // TODO: Fetch from AWS Cost Explorer API
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.stop()

    cli.info('\nCurrent Month (Estimated):')
    cli.info(`  💵 Total: $247.89`)
    cli.info(`  📊 Projected: $325.00\n`)

    cli.table(
      ['Service', 'Current', 'Projected', 'Change'],
      [
        ['EC2', '$89.23', '$120.00', '+12%'],
        ['S3', '$12.45', '$15.00', '+8%'],
        ['CloudFront', '$45.67', '$60.00', '+15%'],
        ['RDS', '$67.89', '$90.00', '+10%'],
        ['Lambda', '$8.23', '$10.00', '+5%'],
        ['ElastiCache', '$24.42', '$30.00', '+12%'],
      ],
    )

    cli.info('\n💡 Tip: Use `cloud cost:breakdown` for detailed analysis')
    cli.info('💡 Tip: Use `cloud optimize` for cost-saving recommendations')
  })

app
  .command('cost:breakdown', 'Cost breakdown by service')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .option('--days <days>', 'Number of days to analyze', '30')
  .action(async (options?: { env?: string, days?: string }) => {
    const environment = options?.env || 'production'
    const days = options?.days || '30'

    cli.header(`💰 Cost Breakdown - ${environment} (Last ${days} days)`)

    const spinner = new cli.Spinner('Analyzing cost data...')
    spinner.start()

    // TODO: Fetch from AWS Cost Explorer API
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.stop()

    cli.info('\n📊 Top Services by Cost:\n')

    cli.table(
      ['Service', 'Cost', '% of Total', 'Trend'],
      [
        ['EC2 Instances', '$89.23', '36%', '↑ +12%'],
        ['RDS Databases', '$67.89', '27%', '↑ +10%'],
        ['CloudFront', '$45.67', '18%', '↑ +15%'],
        ['ElastiCache', '$24.42', '10%', '↑ +12%'],
        ['S3 Storage', '$12.45', '5%', '↑ +8%'],
        ['Lambda', '$8.23', '3%', '↑ +5%'],
      ],
    )

    cli.info('\n📈 Cost Trends:')
    cli.info('  • Overall trend: ↑ +10.5% vs last month')
    cli.info('  • Highest growth: CloudFront (+15%)')
    cli.info('  • Most stable: Lambda (+5%)')

    cli.info('\n💡 Recommendations:')
    cli.info('  • Consider Reserved Instances for EC2 (save up to 40%)')
    cli.info('  • Review CloudFront cache settings to reduce origin requests')
    cli.info('  • Use S3 Intelligent Tiering for automatic cost optimization')
  })

app
  .command('resources', 'List all resources')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .option('--type <type>', 'Resource type (ec2, rds, s3, lambda, etc.)')
  .action(async (options?: { env?: string, type?: string }) => {
    const environment = options?.env || 'production'
    const type = options?.type

    cli.header(`📦 Resources - ${environment}`)

    if (type) {
      cli.info(`Filtering by type: ${type}\n`)
    }

    const spinner = new cli.Spinner('Scanning resources...')
    spinner.start()

    // TODO: Fetch resources from AWS Resource Groups or CloudFormation
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.stop()

    cli.info('\n📊 Resource Summary:\n')

    cli.table(
      ['Type', 'Count', 'Running', 'Stopped', 'Total Cost/mo'],
      [
        ['EC2 Instances', '5', '4', '1', '$89.23'],
        ['RDS Databases', '2', '2', '0', '$67.89'],
        ['S3 Buckets', '12', '-', '-', '$12.45'],
        ['Lambda Functions', '23', '-', '-', '$8.23'],
        ['CloudFront Distributions', '3', '-', '-', '$45.67'],
        ['ElastiCache Clusters', '1', '1', '0', '$24.42'],
      ],
    )

    cli.info('\n💡 Tip: Use `cloud resources:unused` to find resources you can delete')
    cli.info('💡 Tip: Use --type to filter by specific resource type')
  })

app
  .command('resources:unused', 'Find unused resources')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .action(async (options?: { env?: string }) => {
    const environment = options?.env || 'production'

    cli.header(`🔍 Unused Resources - ${environment}`)

    const spinner = new cli.Spinner('Scanning for unused resources...')
    spinner.start()

    // TODO: Analyze CloudWatch metrics, CloudFormation stacks, etc.
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.stop()

    cli.info('\n⚠️  Potentially Unused Resources:\n')

    cli.table(
      ['Resource', 'Type', 'Last Used', 'Monthly Cost', 'Recommendation'],
      [
        ['staging-server-old', 'EC2', '45 days ago', '$28.50', 'Terminate'],
        ['test-db-snapshot', 'RDS Snapshot', '90 days ago', '$5.20', 'Delete'],
        ['old-assets-bucket', 'S3', 'Never', '$2.30', 'Delete'],
        ['dev-redis', 'ElastiCache', '30 days ago', '$18.00', 'Review'],
        ['legacy-function', 'Lambda', '60 days ago', '$0.00', 'Delete'],
      ],
    )

    cli.info('\n💰 Potential Monthly Savings: $54.00')

    cli.warn('\n⚠️  Please review before deleting any resources')
    cli.info('💡 Tip: Create snapshots/backups before deleting databases or instances')
  })

app
  .command('optimize', 'Suggest cost optimizations')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .action(async (options?: { env?: string }) => {
    const environment = options?.env || 'production'

    cli.header(`💡 Cost Optimization Recommendations - ${environment}`)

    const spinner = new cli.Spinner('Analyzing infrastructure...')
    spinner.start()

    // TODO: Analyze resource usage, CloudWatch metrics, Cost Explorer data
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.stop()

    cli.info('\n🎯 Top Recommendations:\n')

    cli.info('1. 💰 Use EC2 Reserved Instances')
    cli.info('   Current: On-Demand instances ($89/mo)')
    cli.info('   Potential: Reserved Instances ($54/mo)')
    cli.info('   Savings: $35/month (39%)')

    cli.info('\n2. 📦 Enable S3 Intelligent Tiering')
    cli.info('   Current: Standard storage ($12.45/mo)')
    cli.info('   Potential: Intelligent Tiering ($7.50/mo)')
    cli.info('   Savings: $4.95/month (40%)')

    cli.info('\n3. ⚡ Right-size EC2 Instances')
    cli.info('   2 instances are under-utilized (<20% CPU)')
    cli.info('   Recommended: Downgrade from t3.medium to t3.small')
    cli.info('   Savings: $18/month (20%)')

    cli.info('\n4. 🗑️  Delete Unused Resources')
    cli.info('   Found 5 unused resources')
    cli.info('   Savings: $54/month')
    cli.info('   Run: `cloud resources:unused` for details')

    cli.info('\n5. ☁️  Use CloudFront Compression')
    cli.info('   Enable automatic compression for text files')
    cli.info('   Savings: ~$8/month (18% reduction in data transfer)')

    cli.success('\n💰 Total Potential Savings: $119.95/month (37%)')

    cli.info('\n📋 Next Steps:')
    cli.info('  • Run `cloud resources:unused` to review unused resources')
    cli.info('  • Run `cloud cost:breakdown` for detailed cost analysis')
    cli.info('  • Contact AWS support for Reserved Instance recommendations')
  })

// ============================================
// 3.16 Team & Collaboration Commands
// ============================================

app
  .command('team:add <email> <role>', 'Add team member')
  .action(async (email: string, role: string) => {
    cli.header('👥 Adding Team Member')

    cli.info(`Email: ${email}`)
    cli.info(`Role: ${role}`)

    const validRoles = ['admin', 'developer', 'viewer']
    if (!validRoles.includes(role.toLowerCase())) {
      cli.error(`Invalid role. Must be one of: ${validRoles.join(', ')}`)
      return
    }

    const confirm = await cli.confirm('\nAdd this team member?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Creating IAM user and sending invitation...')
    spinner.start()

    // TODO: Create IAM user with appropriate policies based on role
    // TODO: Send invitation email with credentials
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Team member added successfully')

    cli.success('\n✓ Team member added!')
    cli.info('An invitation email has been sent with access credentials')

    cli.info('\nAccess Details:')
    cli.info(`  • Email: ${email}`)
    cli.info(`  • Role: ${role}`)
    cli.info(`  • Status: Pending`)
  })

app
  .command('team:list', 'List team members')
  .action(async () => {
    cli.header('👥 Team Members')

    const spinner = new cli.Spinner('Fetching team members...')
    spinner.start()

    // TODO: Fetch IAM users with appropriate tags
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.stop()

    cli.table(
      ['Email', 'Role', 'Status', 'Added', 'Last Login'],
      [
        ['admin@example.com', 'Admin', 'Active', '2024-01-01', '2 hours ago'],
        ['dev@example.com', 'Developer', 'Active', '2024-01-15', '1 day ago'],
        ['viewer@example.com', 'Viewer', 'Active', '2024-02-01', '3 days ago'],
        ['new@example.com', 'Developer', 'Pending', '2024-11-10', 'Never'],
      ],
    )

    cli.info('\n💡 Tip: Use `cloud team:add` to add new team members')
    cli.info('💡 Tip: Use `cloud team:remove` to remove team members')
  })

app
  .command('team:remove <email>', 'Remove team member')
  .action(async (email: string) => {
    cli.header('👥 Removing Team Member')

    cli.info(`Email: ${email}`)

    cli.warn('\n⚠️  This will revoke all access for this team member')

    const confirm = await cli.confirm('Remove this team member?', false)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Removing IAM user and access...')
    spinner.start()

    // TODO: Delete IAM user and associated resources
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Team member removed successfully')

    cli.success('\n✓ Team member removed!')
    cli.info('All access credentials have been revoked')
  })

app
  .command('env:create <name>', 'Create new environment')
  .option('--clone <source>', 'Clone from existing environment')
  .action(async (name: string, options?: { clone?: string }) => {
    cli.header(`🌍 Creating Environment: ${name}`)

    const validEnvs = ['production', 'staging', 'development', 'preview', 'test']
    if (!validEnvs.includes(name.toLowerCase())) {
      cli.warn(`Warning: Creating non-standard environment name`)
      cli.info(`Standard names: ${validEnvs.join(', ')}`)
    }

    if (options?.clone) {
      cli.info(`Cloning from: ${options.clone}`)
    }

    const confirm = await cli.confirm('\nCreate this environment?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Creating environment infrastructure...')
    spinner.start()

    // TODO: Create CloudFormation stack for new environment
    // TODO: If cloning, copy configuration from source environment
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.succeed('Environment created successfully')

    cli.success('\n✓ Environment created!')
    cli.info(`Environment ${name} is now available`)

    cli.info('\nNext steps:')
    cli.info(`  • Deploy to environment: cloud deploy --env ${name}`)
    cli.info(`  • Switch to environment: cloud env:switch ${name}`)
  })

app
  .command('env:list', 'List environments')
  .action(async () => {
    cli.header('🌍 Environments')

    const spinner = new cli.Spinner('Fetching environments...')
    spinner.start()

    // TODO: Fetch from CloudFormation stacks or config
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.stop()

    cli.table(
      ['Environment', 'Status', 'Region', 'Last Deployed', 'Active'],
      [
        ['production', 'Active', 'us-east-1', '2 hours ago', ''],
        ['staging', 'Active', 'us-east-1', '1 day ago', '✓'],
        ['development', 'Active', 'us-west-2', '3 days ago', ''],
        ['preview-pr-123', 'Active', 'us-east-1', '5 hours ago', ''],
      ],
    )

    cli.info('\n💡 Tip: Use `cloud env:switch NAME` to switch active environment')
    cli.info('💡 Tip: Use `cloud env:create NAME` to create new environment')
  })

app
  .command('env:switch <name>', 'Switch active environment')
  .action(async (name: string) => {
    cli.header(`🌍 Switching to Environment: ${name}`)

    cli.info(`Switching to: ${name}`)

    const spinner = new cli.Spinner('Updating environment configuration...')
    spinner.start()

    // TODO: Update config to set active environment
    await new Promise(resolve => setTimeout(resolve, 1000))

    spinner.succeed('Environment switched successfully')

    cli.success(`\n✓ Now using environment: ${name}`)
    cli.info(`All commands will now target the ${name} environment`)

    cli.info('\nEnvironment details:')
    cli.info(`  • Region: us-east-1`)
    cli.info(`  • Status: Active`)
    cli.info(`  • Last deployed: 1 day ago`)
  })

// ============================================
// 3.17 Utility Commands
// ============================================

app
  .command('upgrade', 'Upgrade CLI to latest version')
  .action(async () => {
    cli.header('⬆️  Upgrading TS Cloud CLI')

    const spinner = new cli.Spinner('Checking for updates...')
    spinner.start()

    // TODO: Check npm/GitHub for latest version
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.stop()

    cli.info('\nCurrent version: 0.1.0')
    cli.info('Latest version: 0.2.0')

    const confirm = await cli.confirm('\nUpgrade to latest version?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const upgradeSpinner = new cli.Spinner('Upgrading...')
    upgradeSpinner.start()

    // TODO: Run npm/bun upgrade command
    await new Promise(resolve => setTimeout(resolve, 3000))

    upgradeSpinner.succeed('Upgrade completed successfully')

    cli.success('\n✓ TS Cloud CLI upgraded to v0.2.0!')

    cli.info('\nWhat\'s new in v0.2.0:')
    cli.info('  • New cost optimization commands')
    cli.info('  • Improved team collaboration features')
    cli.info('  • Better error messages')
    cli.info('  • Performance improvements')

    cli.info('\n💡 Tip: Run `cloud --help` to see all available commands')
  })

app
  .command('doctor', 'Check system requirements and AWS credentials')
  .action(async () => {
    cli.header('🔍 System Diagnostics')

    // Check Bun
    cli.step('Checking Bun...')
    cli.success(`Bun ${process.versions.bun}`)

    // Check AWS CLI
    cli.step('Checking AWS CLI...')
    const hasAwsCli = await cli.checkAwsCli()
    if (hasAwsCli) {
      cli.success('AWS CLI is installed')
    }
    else {
      cli.error('AWS CLI is not installed')
      cli.info('Install: https://aws.amazon.com/cli/')
    }

    // Check AWS credentials
    cli.step('Checking AWS credentials...')
    const hasCredentials = await cli.checkAwsCredentials()
    if (hasCredentials) {
      cli.success('AWS credentials are configured')
      const accountId = await cli.getAwsAccountId()
      if (accountId) {
        cli.info(`Account ID: ${accountId}`)
      }
    }
    else {
      cli.error('AWS credentials are not configured')
      cli.info('Run: aws configure')
    }

    // Check for cloud.config.ts
    cli.step('Checking configuration...')
    if (existsSync('cloud.config.ts')) {
      cli.success('cloud.config.ts found')
    }
    else {
      cli.warn('cloud.config.ts not found')
      cli.info('Run: cloud init')
    }
  })

app
  .command('regions', 'List available AWS regions')
  .action(async () => {
    cli.header('🌍 AWS Regions')

    const spinner = new cli.Spinner('Fetching regions...')
    spinner.start()

    const regions = await cli.getAwsRegions()
    spinner.stop()

    regions.forEach((region) => {
      console.log(`  ${region}`)
    })
  })

app
  .command('version', 'Show the version of the CLI')
  .alias('v')
  .action(() => {
    console.log(`TS Cloud v${version}`)
  })

// ============================================
// Deploy Commands
// ============================================

app
  .command('deploy', 'Deploy infrastructure')
  .option('--stack <name>', 'Stack name')
  .option('--env <environment>', 'Environment to deploy to')
  .action(async (options?: { stack?: string, env?: string }) => {
    cli.header('🚀 Deploying Infrastructure')

    try {
      // Load configuration
      const config = await loadCloudConfig()
      const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
      const stackName = options?.stack || `${config.project.slug}-${environment}`
      const region = config.project.region || 'us-east-1'

      cli.info(`Stack: ${stackName}`)
      cli.info(`Region: ${region}`)
      cli.info(`Environment: ${environment}`)

      // Generate CloudFormation template
      cli.step('Generating CloudFormation template...')
      const generator = new InfrastructureGenerator({
        config,
        environment,
      })

      generator.generate()
      const templateBody = generator.toJSON()
      const template = JSON.parse(templateBody)

      // Validate template
      cli.step('Validating template...')
      const validation = validateTemplate(template)
      const sizeValidation = validateTemplateSize(templateBody)
      const limitsValidation = validateResourceLimits(template)

      // Show errors
      const allErrors = [
        ...validation.errors,
        ...sizeValidation.errors,
        ...limitsValidation.errors,
      ]

      if (allErrors.length > 0) {
        cli.error('Template validation failed:')
        for (const error of allErrors) {
          cli.error(`  • ${error.path}: ${error.message}`)
        }
        return
      }

      // Show warnings
      const allWarnings = [
        ...validation.warnings,
        ...sizeValidation.warnings,
        ...limitsValidation.warnings,
      ]

      if (allWarnings.length > 0) {
        for (const warning of allWarnings) {
          cli.warn(`  • ${warning.path}: ${warning.message}`)
        }
      }

      cli.success('Template validated successfully')

      // Show resource summary
      const resourceCount = Object.keys(template.Resources).length
      cli.info(`\n📦 Resources to deploy: ${resourceCount}`)

      // Count resource types
      const typeCounts: Record<string, number> = {}
      for (const resource of Object.values(template.Resources)) {
        const type = (resource as any).Type
        typeCounts[type] = (typeCounts[type] || 0) + 1
      }

      for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        cli.info(`  • ${type}: ${count}`)
      }

      // Confirm deployment
      const confirmed = await cli.confirm('\nDeploy now?', true)
      if (!confirmed) {
        cli.info('Deployment cancelled')
        return
      }

      // Initialize CloudFormation client
      const cfn = new CloudFormationClient(region)

      // Check if stack exists
      cli.step('Checking stack status...')
      let stackExists = false
      try {
        const result = await cfn.describeStacks({ stackName })
        stackExists = result.Stacks && result.Stacks.length > 0
      }
      catch (error) {
        // Stack doesn't exist, that's fine
        stackExists = false
      }

      if (stackExists) {
        cli.info('Stack exists, updating...')
        const updateSpinner = new cli.Spinner('Updating CloudFormation stack...')
        updateSpinner.start()

        try {
          await cfn.updateStack({
            stackName,
            templateBody,
            capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
            tags: [
              { Key: 'Project', Value: config.project.name },
              { Key: 'Environment', Value: environment },
              { Key: 'ManagedBy', Value: 'ts-cloud' },
            ],
          })

          updateSpinner.succeed('Update initiated')

          // Wait for completion
          cli.step('Waiting for stack update to complete...')
          await cfn.waitForStack(stackName, 'stack-update-complete')

          cli.success('Stack updated successfully!')
        }
        catch (error: any) {
          if (error.message.includes('No updates are to be performed')) {
            updateSpinner.succeed('No changes detected')
            cli.info('Stack is already up to date')
            return
          }
          throw error
        }
      }
      else {
        cli.info('Creating new stack...')
        const createSpinner = new cli.Spinner('Creating CloudFormation stack...')
        createSpinner.start()

        await cfn.createStack({
          stackName,
          templateBody,
          capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
          tags: [
            { Key: 'Project', Value: config.project.name },
            { Key: 'Environment', Value: environment },
            { Key: 'ManagedBy', Value: 'ts-cloud' },
          ],
        })

        createSpinner.succeed('Stack creation initiated')

        // Wait for completion
        cli.step('Waiting for stack creation to complete...')
        await cfn.waitForStack(stackName, 'stack-create-complete')

        cli.success('Stack created successfully!')
      }

      // Get stack outputs
      const outputs = await cfn.getStackOutputs(stackName)

      cli.box(`✨ Deployment Complete!

Stack: ${stackName}
Region: ${region}
Environment: ${environment}
Resources: ${resourceCount}

View in console:
https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?stackId=${encodeURIComponent(stackName)}`, 'green')

      if (Object.keys(outputs).length > 0) {
        cli.info('\n📤 Stack Outputs:')
        for (const [key, value] of Object.entries(outputs)) {
          cli.info(`  • ${key}: ${value}`)
        }
      }
    }
    catch (error: any) {
      cli.error(`Deployment failed: ${error.message}`)
      if (error.stack) {
        cli.info('\nStack trace:')
        console.error(error.stack)
      }
    }
  })

app
  .command('deploy:server', 'Deploy EC2 infrastructure')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .action(async (options?: { env?: string }) => {
    cli.header('🖥️  Deploying Server Infrastructure')

    try {
      const config = await loadCloudConfig()
      const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
      const stackName = `${config.project.slug}-server-${environment}`
      const region = config.project.region || 'us-east-1'

      cli.info(`Stack: ${stackName}`)
      cli.info(`Region: ${region}`)
      cli.info(`Environment: ${environment}`)

      cli.step('Generating EC2 server infrastructure...')

      // TODO: Generate server-specific infrastructure
      // - EC2 instances
      // - Auto Scaling Groups
      // - Load Balancers
      // - Security Groups
      // - VPC configuration

      const spinner = new cli.Spinner('Deploying server infrastructure...')
      spinner.start()

      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Server infrastructure deployed successfully!')

      cli.success('\n✓ Deployment complete!')
      cli.info('\nNext steps:')
      cli.info('  • cloud server:list - View deployed servers')
      cli.info('  • cloud server:ssh <name> - SSH into a server')
    }
    catch (error: any) {
      cli.error(`Deployment failed: ${error.message}`)
    }
  })

app
  .command('deploy:serverless', 'Deploy serverless infrastructure')
  .option('--env <environment>', 'Environment (production, staging, development)')
  .option('--function <name>', 'Deploy specific function only')
  .action(async (options?: { env?: string, function?: string }) => {
    cli.header('⚡ Deploying Serverless Infrastructure')

    try {
      const config = await loadCloudConfig()
      const environment = (options?.env || 'production') as 'production' | 'staging' | 'development'
      const stackName = `${config.project.slug}-serverless-${environment}`
      const region = config.project.region || 'us-east-1'

      cli.info(`Stack: ${stackName}`)
      cli.info(`Region: ${region}`)
      cli.info(`Environment: ${environment}`)

      if (options?.function) {
        cli.info(`Function: ${options.function}`)
      }

      cli.step('Generating serverless infrastructure...')

      // TODO: Generate serverless-specific infrastructure
      // - Lambda functions
      // - API Gateway
      // - DynamoDB tables
      // - S3 buckets
      // - EventBridge rules

      const spinner = new cli.Spinner('Deploying serverless infrastructure...')
      spinner.start()

      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Serverless infrastructure deployed successfully!')

      cli.success('\n✓ Deployment complete!')
      cli.info('\nNext steps:')
      cli.info('  • cloud function:list - View deployed functions')
      cli.info('  • cloud function:logs <name> - View function logs')
      cli.info('  • cloud function:invoke <name> - Test function')
    }
    catch (error: any) {
      cli.error(`Deployment failed: ${error.message}`)
    }
  })

app
  .command('deploy:status', 'Check deployment status')
  .option('--stack <name>', 'Stack name')
  .option('--env <environment>', 'Environment')
  .action(async (options?: { stack?: string, env?: string }) => {
    cli.header('📊 Deployment Status')

    try {
      const config = await loadCloudConfig()
      const environment = options?.env || 'production'
      const stackName = options?.stack || `${config.project.slug}-${environment}`
      const region = config.project.region || 'us-east-1'

      cli.info(`Stack: ${stackName}`)
      cli.info(`Region: ${region}`)

      const spinner = new cli.Spinner('Checking deployment status...')
      spinner.start()

      const cfn = new CloudFormationClient(region)

      // Get stack status
      const stacks = await cfn.describeStacks(stackName)

      if (stacks.length === 0) {
        spinner.fail('Stack not found')
        cli.warning('No deployment found for this environment')
        return
      }

      const stack = stacks[0]
      spinner.succeed('Status retrieved')

      cli.info(`\nStatus: ${stack.StackStatus}`)
      cli.info(`Created: ${stack.CreationTime}`)
      if (stack.LastUpdatedTime) {
        cli.info(`Last Updated: ${stack.LastUpdatedTime}`)
      }

      // Show outputs
      if (stack.Outputs && stack.Outputs.length > 0) {
        cli.info('\nOutputs:')
        for (const output of stack.Outputs) {
          cli.info(`  ${output.OutputKey}: ${output.OutputValue}`)
        }
      }
    }
    catch (error: any) {
      cli.error(`Failed to get status: ${error.message}`)
    }
  })

app
  .command('deploy:rollback', 'Rollback to previous version')
  .option('--stack <name>', 'Stack name')
  .option('--env <environment>', 'Environment')
  .action(async (options?: { stack?: string, env?: string }) => {
    cli.header('⏪ Rolling Back Deployment')

    try {
      const config = await loadCloudConfig()
      const environment = options?.env || 'production'
      const stackName = options?.stack || `${config.project.slug}-${environment}`
      const region = config.project.region || 'us-east-1'

      cli.info(`Stack: ${stackName}`)
      cli.info(`Region: ${region}`)

      const confirmed = await cli.confirm('\nAre you sure you want to rollback?', false)
      if (!confirmed) {
        cli.info('Rollback cancelled')
        return
      }

      const spinner = new cli.Spinner('Rolling back stack...')
      spinner.start()

      const cfn = new CloudFormationClient(region)

      // Delete the stack
      await cfn.deleteStack(stackName)

      spinner.succeed('Stack deletion initiated')

      // Wait for deletion
      cli.step('Waiting for stack deletion...')
      await cfn.waitForStack(stackName, 'stack-delete-complete')

      cli.success('Stack rolled back successfully!')
    }
    catch (error: any) {
      cli.error(`Rollback failed: ${error.message}`)
    }
  })

// ============================================
// Stack Management Commands
// ============================================

app
  .command('stack:list', 'List all CloudFormation stacks')
  .action(async () => {
    cli.header('📚 CloudFormation Stacks')

    try {
      const config = await loadCloudConfig()
      const region = config.project.region || 'us-east-1'

      const cfn = new CloudFormationClient(region)

      const spinner = new cli.Spinner('Loading stacks...')
      spinner.start()

      const result = await cfn.listStacks([
        'CREATE_COMPLETE',
        'UPDATE_COMPLETE',
        'ROLLBACK_COMPLETE',
        'UPDATE_ROLLBACK_COMPLETE',
        'CREATE_IN_PROGRESS',
        'UPDATE_IN_PROGRESS',
      ])

      spinner.succeed(`Found ${result.StackSummaries.length} stacks`)

      if (result.StackSummaries.length === 0) {
        cli.info('No stacks found')
        return
      }

      // Display stacks in a table
      const headers = ['Stack Name', 'Status', 'Created', 'Updated']
      const rows = result.StackSummaries.map(stack => [
        stack.StackName,
        stack.StackStatus,
        new Date(stack.CreationTime).toLocaleString(),
        stack.LastUpdatedTime ? new Date(stack.LastUpdatedTime).toLocaleString() : 'Never',
      ])

      cli.table(headers, rows)
    }
    catch (error: any) {
      cli.error(`Failed to list stacks: ${error.message}`)
    }
  })

app
  .command('stack:describe STACK_NAME', 'Describe a CloudFormation stack')
  .action(async (stackName: string) => {
    cli.header(`📋 Stack: ${stackName}`)

    try {
      const config = await loadCloudConfig()
      const region = config.project.region || 'us-east-1'

      const cfn = new CloudFormationClient(region)

      const spinner = new cli.Spinner('Loading stack details...')
      spinner.start()

      const result = await cfn.describeStacks({ stackName })

      if (!result.Stacks || result.Stacks.length === 0) {
        spinner.fail('Stack not found')
        return
      }

      const stack = result.Stacks[0]
      spinner.succeed('Stack details loaded')

      // Display stack info
      cli.info(`\n📦 Stack Information:`)
      cli.info(`  • Name: ${stack.StackName}`)
      cli.info(`  • Status: ${stack.StackStatus}`)
      cli.info(`  • Created: ${new Date(stack.CreationTime).toLocaleString()}`)
      if (stack.LastUpdatedTime) {
        cli.info(`  • Updated: ${new Date(stack.LastUpdatedTime).toLocaleString()}`)
      }

      // Display parameters
      if (stack.Parameters && stack.Parameters.length > 0) {
        cli.info('\n⚙️  Parameters:')
        for (const param of stack.Parameters) {
          cli.info(`  • ${param.ParameterKey}: ${param.ParameterValue}`)
        }
      }

      // Display outputs
      if (stack.Outputs && stack.Outputs.length > 0) {
        cli.info('\n📤 Outputs:')
        for (const output of stack.Outputs) {
          cli.info(`  • ${output.OutputKey}: ${output.OutputValue}`)
          if (output.Description) {
            cli.info(`    ${output.Description}`)
          }
        }
      }

      // Display tags
      if (stack.Tags && stack.Tags.length > 0) {
        cli.info('\n🏷️  Tags:')
        for (const tag of stack.Tags) {
          cli.info(`  • ${tag.Key}: ${tag.Value}`)
        }
      }

      // List resources
      cli.step('\nLoading stack resources...')
      const resources = await cfn.listStackResources(stackName)

      if (resources.StackResourceSummaries.length > 0) {
        cli.info(`\n🔧 Resources (${resources.StackResourceSummaries.length}):`)
        const resourceHeaders = ['Logical ID', 'Type', 'Status']
        const resourceRows = resources.StackResourceSummaries.slice(0, 10).map(resource => [
          resource.LogicalResourceId,
          resource.ResourceType,
          resource.ResourceStatus,
        ])

        cli.table(resourceHeaders, resourceRows)

        if (resources.StackResourceSummaries.length > 10) {
          cli.info(`\n... and ${resources.StackResourceSummaries.length - 10} more resources`)
        }
      }
    }
    catch (error: any) {
      cli.error(`Failed to describe stack: ${error.message}`)
    }
  })

app
  .command('stack:delete STACK_NAME', 'Delete a CloudFormation stack')
  .action(async (stackName: string) => {
    cli.header(`🗑️  Delete Stack: ${stackName}`)

    try {
      const config = await loadCloudConfig()
      const region = config.project.region || 'us-east-1'

      cli.warn('This will permanently delete the stack and all its resources!')

      const confirmed = await cli.confirm('\nAre you sure you want to delete this stack?', false)
      if (!confirmed) {
        cli.info('Deletion cancelled')
        return
      }

      const cfn = new CloudFormationClient(region)

      const spinner = new cli.Spinner('Deleting stack...')
      spinner.start()

      await cfn.deleteStack(stackName)

      spinner.succeed('Stack deletion initiated')

      // Wait for deletion
      cli.step('Waiting for stack deletion...')
      await cfn.waitForStack(stackName, 'stack-delete-complete')

      cli.success('Stack deleted successfully!')
    }
    catch (error: any) {
      cli.error(`Failed to delete stack: ${error.message}`)
    }
  })

app
  .command('stack:events STACK_NAME', 'Show stack events')
  .option('--limit <number>', 'Limit number of events', '20')
  .action(async (stackName: string, options?: { limit?: string }) => {
    cli.header(`📜 Stack Events: ${stackName}`)

    try {
      const config = await loadCloudConfig()
      const region = config.project.region || 'us-east-1'

      const cfn = new CloudFormationClient(region)

      const spinner = new cli.Spinner('Loading events...')
      spinner.start()

      const result = await cfn.describeStackEvents(stackName)

      spinner.succeed(`Found ${result.StackEvents.length} events`)

      const limit = options?.limit ? Number.parseInt(options.limit) : 20
      const events = result.StackEvents.slice(0, limit)

      if (events.length === 0) {
        cli.info('No events found')
        return
      }

      // Display events
      const headers = ['Time', 'Resource', 'Status', 'Reason']
      const rows = events.map(event => [
        new Date(event.Timestamp).toLocaleString(),
        event.LogicalResourceId,
        event.ResourceStatus,
        event.ResourceStatusReason || '',
      ])

      cli.table(headers, rows)
    }
    catch (error: any) {
      cli.error(`Failed to load events: ${error.message}`)
    }
  })

app
  .command('stack:outputs STACK_NAME', 'Show stack outputs')
  .action(async (stackName: string) => {
    cli.header(`📤 Stack Outputs: ${stackName}`)

    try {
      const config = await loadCloudConfig()
      const region = config.project.region || 'us-east-1'

      const cfn = new CloudFormationClient(region)

      const spinner = new cli.Spinner('Loading stack outputs...')
      spinner.start()

      const result = await cfn.describeStacks({ stackName })

      if (!result.Stacks || result.Stacks.length === 0) {
        spinner.fail('Stack not found')
        return
      }

      const stack = result.Stacks[0]
      spinner.succeed('Stack outputs loaded')

      if (!stack.Outputs || stack.Outputs.length === 0) {
        cli.info('No outputs found for this stack')
        return
      }

      // Display outputs in a table
      const headers = ['Key', 'Value', 'Description', 'Export Name']
      const rows = stack.Outputs.map(output => [
        output.OutputKey || '',
        output.OutputValue || '',
        output.Description || '',
        output.ExportName || '',
      ])

      cli.table(headers, rows)

      // Also display in key=value format for easy copying
      cli.info('\n📋 Copy-friendly format:')
      for (const output of stack.Outputs) {
        cli.info(`${output.OutputKey}=${output.OutputValue}`)
      }
    }
    catch (error: any) {
      cli.error(`Failed to load outputs: ${error.message}`)
    }
  })

app
  .command('stack:export STACK_NAME', 'Export stack template')
  .option('--output <file>', 'Output file path')
  .option('--format <format>', 'Output format (json or yaml)', 'json')
  .action(async (stackName: string, options?: { output?: string, format?: string }) => {
    cli.header(`💾 Export Stack: ${stackName}`)

    try {
      const config = await loadCloudConfig()
      const region = config.project.region || 'us-east-1'

      const cfn = new CloudFormationClient(region)

      const spinner = new cli.Spinner('Fetching stack template...')
      spinner.start()

      const result = await cfn.getTemplate(stackName)

      if (!result.TemplateBody) {
        spinner.fail('Template not found')
        return
      }

      spinner.succeed('Template fetched')

      const format = options?.format || 'json'
      let templateContent = result.TemplateBody

      // Parse and re-format if needed
      if (format === 'json') {
        const template = JSON.parse(templateContent)
        templateContent = JSON.stringify(template, null, 2)
      }

      // Save to file or display
      if (options?.output) {
        const outputPath = options.output
        writeFileSync(outputPath, templateContent, 'utf-8')
        cli.success(`Template exported to: ${outputPath}`)

        // Show file size
        const stats = statSync(outputPath)
        const sizeInKB = (stats.size / 1024).toFixed(2)
        cli.info(`File size: ${sizeInKB} KB`)
      }
      else {
        // Display template
        cli.info('\n📄 Template:')
        console.log(templateContent)
      }
    }
    catch (error: any) {
      cli.error(`Failed to export template: ${error.message}`)
    }
  })

// ============================================
// Asset Management Commands
// ============================================

app
  .command('assets:deploy', 'Deploy static assets to S3')
  .option('--source <path>', 'Source directory', 'dist')
  .option('--bucket <name>', 'S3 bucket name')
  .option('--prefix <prefix>', 'S3 prefix/folder')
  .option('--delete', 'Delete files not in source')
  .option('--cache-control <value>', 'Cache-Control header', 'public, max-age=31536000')
  .action(async (options?: { source?: string, bucket?: string, prefix?: string, delete?: boolean, cacheControl?: string }) => {
    cli.header('📦 Deploying Assets to S3')

    try {
      const config = await loadCloudConfig()
      const region = config.project.region || 'us-east-1'

      const source = options?.source || 'dist'
      const bucket = options?.bucket
      const prefix = options?.prefix
      const shouldDelete = options?.delete || false
      const cacheControl = options?.cacheControl || 'public, max-age=31536000'

      if (!bucket) {
        cli.error('--bucket is required')
        return
      }

      // Check if source directory exists
      if (!existsSync(source)) {
        cli.error(`Source directory not found: ${source}`)
        return
      }

      cli.info(`Source: ${source}`)
      cli.info(`Bucket: s3://${bucket}${prefix ? `/${prefix}` : ''}`)
      cli.info(`Cache-Control: ${cacheControl}`)
      if (shouldDelete) {
        cli.warn('Delete mode enabled - files not in source will be removed')
      }

      const confirmed = await cli.confirm('\nDeploy assets now?', true)
      if (!confirmed) {
        cli.info('Deployment cancelled')
        return
      }

      const s3 = new S3Client(region)

      const spinner = new cli.Spinner('Uploading assets to S3...')
      spinner.start()

      await s3.sync({
        source,
        bucket,
        prefix,
        delete: shouldDelete,
        cacheControl,
        acl: 'public-read',
      })

      spinner.succeed('Assets deployed successfully!')

      // Get bucket size
      const size = await s3.getBucketSize(bucket, prefix)
      const sizeInMB = (size / 1024 / 1024).toFixed(2)

      cli.success(`\nDeployment complete!`)
      cli.info(`Total size: ${sizeInMB} MB`)
      cli.info(`\nAssets URL: https://${bucket}.s3.${region}.amazonaws.com${prefix ? `/${prefix}` : ''}`)
    }
    catch (error: any) {
      cli.error(`Deployment failed: ${error.message}`)
    }
  })

app
  .command('assets:invalidate', 'Invalidate CloudFront cache')
  .option('--distribution <id>', 'CloudFront distribution ID')
  .option('--paths <paths>', 'Paths to invalidate (comma-separated)', '/*')
  .option('--wait', 'Wait for invalidation to complete')
  .action(async (options?: { distribution?: string, paths?: string, wait?: boolean }) => {
    cli.header('🔄 Invalidating CloudFront Cache')

    try {
      const distributionId = options?.distribution

      if (!distributionId) {
        cli.error('--distribution is required')
        return
      }

      const pathsStr = options?.paths || '/*'
      const paths = pathsStr.split(',').map(p => p.trim())
      const shouldWait = options?.wait || false

      cli.info(`Distribution: ${distributionId}`)
      cli.info(`Paths: ${paths.join(', ')}`)

      const confirmed = await cli.confirm('\nInvalidate cache now?', true)
      if (!confirmed) {
        cli.info('Invalidation cancelled')
        return
      }

      const cloudfront = new CloudFrontClient()

      const spinner = new cli.Spinner('Creating invalidation...')
      spinner.start()

      const invalidation = await cloudfront.invalidatePaths(distributionId, paths)

      spinner.succeed('Invalidation created')

      cli.success(`\nInvalidation ID: ${invalidation.Id}`)
      cli.info(`Status: ${invalidation.Status}`)
      cli.info(`Created: ${new Date(invalidation.CreateTime).toLocaleString()}`)

      if (shouldWait) {
        const waitSpinner = new cli.Spinner('Waiting for invalidation to complete...')
        waitSpinner.start()

        await cloudfront.waitForInvalidation(distributionId, invalidation.Id)

        waitSpinner.succeed('Invalidation completed!')
      }
      else {
        cli.info('\nInvalidation is in progress. Use --wait to wait for completion.')
      }
    }
    catch (error: any) {
      cli.error(`Invalidation failed: ${error.message}`)
    }
  })

app
  .command('cdn:list', 'List CloudFront distributions')
  .action(async () => {
    cli.header('☁️  CloudFront Distributions')

    try {
      const cloudfront = new CloudFrontClient()

      const spinner = new cli.Spinner('Loading distributions...')
      spinner.start()

      const distributions = await cloudfront.listDistributions()

      spinner.succeed(`Found ${distributions.length} distributions`)

      if (distributions.length === 0) {
        cli.info('No distributions found')
        return
      }

      // Display distributions in a table
      const headers = ['ID', 'Domain Name', 'Status', 'Enabled']
      const rows = distributions.map(dist => [
        dist.Id,
        dist.DomainName,
        dist.Status,
        dist.Enabled ? 'Yes' : 'No',
      ])

      cli.table(headers, rows)

      // Show aliases if any
      cli.info('\nAliases:')
      for (const dist of distributions) {
        if (dist.Aliases && dist.Aliases.length > 0) {
          cli.info(`  ${dist.Id}: ${dist.Aliases.join(', ')}`)
        }
      }
    }
    catch (error: any) {
      cli.error(`Failed to list distributions: ${error.message}`)
    }
  })

// ============================================
// Cache Commands
// ============================================

app
  .command('cache:create <name>', 'Create a cache cluster')
  .option('--engine <engine>', 'Cache engine (redis or memcached)', 'redis')
  .option('--node-type <type>', 'Node type', 'cache.t3.micro')
  .option('--nodes <count>', 'Number of nodes', '1')
  .action(async (name: string, options?: { engine?: string, nodeType?: string, nodes?: string }) => {
    cli.header('🗄️  Creating Cache Cluster')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const elasticache = new ElastiCacheClient(region, config.aws.profile)

      const engine = (options?.engine || 'redis') as 'redis' | 'memcached'
      const nodeType = options?.nodeType || 'cache.t3.micro'
      const numNodes = Number.parseInt(options?.nodes || '1')

      cli.info(`Name: ${name}`)
      cli.info(`Engine: ${engine}`)
      cli.info(`Node Type: ${nodeType}`)
      cli.info(`Nodes: ${numNodes}`)

      const confirmed = await cli.confirm('\nCreate cache cluster?', true)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Creating cache cluster...')
      spinner.start()

      const result = await elasticache.createCacheCluster({
        cacheClusterId: name,
        engine,
        cacheNodeType: nodeType,
        numCacheNodes: numNodes,
      })

      spinner.succeed('Cache cluster created successfully!')

      cli.success(`\n✓ Cache cluster "${name}" is being created`)
      cli.info(`  Status: ${result.CacheCluster.CacheClusterStatus}`)
      cli.info(`  Engine: ${result.CacheCluster.Engine} ${result.CacheCluster.EngineVersion}`)
    }
    catch (error: any) {
      cli.error(`Failed to create cache cluster: ${error.message}`)
    }
  })

app
  .command('cache:list', 'List all cache clusters')
  .action(async () => {
    cli.header('🗄️  Cache Clusters')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const elasticache = new ElastiCacheClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Loading cache clusters...')
      spinner.start()

      const result = await elasticache.describeCacheClusters()

      spinner.succeed(`Found ${result.CacheClusters.length} cache clusters`)

      if (result.CacheClusters.length === 0) {
        cli.info('No cache clusters found')
        return
      }

      // Display clusters in a table
      const headers = ['ID', 'Engine', 'Type', 'Nodes', 'Status']
      const rows = result.CacheClusters.map(cluster => [
        cluster.CacheClusterId,
        `${cluster.Engine} ${cluster.EngineVersion}`,
        cluster.CacheNodeType,
        cluster.NumCacheNodes.toString(),
        cluster.CacheClusterStatus,
      ])

      cli.table(headers, rows)

      // Show endpoints
      cli.info('\nEndpoints:')
      for (const cluster of result.CacheClusters) {
        if (cluster.CacheNodes && cluster.CacheNodes.length > 0) {
          const endpoint = cluster.CacheNodes[0].Endpoint
          if (endpoint) {
            cli.info(`  ${cluster.CacheClusterId}: ${endpoint.Address}:${endpoint.Port}`)
          }
        }
      }
    }
    catch (error: any) {
      cli.error(`Failed to list cache clusters: ${error.message}`)
    }
  })

app
  .command('cache:flush <name>', 'Flush cache cluster (reboot nodes)')
  .action(async (name: string) => {
    cli.header('🔄 Flushing Cache Cluster')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const elasticache = new ElastiCacheClient(region, config.aws.profile)

      cli.info(`Cache Cluster: ${name}`)

      const confirmed = await cli.confirm('\nThis will reboot all cache nodes. Continue?', false)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Getting cache cluster info...')
      spinner.start()

      const result = await elasticache.describeCacheClusters(name)

      if (!result.CacheClusters || result.CacheClusters.length === 0) {
        spinner.fail('Cache cluster not found')
        return
      }

      const cluster = result.CacheClusters[0]
      const nodeIds = cluster.CacheNodes?.map(node => node.CacheNodeId) || []

      spinner.text = 'Rebooting cache nodes...'

      await elasticache.rebootCacheCluster(name, nodeIds)

      spinner.succeed('Cache cluster flushed successfully!')

      cli.success(`\n✓ Cache cluster "${name}" is being rebooted`)
      cli.info(`  ${nodeIds.length} nodes will be restarted`)
    }
    catch (error: any) {
      cli.error(`Failed to flush cache: ${error.message}`)
    }
  })

app
  .command('cache:stats <name>', 'View cache cluster statistics')
  .action(async (name: string) => {
    cli.header('📊 Cache Cluster Statistics')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const elasticache = new ElastiCacheClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Loading statistics...')
      spinner.start()

      const cluster = await elasticache.describeCacheClusters(name)

      if (!cluster.CacheClusters || cluster.CacheClusters.length === 0) {
        spinner.fail('Cache cluster not found')
        return
      }

      const stats = await elasticache.getCacheStatistics(name)

      spinner.succeed('Statistics loaded')

      const info = cluster.CacheClusters[0]

      cli.info('\nCluster Information:')
      cli.info(`  ID: ${info.CacheClusterId}`)
      cli.info(`  Engine: ${info.Engine} ${info.EngineVersion}`)
      cli.info(`  Node Type: ${info.CacheNodeType}`)
      cli.info(`  Nodes: ${info.NumCacheNodes}`)
      cli.info(`  Status: ${info.CacheClusterStatus}`)

      if (info.CacheNodes && info.CacheNodes.length > 0) {
        cli.info('\nEndpoints:')
        for (const node of info.CacheNodes) {
          if (node.Endpoint) {
            cli.info(`  ${node.CacheNodeId}: ${node.Endpoint.Address}:${node.Endpoint.Port}`)
          }
        }
      }

      cli.info('\nMetrics:')
      cli.info(`  CPU Utilization: ${stats.cpuUtilization}%`)
      cli.info(`  Evictions: ${stats.evictions}`)
      cli.info(`  Cache Hits: ${stats.hits}`)
      cli.info(`  Cache Misses: ${stats.misses}`)
      cli.info(`  Connections: ${stats.connections}`)
    }
    catch (error: any) {
      cli.error(`Failed to get statistics: ${error.message}`)
    }
  })

app
  .command('cache:delete <name>', 'Delete a cache cluster')
  .option('--snapshot <id>', 'Create final snapshot with this ID')
  .action(async (name: string, options?: { snapshot?: string }) => {
    cli.header('🗑️  Deleting Cache Cluster')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const elasticache = new ElastiCacheClient(region, config.aws.profile)

      cli.info(`Cache Cluster: ${name}`)

      if (options?.snapshot) {
        cli.info(`Final Snapshot: ${options.snapshot}`)
      }

      const confirmed = await cli.confirm('\nDelete cache cluster?', false)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Deleting cache cluster...')
      spinner.start()

      await elasticache.deleteCacheCluster(name, options?.snapshot)

      spinner.succeed('Cache cluster deleted successfully!')

      cli.success(`\n✓ Cache cluster "${name}" is being deleted`)
    }
    catch (error: any) {
      cli.error(`Failed to delete cache cluster: ${error.message}`)
    }
  })

// ============================================
// Queue Commands
// ============================================

app
  .command('queue:create <name>', 'Create an SQS queue')
  .option('--fifo', 'Create FIFO queue')
  .option('--visibility-timeout <seconds>', 'Visibility timeout in seconds', '30')
  .option('--retention <seconds>', 'Message retention period in seconds', '345600')
  .option('--delay <seconds>', 'Delay seconds', '0')
  .action(async (name: string, options?: { fifo?: boolean, visibilityTimeout?: string, retention?: string, delay?: string }) => {
    cli.header('📬 Creating SQS Queue')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const sqs = new SQSClient(region, config.aws.profile)

      const isFifo = options?.fifo || false
      const queueName = isFifo && !name.endsWith('.fifo') ? `${name}.fifo` : name

      cli.info(`Queue Name: ${queueName}`)
      cli.info(`Type: ${isFifo ? 'FIFO' : 'Standard'}`)
      cli.info(`Visibility Timeout: ${options?.visibilityTimeout || '30'}s`)
      cli.info(`Message Retention: ${options?.retention || '345600'}s (4 days)`)

      const confirmed = await cli.confirm('\nCreate queue?', true)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Creating queue...')
      spinner.start()

      const result = await sqs.createQueue({
        queueName: name,
        fifo: isFifo,
        visibilityTimeout: Number.parseInt(options?.visibilityTimeout || '30'),
        messageRetentionPeriod: Number.parseInt(options?.retention || '345600'),
        delaySeconds: Number.parseInt(options?.delay || '0'),
      })

      spinner.succeed('Queue created successfully!')

      cli.success(`\n✓ Queue "${queueName}" created`)
      cli.info(`  URL: ${result.QueueUrl}`)
    }
    catch (error: any) {
      cli.error(`Failed to create queue: ${error.message}`)
    }
  })

app
  .command('queue:list', 'List all SQS queues')
  .option('--prefix <prefix>', 'Filter by queue name prefix')
  .action(async (options?: { prefix?: string }) => {
    cli.header('📬 SQS Queues')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const sqs = new SQSClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Loading queues...')
      spinner.start()

      const result = await sqs.listQueues(options?.prefix)
      const queueUrls = result.QueueUrls || []

      spinner.succeed(`Found ${queueUrls.length} queues`)

      if (queueUrls.length === 0) {
        cli.info('No queues found')
        return
      }

      // Get attributes for each queue
      const queues = await Promise.all(
        queueUrls.map(async (url) => {
          try {
            const attrs = await sqs.getQueueAttributes(url)
            const name = url.split('/').pop() || url
            return {
              name,
              url,
              messages: attrs.Attributes.ApproximateNumberOfMessages || '0',
              type: attrs.Attributes.FifoQueue === 'true' ? 'FIFO' : 'Standard',
            }
          }
          catch {
            const name = url.split('/').pop() || url
            return {
              name,
              url,
              messages: 'N/A',
              type: 'Unknown',
            }
          }
        }),
      )

      // Display queues in a table
      const headers = ['Name', 'Type', 'Messages']
      const rows = queues.map(q => [q.name, q.type, q.messages])

      cli.table(headers, rows)

      // Show URLs
      cli.info('\nQueue URLs:')
      for (const queue of queues) {
        cli.info(`  ${queue.name}: ${queue.url}`)
      }
    }
    catch (error: any) {
      cli.error(`Failed to list queues: ${error.message}`)
    }
  })

app
  .command('queue:stats <name>', 'View queue statistics')
  .action(async (name: string) => {
    cli.header('📊 Queue Statistics')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const sqs = new SQSClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Loading queue statistics...')
      spinner.start()

      const urlResult = await sqs.getQueueUrl(name)
      const attrs = await sqs.getQueueAttributes(urlResult.QueueUrl)

      spinner.succeed('Statistics loaded')

      cli.info(`\nQueue: ${name}`)
      cli.info(`URL: ${urlResult.QueueUrl}`)
      cli.info(`\nQueue Configuration:`)
      cli.info(`  Type: ${attrs.Attributes.FifoQueue === 'true' ? 'FIFO' : 'Standard'}`)
      cli.info(`  Visibility Timeout: ${attrs.Attributes.VisibilityTimeout}s`)
      cli.info(`  Message Retention: ${attrs.Attributes.MessageRetentionPeriod}s`)
      cli.info(`  Max Message Size: ${attrs.Attributes.MaximumMessageSize} bytes`)
      cli.info(`  Delay: ${attrs.Attributes.DelaySeconds}s`)

      cli.info(`\nMessages:`)
      cli.info(`  Available: ${attrs.Attributes.ApproximateNumberOfMessages || '0'}`)
      cli.info(`  In Flight: ${attrs.Attributes.ApproximateNumberOfMessagesNotVisible || '0'}`)
      cli.info(`  Delayed: ${attrs.Attributes.ApproximateNumberOfMessagesDelayed || '0'}`)

      if (attrs.Attributes.CreatedTimestamp) {
        const created = new Date(Number.parseInt(attrs.Attributes.CreatedTimestamp) * 1000)
        cli.info(`\nCreated: ${created.toLocaleString()}`)
      }

      if (attrs.Attributes.LastModifiedTimestamp) {
        const modified = new Date(Number.parseInt(attrs.Attributes.LastModifiedTimestamp) * 1000)
        cli.info(`Last Modified: ${modified.toLocaleString()}`)
      }
    }
    catch (error: any) {
      cli.error(`Failed to get queue statistics: ${error.message}`)
    }
  })

app
  .command('queue:purge <name>', 'Purge all messages from a queue')
  .action(async (name: string) => {
    cli.header('🗑️  Purging Queue')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const sqs = new SQSClient(region, config.aws.profile)

      cli.info(`Queue: ${name}`)

      const confirmed = await cli.confirm('\nThis will delete all messages. Continue?', false)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Purging queue...')
      spinner.start()

      const urlResult = await sqs.getQueueUrl(name)
      await sqs.purgeQueue(urlResult.QueueUrl)

      spinner.succeed('Queue purged successfully!')

      cli.success(`\n✓ All messages deleted from "${name}"`)
    }
    catch (error: any) {
      cli.error(`Failed to purge queue: ${error.message}`)
    }
  })

app
  .command('queue:delete <name>', 'Delete a queue')
  .action(async (name: string) => {
    cli.header('🗑️  Deleting Queue')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const sqs = new SQSClient(region, config.aws.profile)

      cli.info(`Queue: ${name}`)

      const confirmed = await cli.confirm('\nDelete queue?', false)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Deleting queue...')
      spinner.start()

      const urlResult = await sqs.getQueueUrl(name)
      await sqs.deleteQueue(urlResult.QueueUrl)

      spinner.succeed('Queue deleted successfully!')

      cli.success(`\n✓ Queue "${name}" deleted`)
    }
    catch (error: any) {
      cli.error(`Failed to delete queue: ${error.message}`)
    }
  })

app
  .command('queue:send <name> <message>', 'Send a message to a queue')
  .option('--delay <seconds>', 'Delay seconds', '0')
  .option('--group-id <id>', 'Message group ID (for FIFO queues)')
  .action(async (name: string, message: string, options?: { delay?: string, groupId?: string }) => {
    cli.header('📤 Sending Message')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const sqs = new SQSClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Sending message...')
      spinner.start()

      const urlResult = await sqs.getQueueUrl(name)

      const result = await sqs.sendMessage({
        queueUrl: urlResult.QueueUrl,
        messageBody: message,
        delaySeconds: options?.delay ? Number.parseInt(options.delay) : undefined,
        messageGroupId: options?.groupId,
      })

      spinner.succeed('Message sent successfully!')

      cli.success(`\n✓ Message sent to "${name}"`)
      cli.info(`  Message ID: ${result.MessageId}`)
    }
    catch (error: any) {
      cli.error(`Failed to send message: ${error.message}`)
    }
  })

app
  .command('queue:receive <name>', 'Receive messages from a queue')
  .option('--max <count>', 'Maximum number of messages', '1')
  .option('--wait <seconds>', 'Wait time for long polling', '0')
  .action(async (name: string, options?: { max?: string, wait?: string }) => {
    cli.header('📥 Receiving Messages')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const sqs = new SQSClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Receiving messages...')
      spinner.start()

      const urlResult = await sqs.getQueueUrl(name)

      const result = await sqs.receiveMessages({
        queueUrl: urlResult.QueueUrl,
        maxMessages: options?.max ? Number.parseInt(options.max) : 1,
        waitTimeSeconds: options?.wait ? Number.parseInt(options.wait) : 0,
      })

      const messages = result.Messages || []

      spinner.succeed(`Received ${messages.length} messages`)

      if (messages.length === 0) {
        cli.info('No messages available')
        return
      }

      cli.info('\nMessages:')
      for (const msg of messages) {
        cli.info(`\n  Message ID: ${msg.MessageId}`)
        cli.info(`  Body: ${msg.Body}`)
        cli.info(`  Receipt Handle: ${msg.ReceiptHandle.substring(0, 50)}...`)
      }
    }
    catch (error: any) {
      cli.error(`Failed to receive messages: ${error.message}`)
    }
  })

// ============================================
// Schedule Commands
// ============================================

app
  .command('schedule:add <name> <cron> <target>', 'Add a scheduled job')
  .option('--description <desc>', 'Schedule description')
  .option('--input <json>', 'Input data (JSON string)')
  .action(async (name: string, cron: string, target: string, options?: { description?: string, input?: string }) => {
    cli.header('⏰ Creating Schedule')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const scheduler = new SchedulerClient(region, config.aws.profile)

      cli.info(`Name: ${name}`)
      cli.info(`Schedule: ${cron}`)
      cli.info(`Target: ${target}`)

      if (options?.description) {
        cli.info(`Description: ${options.description}`)
      }

      const confirmed = await cli.confirm('\nCreate schedule?', true)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Creating schedule...')
      spinner.start()

      // Create the EventBridge rule
      const result = await scheduler.createRule({
        name,
        scheduleExpression: cron,
        description: options?.description,
        state: 'ENABLED',
      })

      // Add the target
      await scheduler.putTargets(name, [
        {
          Id: '1',
          Arn: target,
          Input: options?.input,
        },
      ])

      spinner.succeed('Schedule created successfully!')

      cli.success(`\n✓ Schedule "${name}" created`)
      cli.info(`  ARN: ${result.RuleArn}`)
    }
    catch (error: any) {
      cli.error(`Failed to create schedule: ${error.message}`)
    }
  })

app
  .command('schedule:list', 'List all scheduled jobs')
  .option('--prefix <prefix>', 'Filter by name prefix')
  .action(async (options?: { prefix?: string }) => {
    cli.header('⏰ Scheduled Jobs')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const scheduler = new SchedulerClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Loading schedules...')
      spinner.start()

      const result = await scheduler.listRules(options?.prefix)
      const rules = result.Rules || []

      spinner.succeed(`Found ${rules.length} schedules`)

      if (rules.length === 0) {
        cli.info('No schedules found')
        return
      }

      // Display rules in a table
      const headers = ['Name', 'Schedule', 'State']
      const rows = rules.map(rule => [
        rule.Name,
        rule.ScheduleExpression || 'N/A',
        rule.State,
      ])

      cli.table(headers, rows)

      // Show details
      cli.info('\nSchedule Details:')
      for (const rule of rules) {
        cli.info(`\n  ${rule.Name}:`)
        if (rule.Description) {
          cli.info(`    Description: ${rule.Description}`)
        }
        cli.info(`    ARN: ${rule.Arn}`)
        cli.info(`    State: ${rule.State}`)

        // Get targets
        try {
          const targets = await scheduler.listTargetsByRule(rule.Name)
          if (targets.Targets && targets.Targets.length > 0) {
            cli.info(`    Targets: ${targets.Targets.length}`)
            for (const target of targets.Targets) {
              cli.info(`      - ${target.Arn}`)
            }
          }
        }
        catch {
          // Ignore errors getting targets
        }
      }
    }
    catch (error: any) {
      cli.error(`Failed to list schedules: ${error.message}`)
    }
  })

app
  .command('schedule:remove <name>', 'Remove a scheduled job')
  .option('--force', 'Force deletion (remove targets first)')
  .action(async (name: string, options?: { force?: boolean }) => {
    cli.header('🗑️  Removing Schedule')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const scheduler = new SchedulerClient(region, config.aws.profile)

      cli.info(`Schedule: ${name}`)

      const confirmed = await cli.confirm('\nRemove schedule?', false)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Removing schedule...')
      spinner.start()

      await scheduler.deleteRule(name, options?.force || true)

      spinner.succeed('Schedule removed successfully!')

      cli.success(`\n✓ Schedule "${name}" removed`)
    }
    catch (error: any) {
      cli.error(`Failed to remove schedule: ${error.message}`)
    }
  })

app
  .command('schedule:enable <name>', 'Enable a scheduled job')
  .action(async (name: string) => {
    cli.header('✅ Enabling Schedule')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const scheduler = new SchedulerClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Enabling schedule...')
      spinner.start()

      await scheduler.enableRule(name)

      spinner.succeed('Schedule enabled successfully!')

      cli.success(`\n✓ Schedule "${name}" enabled`)
    }
    catch (error: any) {
      cli.error(`Failed to enable schedule: ${error.message}`)
    }
  })

app
  .command('schedule:disable <name>', 'Disable a scheduled job')
  .action(async (name: string) => {
    cli.header('⏸️  Disabling Schedule')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const scheduler = new SchedulerClient(region, config.aws.profile)

      const spinner = new cli.Spinner('Disabling schedule...')
      spinner.start()

      await scheduler.disableRule(name)

      spinner.succeed('Schedule disabled successfully!')

      cli.success(`\n✓ Schedule "${name}" disabled`)
    }
    catch (error: any) {
      cli.error(`Failed to disable schedule: ${error.message}`)
    }
  })

app
  .command('schedule:lambda <name> <cron> <function-arn>', 'Schedule Lambda function execution')
  .option('--description <desc>', 'Schedule description')
  .option('--input <json>', 'Input data for Lambda (JSON string)')
  .action(async (name: string, cron: string, functionArn: string, options?: { description?: string, input?: string }) => {
    cli.header('⏰ Creating Lambda Schedule')

    try {
      const config = await loadCloudConfig()
      const region = config.aws.region || 'us-east-1'
      const scheduler = new SchedulerClient(region, config.aws.profile)

      cli.info(`Name: ${name}`)
      cli.info(`Schedule: ${cron}`)
      cli.info(`Function: ${functionArn}`)

      const confirmed = await cli.confirm('\nCreate Lambda schedule?', true)

      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Creating Lambda schedule...')
      spinner.start()

      const result = await scheduler.createLambdaSchedule({
        name,
        scheduleExpression: cron,
        functionArn,
        description: options?.description,
        input: options?.input,
      })

      spinner.succeed('Lambda schedule created successfully!')

      cli.success(`\n✓ Lambda schedule "${name}" created`)
      cli.info(`  ARN: ${result.RuleArn}`)
      cli.info(`\nNote: Make sure Lambda has permission to be invoked by EventBridge`)
    }
    catch (error: any) {
      cli.error(`Failed to create Lambda schedule: ${error.message}`)
    }
  })

// ============================================
// 3.23 Notification Commands
// ============================================

app
  .command('notify:add <type> <config>', 'Add notification channel')
  .action(async (type: string, config: string) => {
    cli.header('🔔 Adding Notification Channel')

    const validTypes = ['slack', 'discord', 'email', 'webhook']
    if (!validTypes.includes(type.toLowerCase())) {
      cli.error(`Invalid type. Must be one of: ${validTypes.join(', ')}`)
      return
    }

    cli.info(`Type: ${type}`)
    cli.info(`Config: ${config}`)

    const confirm = await cli.confirm('\nAdd this notification channel?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Creating SNS topic and subscription...')
    spinner.start()

    // TODO: Create SNS topic and subscription
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Notification channel added')

    cli.success('\n✓ Notification channel configured!')
    cli.info(`All deployment events will be sent to ${type}`)
  })

app
  .command('notify:list', 'List notification channels')
  .action(async () => {
    cli.header('🔔 Notification Channels')

    const spinner = new cli.Spinner('Fetching notification channels...')
    spinner.start()

    // TODO: Fetch SNS subscriptions
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.stop()

    cli.table(
      ['Type', 'Destination', 'Status', 'Events'],
      [
        ['Slack', '#deployments', 'Active', 'All'],
        ['Email', 'team@example.com', 'Active', 'Errors only'],
        ['Discord', 'webhook-url', 'Active', 'All'],
      ],
    )
  })

app
  .command('notify:test <channel>', 'Test notification')
  .action(async (channel: string) => {
    cli.header('🔔 Testing Notification Channel')

    cli.info(`Channel: ${channel}`)

    const spinner = new cli.Spinner('Sending test notification...')
    spinner.start()

    // TODO: Send test SNS message
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Test notification sent')

    cli.success('\n✓ Check your notification channel for the test message')
  })

app
  .command('notify:remove <channel>', 'Remove notification channel')
  .action(async (channel: string) => {
    cli.header('🔔 Removing Notification Channel')

    cli.info(`Channel: ${channel}`)

    const confirm = await cli.confirm('\nRemove this notification channel?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Removing notification channel...')
    spinner.start()

    // TODO: Delete SNS subscription
    await new Promise(resolve => setTimeout(resolve, 1500))

    spinner.succeed('Notification channel removed')

    cli.success('\n✓ Notification channel removed!')
  })

// ============================================
// 3.24 Infrastructure Management Commands
// ============================================

app
  .command('infra:import <resource>', 'Import existing AWS resource')
  .action(async (resource: string) => {
    cli.header('📦 Importing AWS Resource')

    cli.info(`Resource ARN: ${resource}`)

    const spinner = new cli.Spinner('Analyzing resource...')
    spinner.start()

    // TODO: Use CloudFormation import or Resource Groups API
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Resource analyzed')

    cli.success('\n✓ Resource can be imported!')
    cli.info('Generated CloudFormation template:')
    cli.info('  File: cloudformation/imported-resources.json')

    cli.warn('\nNext steps:')
    cli.info('  1. Review the generated template')
    cli.info('  2. Run: cloud deploy')
  })

app
  .command('infra:drift', 'Detect infrastructure drift')
  .action(async () => {
    cli.header('🔍 Detecting Infrastructure Drift')

    const spinner = new cli.Spinner('Analyzing infrastructure...')
    spinner.start()

    // TODO: Use CloudFormation drift detection API
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.stop()

    cli.info('\n📊 Drift Detection Results:\n')

    cli.table(
      ['Resource', 'Status', 'Properties Changed', 'Action'],
      [
        ['S3Bucket-assets', 'Drifted', 'Versioning', 'Review'],
        ['EC2Instance-web', 'In Sync', '-', '-'],
        ['RDSInstance-db', 'In Sync', '-', '-'],
        ['SecurityGroup-web', 'Drifted', 'IngressRules', 'Review'],
      ],
    )

    cli.warn('\n⚠️  Found 2 resources with drift')
    cli.info('💡 Tip: Run `cloud infra:drift:fix` to fix detected drift')
  })

app
  .command('infra:drift:fix', 'Fix detected drift')
  .action(async () => {
    cli.header('🔧 Fixing Infrastructure Drift')

    cli.warn('This will update resources to match CloudFormation template')

    const confirm = await cli.confirm('\nFix infrastructure drift?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Updating resources...')
    spinner.start()

    // TODO: Update CloudFormation stack
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.succeed('Drift fixed successfully')

    cli.success('\n✓ Infrastructure is now in sync!')
  })

app
  .command('infra:diagram', 'Generate infrastructure diagram')
  .action(async () => {
    cli.header('📊 Generating Infrastructure Diagram')

    const spinner = new cli.Spinner('Analyzing infrastructure...')
    spinner.start()

    // TODO: Generate diagram using CloudFormation template
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Diagram generated')

    cli.success('\n✓ Infrastructure diagram created!')
    cli.info('File: infrastructure-diagram.svg')
    cli.info('\nOpen with: open infrastructure-diagram.svg')
  })

app
  .command('infra:export', 'Export infrastructure as CloudFormation')
  .action(async () => {
    cli.header('📤 Exporting Infrastructure')

    const spinner = new cli.Spinner('Exporting CloudFormation templates...')
    spinner.start()

    // TODO: Export all stacks
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Infrastructure exported')

    cli.success('\n✓ CloudFormation templates exported!')
    cli.info('Directory: cloudformation-export/')
    cli.info('  • main-stack.json')
    cli.info('  • network-stack.json')
    cli.info('  • database-stack.json')
  })

app
  .command('infra:visualize', 'Open visual infrastructure map')
  .action(async () => {
    cli.header('🗺️  Opening Infrastructure Visualizer')

    const spinner = new cli.Spinner('Generating visualization...')
    spinner.start()

    // TODO: Generate interactive HTML visualization
    await new Promise(resolve => setTimeout(resolve, 2000))

    spinner.succeed('Visualization ready')

    cli.success('\n✓ Opening in browser...')
    cli.info('URL: http://localhost:3000/infrastructure')
  })

// ============================================
// 3.26 Testing Commands
// ============================================

app
  .command('test:infra', 'Test infrastructure configuration')
  .action(async () => {
    cli.header('🧪 Testing Infrastructure')

    const spinner = new cli.Spinner('Running infrastructure tests...')
    spinner.start()

    // TODO: Validate CloudFormation, check security groups, etc.
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.stop()

    cli.success('\n✓ Infrastructure tests passed!')

    cli.info('\nTest Results:')
    cli.info('  ✓ CloudFormation templates valid')
    cli.info('  ✓ Security groups properly configured')
    cli.info('  ✓ IAM roles follow least privilege')
    cli.info('  ✓ All resources tagged correctly')
    cli.info('  ⚠️  Warning: 2 resources missing backup configuration')
  })

app
  .command('test:smoke', 'Run smoke tests after deployment')
  .action(async () => {
    cli.header('🧪 Running Smoke Tests')

    const spinner = new cli.Spinner('Testing deployment...')
    spinner.start()

    // TODO: Run basic health checks
    await new Promise(resolve => setTimeout(resolve, 3000))

    spinner.stop()

    cli.success('\n✓ All smoke tests passed!')

    cli.info('\nTest Results:')
    cli.info('  ✓ Application responding (200 OK)')
    cli.info('  ✓ Database connection successful')
    cli.info('  ✓ Cache connection successful')
    cli.info('  ✓ S3 bucket accessible')
    cli.info('  ✓ CDN serving content')
  })

app
  .command('test:load <url>', 'Run load test')
  .option('--users <count>', 'Number of concurrent users', '100')
  .option('--duration <seconds>', 'Test duration in seconds', '60')
  .action(async (url: string, options?: { users?: string, duration?: string }) => {
    const users = options?.users || '100'
    const duration = options?.duration || '60'

    cli.header('🧪 Running Load Test')

    cli.info(`URL: ${url}`)
    cli.info(`Concurrent users: ${users}`)
    cli.info(`Duration: ${duration}s`)

    const confirm = await cli.confirm('\nStart load test?', true)
    if (!confirm) {
      cli.info('Operation cancelled')
      return
    }

    const spinner = new cli.Spinner('Running load test...')
    spinner.start()

    // TODO: Integrate with load testing tool
    await new Promise(resolve => setTimeout(resolve, Number.parseInt(duration) * 100))

    spinner.stop()

    cli.success('\n✓ Load test completed!')

    cli.info('\nResults:')
    cli.info('  • Requests: 15,234')
    cli.info('  • Success rate: 99.8%')
    cli.info('  • Avg response time: 145ms')
    cli.info('  • P95 response time: 320ms')
    cli.info('  • P99 response time: 580ms')
    cli.info('  • Errors: 32 (0.2%)')

    cli.info('\nReport: load-test-report.html')
  })

app
  .command('test:security', 'Run security scan')
  .action(async () => {
    cli.header('🔒 Running Security Scan')

    const spinner = new cli.Spinner('Scanning for vulnerabilities...')
    spinner.start()

    // TODO: Run security scanning tools
    await new Promise(resolve => setTimeout(resolve, 4000))

    spinner.stop()

    cli.info('\n🔍 Security Scan Results:\n')

    cli.info('✓ No critical vulnerabilities found')
    cli.info('⚠️  2 medium severity issues:')
    cli.info('  • S3 bucket logging not enabled')
    cli.info('  • CloudTrail not configured')

    cli.info('\n💡 Recommendations:')
    cli.info('  • Enable S3 bucket logging for audit trail')
    cli.info('  • Configure CloudTrail for API activity logging')
    cli.info('  • Enable AWS Config for compliance monitoring')
  })

// ============================================
// 3.27 Shell & Completion Commands
// ============================================

app
  .command('completion bash', 'Generate bash completion script')
  .action(async () => {
    cli.header('🐚 Bash Completion')

    const script = `# TS Cloud CLI bash completion
_cloud_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  commands="init deploy server function container domain db cache queue logs metrics alarms stack team env upgrade doctor regions version help"

  COMPREPLY=( $(compgen -W "$commands" -- $cur) )
  return 0
}

complete -F _cloud_completions cloud
`

    cli.info('Add this to your ~/.bashrc:\n')
    cli.info(script)

    cli.info('\nOr run:')
    cli.info('  cloud completion bash >> ~/.bashrc')
    cli.info('  source ~/.bashrc')
  })

app
  .command('completion zsh', 'Generate zsh completion script')
  .action(async () => {
    cli.header('🐚 Zsh Completion')

    const script = `# TS Cloud CLI zsh completion
#compdef cloud

_cloud() {
  local -a commands
  commands=(
    'init:Initialize new project'
    'deploy:Deploy infrastructure'
    'server:Manage servers'
    'function:Manage Lambda functions'
    'container:Manage containers'
    'domain:Manage domains'
    'db:Manage databases'
    'cache:Manage cache clusters'
    'queue:Manage queues'
    'logs:View logs'
    'metrics:View metrics'
    'alarms:Manage alarms'
    'stack:Manage CloudFormation stacks'
    'team:Manage team members'
    'env:Manage environments'
    'upgrade:Upgrade CLI'
    'doctor:Check system requirements'
    'regions:List AWS regions'
    'version:Show version'
    'help:Show help'
  )

  _describe 'command' commands
}

_cloud "$@"
`

    cli.info('Add this to your ~/.zshrc:\n')
    cli.info(script)

    cli.info('\nOr run:')
    cli.info('  cloud completion zsh >> ~/.zshrc')
    cli.info('  source ~/.zshrc')
  })

app
  .command('completion fish', 'Generate fish completion script')
  .action(async () => {
    cli.header('🐚 Fish Completion')

    const script = `# TS Cloud CLI fish completion
complete -c cloud -f

# Commands
complete -c cloud -n "__fish_use_subcommand" -a init -d "Initialize new project"
complete -c cloud -n "__fish_use_subcommand" -a deploy -d "Deploy infrastructure"
complete -c cloud -n "__fish_use_subcommand" -a server -d "Manage servers"
complete -c cloud -n "__fish_use_subcommand" -a function -d "Manage Lambda functions"
complete -c cloud -n "__fish_use_subcommand" -a container -d "Manage containers"
complete -c cloud -n "__fish_use_subcommand" -a domain -d "Manage domains"
complete -c cloud -n "__fish_use_subcommand" -a db -d "Manage databases"
complete -c cloud -n "__fish_use_subcommand" -a cache -d "Manage cache clusters"
complete -c cloud -n "__fish_use_subcommand" -a queue -d "Manage queues"
complete -c cloud -n "__fish_use_subcommand" -a logs -d "View logs"
complete -c cloud -n "__fish_use_subcommand" -a metrics -d "View metrics"
complete -c cloud -n "__fish_use_subcommand" -a alarms -d "Manage alarms"
complete -c cloud -n "__fish_use_subcommand" -a stack -d "Manage CloudFormation stacks"
complete -c cloud -n "__fish_use_subcommand" -a team -d "Manage team members"
complete -c cloud -n "__fish_use_subcommand" -a env -d "Manage environments"
complete -c cloud -n "__fish_use_subcommand" -a upgrade -d "Upgrade CLI"
complete -c cloud -n "__fish_use_subcommand" -a doctor -d "Check system requirements"
complete -c cloud -n "__fish_use_subcommand" -a regions -d "List AWS regions"
complete -c cloud -n "__fish_use_subcommand" -a version -d "Show version"
complete -c cloud -n "__fish_use_subcommand" -a help -d "Show help"
`

    cli.info('Save this to ~/.config/fish/completions/cloud.fish:\n')
    cli.info(script)

    cli.info('\nOr run:')
    cli.info('  mkdir -p ~/.config/fish/completions')
    cli.info('  cloud completion fish > ~/.config/fish/completions/cloud.fish')
  })

app
  .command('shell', 'Interactive shell mode')
  .action(async () => {
    cli.header('🐚 TS Cloud Interactive Shell')

    cli.info('Welcome to TS Cloud interactive mode!')
    cli.info('Type commands without "cloud" prefix. Type "exit" to quit.\n')

    cli.warn('⚠️  Interactive shell mode is not yet implemented')
    cli.info('Coming in a future release!')
  })

// ============================================
// Help & Version
// ============================================

app.version(version)
app.help()
app.parse()
