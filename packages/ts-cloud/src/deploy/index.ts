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
// Object-storage egress. Exported because the interesting half of this contract
// lives outside ts-cloud: applications implement the EgressReport shape (see
// @ts-cloud/core) and this is what reads it, so both sides need to be able to
// reference and test against the same code.
export {
  collectEgressMetrics,
  type EgressCollectionResult,
  egressReportMetrics,
  type EgressMetric,
  fetchEgressReport,
} from './egress-collection'
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
  dashboardCredentialsFile,
  ensureManagementDashboard,
  type EnsureDashboardLogger,
  MANAGEMENT_DASHBOARD_SITE,
  resolveDashboardAuth,
  type ResolvedDashboardAuth,
  resolveUiSource,
} from './management-dashboard'
