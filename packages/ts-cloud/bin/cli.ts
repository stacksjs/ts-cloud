#!/usr/bin/env bun
import { CLI } from '@stacksjs/clapp'
import { version } from '../package.json'
import {
  registerInitCommands,
  registerConfigCommands,
  registerSiteCommands,
  registerGenerateCommands,
  registerServerCommands,
  registerPlacementCommands,
  registerRegionCommands,
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
  registerApplicationCommands,
  registerEnvironmentCommands,
  registerComposeCommands,
  registerReleaseCommands,
  registerAssetsCommands,
  registerTeamCommands,
  registerDeployCommands,
  registerFullStackCommands,
  registerComputeLifecycleCommands,
  registerStackCommands,
  registerUtilsCommands,
  registerAnalyticsCommands,
  registerDashboardCommands,
  // New infrastructure commands
  registerCdnCommands,
  registerStorageCommands,
  registerMigrateCommands,
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
  registerRecoveryCommands,
  registerApiCommands,
  registerOperationQueueCommands,
  registerRuntimeCommands,
  registerTelemetryCommands,
  registerAlertingCommands,
  registerJobCommands,
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

// Monitoring & Logs — registered FIRST so the bare `logs`/`metrics`/`alarms`
// commands win clapp's first-match resolution over namespaced `*:logs`/`*:metrics`
// commands (clapp matches a namespaced command by its bare trailing segment too).
registerLogsCommands(app)

// Core commands
registerInitCommands(app)
registerConfigCommands(app)
registerSiteCommands(app)
registerGenerateCommands(app)
registerDeployCommands(app)
registerFullStackCommands(app)
registerComputeLifecycleCommands(app)
registerStackCommands(app)

// Infrastructure Management
registerServerCommands(app)
registerPlacementCommands(app)
registerRegionCommands(app)
registerFunctionCommands(app)
registerContainerCommands(app)
registerCdnCommands(app)
registerStorageCommands(app)
registerMigrateCommands(app)
registerCacheCommands(app)
registerQueueCommands(app)
registerNetworkCommands(app)

// Domain & DNS
registerDomainCommands(app)
registerSslCommands(app)

// Database & Data
registerDatabaseCommands(app)

// Monitoring & Logs (registerLogsCommands is registered earlier — see top)
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
registerRecoveryCommands(app)
registerApiCommands(app)
registerOperationQueueCommands(app)
registerRuntimeCommands(app)
registerTelemetryCommands(app)
registerAlertingCommands(app)
registerJobCommands(app)

// Cost & Resources
registerCostCommands(app)

// Git & Environment
registerGitCommands(app)
registerApplicationCommands(app)
registerEnvironmentCommands(app)
registerComposeCommands(app)
registerReleaseCommands(app)

// Assets & Team
registerAssetsCommands(app)
registerTeamCommands(app)

// Analytics & Tunnel
registerAnalyticsCommands(app)
registerTunnelCommands(app)
registerDashboardCommands(app)

// Utilities
registerUtilsCommands(app, version)

// ============================================
// Help & Version
// ============================================
app.version(version)
app.help()
app.parse()
