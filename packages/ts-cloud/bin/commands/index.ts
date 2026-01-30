export { registerInitCommands } from './init'
export { registerConfigCommands } from './config'
export { registerGenerateCommands } from './generate'
export { registerServerCommands } from './server'
export { registerFunctionCommands } from './function'
export { registerContainerCommands } from './container'
export { registerDomainCommands } from './domain'
export { registerDatabaseCommands } from './database'
export { registerLogsCommands } from './logs'
export { registerSecretsCommands } from './secrets'
export { registerFirewallCommands } from './firewall'
export { registerSslCommands } from './ssl'
export { registerCostCommands } from './cost'
export { registerGitCommands } from './git'
export { registerEnvironmentCommands } from './environment'
export { registerAssetsCommands } from './assets'
export { registerTeamCommands } from './team'
export { registerDeployCommands } from './deploy'
export { registerStackCommands } from './stack'
export { registerUtilsCommands } from './utils'
export { registerAnalyticsCommands } from './analytics'

// New infrastructure commands
export { registerCdnCommands } from './cdn'
export { registerStorageCommands } from './storage'
export { registerCacheCommands } from './cache'
export { registerQueueCommands } from './queue'
export { registerNetworkCommands } from './network'

// Scheduling & Events
export { registerSchedulerCommands } from './scheduler'
export { registerEventsCommands } from './events'

// Communication
export { registerEmailCommands } from './email'
export { registerNotifyCommands } from './notify'

// Security & Access
export { registerIamCommands } from './iam'
export { registerAuditCommands } from './audit'

// Operations
export { registerStatusCommands } from './status'
export { registerBackupCommands } from './backup'
export { registerApiCommands } from './api'
export { registerTunnelCommands } from './tunnel'

export { loadValidatedConfig, resolveDnsProviderConfig, getDnsProvider } from './shared'
