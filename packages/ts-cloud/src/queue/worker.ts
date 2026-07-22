import type { QueueOperationHandler, QueueRunResult } from './types'
import type { DurableOperationQueue } from './queue'

export interface DurableQueueWorkerOptions {
  parallelism?: number
  pollIntervalMs?: number
  onResult?: (result: QueueRunResult) => void
  onError?: (error: unknown) => void
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value))
    return fallback
  return Math.min(maximum, Math.max(1, Math.floor(value!)))
}

/**
 * Runs a fixed number of durable polling lanes. The database queue remains the
 * source of truth for claims, resource locks, and per-scope concurrency.
 */
export class DurableQueueWorker {
  private readonly parallelism: number
  private readonly pollIntervalMs: number
  private readonly onResult?: (result: QueueRunResult) => void
  private readonly onError?: (error: unknown) => void
  private readonly waits = new Map<ReturnType<typeof setTimeout>, () => void>()
  private lanes: Promise<void>[] = []
  private running = false

  constructor(
    private readonly queue: DurableOperationQueue,
    private readonly handlers: Record<string, QueueOperationHandler>,
    options: DurableQueueWorkerOptions = {},
  ) {
    this.parallelism = bounded(options.parallelism, 4, 100)
    this.pollIntervalMs = bounded(options.pollIntervalMs, 500, 60_000)
    this.onResult = options.onResult
    this.onError = options.onError
  }

  get active(): boolean { return this.running }

  start(): this {
    if (this.running)
      return this
    this.running = true
    this.lanes = Array.from({ length: this.parallelism }, () => this.runLane())
    return this
  }

  stop(): void {
    this.running = false
    for (const [timer, resolve] of this.waits) {
      clearTimeout(timer)
      resolve()
    }
    this.waits.clear()
  }

  async settled(): Promise<void> {
    await Promise.allSettled(this.lanes)
  }

  /** Execute all currently claimable work, using the configured lane bound. */
  async drain(): Promise<QueueRunResult[]> {
    const results: QueueRunResult[] = []
    while (true) {
      const batch = await Promise.all(Array.from({ length: this.parallelism }, () => this.queue.runOne(this.handlers)))
      results.push(...batch.filter(result => result.handled))
      if (!batch.some(result => result.handled))
        return results
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waits.delete(timer)
        resolve()
      }, this.pollIntervalMs)
      timer.unref?.()
      this.waits.set(timer, resolve)
    })
  }

  private async runLane(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.queue.runOne(this.handlers)
        if (!this.running)
          break
        if (result.handled) {
          this.onResult?.(result)
          continue
        }
      }
      catch (error) {
        this.onError?.(error)
      }
      await this.wait()
    }
  }
}
