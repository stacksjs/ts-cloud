import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import type { JsonValue, ScheduledJob } from '../../src'
import { resolveDeploymentMode } from '@ts-cloud/core'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { buildDashboardOperations, resolveDashboardOperation, runDashboardOperation } from '../../src/deploy/dashboard-operations'
import { jobProviderCapability, JobService, JobStore, nextScheduleRuns, previewSchedule, synchronizeConfiguredJobs } from '../../src/jobs'
import { DurableOperationQueue } from '../../src/queue'
import * as output from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

async function context(environment?: string, jobId?: string) {
  const config = await loadValidatedConfig()
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  const hintedJob = !environment && jobId ? new JobStore(controlPlane.store).get(jobId) : undefined
  const hintedEnvironment = hintedJob?.environmentId ? controlPlane.store.listEnvironments(controlPlane.project.id).find(item => item.id === hintedJob.environmentId)?.slug : undefined
  const env = (environment ?? hintedEnvironment ?? Object.keys(config.environments ?? {})[0] ?? 'production') as EnvironmentType
  if (!Object.hasOwn(config.environments ?? {}, env)) {
    controlPlane.store.close()
    throw new Error(`Environment ${env} was not found`)
  }
  const environmentRecord = controlPlane.environments.get(env)
  if (!environmentRecord) {
    controlPlane.store.close()
    throw new Error(`Environment ${env} was not found in the control plane`)
  }
  const store = new JobStore(controlPlane.store)
  const queue = new DurableOperationQueue(controlPlane.store, { workerId: `cli:${process.pid}` })
  const service = new JobService(store, { queue })
  const resources = controlPlane.store.listResources(controlPlane.project.id, environmentRecord.id)
  synchronizeConfiguredJobs(store, config, { organization: controlPlane.organization, project: controlPlane.project, environment: environmentRecord, resources })
  const actor = controlPlane.store.getActorByExternalId('system', 'cli') ?? controlPlane.store.createActor({ kind: 'system', externalId: 'cli', displayName: 'ts-cloud CLI' })
  return { config, env, controlPlane, environmentRecord, resources, store, queue, service, actor }
}

type JobContext = Awaited<ReturnType<typeof context>>

async function withContext<T>(environment: string | undefined, callback: (value: JobContext) => Promise<T>, jobId?: string): Promise<T> {
  const value = await context(environment, jobId)
  try { return await callback(value) }
  finally { value.controlPlane.store.close() }
}

async function run(callback: () => Promise<void>): Promise<void> {
  try { await callback() }
  catch (error) { output.error(error instanceof Error ? error.message : String(error)) }
}

function findJob(value: JobContext, idOrName: string): ScheduledJob {
  const jobs = value.store.list(value.controlPlane.project.id, { environmentId: value.environmentRecord.id })
  const exact = value.store.get(idOrName) ?? jobs.find(item => item.name === idOrName)
  if (!exact || exact.environmentId !== value.environmentRecord.id) throw new Error(`Scheduled job ${idOrName} was not found in ${value.env}`)
  return exact
}

function audit(value: JobContext, type: string, payload: Record<string, JsonValue>, resourceId?: string): void {
  value.controlPlane.store.appendEvent({ organizationId: value.controlPlane.organization.id, projectId: value.controlPlane.project.id, resourceId, actorId: value.actor.id, type: `job.${type}`, payload })
}

function requireProductionConfirmation(value: JobContext, action: 'disable' | 'delete', confirmation?: string): void {
  if (value.environmentRecord.kind === 'production' && confirmation !== action) throw new Error(`Production ${action} requires --confirm ${action}`)
}

