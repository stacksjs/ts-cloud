/**
 * Deployment Modules
 * High-level deployment functions for common AWS architectures
 */

export * from './site-target'
export * from './static-site'
export * from './static-site-external-dns'
export * from './static-site-helper'

// Serverless application pipeline (Laravel-Vapor-equivalent) — orchestrator API.
export {
  buildFunctionEnv,
  type CodeSource,
  deployServerlessApp,
  type DeployServerlessOptions,
  infraEnvFromOutputs,
  redeployServerlessApp,
  type ResolvedContext,
  rollbackServerlessApp,
  runRemoteCommand,
  setMaintenance,
} from './serverless-app'
export {
  buildAndPushServerlessImage,
  type BuildImageOptions,
  type BuiltImage,
} from './serverless-image'
export {
  type DashboardData,
  resolveDashboardData,
} from './dashboard-data'
export {
  dashboardActions,
  resolveDashboardAction,
  sanitizeCloudConfig,
  startLocalDashboardServer,
  type DashboardAction,
  type LocalDashboardServer,
  type LocalDashboardServerOptions,
} from './local-dashboard-server'
