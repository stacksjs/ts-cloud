import type { JsonValue } from '../control-plane'
import type { ScheduledJob } from './model'
import { normalizeScheduleExpression } from './schedule'

export interface JobProviderCapability {
  provider: ScheduledJob['provider']
  supported: boolean
  features: {
    timezone: boolean
    flexibleWindow: boolean
    catchUp: boolean
    replaceOverlap: boolean
  }
  notes: string[]
}
export function jobProviderCapability(
  job: Pick<ScheduledJob, 'provider' | 'expression' | 'flexibleMinutes' | 'missedRunPolicy' | 'overlapPolicy'>,
): JobProviderCapability {
  const parsed = normalizeScheduleExpression(job.expression),
    fields = parsed.normalized.slice(5, -1).trim().split(/\s+/),
    serverCron = parsed.kind === 'cron' && fields.length === 5
  if (job.provider === 'server')
    return {
      provider: 'server',
      supported: serverCron,
      features: {
        timezone: true,
        flexibleWindow: false,
        catchUp: false,
        replaceOverlap: false,
      },
      notes: [
        parsed.kind === 'rate'
          ? 'Server cron requires a cron expression; use an equivalent cron schedule.'
          : fields.length !== 5
            ? 'EventBridge six-field cron extensions cannot be installed as server cron.'
            : 'Cron is reconciled through a root-owned ts-cloud entry.',
        job.missedRunPolicy === 'catch_up'
          ? 'Catch-up is handled by the control plane, not cron.'
          : 'Missed runs are skipped by cron.',
      ],
    }
  if (job.provider === 'eventbridge')
    return {
      provider: 'eventbridge',
      supported: true,
      features: {
        timezone: true,
        flexibleWindow: true,
        catchUp: false,
        replaceOverlap: false,
      },
      notes: [
        'Five-field cron is translated explicitly to EventBridge six-field syntax. Flexible windows are provider-native; overlap and catch-up remain control-plane policies.',
      ],
    }
  if (job.provider === 'lambda')
    return {
      provider: 'lambda',
      supported: true,
      features: {
        timezone: true,
        flexibleWindow: true,
        catchUp: false,
        replaceOverlap: false,
      },
      notes: ['The schedule invokes one immutable Lambda target.'],
    }
  return {
    provider: 'platform',
    supported: true,
    features: {
      timezone: true,
      flexibleWindow: true,
      catchUp: true,
      replaceOverlap: true,
    },
    notes: ['The durable control-plane worker enforces all configured policies.'],
  }
}
export function renderServerCron(job: ScheduledJob): {
  path: string
  content: string
} {
  const capability = jobProviderCapability({ ...job, provider: 'server' })
  if (!capability.supported) throw new Error(capability.notes.join(' '))
  const expression = normalizeScheduleExpression(job.expression)
  const cron = expression.normalized.slice(5, -1)
  return {
    path: `/etc/cron.d/ts-cloud-${job.id}`,
    content: `CRON_TZ=${job.timezone}\n${cron} root /usr/local/bin/cloud jobs:dispatch ${job.id} --scheduled >/dev/null 2>&1\n`,
  }
}
function eventBridgeExpression(expression: string): string {
  const parsed = normalizeScheduleExpression(expression)
  if (parsed.kind === 'rate') return expression
  const fields = parsed.normalized.slice(5, -1).trim().split(/\s+/)
  if (fields.length === 6) return parsed.normalized
  const [minute, hour, day, month, weekday] = fields
  const awsWeekday =
    weekday === '*' ? '?' : weekday.replace(/(^|[,-])0(?=$|[,-])/g, (_match, prefix: string) => `${prefix}1`)
  return day === '*' && weekday !== '*'
    ? `cron(${minute} ${hour} ? ${month} ${awsWeekday} *)`
    : `cron(${minute} ${hour} ${day} ${month} ? *)`
}
export function eventBridgeScheduleInput(job: ScheduledJob): Record<string, JsonValue> {
  const capability = jobProviderCapability(job)
  if (!capability.supported) throw new Error(capability.notes.join(' '))
  return {
    Name: `ts-cloud-${job.id}`,
    ScheduleExpression: eventBridgeExpression(job.expression),
    ScheduleExpressionTimezone: job.timezone,
    State: job.enabled ? 'ENABLED' : 'DISABLED',
    FlexibleTimeWindow: job.flexibleMinutes
      ? { Mode: 'FLEXIBLE', MaximumWindowInMinutes: job.flexibleMinutes }
      : { Mode: 'OFF' },
    Target: {
      kind: job.target.kind,
      functionName: job.target.functionName ?? null,
      payloadRefs: job.payloadRefs,
    },
    RetryPolicy: {
      MaximumRetryAttempts: job.retryPolicy.maxAttempts,
      MaximumEventAgeInSeconds: job.timeoutSeconds,
    },
    DeadLetterRef: job.retryPolicy.deadLetterRef ?? null,
  }
}
export function reconcileJobObservation(
  job: ScheduledJob,
  observed: Record<string, JsonValue> | undefined,
): {
  status: ScheduledJob['reconciliationStatus']
  observedState: Record<string, JsonValue>
} {
  if (!observed)
    return {
      status: 'unavailable',
      observedState: { message: 'Provider observation is unavailable.' },
    }
  const expression = String(observed.expression ?? ''),
    enabled = observed.enabled
  const drift =
    (expression && expression !== job.normalizedExpression) || (typeof enabled === 'boolean' && enabled !== job.enabled)
  return { status: drift ? 'drifted' : 'in_sync', observedState: observed }
}
