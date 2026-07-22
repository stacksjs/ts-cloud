import { randomUUID } from 'node:crypto'

export type RuntimeStreamKind = 'exec' | 'logs'
export type RuntimeStreamState = 'open' | 'complete' | 'failed' | 'cancelled'

export interface RuntimeStreamChunk {
  cursor: number
  stream: 'stdout' | 'stderr' | 'system'
  data: string
  at: string
}

export interface RuntimeStreamSnapshot {
  id: string
  workloadId: string
  kind: RuntimeStreamKind
  state: RuntimeStreamState
  chunks: RuntimeStreamChunk[]
  cursor: number
  reset: boolean
  droppedBytes: number
  createdAt: string
  updatedAt: string
  error?: string
}

interface RuntimeStreamRecord extends Omit<RuntimeStreamSnapshot, 'chunks' | 'reset'> {
  chunks: RuntimeStreamChunk[]
  bufferedBytes: number
  abort: AbortController
  listeners: Set<(snapshot: RuntimeStreamSnapshot) => void>
}

export interface RuntimeStreamRegistryOptions {
  maxBufferBytes?: number
  ttlMs?: number
  now?: () => Date
}

/**
 * Bounded, reconnectable runtime output. Cursors are monotonically increasing
 * chunk IDs: clients can reconnect with their last cursor, and receive a reset
 * signal when backpressure already evicted older chunks.
 */
export class RuntimeStreamRegistry {
  private readonly records = new Map<string, RuntimeStreamRecord>()
  private readonly maxBufferBytes: number
  private readonly ttlMs: number
  private readonly now: () => Date

  constructor(options: RuntimeStreamRegistryOptions = {}) {
    this.maxBufferBytes = Math.max(1024, options.maxBufferBytes ?? 256 * 1024)
    this.ttlMs = Math.max(1000, options.ttlMs ?? 15 * 60 * 1000)
    this.now = options.now ?? (() => new Date())
  }

  create(kind: RuntimeStreamKind, workloadId: string): RuntimeStreamSnapshot {
    this.sweep()
    const at = this.now().toISOString()
    const record: RuntimeStreamRecord = {
      id: randomUUID(), workloadId, kind, state: 'open', chunks: [], cursor: 0, droppedBytes: 0,
      bufferedBytes: 0, createdAt: at, updatedAt: at, abort: new AbortController(), listeners: new Set(),
    }
    this.records.set(record.id, record)
    return this.snapshot(record, 0)
  }

  signal(id: string): AbortSignal | undefined {
    return this.records.get(id)?.abort.signal
  }

  append(id: string, data: string, stream: RuntimeStreamChunk['stream'] = 'stdout'): RuntimeStreamSnapshot | undefined {
    const record = this.records.get(id)
    if (!record || record.state !== 'open' || !data) return record ? this.snapshot(record, record.cursor) : undefined
    const bytes = Buffer.from(data)
    const bounded = bytes.byteLength > this.maxBufferBytes ? bytes.subarray(bytes.byteLength - this.maxBufferBytes).toString('utf8') : data
    const chunk: RuntimeStreamChunk = { cursor: ++record.cursor, stream, data: bounded, at: this.now().toISOString() }
    record.chunks.push(chunk)
    record.bufferedBytes += Buffer.byteLength(bounded)
    record.updatedAt = chunk.at
    while (record.bufferedBytes > this.maxBufferBytes && record.chunks.length > 1) {
      const removed = record.chunks.shift()!
      const removedBytes = Buffer.byteLength(removed.data)
      record.bufferedBytes -= removedBytes
      record.droppedBytes += removedBytes
    }
    this.publish(record)
    return this.snapshot(record, chunk.cursor - 1)
  }

  read(id: string, workloadId: string, after = 0): RuntimeStreamSnapshot | undefined {
    const record = this.records.get(id)
    if (!record || record.workloadId !== workloadId) return undefined
    record.updatedAt = this.now().toISOString()
    return this.snapshot(record, Math.max(0, Math.floor(after)))
  }

  close(id: string, state: Exclude<RuntimeStreamState, 'open'> = 'complete', error?: string): RuntimeStreamSnapshot | undefined {
    const record = this.records.get(id)
    if (!record || record.state !== 'open') return record ? this.snapshot(record, record.cursor) : undefined
    record.state = state
    record.error = error
    record.updatedAt = this.now().toISOString()
    if (state === 'cancelled') record.abort.abort()
    this.publish(record)
    return this.snapshot(record, record.cursor)
  }

  cancel(id: string, workloadId: string): RuntimeStreamSnapshot | undefined {
    const record = this.records.get(id)
    if (!record || record.workloadId !== workloadId) return undefined
    return this.close(id, 'cancelled')
  }

  subscribe(id: string, workloadId: string, listener: (snapshot: RuntimeStreamSnapshot) => void): (() => void) | undefined {
    const record = this.records.get(id)
    if (!record || record.workloadId !== workloadId) return undefined
    record.listeners.add(listener)
    return () => record.listeners.delete(listener)
  }

  sweep(): number {
    const expiresBefore = this.now().getTime() - this.ttlMs
    let removed = 0
    for (const [id, record] of this.records) {
      if (new Date(record.updatedAt).getTime() > expiresBefore) continue
      record.abort.abort()
      this.records.delete(id)
      removed++
    }
    return removed
  }

  clear(): void {
    for (const record of this.records.values()) record.abort.abort()
    this.records.clear()
  }

  private snapshot(record: RuntimeStreamRecord, after: number): RuntimeStreamSnapshot {
    const first = record.chunks[0]?.cursor ?? record.cursor + 1
    const reset = after > 0 && after < first - 1
    return {
      id: record.id, workloadId: record.workloadId, kind: record.kind, state: record.state,
      chunks: record.chunks.filter(chunk => reset || chunk.cursor > after), cursor: record.cursor,
      reset, droppedBytes: record.droppedBytes, createdAt: record.createdAt, updatedAt: record.updatedAt, error: record.error,
    }
  }

  private publish(record: RuntimeStreamRecord): void {
    const snapshot = this.snapshot(record, 0)
    for (const listener of record.listeners) listener(snapshot)
  }
}
