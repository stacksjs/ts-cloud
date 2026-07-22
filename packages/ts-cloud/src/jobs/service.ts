import type { JsonValue } from '../control-plane'
import type { QueueExecutionContext, QueueOperationHandler } from '../queue'
import type { JobExecution, JobTarget, JobTrigger, ScheduledJob } from './model'
import { DurableOperationQueue, RetryableOperationError } from '../queue'
import { JobStore } from './store'
import { nextScheduleRuns } from './schedule'

export interface JobExecutorResult {
  ok: boolean
  output?: Record<string, JsonValue>
  stdout?: string
  stderr?: string
  retryable?: boolean
}
export type JobExecutor = (
  job: ScheduledJob,
  target: JobTarget,
  context: QueueExecutionContext,
) => Promise<JobExecutorResult>
export class JobService {
  readonly queue: DurableOperationQueue
  constructor(
    readonly store: JobStore,
    options: { queue?: DurableOperationQueue } = {},
  ) {
    this.queue = options.queue ?? new DurableOperationQueue(store.controlPlane)
  }
  enqueue(
    job: ScheduledJob,
    input: { trigger: JobTrigger; scheduledFor?: string; actorId?: string },
  ): JobExecution {
    const scheduledFor = new Date(
        input.scheduledFor ?? this.store.now(),
      ).toISOString(),
      key = `${job.id}:${input.trigger === 'manual' ? crypto.randomUUID() : scheduledFor}`
    const active = this.store.activeExecution(job.id)
    if (active && job.overlapPolicy === 'forbid')
      return this.store.createExecution({
        jobId: job.id,
        trigger: input.trigger,
        scheduledFor,
        idempotencyKey: key,
        status: 'skipped',
        output: { reason: 'overlap_forbidden', activeExecutionId: active.id },
      })
    if (active && job.overlapPolicy === 'replace' && active.operationId) {
      try {
        this.queue.requestCancellation(active.operationId, input.actorId)
      } catch {}
    }
    const execution = this.store.createExecution({
      jobId: job.id,
      trigger: input.trigger,
      scheduledFor,
      idempotencyKey: key,
      status: 'queued',
      output: { semantics: 'at_least_once' },
    })
    if (execution.operationId) return execution
    const operation = this.queue.enqueue({
      projectId: job.projectId,
      environmentId: job.environmentId,
      resourceId: job.resourceId,
      actorId: input.actorId,
      kind: 'job.execute',
      input: { jobId: job.id, executionId: execution.id },
      idempotencyKey: `job-execution:${execution.id}`,
      lockKey:
        job.overlapPolicy === 'allow'
          ? `job-execution:${execution.id}`
          : `job:${job.id}`,
      maxAttempts: job.retryPolicy.maxAttempts,
      timeoutSeconds: job.timeoutSeconds,
      retryClasses: ['job_transient'],
      resumePolicy: 'requeue',
    }).operation
    return this.store.attachOperation(execution.id, operation.id)
  }
  tick(at: Date = this.store.now()): JobExecution[] {
    const queued: JobExecution[] = []
    for (const job of this.store.due(at.toISOString())) {
      const due = job.nextRunAt!,
        next = nextScheduleRuns(
          job.normalizedExpression,
          job.timezone,
          at,
          1,
        )[0]
      if (job.missedRunPolicy === 'catch_up') {
        let cursor = due,
          count = 0
        while (cursor <= at.toISOString() && count < 10) {
          queued.push(
            this.enqueue(job, {
              trigger: cursor === due ? 'scheduled' : 'catch_up',
              scheduledFor: cursor,
            }),
          )
          cursor = nextScheduleRuns(
            job.normalizedExpression,
            job.timezone,
            new Date(cursor),
            1,
          )[0]
          count++
        }
      } else
        queued.push(
          this.enqueue(job, { trigger: 'scheduled', scheduledFor: due }),
        )
      this.store.markScheduled(job.id, due, next)
    }
    return queued
  }
}
export function createJobQueueHandlers(input: {
  store: JobStore
  executor: JobExecutor
}): Record<string, QueueOperationHandler> {
  const handler: QueueOperationHandler = async (context) => {
    const record =
      context.operation.input &&
      typeof context.operation.input === 'object' &&
      !Array.isArray(context.operation.input)
        ? (context.operation.input as Record<string, JsonValue>)
        : {}
    const job = input.store.get(String(record.jobId ?? ''))
    const execution = input.store.getExecution(String(record.executionId ?? ''))
    if (!job || !execution)
      throw new Error('Scheduled job execution is no longer available.')
    input.store.transitionExecution(execution.id, 'running', {
      attempt: context.operation.attempt,
    })
    context.checkpoint('execute', `Running ${job.name} on ${job.provider}.`)
    context.log(
      `Trigger ${execution.trigger}; scheduled for ${execution.scheduledFor}; semantics at-least-once.`,
      { stream: 'system' },
    )
    const result = await input.executor(job, job.target, context)
    if (result.stdout) context.log(result.stdout, { stream: 'stdout' })
    if (result.stderr) context.log(result.stderr, { stream: 'stderr' })
    if (!result.ok) {
      input.store.transitionExecution(
        execution.id,
        context.operation.attempt >= job.retryPolicy.maxAttempts
          ? 'dead'
          : 'failed',
        {
          attempt: context.operation.attempt,
          error: result.stderr ?? 'Job execution failed.',
        },
      )
      if (result.retryable)
        throw new RetryableOperationError(
          result.stderr ?? 'Scheduled job failed transiently.',
          'job_transient',
        )
      throw new Error(result.stderr ?? 'Scheduled job failed.')
    }
    input.store.transitionExecution(execution.id, 'succeeded', {
      attempt: context.operation.attempt,
      output: result.output ?? {},
    })
    return { jobId: job.id, executionId: execution.id, provider: job.provider }
  }
  return { 'job.execute': handler }
}
