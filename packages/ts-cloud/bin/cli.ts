#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI } from '@stacksjs/clapp'
import { TemplateBuilder } from '@ts-cloud/core'
import { version } from '../package.json'
import {
  findConfigFile,
  getActiveEnvironment,
  loadCloudConfig,
  loadConfigWithEnvironment,
  validateConfig,
} from '../src/config'
import type { CloudConfig } from '@ts-cloud/types'

const cli = new CLI('cloud')

// Global options
cli
  .option('--env <environment>', 'Environment (production, staging, development)')
  .option('--region <region>', 'AWS Region')
  .option('--profile <profile>', 'AWS CLI Profile')
  .option('--verbose', 'Enable verbose logging')
  .option('--dry-run', 'Show what would be done without making changes')

// Init command
cli
  .command('init', 'Initialize a new TS Cloud project')
  .option('--mode <mode>', 'Deployment mode: server, serverless, or hybrid')
  .option('--name <name>', 'Project name')
  .option('--slug <slug>', 'Project slug')
  .option('--region <region>', 'Default AWS region')
  .action(async (options?: { mode?: string, name?: string, slug?: string, region?: string }) => {
    console.log('🚀 Initializing TS Cloud project...')

    // Check if config already exists
    const existingConfig = findConfigFile()
    if (existingConfig) {
      console.error('❌ Configuration file already exists:', existingConfig)
      console.error('   Remove it first or edit it directly.')
      process.exit(1)
    }

    const projectName = options?.name || 'my-project'
    const projectSlug = options?.slug || projectName.toLowerCase().replace(/\s+/g, '-')
    const mode = options?.mode || 'serverless'
    const region = options?.region || 'us-east-1'

    const configTemplate = `import type { CloudConfig } from '@ts-cloud/types'

/**
 * TS Cloud Configuration
 *
 * This file defines your cloud infrastructure configuration.
 * Supports both server mode (Forge-style) and serverless mode (Vapor-style).
 *
 * Environment variables:
 * - CLOUD_ENV: Set the active environment (production, staging, development)
 * - NODE_ENV: Fallback for CLOUD_ENV
 */
const config: CloudConfig = {
  project: {
    name: '${projectName}',
    slug: '${projectSlug}',
    region: '${region}',
  },

  mode: '${mode}',

  environments: {
    production: {
      type: 'production',
      region: '${region}',
      variables: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },
    },
    staging: {
      type: 'staging',
      region: '${region}',
      variables: {
        NODE_ENV: 'staging',
        LOG_LEVEL: 'debug',
      },
    },
    development: {
      type: 'development',
      region: '${region}',
      variables: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },
    },
  },

  infrastructure: {
    // Define your infrastructure here
    // See documentation for available options
  },
}

export default config
`

    const configPath = join(process.cwd(), 'cloud.config.ts')
    writeFileSync(configPath, configTemplate, 'utf-8')

    console.log('✅ Created cloud.config.ts')
    console.log(`   Project: ${projectName}`)
    console.log(`   Mode: ${mode}`)
    console.log(`   Region: ${region}`)
    console.log('\nNext steps:')
    console.log('  1. Edit cloud.config.ts to configure your infrastructure')
    console.log('  2. Run `cloud config:validate` to validate your configuration')
    console.log('  3. Run `cloud generate` to create CloudFormation templates')
  })

// Generate command
cli
  .command('generate', 'Generate CloudFormation templates')
  .alias('gen')
  .option('--output <path>', 'Output directory for templates')
  .option('--format <format>', 'Output format: json or yaml')
  .action(async (options?: { output?: string, format?: string }) => {
    console.log('📝 Generating CloudFormation templates...')

    const builder = new TemplateBuilder('TS Cloud Infrastructure')
    builder.addResource('ExampleBucket', {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: 'my-example-bucket',
      },
    })

    const format = options?.format || 'json'
    const output = format === 'yaml' ? builder.toYAML() : builder.toJSON()

    console.log(output)
  })

// Deploy command
cli
  .command('deploy', 'Deploy infrastructure')
  .option('--stack <name>', 'Stack name')
  .action(async () => {
    console.log('🚀 Deploying infrastructure...')
    // TODO: Implement deploy logic
  })

// Server management commands
cli
  .command('server:list', 'List all servers')
  .action(async () => {
    console.log('📋 Listing servers...')
    // TODO: Implement server list logic
  })

cli
  .command('server:create <name>', 'Create a new server')
  .option('--type <type>', 'Instance type (e.g., t3.micro)')
  .action(async (name: string) => {
    console.log(`🖥️  Creating server: ${name}`)
    // TODO: Implement server create logic
  })

