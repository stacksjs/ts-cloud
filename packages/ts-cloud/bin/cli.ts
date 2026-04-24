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
  // New infrastructure commands
  registerCdnCommands,
  registerStorageCommands,
  registerCacheCommands,
  registerQueueCommands,
  registerNetworkCommands,
  // Scheduling & Events
  registerSchedulerCommands,
  registerEventsCommands,
  // Communication
  registerEmailCommands,
  registerNotifyCommands,
  // Security & Access
  registerIamCommands,
  registerAuditCommands,
  // Operations
  registerStatusCommands,
  registerBackupCommands,
  registerApiCommands,
  registerTunnelCommands,
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

// Core commands
registerInitCommands(app)
registerConfigCommands(app)
registerGenerateCommands(app)
registerDeployCommands(app)
registerStackCommands(app)

// Infrastructure Management
registerServerCommands(app)
registerFunctionCommands(app)
registerContainerCommands(app)
registerCdnCommands(app)
registerStorageCommands(app)
registerCacheCommands(app)
registerQueueCommands(app)
registerNetworkCommands(app)

// Domain & DNS
registerDomainCommands(app)
registerSslCommands(app)

// Database & Data
registerDatabaseCommands(app)

// Monitoring & Logs
registerLogsCommands(app)
registerStatusCommands(app)

// Scheduling & Events
registerSchedulerCommands(app)
registerEventsCommands(app)

// Communication
registerEmailCommands(app)
registerNotifyCommands(app)

// Security & Access
registerSecretsCommands(app)
registerFirewallCommands(app)
registerIamCommands(app)
registerAuditCommands(app)

// Operations & Backup
registerBackupCommands(app)
registerApiCommands(app)

// Cost & Resources
registerCostCommands(app)

// Git & Environment
registerGitCommands(app)
registerEnvironmentCommands(app)

// Assets & Team
registerAssetsCommands(app)
registerTeamCommands(app)

// Analytics & Tunnel
registerAnalyticsCommands(app)
registerTunnelCommands(app)

// Utilities
registerUtilsCommands(app, version)

// ============================================
// Help & Version
// ============================================
app.version(version)
app.help()
app.parse()
