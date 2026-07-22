import type { JsonValue } from '../control-plane'

export type JobProvider = 'server' | 'eventbridge' | 'lambda' | 'platform'
export type JobTrigger =
  | 'scheduled'
  | 'manual'
  | 'catch_up'
  | 'external'
  | 'retry'
export type JobExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'dead'
export type ReconciliationStatus =
  | 'pending'
  | 'in_sync'
  | 'drifted'
  | 'unsupported'
  | 'unavailable'
export interface JobTarget {
  kind: 'dashboard_operation' | 'serverless_scheduler' | 'lambda' | 'platform'
  operationId?: string
  action?: string
  functionName?: string
  platformOperation?: string
}
export interface ScheduledJob {
  id: string
  organizationId: string
  projectId: string
  environmentId?: string
  resourceId?: string
  name: string
  provider: JobProvider
  expression: string
  normalizedExpression: string
  timezone: string
  startsAt?: string
  endsAt?: string
  flexibleMinutes: number
  target: JobTarget
  payloadRefs: Record<string, JsonValue>
  missedRunPolicy: 'skip' | 'catch_up'
  overlapPolicy: 'allow' | 'forbid' | 'replace'
  retryPolicy: {
    maxAttempts: number
    backoffSeconds: number
    deadLetterRef?: string
  }
  timeoutSeconds: number
  enabled: boolean
  origin: 'managed' | 'config' | 'external'
  sourceKey?: string
  ownerActorId?: string
  observedState: Record<string, JsonValue>
  reconciliationStatus: ReconciliationStatus
  nextRunAt?: string
  lastScheduledFor?: string
  version: number
  createdAt: string
  updatedAt: string
}
export interface JobExecution {
  id: string
  jobId: string
  operationId?: string
  trigger: JobTrigger
  scheduledFor: string
  idempotencyKey: string
  status: JobExecutionStatus
  attempt: number
  startedAt?: string
  finishedAt?: string
  output: Record<string, JsonValue>
  error?: string
  createdAt: string
  updatedAt: string
}
export interface WorkerDefinition {
  id: string
  organizationId: string
  projectId: string
  environmentId?: string
  resourceId?: string
  name: string
  provider: 'systemd' | 'ecs' | 'lambda'
  queue: string
  processes: number
  timeoutSeconds: number
  restartPolicy: 'always' | 'on_failure' | 'never'
  target: Record<string, JsonValue>
  enabled: boolean
  origin: 'managed' | 'config' | 'external'
  sourceKey?: string
  ownerActorId?: string
  observedState: Record<string, JsonValue>
  reconciliationStatus: ReconciliationStatus
  version: number
  createdAt: string
  updatedAt: string
}
export interface SchedulePreview {
  original: string
  normalized: string
  kind: 'cron' | 'rate'
  timezone: string
  description: string
  nextRuns: string[]
  capabilities: { server: boolean; eventbridge: boolean; notes: string[] }
}
