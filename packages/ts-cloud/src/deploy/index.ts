/**
 * Deployment Modules
 * High-level deployment functions for common AWS architectures
 */

export * from './site-target'
export * from './server-dns'
export * from './dashboard-control-plane'
export * from './dashboard-route-manifest'
export * from './static-site'
export * from './static-site-external-dns'
export * from './static-site-helper'
export * from './static-api-origin'
export * from './fullstack-container'
export * from './container-image'

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
export { buildAndPushServerlessImage, type BuildImageOptions, type BuiltImage } from './serverless-image'
export { type DashboardData, resolveDashboardData } from './dashboard-data'
export {
  dashboardActions,
  resolveDashboardAction,
  sanitizeCloudConfig,
  startLocalDashboardServer,
  type DashboardAction,
  type LocalDashboardServer,
  type LocalDashboardServerOptions,
} from './local-dashboard-server'
// Management-dashboard auto-deploy: injecting the `dashboard.<apex>` site so it
// ships (behind auth) on every server deploy. Exported so orchestrators (e.g.
// buddy) can inject it BEFORE provisioning, when rpx routes + DNS are derived.
export {
  buildManagementDashboardArtifact,
  DASHBOARD_CREDENTIALS_FILE,
  ensureManagementDashboard,
  type EnsureDashboardLogger,
  MANAGEMENT_DASHBOARD_SITE,
  resolveDashboardAuth,
  type ResolvedDashboardAuth,
  resolveUiSource,
} from './management-dashboard'
