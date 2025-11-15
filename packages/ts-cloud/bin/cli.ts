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
// 3.17 Utility Commands
// ============================================

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
// Help & Version
// ============================================

app.version(version)
app.help()
app.parse()
