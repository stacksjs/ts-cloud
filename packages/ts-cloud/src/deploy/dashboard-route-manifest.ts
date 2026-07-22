export type DashboardMode = 'server' | 'serverless'
export type DashboardNavigationGroup = 'overview' | 'applications' | 'operations' | 'infrastructure' | 'compute-data' | 'settings' | 'organization'

export interface DashboardPageRoute {
  id: string
  path: string
  label: string
  group: DashboardNavigationGroup
  modes: readonly DashboardMode[]
  adminOnly: boolean
  legacyPaths?: readonly string[]
}

export const dashboardPageRoutes: readonly DashboardPageRoute[] = [
  { id: 'server.overview', path: '/', label: 'Dashboard', group: 'overview', modes: ['server'], adminOnly: true, legacyPaths: ['/server'] },
  { id: 'server.activity', path: '/server/activity', label: 'Activity', group: 'overview', modes: ['server'], adminOnly: true, legacyPaths: ['/activity'] },
  { id: 'services.list', path: '/server/sites', label: 'Services', group: 'applications', modes: ['server'], adminOnly: false, legacyPaths: ['/sites', '/services'] },
  { id: 'deployments.list', path: '/server/deployments', label: 'Deployments', group: 'applications', modes: ['server'], adminOnly: false, legacyPaths: ['/deployments'] },
  { id: 'logs.list', path: '/server/logs', label: 'Logs', group: 'applications', modes: ['server'], adminOnly: false, legacyPaths: ['/logs'] },
  { id: 'sources.integrations', path: '/integrations', label: 'Git integrations', group: 'applications', modes: ['server', 'serverless'], adminOnly: false },
  { id: 'applications.create', path: '/applications/new', label: 'Create application', group: 'applications', modes: ['server', 'serverless'], adminOnly: false },
  { id: 'applications.compose', path: '/applications/compose', label: 'Compose applications', group: 'applications', modes: ['server'], adminOnly: false },
  { id: 'operations.queue', path: '/operations/queue', label: 'Deployment queue', group: 'operations', modes: ['server', 'serverless'], adminOnly: false },
  { id: 'operations.previews', path: '/operations/previews', label: 'Preview environments', group: 'operations', modes: ['server', 'serverless'], adminOnly: false },
  { id: 'operations.releases', path: '/operations/releases', label: 'Releases & promotion', group: 'operations', modes: ['server', 'serverless'], adminOnly: false },
  { id: 'runtime.workloads', path: '/operations/workloads', label: 'Workloads', group: 'operations', modes: ['server', 'serverless'], adminOnly: false },
  { id: 'observability.overview', path: '/operations/observability', label: 'Observability', group: 'operations', modes: ['server', 'serverless'], adminOnly: false },
  { id: 'metrics.overview', path: '/server/metrics', label: 'Metrics', group: 'operations', modes: ['server'], adminOnly: true },
  { id: 'runtime.services', path: '/server/services', label: 'Runtime services', group: 'operations', modes: ['server'], adminOnly: true },
  { id: 'automation.workers', path: '/server/workers', label: 'Workers & schedules', group: 'operations', modes: ['server'], adminOnly: true },
  { id: 'backups.list', path: '/server/backups', label: 'Backups', group: 'operations', modes: ['server'], adminOnly: true },
  { id: 'operations.run', path: '/server/actions', label: 'Run operations', group: 'operations', modes: ['server'], adminOnly: true },
  { id: 'databases.list', path: '/server/database', label: 'Databases', group: 'infrastructure', modes: ['server'], adminOnly: true, legacyPaths: ['/database', '/databases'] },
  { id: 'network.firewall', path: '/server/firewall', label: 'Network & firewall', group: 'infrastructure', modes: ['server'], adminOnly: true },
  { id: 'security.posture', path: '/security', label: 'Security posture', group: 'infrastructure', modes: ['server', 'serverless'], adminOnly: false, legacyPaths: ['/server/security'] },
  { id: 'access.ssh', path: '/server/ssh-keys', label: 'SSH keys', group: 'infrastructure', modes: ['server'], adminOnly: true },
  { id: 'runtime.terminal', path: '/server/terminal', label: 'Terminal', group: 'infrastructure', modes: ['server'], adminOnly: true },
  { id: 'organization.people', path: '/server/team', label: 'People & access', group: 'organization', modes: ['server', 'serverless'], adminOnly: true, legacyPaths: ['/team'] },
  { id: 'organization.automation', path: '/account/automation', label: 'API & automation', group: 'organization', modes: ['server', 'serverless'], adminOnly: true },
  { id: 'serverless.overview', path: '/serverless', label: 'Dashboard', group: 'overview', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.deployments', path: '/serverless/deployments', label: 'Deployments', group: 'overview', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.logs', path: '/serverless/logs', label: 'Logs', group: 'overview', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.metrics', path: '/serverless/metrics', label: 'Metrics', group: 'overview', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.traces', path: '/serverless/traces', label: 'Traces', group: 'overview', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.functions', path: '/serverless/functions', label: 'Functions', group: 'compute-data', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.queues', path: '/serverless/queues', label: 'Queues', group: 'compute-data', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.schedules', path: '/serverless/scheduler', label: 'Schedules', group: 'compute-data', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.data', path: '/serverless/data', label: 'Data', group: 'compute-data', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.assets', path: '/serverless/assets', label: 'Assets', group: 'compute-data', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.secrets', path: '/serverless/secrets', label: 'Environment & secrets', group: 'settings', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.network', path: '/serverless/firewall', label: 'Network', group: 'settings', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.alerts', path: '/serverless/alarms', label: 'Alerts', group: 'settings', modes: ['serverless'], adminOnly: true },
  { id: 'serverless.cost', path: '/serverless/cost', label: 'Costs', group: 'settings', modes: ['serverless'], adminOnly: true },
]

const legacyRedirects: ReadonlyMap<string, string> = new Map(
  dashboardPageRoutes.flatMap(route => (route.legacyPaths ?? []).map(path => [path, route.path] as const)),
)

export function resolveLegacyDashboardRoute(path: string): string | undefined {
  return legacyRedirects.get(path)
}

export function routesForDashboard(mode: DashboardMode, member: boolean): DashboardPageRoute[] {
  return dashboardPageRoutes.filter(route => route.modes.includes(mode) && (!member || !route.adminOnly))
}
