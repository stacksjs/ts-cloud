import type { JsonValue } from '../control-plane'
import type { JobProvider, ScheduledJob } from './model'
import { eventBridgeScheduleInput, renderServerCron } from './adapters'
import { JobStore } from './store'

export type JobDesiredState = Record<string, JsonValue>

export interface JobProviderAdapter {
  readonly provider: JobProvider
  observe(job: ScheduledJob): Promise<JobDesiredState | undefined>
  apply(job: ScheduledJob, desired: JobDesiredState): Promise<void>
  remove(job: ScheduledJob): Promise<void>
  matches(desired: JobDesiredState, observed: JobDesiredState): boolean
}

export interface ServerCronTransport {
  read(path: string): Promise<string | undefined>
  writeRootOwned(path: string, content: string): Promise<void>
  removeRootOwned(path: string): Promise<void>
}

export interface EventBridgeScheduleTransport {
  get(name: string): Promise<JobDesiredState | undefined>
  put(input: JobDesiredState): Promise<void>
  remove(name: string): Promise<void>
}

function desiredState(job: ScheduledJob): JobDesiredState {
  if (job.provider === 'server') {
    const artifact = renderServerCron(job)
    return { path: artifact.path, content: artifact.content, enabled: job.enabled }
  }
  if (job.provider === 'eventbridge') return eventBridgeScheduleInput(job)
  throw new Error(`No reconciliation adapter is configured for ${job.provider} schedules.`)
}

function contains(expected: JsonValue, observed: JsonValue): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(observed) &&
      expected.length === observed.length &&
      expected.every((item, index) => contains(item, observed[index]))
    )
  if (expected && typeof expected === 'object') {
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false
    return Object.entries(expected).every(([key, value]) =>
      contains(value, (observed as Record<string, JsonValue>)[key]),
    )
  }
  return expected === observed
}

export class ServerCronJobAdapter implements JobProviderAdapter {
  readonly provider = 'server' as const
  constructor(private readonly transport: ServerCronTransport) {}

  async observe(job: ScheduledJob): Promise<JobDesiredState | undefined> {
    const artifact = renderServerCron(job)
    const content = await this.transport.read(artifact.path)
    return content == null ? undefined : { path: artifact.path, content, enabled: true }
  }

  async apply(job: ScheduledJob, desired: JobDesiredState): Promise<void> {
    const path = String(desired.path ?? '')
    if (!job.enabled) {
      await this.transport.removeRootOwned(path)
      return
    }
    await this.transport.writeRootOwned(path, String(desired.content ?? ''))
  }

  async remove(job: ScheduledJob): Promise<void> {
    await this.transport.removeRootOwned(renderServerCron(job).path)
  }

  matches(desired: JobDesiredState, observed: JobDesiredState): boolean {
    if (desired.enabled === false) return false
    return desired.path === observed.path && desired.content === observed.content
  }
}

export class EventBridgeJobAdapter implements JobProviderAdapter {
  readonly provider = 'eventbridge' as const
  constructor(private readonly transport: EventBridgeScheduleTransport) {}

  observe(job: ScheduledJob): Promise<JobDesiredState | undefined> {
    return this.transport.get(`ts-cloud-${job.id}`)
  }

  apply(_job: ScheduledJob, desired: JobDesiredState): Promise<void> {
    return this.transport.put(desired)
  }

  remove(job: ScheduledJob): Promise<void> {
    return this.transport.remove(`ts-cloud-${job.id}`)
  }

  matches(desired: JobDesiredState, observed: JobDesiredState): boolean {
    return contains(desired, observed)
  }
}

export class JobProviderReconciler {
  constructor(private readonly store: JobStore) {}

  async reconcile(
    job: ScheduledJob,
    adapter: JobProviderAdapter,
    options: { apply?: boolean } = {},
  ): Promise<ScheduledJob> {
    if (adapter.provider !== job.provider)
      return this.store.reconcile(job.id, 'unsupported', {
        provider: adapter.provider,
        message: `Adapter ${adapter.provider} cannot reconcile ${job.provider}.`,
      })
    try {
      const desired = desiredState(job)
      const observed = await adapter.observe(job)
      if (observed && adapter.matches(desired, observed))
        return this.store.reconcile(job.id, 'in_sync', { provider: adapter.provider, observed })
      if (options.apply === false)
        return this.store.reconcile(job.id, observed ? 'drifted' : 'unavailable', {
          provider: adapter.provider,
          observed: observed ?? null,
          applyRequired: true,
        })
      await adapter.apply(job, desired)
      if (!job.enabled)
        return this.store.reconcile(job.id, 'in_sync', { provider: adapter.provider, observed: null, disabled: true })
      const after = await adapter.observe(job)
      return this.store.reconcile(job.id, after && adapter.matches(desired, after) ? 'in_sync' : 'drifted', {
        provider: adapter.provider,
        observed: after ?? null,
        applied: true,
      })
    } catch (error) {
      return this.store.reconcile(job.id, 'unavailable', {
        provider: adapter.provider,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async remove(job: ScheduledJob, adapter: JobProviderAdapter): Promise<void> {
    if (job.origin === 'config')
      throw new Error('Config-defined jobs must be removed from configuration, not destructively deleted.')
    if (adapter.provider !== job.provider) throw new Error(`Adapter ${adapter.provider} cannot remove ${job.provider}.`)
    await adapter.remove(job)
    this.store.remove(job.id)
  }
}

export { desiredState as desiredJobProviderState }
