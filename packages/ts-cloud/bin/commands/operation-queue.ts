import type { CLI } from '@stacksjs/clapp'
import type { OperationState, QueueConcurrencyLimits } from '../../src'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { DurableOperationQueue } from '../../src/queue'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

async function withQueue<T>(callback: (queue: DurableOperationQueue, projectId: string, organizationId: string) => Promise<T>): Promise<T> {
  const config = await loadValidatedConfig()
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  const queue = new DurableOperationQueue(controlPlane.store, { workerId: `cli:${process.pid}` })
  try { return await callback(queue, controlPlane.project.id, controlPlane.organization.id) }
  finally { controlPlane.store.close() }
}

function state(value: string | undefined): OperationState | undefined {
  if (!value) return undefined
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'].includes(value)) throw new Error('State must be queued, running, succeeded, failed, cancelled, or timed_out')
  return value as OperationState
}

function age(start?: string, end?: string): string {
  if (!start) return '—'
  const milliseconds = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime())
  return milliseconds < 1000 ? `${milliseconds}ms` : milliseconds < 60_000 ? `${Math.round(milliseconds / 1000)}s` : `${Math.round(milliseconds / 60_000)}m`
}

export function registerOperationQueueCommands(app: CLI): void {
  app.command('ops:list', 'List durable deployment and mutation jobs').option('--state <state>', 'Filter queue state').option('--all-projects', 'Show all locally authorized projects').action(async (options: { state?: string, allProjects?: boolean }) => {
    try { await withQueue(async (queue, projectId) => { const values = queue.list({ projectId: options.allProjects ? undefined : projectId, state: state(options.state), limit: 500 }); cli.table(['ID', 'State', 'Operation', 'Target', 'Attempt', 'Step / blocked', 'Queued', 'Duration'], values.map(({ operation, job, approximatePosition }) => [operation.id, operation.state, operation.kind, operation.resourceId ?? operation.environmentId ?? operation.projectId ?? 'global', `${operation.attempt}/${job.maxAttempts}`, job.blockedReason ?? job.currentStep ?? (approximatePosition ? `${approximatePosition.ahead} ahead` : '—'), operation.createdAt, age(operation.startedAt, operation.finishedAt)])) }) } catch (cause) { cli.error(cause instanceof Error ? cause.message : String(cause)) }
  })

  app.command('ops:show <id>', 'Show a durable operation and its latest sanitized logs').option('--after <cursor>', 'Show logs after this sequence', { default: '0' }).action(async (id: string, options: { after?: string }) => {
    try { await withQueue(async (queue) => { const value = queue.view(id); if (!value) throw new Error(`Operation ${id} was not found`); cli.info(JSON.stringify(value, null, 2)); for (const entry of queue.logs(id, { after: Number(options.after) || 0, limit: 500 })) cli.info(`${entry.sequence} ${entry.stream.toUpperCase()}${entry.step ? ` [${entry.step}]` : ''} ${entry.message}`) }) } catch (cause) { cli.error(cause instanceof Error ? cause.message : String(cause)) }
  })

  app.command('ops:cancel <id>', 'Cancel queued work or request running cancellation').option('--yes', 'Skip confirmation').action(async (id: string, options: { yes?: boolean }) => {
    try { await withQueue(async (queue) => { const value = queue.view(id); if (!value) throw new Error(`Operation ${id} was not found`); if (!options.yes && !(await cli.confirm(`Cancel ${value.operation.kind} (${id})?`, false))) return; const operation = queue.requestCancellation(id); cli.success(`${operation.state === 'cancelled' ? 'Cancelled' : 'Cancellation requested for'} ${id}`) }) } catch (cause) { cli.error(cause instanceof Error ? cause.message : String(cause)) }
  })

  app.command('ops:retry <id>', 'Retry a terminal job using an allow-listed error class').option('--class <name>', 'Retryable error class').option('--delay <milliseconds>', 'Delay before the next attempt', { default: '0' }).action(async (id: string, options: { class?: string, delay?: string }) => {
    try { if (!options.class) throw new Error('Pass --class with one of the retry classes shown by ops:show'); await withQueue(async (queue) => { const operation = queue.retry(id, options.class!, { delayMs: Number(options.delay) || 0 }); cli.success(`Retry queued: ${operation.id} · attempt ${operation.attempt + 1}`) }) } catch (cause) { cli.error(cause instanceof Error ? cause.message : String(cause)) }
  })

  app.command('ops:concurrency', 'Show effective durable queue concurrency limits').action(async () => { try { await withQueue(async queue => cli.info(JSON.stringify(queue.limits, null, 2))) } catch (cause) { cli.error(cause instanceof Error ? cause.message : String(cause)) } })

  app.command('ops:concurrency:set', 'Confirm and audit durable queue concurrency limits')
    .option('--project <count>', 'Concurrent jobs per project').option('--environment <count>', 'Concurrent jobs per environment').option('--provider <count>', 'Concurrent jobs per provider').option('--builds <count>', 'Concurrent build slots').option('--confirm <text>', 'Must equal "update queue limits"')
    .action(async (options: { project?: string, environment?: string, provider?: string, builds?: string, confirm?: string }) => {
      try { if (options.confirm !== 'update queue limits') throw new Error('Pass --confirm "update queue limits" to change production concurrency'); const limits: Partial<QueueConcurrencyLimits> = {}; for (const key of ['project', 'environment', 'provider', 'builds'] as const) if (options[key] !== undefined) limits[key] = Number(options[key]); await withQueue(async (queue, _projectId, organizationId) => cli.success(`Queue concurrency updated: ${JSON.stringify(queue.configureConcurrency(limits, { organizationId }))}`)) } catch (cause) { cli.error(cause instanceof Error ? cause.message : String(cause)) }
    })

  app.command('ops:history:clear', 'Clear terminal jobs after their retention policy expires').option('--before <date>', 'Also require completion before this timestamp').option('--yes', 'Skip confirmation').action(async (options: { before?: string, yes?: boolean }) => {
    try { await withQueue(async (queue, projectId) => { if (!options.yes && !(await cli.confirm('Clear completed queue history whose retention has elapsed?', false))) return; const deleted = queue.clearCompleted({ projectId, before: options.before }); cli.success(`Cleared ${deleted} retained operation${deleted === 1 ? '' : 's'}.`) }) } catch (cause) { cli.error(cause instanceof Error ? cause.message : String(cause)) }
  })
}

export { age as formatQueueDuration }
