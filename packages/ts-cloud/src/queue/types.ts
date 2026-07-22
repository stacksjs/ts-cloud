import type { ControlPlaneOperation, CreateOperationInput, JsonValue, OperationState } from '../control-plane'

export interface QueueConcurrencyLimits {
  project: number
  environment: number
  provider: number
  builds: number
}

export interface EnqueueOperationInput extends CreateOperationInput {
  lockKey?: string
  providerKey?: string
  buildSlot?: boolean
  maxAttempts?: number
  availableAt?: string
  timeoutSeconds?: number
  retryClasses?: string[]
  resumePolicy?: 'fail' | 'requeue'
  cancellationMode?: 'cooperative' | 'provider_non_cancellable'
  retentionDays?: number
}

export interface OperationJob {
  operationId: string
  lockKey?: string
  providerKey?: string
  buildSlot: boolean
  maxAttempts: number
  availableAt: string
  timeoutSeconds: number
  heartbeatAt?: string
  currentStep?: string
  blockedReason?: string
  retryClasses: string[]
  resumePolicy: 'fail' | 'requeue'
  cancellationMode: 'cooperative' | 'provider_non_cancellable'
  retentionUntil: string
  createdAt: string
  updatedAt: string
}

export interface OperationLogEntry {
  sequence: number
  id: string
  operationId: string
  stream: 'stdout' | 'stderr' | 'system' | 'step'
  step?: string
  message: string
  redacted: boolean
  truncated: boolean
  createdAt: string
}

export interface QueueOperationView {
  operation: ControlPlaneOperation
  job: OperationJob
  approximatePosition?: { ahead: number; precision: 'bounded' }
}

export interface QueueLogInput {
  stream?: OperationLogEntry['stream']
  step?: string
  secrets?: string[]
}

export interface QueueExecutionContext {
  operation: ControlPlaneOperation
  signal: AbortSignal
  log: (message: string, input?: QueueLogInput) => OperationLogEntry
  checkpoint: (step: string, message?: string) => void
  heartbeat: () => void
  cancellationRequested: () => boolean
  throwIfCancellationRequested: () => void
}

export type QueueOperationHandler = (context: QueueExecutionContext) => Promise<JsonValue | void>

export interface QueueRunResult {
  operation?: ControlPlaneOperation
  handled: boolean
  terminalState?: Extract<OperationState, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>
  requeued?: boolean
}

export interface QueueRecoveryResult {
  requeued: number
  failed: number
  cancelled: number
}

export class QueueCancellationError extends Error {
  constructor() {
    super('Operation cancellation was requested')
  }
}

export class QueueTimeoutError extends Error {
  constructor(public readonly timeoutSeconds: number) {
    super(`Operation exceeded its ${timeoutSeconds}s timeout`)
  }
}

export class RetryableOperationError extends Error {
  constructor(
    message: string,
    public readonly errorClass: string,
  ) {
    super(message)
  }
}