function payloadReferences(input?: string): Record<string, JsonValue> {
  if (!input) return {}
  if (!/^(?:secret|ssm|arn|env):\/\//.test(input)) throw new Error('Payloads must use a secret://, ssm://, arn://, or env:// reference')
  return { input }
}

function scheduleRows(jobs: ScheduledJob[]): string[][] {
  return jobs.map(item => [item.id, item.enabled ? 'enabled' : 'disabled', item.provider, item.name, item.expression, item.timezone, item.nextRunAt ?? '—', item.reconciliationStatus])
}

export function registerJobCommands(app: CLI): void {
  app.command('jobs:list', 'List server cron, EventBridge, and recurring control-plane jobs')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string, json?: boolean }) => run(async () => withContext(options.env, async (value) => {
      const jobs = value.store.list(value.controlPlane.project.id, { environmentId: value.environmentRecord.id })
      if (options.json) output.info(JSON.stringify(jobs, null, 2))
      else output.table(['ID', 'State', 'Provider', 'Name', 'Expression', 'Timezone', 'Next run', 'Reconciliation'], scheduleRows(jobs))
    })))

  app.command('jobs:preview <expression>', 'Preview the next runs without creating production work')
    .option('--timezone <timezone>', 'IANA timezone', { default: 'UTC' })
    .option('--from <date>', 'Preview from an ISO timestamp')
    .option('--count <count>', 'Number of runs', { default: '5' })
    .action(async (expression: string, options: { timezone?: string, from?: string, count?: string }) => run(async () => {
      const preview = previewSchedule(expression, options.timezone ?? 'UTC', options.from ? new Date(options.from) : new Date(), Number(options.count) || 5)
      output.info(JSON.stringify({ ...preview, productionExecutionCreated: false }, null, 2))
    }))

  app.command('jobs:add <name> <expression>', 'Create a managed recurring job')
    .option('--env <environment>', 'Target environment')
    .option('--timezone <timezone>', 'IANA timezone', { default: 'UTC' })
    .option('--operation <id>', 'Safe server operation target (scheduler, backup, or worker)')
    .option('--resource <id>', 'Resource ID or slug')
    .option('--starts-at <date>', 'Schedule window start')
    .option('--ends-at <date>', 'Schedule window end')
    .option('--flexible-minutes <count>', 'Provider flexible window', { default: '0' })
    .option('--missed <policy>', 'skip or catch_up', { default: 'skip' })
    .option('--overlap <policy>', 'allow, forbid, or replace', { default: 'forbid' })
    .option('--attempts <count>', 'Maximum attempts', { default: '3' })
    .option('--backoff <seconds>', 'Retry backoff seconds', { default: '30' })
    .option('--timeout <seconds>', 'Execution timeout', { default: '900' })
    .option('--dead-letter <reference>', 'Dead-letter ARN or secret reference')
    .option('--payload-ref <reference>', 'Referenced payload; inline values are forbidden')
    .option('--disabled', 'Create disabled')
    .action(async (name: string, expression: string, options: { env?: string, timezone?: string, operation?: string, resource?: string, startsAt?: string, endsAt?: string, flexibleMinutes?: string, missed?: string, overlap?: string, attempts?: string, backoff?: string, timeout?: string, deadLetter?: string, payloadRef?: string, disabled?: boolean }) => run(async () => withContext(options.env, async (value) => {
      if (!['skip', 'catch_up'].includes(options.missed ?? 'skip')) throw new Error('--missed must be skip or catch_up')
      if (!['allow', 'forbid', 'replace'].includes(options.overlap ?? 'forbid')) throw new Error('--overlap must be allow, forbid, or replace')
      const mode = resolveDeploymentMode(value.config)
      const workers = value.store.listWorkers(value.controlPlane.project.id, value.environmentRecord.id)
      const operationData = { workers: workers.map(worker => ({ name: worker.name })) }
      let target: ScheduledJob['target']
      if (mode === 'server') {
        const safe = buildDashboardOperations(value.config, operationData).filter(item => !item.danger && ['scheduler', 'backup', 'worker'].includes(item.group))
        const operation = options.operation ? safe.find(item => item.id === options.operation) : safe.length === 1 ? safe[0] : undefined
        if (!operation) throw new Error(`Choose a safe target with --operation. Available: ${safe.map(item => item.id).join(', ') || 'none'}`)
        target = { kind: 'dashboard_operation', operationId: operation.id }
      }
      else target = { kind: 'serverless_scheduler', action: 'run' }
      const provider = mode === 'server' ? 'server' : 'eventbridge'
      const capability = jobProviderCapability({ provider, expression, flexibleMinutes: Number(options.flexibleMinutes) || 0, missedRunPolicy: (options.missed ?? 'skip') as ScheduledJob['missedRunPolicy'], overlapPolicy: (options.overlap ?? 'forbid') as ScheduledJob['overlapPolicy'] })
      if (!capability.supported) throw new Error(capability.notes.join(' '))
      const resource = options.resource ? value.resources.find(item => item.id === options.resource || item.slug === options.resource) : undefined
      if (options.resource && !resource) throw new Error(`Resource ${options.resource} was not found in ${value.env}`)
      const job = value.store.create({
        organizationId: value.controlPlane.organization.id,
        projectId: value.controlPlane.project.id,
        environmentId: value.environmentRecord.id,
        resourceId: resource?.id,
        name,
        provider,
        expression,
        timezone: options.timezone ?? 'UTC',
        startsAt: options.startsAt,
        endsAt: options.endsAt,
        flexibleMinutes: Number(options.flexibleMinutes) || 0,
        target,
        payloadRefs: payloadReferences(options.payloadRef),
        missedRunPolicy: (options.missed ?? 'skip') as ScheduledJob['missedRunPolicy'],
        overlapPolicy: (options.overlap ?? 'forbid') as ScheduledJob['overlapPolicy'],
        retryPolicy: { maxAttempts: Number(options.attempts) || 3, backoffSeconds: Number(options.backoff) || 30, deadLetterRef: options.deadLetter },
        timeoutSeconds: Number(options.timeout) || 900,
        enabled: !options.disabled,
        origin: 'managed',
        ownerActorId: value.actor.id,
        observedState: {},
        reconciliationStatus: 'pending',
      })
      audit(value, 'created', { jobId: job.id, provider: job.provider, expression: job.normalizedExpression }, job.resourceId)
      output.success(`Created ${job.name} (${job.id}); next run ${job.nextRunAt ?? 'outside the active window'}`)
    })))

  app.command('jobs:update <job>', 'Update a managed job schedule and policies')
    .option('--env <environment>', 'Target environment')
    .option('--expression <expression>', 'Cron, preset, or rate expression')
    .option('--timezone <timezone>', 'IANA timezone')
    .option('--missed <policy>', 'skip or catch_up')
    .option('--overlap <policy>', 'allow, forbid, or replace')
    .option('--timeout <seconds>', 'Execution timeout')
    .action(async (jobId: string, options: { env?: string, expression?: string, timezone?: string, missed?: string, overlap?: string, timeout?: string }) => run(async () => withContext(options.env, async (value) => {
      const current = findJob(value, jobId)
      if (current.origin === 'config') throw new Error('Config-defined schedules must be edited in cloud.config.ts and reconciled')
      if (options.missed && !['skip', 'catch_up'].includes(options.missed)) throw new Error('--missed must be skip or catch_up')
      if (options.overlap && !['allow', 'forbid', 'replace'].includes(options.overlap)) throw new Error('--overlap must be allow, forbid, or replace')
      const updated = value.store.updateSchedule(current.id, { expression: options.expression, timezone: options.timezone, missedRunPolicy: options.missed as ScheduledJob['missedRunPolicy'] | undefined, overlapPolicy: options.overlap as ScheduledJob['overlapPolicy'] | undefined, timeoutSeconds: options.timeout == null ? undefined : Number(options.timeout) })
      audit(value, 'updated', { jobId: updated.id, expression: updated.normalizedExpression, version: updated.version }, updated.resourceId)
      output.success(`Updated ${updated.name}; next run ${updated.nextRunAt ?? 'outside the active window'}`)
    })))

  app.command('jobs:run <job>', 'Queue a manual run through the durable operation worker')
    .option('--env <environment>', 'Target environment')
    .action(async (jobId: string, options: { env?: string }) => run(async () => withContext(options.env, async (value) => {
      const job = findJob(value, jobId)
      const execution = value.service.enqueue(job, { trigger: 'manual', actorId: value.actor.id })
      audit(value, 'run_queued', { jobId: job.id, executionId: execution.id }, job.resourceId)
      output.success(`Queued execution ${execution.id}; inspect it with cloud jobs:history "${job.name}"`)
    })))

  app.command('jobs:dispatch <job>', 'Dispatch an externally triggered schedule into the durable queue')
    .option('--env <environment>', 'Target environment')
    .option('--scheduled-for <date>', 'Provider scheduled timestamp')
    .option('--scheduled', 'Mark this as a provider schedule trigger')
    .action(async (jobId: string, options: { env?: string, scheduledFor?: string, scheduled?: boolean }) => run(async () => withContext(options.env, async (value) => {
      const job = findJob(value, jobId)
      if (!job.enabled) throw new Error(`${job.name} is disabled`)
      const instant = options.scheduledFor ? new Date(options.scheduledFor) : new Date()
      if (!options.scheduledFor) instant.setUTCSeconds(0, 0)
      const scheduledFor = instant.toISOString()
      const execution = value.service.enqueue(job, { trigger: options.scheduled ? 'scheduled' : 'external', scheduledFor, actorId: value.actor.id })
      const next = nextScheduleRuns(job.normalizedExpression, job.timezone, instant, 1)[0]
      value.store.markScheduled(job.id, scheduledFor, next)
      output.success(`Accepted ${job.name} for ${scheduledFor} as ${execution.id}`)
    }, jobId)))

  for (const action of ['enable', 'disable'] as const) {
    app.command(`jobs:${action} <job>`, `${action === 'enable' ? 'Enable' : 'Disable'} a scheduled job`)
      .option('--env <environment>', 'Target environment')
      .option('--confirm <text>', `Production ${action} confirmation`)
      .action(async (jobId: string, options: { env?: string, confirm?: string }) => run(async () => withContext(options.env, async (value) => {
        const job = findJob(value, jobId)
        if (action === 'disable') requireProductionConfirmation(value, action, options.confirm)
        const updated = value.store.setEnabled(job.id, action === 'enable')
        audit(value, action === 'enable' ? 'enabled' : 'disabled', { jobId: updated.id }, updated.resourceId)
        output.success(`${updated.name} is ${updated.enabled ? 'enabled' : 'disabled'}`)
      })))
  }

  app.command('jobs:delete <job>', 'Delete a managed schedule')
    .option('--env <environment>', 'Target environment')
    .option('--confirm <text>', 'Must be delete in production')
    .action(async (jobId: string, options: { env?: string, confirm?: string }) => run(async () => withContext(options.env, async (value) => {
      const job = findJob(value, jobId)
      requireProductionConfirmation(value, 'delete', options.confirm)
      value.store.remove(job.id)
      audit(value, 'deleted', { jobId: job.id, name: job.name }, job.resourceId)
      output.success(`Deleted ${job.name}`)
    })))

  app.command('jobs:history <job>', 'Show execution attempts, output, errors, and redacted logs')
    .option('--env <environment>', 'Target environment')
    .option('--limit <count>', 'Maximum executions', { default: '100' })
    .option('--logs', 'Print execution logs')
    .option('--json', 'Print structured JSON')
    .action(async (jobId: string, options: { env?: string, limit?: string, logs?: boolean, json?: boolean }) => run(async () => withContext(options.env, async (value) => {
      const job = findJob(value, jobId)
      const executions = value.store.listExecutions(job.id, Number(options.limit) || 100).map(item => ({ ...item, logs: options.logs && item.operationId ? value.queue.logs(item.operationId, { limit: 500 }) : [] }))
      if (options.json) output.info(JSON.stringify(executions, null, 2))
      else {
        output.table(['ID', 'Status', 'Trigger', 'Scheduled for', 'Attempt', 'Started', 'Finished', 'Error'], executions.map(item => [item.id, item.status, item.trigger, item.scheduledFor, String(item.attempt), item.startedAt ?? '—', item.finishedAt ?? '—', item.error ?? '—']))
        if (options.logs) for (const execution of executions) for (const entry of execution.logs) output.info(`${execution.id} ${entry.sequence} ${entry.stream.toUpperCase()} ${entry.message}`)
      }
    })))

  app.command('jobs:reconcile', 'Import declarative schedules and workers without destructive deletion')
    .option('--env <environment>', 'Target environment')
    .action(async (options: { env?: string }) => run(async () => withContext(options.env, async (value) => {
      const result = synchronizeConfiguredJobs(value.store, value.config, { organization: value.controlPlane.organization, project: value.controlPlane.project, environment: value.environmentRecord, resources: value.resources })
      audit(value, 'reconciled', result)
      output.success(`Reconciled ${result.jobs} schedules and ${result.workers} workers; retained ${result.drifted} missing definitions as drifted`)
    })))

  app.command('workers:list', 'List configured systemd, ECS, and Lambda workers')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string, json?: boolean }) => run(async () => withContext(options.env, async (value) => {
      const workers = value.store.listWorkers(value.controlPlane.project.id, value.environmentRecord.id)
      if (options.json) output.info(JSON.stringify(workers, null, 2))
      else output.table(['ID', 'Provider', 'Name', 'Queue', 'Processes', 'Timeout', 'Restart', 'Reconciliation'], workers.map(item => [item.id, item.provider, item.name, item.queue, String(item.processes), `${item.timeoutSeconds}s`, item.restartPolicy, item.reconciliationStatus]))
    })))

  app.command('workers:restart <worker>', 'Gracefully restart an allowlisted systemd worker')
    .option('--env <environment>', 'Target environment')
    .option('--confirm <name>', 'Exact worker name confirmation')
    .action(async (workerId: string, options: { env?: string, confirm?: string }) => run(async () => withContext(options.env, async (value) => {
      const workers = value.store.listWorkers(value.controlPlane.project.id, value.environmentRecord.id)
      const worker = value.store.getWorker(workerId) ?? workers.find(item => item.name === workerId)
      if (!worker || worker.environmentId !== value.environmentRecord.id) throw new Error(`Worker ${workerId} was not found in ${value.env}`)
      if (options.confirm !== worker.name) throw new Error(`Restart requires --confirm "${worker.name}"`)
      if (worker.provider !== 'systemd') throw new Error(`${worker.provider} workers are provider/config managed and do not expose a safe restart adapter`)
      const operation = resolveDashboardOperation(String(worker.target.operationId ?? ''), value.config, { workers: workers.map(item => ({ name: item.name })) })
      if (!operation || operation.danger || operation.group !== 'worker') throw new Error('The allowlisted worker restart operation is unavailable')
      const result = await runDashboardOperation(value.config, value.env, operation)
      value.store.reconcileWorker(worker.id, result.ok ? 'in_sync' : 'unavailable', { ...worker.observedState, lastRestartAt: new Date().toISOString(), command: result.command ?? null, error: result.error ?? result.stderr ?? null })
      audit(value, 'worker_restarted', { workerId: worker.id, ok: result.ok }, worker.resourceId)
      if (!result.ok) throw new Error(result.error ?? result.stderr ?? 'Worker restart failed')
      output.success(`Restarted ${worker.name}`)
    })))
}
