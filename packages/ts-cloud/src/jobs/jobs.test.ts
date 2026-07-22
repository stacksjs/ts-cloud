import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { DurableOperationQueue, DurableQueueWorker } from '../queue'
import {
  createJobQueueHandlers,
  eventBridgeScheduleInput,
  JobService,
  JobStore,
  nextScheduleRuns,
  previewSchedule,
  renderServerCron,
  synchronizeConfiguredJobs,
} from '.'

const stores: ControlPlaneStore[] = []
function fixture() {
  const controlPlane = new ControlPlaneStore({ path: ':memory:' })
  stores.push(controlPlane)
  const organization = controlPlane.createOrganization({
      slug: 'acme',
      name: 'Acme',
    }),
    project = controlPlane.createProject({
      organizationId: organization.id,
      slug: 'app',
      name: 'App',
    }),
    environment = controlPlane.createEnvironment({
      projectId: project.id,
      slug: 'production',
      name: 'Production',
      kind: 'production',
    }),
    resource = controlPlane.createResource({
      projectId: project.id,
      environmentId: environment.id,
      kind: 'application',
      slug: 'api',
      name: 'API',
    })
  let now = new Date('2026-03-07T08:00:00Z')
  const store = new JobStore(controlPlane, { now: () => now })
  const create = (overrides: Record<string, unknown> = {}) =>
    store.create({
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      resourceId: resource.id,
      name: 'Daily task',
      provider: 'server',
      expression: '30 2 * * *',
      timezone: 'America/Los_Angeles',
      flexibleMinutes: 0,
      target: { kind: 'dashboard_operation', operationId: 'scheduler:run:api' },
      payloadRefs: { secretRef: 'secret://api/job' },
      missedRunPolicy: 'skip',
      overlapPolicy: 'forbid',
      retryPolicy: { maxAttempts: 3, backoffSeconds: 1 },
      timeoutSeconds: 60,
      enabled: true,
      origin: 'managed',
      observedState: {},
      reconciliationStatus: 'pending',
      ...overrides,
    } as any)
  return {
    controlPlane,
    organization,
    project,
    environment,
    resource,
    store,
    create,
    setNow: (value: string) => {
      now = new Date(value)
    },
    now: () => now,
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('schedule parsing and provider capabilities', () => {
  it('normalizes presets, rate expressions, and standard/EventBridge cron', () => {
    expect(
      previewSchedule('hourly', 'UTC', new Date('2026-01-01T00:00:00Z'), 2),
    ).toMatchObject({
      normalized: 'cron(0 * * * *)',
      nextRuns: ['2026-01-01T01:00:00.000Z', '2026-01-01T02:00:00.000Z'],
    })
    expect(
      nextScheduleRuns(
        'rate(5 minutes)',
        'UTC',
        new Date('2026-01-01T00:00:00Z'),
        2,
      ),
    ).toEqual(['2026-01-01T00:05:00.000Z', '2026-01-01T00:10:00.000Z'])
    expect(
      nextScheduleRuns(
        'cron(0 9 ? * 2 2026)',
        'UTC',
        new Date('2026-01-04T00:00:00Z'),
        1,
      )[0],
    ).toBe('2026-01-05T09:00:00.000Z')
  })
  it('skips nonexistent spring wall time and does not double-run repeated fall wall time', () => {
    expect(
      nextScheduleRuns(
        '30 2 * * *',
        'America/Los_Angeles',
        new Date('2026-03-08T08:00:00Z'),
        2,
      ),
    ).toEqual(['2026-03-09T09:30:00.000Z', '2026-03-10T09:30:00.000Z'])
    expect(
      nextScheduleRuns(
        '30 1 * * *',
        'America/Los_Angeles',
        new Date('2026-11-01T07:00:00Z'),
        2,
      ),
    ).toEqual(['2026-11-01T08:30:00.000Z', '2026-11-02T09:30:00.000Z'])
  })
  it('renders provider-specific desired state without pretending unsupported semantics match', () => {
    const target = fixture(),
      job = target.create()
    expect(renderServerCron(job)).toMatchObject({
      path: `/etc/cron.d/ts-cloud-${job.id}`,
    })
    expect(renderServerCron(job).content).toContain(
      'CRON_TZ=America/Los_Angeles',
    )
    expect(() =>
      renderServerCron({ ...job, expression: 'cron(30 2 ? * 2 *)' }),
    ).toThrow('EventBridge six-field cron extensions')
    expect(
      eventBridgeScheduleInput({
        ...job,
        provider: 'eventbridge',
        flexibleMinutes: 10,
      }),
    ).toMatchObject({
      ScheduleExpression: 'cron(30 2 * * ? *)',
      FlexibleTimeWindow: { Mode: 'FLEXIBLE', MaximumWindowInMinutes: 10 },
    })
  })
})

describe('durable job execution', () => {
  it('deduplicates scheduled dispatch and deterministically forbids overlap', () => {
    const target = fixture(),
      job = target.create(),
      queue = new DurableOperationQueue(target.controlPlane, {
        now: target.now,
      }),
      service = new JobService(target.store, { queue }),
      first = service.enqueue(job, {
        trigger: 'scheduled',
        scheduledFor: '2026-03-09T09:30:00Z',
      }),
      replay = service.enqueue(job, {
        trigger: 'scheduled',
        scheduledFor: '2026-03-09T09:30:00Z',
      }),
      blocked = service.enqueue(job, { trigger: 'manual' })
    expect(first.id).toBe(replay.id)
    expect(blocked).toMatchObject({
      status: 'skipped',
      output: { reason: 'overlap_forbidden' },
    })
  })
  it('runs failure, durable retry, linked logs, and success history end to end', async () => {
    const target = fixture(),
      job = target.create({ overlapPolicy: 'allow' }),
      queue = new DurableOperationQueue(target.controlPlane, {
        now: target.now,
      }),
      service = new JobService(target.store, { queue }),
      execution = service.enqueue(job, { trigger: 'manual' })
    let calls = 0
    const handlers = createJobQueueHandlers({
        store: target.store,
        executor: async () =>
          ++calls === 1
            ? {
                ok: false,
                stderr: 'provider temporarily unavailable',
                retryable: true,
              }
            : { ok: true, stdout: 'done', output: { processed: 4 } },
      }),
      worker = new DurableQueueWorker(queue, handlers)
    expect(await worker.drain()).toMatchObject([{ requeued: true }])
    expect(target.store.getExecution(execution.id)?.status).toBe('failed')
    target.setNow('2026-03-07T08:00:02Z')
    expect(await worker.drain()).toMatchObject([{ terminalState: 'succeeded' }])
    expect(target.store.getExecution(execution.id)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      output: { processed: 4 },
    })
    expect(
      queue
        .logs(execution.operationId!)
        .map((item) => item.message)
        .join('\n'),
    ).toContain('done')
  })
  it('applies bounded catch-up after downtime and advances the persisted cursor', () => {
    const target = fixture(),
      job = target.create({
        expression: '* * * * *',
        timezone: 'UTC',
        missedRunPolicy: 'catch_up',
        overlapPolicy: 'allow',
      })
    target.controlPlane.database.run(
      'UPDATE scheduled_jobs SET next_run_at=? WHERE id=?',
      ['2026-03-07T08:01:00Z', job.id],
    )
    target.setNow('2026-03-07T08:04:30Z')
    const executions = new JobService(target.store, {
      queue: new DurableOperationQueue(target.controlPlane, {
        now: target.now,
      }),
    }).tick(target.now())
    expect(executions.map((item) => item.trigger)).toEqual([
      'scheduled',
      'catch_up',
      'catch_up',
      'catch_up',
    ])
    expect(target.store.get(job.id)?.nextRunAt).toBe('2026-03-07T08:05:00.000Z')
  })
})

describe('config reconciliation', () => {
  it('imports workers and schedules idempotently and retains removed definitions as drift', () => {
    const target = fixture(),
      scope = {
        organization: target.organization,
        project: target.project,
        environment: target.environment,
        resources: [target.resource],
      },
      config = {
        project: { slug: 'app' },
        sites: {
          api: {
            scheduler: true,
            queues: [{ queue: 'emails', processes: 2, timeout: 90 }],
          },
        },
        infrastructure: {
          compute: { backups: { enabled: true, schedule: '0 3 * * *' } },
        },
      } as any
    expect(synchronizeConfiguredJobs(target.store, config, scope)).toEqual({
      jobs: 2,
      workers: 1,
      drifted: 0,
    })
    expect(synchronizeConfiguredJobs(target.store, config, scope)).toEqual({
      jobs: 2,
      workers: 1,
      drifted: 0,
    })
    expect(
      target.store.list(target.project.id, {
        environmentId: target.environment.id,
      }),
    ).toHaveLength(2)
    expect(
      target.store.listWorkers(target.project.id, target.environment.id),
    ).toMatchObject([{ queue: 'emails', processes: 2, origin: 'config' }])
    const result = synchronizeConfiguredJobs(
      target.store,
      { project: { slug: 'app' }, sites: {} } as any,
      scope,
    )
    expect(result.drifted).toBe(3)
    expect(
      target.store.list(target.project.id, {
        environmentId: target.environment.id,
      })[0].reconciliationStatus,
    ).toBe('drifted')
  })
})

describe('serverless config reconciliation', () => {
  it('imports the scheduler and queue functions as provider-managed jobs and workers', () => {
    const target = fixture(),
      scope = {
        organization: target.organization,
        project: target.project,
        environment: target.environment,
        resources: [target.resource],
      },
      config = {
        project: { slug: 'app' },
        environments: {
          production: {
            type: 'production',
            app: {
              scheduler: 'sub-minute',
              queues: ['emails', { critical: 4 }],
              queueTimeout: 180,
            },
          },
        },
      } as any
    expect(synchronizeConfiguredJobs(target.store, config, scope)).toEqual({
      jobs: 1,
      workers: 2,
      drifted: 0,
    })
    expect(
      target.store.list(target.project.id, {
        environmentId: target.environment.id,
      })[0],
    ).toMatchObject({
      provider: 'eventbridge',
      target: { kind: 'serverless_scheduler' },
      missedRunPolicy: 'catch_up',
    })
    const workers = target.store.listWorkers(
      target.project.id,
      target.environment.id,
    )
    expect(workers.find((item) => item.queue === 'emails')).toMatchObject({
      provider: 'lambda',
      processes: 1,
      timeoutSeconds: 180,
    })
    expect(workers.find((item) => item.queue === 'critical')).toMatchObject({
      provider: 'lambda',
      processes: 4,
      timeoutSeconds: 180,
    })
  })
})
