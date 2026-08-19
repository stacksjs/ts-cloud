import type { CloudConfig, ServerlessAppConfig } from '@ts-cloud/core'
import type { ControlPlaneEnvironment, ControlPlaneOrganization, ControlPlaneProject, ControlPlaneResource } from '../control-plane'
import { JobStore } from './store'

interface ReconciliationScope {
  organization: ControlPlaneOrganization
  project: ControlPlaneProject
  environment: ControlPlaneEnvironment
  resources: ControlPlaneResource[]
}

function serverlessQueues(app: ServerlessAppConfig): Array<{ queue: string; processes: number }> {
  if (app.queues === true) return [{ queue: 'default', processes: app.queueConcurrency ?? 1 }]
  if (!Array.isArray(app.queues)) return []
  return app.queues.map((item) => {
    if (typeof item === 'string') return { queue: item, processes: app.queueConcurrency ?? 1 }
    const [queue, concurrency] = Object.entries(item)[0] ?? ['default', app.queueConcurrency ?? 1]
    return { queue, processes: concurrency }
  })
}

/**
 * Import declarative schedules and workers without deleting records that disappear
 * from configuration. Missing definitions are marked drifted for an explicit review.
 */
export function synchronizeConfiguredJobs(
  store: JobStore,
  config: CloudConfig,
  scope: ReconciliationScope,
): { jobs: number; workers: number; drifted: number } {
  const seenJobs = new Set<string>()
  const seenWorkers = new Set<string>()
  const resourceBySlug = new Map(scope.resources.map((item) => [item.slug, item]))
  let jobs = 0
  let workers = 0

  for (const [siteName, site] of Object.entries(config.sites ?? {})) {
    const resource = resourceBySlug.get(siteName)
    if (site.scheduler) {
      const sourceKey = `config:site:${siteName}:scheduler`
      seenJobs.add(sourceKey)
      store.upsertConfigJob({
        organizationId: scope.organization.id,
        projectId: scope.project.id,
        environmentId: scope.environment.id,
        resourceId: resource?.id,
        name: `${siteName} scheduler`,
        provider: 'server',
        expression: '* * * * *',
        timezone: 'UTC',
        flexibleMinutes: 0,
        target: {
          kind: 'dashboard_operation',
          operationId: `scheduler:run:${siteName}`,
        },
        payloadRefs: {},
        missedRunPolicy: 'skip',
        overlapPolicy: 'forbid',
        retryPolicy: { maxAttempts: 3, backoffSeconds: 30 },
        timeoutSeconds: 300,
        enabled: true,
        origin: 'config',
        sourceKey,
        observedState: { source: 'cloud.config.ts' },
        reconciliationStatus: 'pending',
      })
      jobs++
    }

    const siteRecord = site as any
    const definitions = Array.isArray(siteRecord.queues ?? siteRecord.workers)
      ? ((siteRecord.queues ?? siteRecord.workers) as any[])
      : []
    for (const [index, item] of definitions.entries()) {
      const value = typeof item === 'string' ? { queue: item } : item
      const queue = String(value.queue ?? value.name ?? 'default')
      const sourceKey = `config:site:${siteName}:worker:${index}:${queue}`
      seenWorkers.add(sourceKey)
      store.upsertWorker({
        organizationId: scope.organization.id,
        projectId: scope.project.id,
        environmentId: scope.environment.id,
        resourceId: resource?.id,
        name: `${siteName}:${queue}`,
        provider: 'systemd',
        queue,
        processes: Number(value.processes) || 1,
        timeoutSeconds: Number(value.timeout) || 60,
        restartPolicy: 'always',
        target: { operationId: `worker:restart:${siteName}`, site: siteName },
        enabled: true,
        origin: 'config',
        sourceKey,
        observedState: {
          source: 'cloud.config.ts',
          currentJob: null,
          failures: 0,
        },
        reconciliationStatus: 'pending',
      })
      workers++
    }
  }

  const backups = (config.infrastructure?.compute as any)?.backups
  if (backups?.enabled) {
    const sourceKey = 'config:platform:backup'
    seenJobs.add(sourceKey)
    store.upsertConfigJob({
      organizationId: scope.organization.id,
      projectId: scope.project.id,
      environmentId: scope.environment.id,
      name: 'Scheduled backup',
      provider: 'server',
      expression: String(backups.schedule ?? '0 2 * * *'),
      timezone: String(backups.timezone ?? 'UTC'),
      flexibleMinutes: 0,
      target: { kind: 'dashboard_operation', operationId: 'backup:run' },
      payloadRefs: {},
      missedRunPolicy: 'skip',
      overlapPolicy: 'forbid',
      retryPolicy: { maxAttempts: 3, backoffSeconds: 60 },
      timeoutSeconds: 3600,
      enabled: true,
      origin: 'config',
      sourceKey,
      observedState: { source: 'cloud.config.ts' },
      reconciliationStatus: 'pending',
    })
    jobs++
  }

  const app = config.environments?.[scope.environment.slug]?.app
  if (app) {
    if (app.scheduler !== 'off') {
      const sourceKey = `config:serverless:${scope.environment.slug}:scheduler`
      seenJobs.add(sourceKey)
      store.upsertConfigJob({
        organizationId: scope.organization.id,
        projectId: scope.project.id,
        environmentId: scope.environment.id,
        name: `${scope.environment.name} serverless scheduler`,
        provider: 'eventbridge',
        expression: 'rate(1 minute)',
        timezone: 'UTC',
        flexibleMinutes: 0,
        target: { kind: 'serverless_scheduler', action: 'schedule:run' },
        payloadRefs: {},
        missedRunPolicy: app.scheduler === 'sub-minute' ? 'catch_up' : 'skip',
        overlapPolicy: 'forbid',
        retryPolicy: { maxAttempts: 3, backoffSeconds: 30 },
        timeoutSeconds: app.cliTimeout ?? 900,
        enabled: true,
        origin: 'config',
        sourceKey,
        observedState: {
          source: 'cloud.config.ts',
          mode: app.scheduler ?? 'on',
        },
        reconciliationStatus: 'pending',
      })
      jobs++
    }

    for (const { queue, processes } of serverlessQueues(app)) {
      const sourceKey = `config:serverless:${scope.environment.slug}:worker:${queue}`
      seenWorkers.add(sourceKey)
      store.upsertWorker({
        organizationId: scope.organization.id,
        projectId: scope.project.id,
        environmentId: scope.environment.id,
        name: `${scope.environment.name}:${queue}`,
        provider: 'lambda',
        queue,
        processes,
        timeoutSeconds: app.queueTimeout ?? 120,
        restartPolicy: 'on_failure',
        target: { function: 'queue', queue },
        enabled: true,
        origin: 'config',
        sourceKey,
        observedState: {
          source: 'cloud.config.ts',
          currentJob: null,
          failures: 0,
        },
        reconciliationStatus: 'pending',
      })
      workers++
    }
  }

  let drifted = 0
  for (const item of store
    .list(scope.project.id, { environmentId: scope.environment.id })
    .filter((item) => item.origin === 'config' && item.sourceKey && !seenJobs.has(item.sourceKey))) {
    store.reconcile(item.id, 'drifted', {
      ...item.observedState,
      reason: 'Definition is no longer present in configuration; retained for non-destructive review.',
    })
    drifted++
  }
  for (const item of store
    .listWorkers(scope.project.id, scope.environment.id)
    .filter((item) => item.origin === 'config' && item.sourceKey && !seenWorkers.has(item.sourceKey))) {
    store.reconcileWorker(item.id, 'drifted', {
      ...item.observedState,
      reason: 'Definition is no longer present in configuration; retained for non-destructive review.',
    })
    drifted++
  }
  return { jobs, workers, drifted }
}
