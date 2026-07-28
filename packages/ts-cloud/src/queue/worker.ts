import type { DurableOperationQueue } from './queue'
import type { QueueOperationHandler, QueueRunResult } from './types'

export interface DurableQueueWorkerOptions {
  parallelism?: number
  pollIntervalMs?: number
  onResult?: (result: QueueRunResult) => void
  onError?: (error: unknown) => void
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback
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
  private readonly waits = new Map<
    number,
    { resolve: () => void; timer?: ReturnType<typeof setTimeout> }
  >()
  private nextWaitId = 0
  private lanes: Promise<void>[] = []
  private running = false
  private unsubscribeAvailability?: () => void

  constructor(
    private readonly queue: DurableOperationQueue,
    private readonly handlers: Record<string, QueueOperationHandler>,
    options: DurableQueueWorkerOptions = {},
  ) {
    this.parallelism = bounded(options.parallelism, 4, 100)
    this.pollIntervalMs = bounded(options.pollIntervalMs, 5_000, 60_000)
    this.onResult = options.onResult
    this.onError = options.onError
  }

  get active(): boolean {
    return this.running
  }

  start(): this {
    if (this.running) return this
    this.running = true
    this.unsubscribeAvailability = this.queue.onAvailable(() => this.wake())
    this.lanes = Array.from({ length: this.parallelism }, (_, index) => this.runLane(index))
    return this
  }

  stop(): void {
    this.running = false
    this.unsubscribeAvailability?.()
    this.unsubscribeAvailability = undefined
    this.wake()
  }

  private wake(): void {
    for (const { resolve, timer } of this.waits.values()) {
      if (timer) clearTimeout(timer)
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
      results.push(...batch.filter((result) => result.handled))
      if (!batch.some((result) => result.handled)) return results
    }
  }

  private wait(useFallbackPoll: boolean): Promise<void> {
    return new Promise((resolve) => {
      const id = ++this.nextWaitId
      const timer = useFallbackPoll
        ? setTimeout(() => {
            this.waits.delete(id)
            resolve()
          }, this.pollIntervalMs)
        : undefined
      timer?.unref?.()
      this.waits.set(id, { resolve, timer })
    })
  }

  private async runLane(index: number): Promise<void> {
    while (this.running) {
      try {
        const result = await this.queue.runOne(this.handlers)
        if (!this.running) break
        if (result.handled) {
          this.onResult?.(result)
          // A claimed job proves work exists. Wake the other lanes so they can
          // fill the configured concurrency without giving every idle lane its
          // own database poll timer.
          this.wake()
          continue
        }
      } catch (error) {
        this.onError?.(error)
      }
      // One coordinator lane retains the durable cross-process recovery poll.
      // Every other lane sleeps until an enqueue or a successful claim wakes
      // it, reducing idle SQLite reads from parallelism-per-interval to one.
      await this.wait(index === 0)
    }
  }
}
