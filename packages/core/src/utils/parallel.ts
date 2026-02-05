/**
 * Parallel execution utilities
 * Optimize deployment performance with parallel operations
*/

export interface ParallelOptions {
  concurrency?: number
  stopOnError?: boolean
}

export interface ParallelResult<T> {
  results: T[]
  errors: Error[]
  duration: number
}

/**
 * Execute tasks in parallel with configurable concurrency
*/
export async function parallel<T>(
  tasks: (() => Promise<T>)[],
  options: ParallelOptions = {},
): Promise<ParallelResult<T>> {
  const concurrency = options.concurrency || 5
  const stopOnError = options.stopOnError ?? true

  const results: T[] = []
  const errors: Error[] = []
  const startTime = Date.now()

  const queue = [...tasks]
  const running: Promise<void>[] = []

  async function runTask(task: () => Promise<T>, index: number): Promise<void> {
    try {
      const result = await task()
      results[index] = result
    }
    catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      errors.push(err)

      if (stopOnError) {
        queue.length = 0 // Clear queue
        throw err
      }
    }
  }

  let index = 0
  while (queue.length > 0 || running.length > 0) {
    // Fill up to concurrency limit
    while (running.length < concurrency && queue.length > 0) {
      const task = queue.shift()!
      const currentIndex = index++
      const promise = runTask(task, currentIndex)
      running.push(promise)
    }

    // Wait for at least one task to complete
    if (running.length > 0) {
      await Promise.race(running)

      // Remove completed tasks
      for (let i = running.length - 1; i >= 0; i--) {
        const settled = await Promise.race([
          running[i].then(() => true),
          Promise.resolve(false),
        ])

        if (settled) {
          running.splice(i, 1)
        }
      }
    }

    // Stop if error occurred and stopOnError is true
    if (stopOnError && errors.length > 0) {
      break
    }
  }

  const duration = Date.now() - startTime

  return {
    results: results.filter(r => r !== undefined),
    errors,
    duration,
  }
}

/**
 * Execute tasks in batches with controlled concurrency
*/
export async function batch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  options: ParallelOptions = {},
): Promise<ParallelResult<R>> {
  const tasks = items.map(item => () => processor(item))
  return parallel(tasks, options)
}

/**
 * Map over array with parallel execution
*/
export async function parallelMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number = 5,
): Promise<R[]> {
  const tasks = items.map((item, index) => () => mapper(item, index))
  const result = await parallel(tasks, { concurrency, stopOnError: false })

  if (result.errors.length > 0) {
    throw new AggregateError(result.errors, 'Parallel map failed')
  }

  return result.results
}

/**
 * Execute tasks with retry logic
*/
export async function parallelWithRetry<T>(
  tasks: (() => Promise<T>)[],
  options: ParallelOptions & { retries?: number, retryDelay?: number } = {},
): Promise<ParallelResult<T>> {
  const retries = options.retries || 3
  const retryDelay = options.retryDelay || 1000

  const retriableTasks = tasks.map(task => async () => {
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await task()
      }
      catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        // Wait before retry (except on last attempt)
        if (attempt < retries) {
          await sleep(retryDelay * (attempt + 1)) // Exponential backoff
        }
      }
    }

    throw lastError
  })

  return parallel(retriableTasks, options)
}

/**
 * Execute tasks in sequence (one after another)
*/
export async function sequence<T>(
  tasks: (() => Promise<T>)[],
): Promise<T[]> {
  const results: T[] = []

  for (const task of tasks) {
    const result = await task()
    results.push(result)
  }

  return results
}

/**
 * Sleep for specified milliseconds
*/
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Execute tasks with timeout
*/
export async function withTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string = 'Operation timed out',
): Promise<T> {
  return Promise.race([
    task(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs),
    ),
  ])
}

/**
 * Rate limiter for API calls
*/
export class RateLimiter {
  private queue: (() => void)[] = []
  private running = 0
  private lastExecution = 0

  constructor(
    private maxConcurrent: number = 5,
    private minInterval: number = 100, // milliseconds between calls
  ) {}

  /**
   * Execute task with rate limiting
  */
  async execute<T>(task: () => Promise<T>): Promise<T> {
    // Wait for available slot
    await this.waitForSlot()

    this.running++
    this.lastExecution = Date.now()

    try {
      return await task()
    }
    finally {
      this.running--
      this.processQueue()
    }
  }

  /**
   * Wait for available execution slot
  */
  private waitForSlot(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      const timeSinceLastExecution = Date.now() - this.lastExecution

      if (timeSinceLastExecution >= this.minInterval) {
        return Promise.resolve()
      }

      return sleep(this.minInterval - timeSinceLastExecution)
    }

    return new Promise(resolve => this.queue.push(resolve))
  }

  /**
   * Process queued tasks
  */
  private processQueue(): void {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const resolve = this.queue.shift()!
      resolve()
    }
  }

  /**
   * Get stats
  */
  stats(): { running: number, queued: number } {
    return {
      running: this.running,
      queued: this.queue.length,
    }
  }
}

/**
 * Chunk array into smaller batches
*/
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = []

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }

  return chunks
}

/**
 * Process array in chunks with parallel execution
*/
export async function processInChunks<T, R>(
  items: T[],
  chunkSize: number,
  processor: (chunk: T[]) => Promise<R[]>,
): Promise<R[]> {
  const chunks = chunk(items, chunkSize)
  const results: R[] = []

  for (const currentChunk of chunks) {
    const chunkResults = await processor(currentChunk)
    results.push(...chunkResults)
  }

  return results
}
