#!/usr/bin/env bun
import { CLI } from '@stacksjs/clapp'
import { version } from '../package.json'
import {
  registerInitCommands,
  registerConfigCommands,
  registerGenerateCommands,
  registerServerCommands,
  registerFunctionCommands,
  registerContainerCommands,
  registerDomainCommands,
  registerDatabaseCommands,
  registerLogsCommands,
  registerSecretsCommands,
  registerFirewallCommands,
  registerSslCommands,
  registerCostCommands,
  registerGitCommands,
  registerEnvironmentCommands,
  registerAssetsCommands,
  registerTeamCommands,
  registerDeployCommands,
  registerStackCommands,
  registerUtilsCommands,
  registerAnalyticsCommands,
} from './commands'

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
// Register All Commands
// ============================================
registerInitCommands(app)
registerConfigCommands(app)
registerGenerateCommands(app)
registerServerCommands(app)
registerFunctionCommands(app)
registerContainerCommands(app)
registerDomainCommands(app)
registerDatabaseCommands(app)
registerLogsCommands(app)
registerSecretsCommands(app)
registerFirewallCommands(app)
registerSslCommands(app)
registerCostCommands(app)
registerGitCommands(app)
registerEnvironmentCommands(app)
registerAssetsCommands(app)
registerTeamCommands(app)
registerDeployCommands(app)
registerStackCommands(app)
registerUtilsCommands(app, version)
registerAnalyticsCommands(app)

// ============================================
// Help & Version
// ============================================
app.version(version)
app.help()
app.parse()