// Function management commands
cli
  .command('function:list', 'List all Lambda functions')
  .action(async () => {
    console.log('📋 Listing functions...')
    // TODO: Implement function list logic
  })

// Database commands
cli
  .command('db:list', 'List all databases')
  .action(async () => {
    console.log('📊 Listing databases...')
    // TODO: Implement db list logic
  })

// Logs command
cli
  .command('logs', 'Stream application logs')
  .option('--tail', 'Tail logs in real-time')
  .option('--filter <pattern>', 'Filter logs by pattern')
  .action(async () => {
    console.log('📄 Streaming logs...')
    // TODO: Implement logs logic
  })

// Config commands
cli
  .command('config', 'Show current configuration')
  .option('--env <environment>', 'Show config for specific environment')
  .action(async (options?: { env?: string }) => {
    try {
      const { config, environment, environmentConfig } = await loadConfigWithEnvironment()

      console.log('⚙️  Configuration:\n')
      console.log('Project:')
      console.log(`  Name:   ${config.project.name}`)
      console.log(`  Slug:   ${config.project.slug}`)
      console.log(`  Region: ${config.project.region}`)
      console.log(`  Mode:   ${config.mode}\n`)

      const targetEnv = options?.env || environment
      const targetEnvConfig = options?.env ? config.environments[options.env] : environmentConfig

      if (!targetEnvConfig) {
        console.error(`❌ Environment '${targetEnv}' not found`)
        process.exit(1)
      }

      console.log(`Active Environment: ${targetEnv}`)
      console.log(`  Type:   ${targetEnvConfig.type}`)
      console.log(`  Region: ${targetEnvConfig.region || config.project.region}`)

      if (targetEnvConfig.variables) {
        console.log(`  Variables:`)
        for (const [key, value] of Object.entries(targetEnvConfig.variables)) {
          console.log(`    ${key}: ${value}`)
        }
      }

      if (config.infrastructure) {
        console.log('\nInfrastructure:')
        if (config.infrastructure.vpc) {
          console.log(`  VPC: ${config.infrastructure.vpc.cidr || 'default'}`)
        }
        if (config.infrastructure.storage?.buckets) {
          console.log(`  Buckets: ${config.infrastructure.storage.buckets.length}`)
        }
        if (config.infrastructure.compute) {
          console.log(`  Compute: ${config.infrastructure.compute.mode || config.mode}`)
        }
        if (config.infrastructure.database) {
          console.log(`  Database: ${config.infrastructure.database.type || 'none'}`)
        }
        if (config.infrastructure.cdn?.enabled) {
          console.log(`  CDN: enabled`)
        }
        if (config.infrastructure.security?.waf?.enabled) {
          console.log(`  WAF: enabled`)
        }
      }

      const configPath = findConfigFile()
      if (configPath) {
        console.log(`\nConfig file: ${configPath}`)
      }
    }
    catch (error) {
      if (error instanceof Error) {
        console.error('❌ Error loading configuration:', error.message)
      }
      process.exit(1)
    }
  })

cli
  .command('config:validate', 'Validate configuration file')
  .action(async () => {
    console.log('✅ Validating configuration...\n')

    try {
      const configPath = findConfigFile()

      if (!configPath) {
        console.error('❌ No configuration file found')
        console.error('   Run `cloud init` to create one')
        process.exit(1)
      }

      console.log(`📄 Found: ${configPath}`)

      const config = await loadCloudConfig()

      // Validation happens automatically in loadCloudConfig
      console.log('✅ Configuration is valid!\n')
      console.log(`   Project: ${config.project.name}`)
      console.log(`   Mode: ${config.mode}`)
      console.log(`   Environments: ${Object.keys(config.environments).join(', ')}`)
    }
    catch (error) {
      if (error instanceof Error) {
        console.error('\n❌ Validation failed:', error.message)
      }
      process.exit(1)
    }
  })

// Doctor command
cli
  .command('doctor', 'Check system requirements and AWS credentials')
  .action(async () => {
    console.log('🔍 Running diagnostics...')
    console.log('✅ Bun:', process.versions.bun)
    console.log('✅ Node:', process.versions.node)
    // TODO: Check AWS CLI, credentials, etc.
  })

// Version command
cli.command('version', 'Show the version of the CLI').action(() => {
  console.log(`TS Cloud v${version}`)
})

// Help
cli.version(version)
cli.help()
cli.parse()
