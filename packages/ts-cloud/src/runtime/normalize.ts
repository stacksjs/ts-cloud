import type { WorkloadStatus } from './model'

const SECRET_KEY = /(?:secret|password|passwd|token|api[_-]?key|private[_-]?key|credential|authorization|cookie)/i

export function normalizeRuntimeStatus(raw: unknown): WorkloadStatus {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (['active', 'running', 'ready', 'healthy', 'available', 'steady', 'active:running'].includes(value))
    return 'running'
  if (['activating', 'pending', 'provisioning', 'starting', 'created', 'initializing'].includes(value))
    return 'starting'
  if (['deactivating', 'stopping', 'draining', 'terminating'].includes(value)) return 'stopping'
  if (['inactive', 'stopped', 'complete', 'completed', 'exited', 'disabled'].includes(value)) return 'stopped'
  if (['degraded', 'unhealthy', 'warning'].includes(value)) return 'degraded'
  if (['failed', 'dead', 'error', 'crashed', 'oomkilled'].includes(value)) return 'failed'
  return 'unknown'
}

export function redactRuntimeConfig<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactRuntimeConfig(item)) as T
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactRuntimeConfig(item)
  return output as T
}

export function ageSeconds(value: string | undefined, now: Date = new Date()): number | undefined {
  if (!value) return undefined
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((now.getTime() - timestamp) / 1000)) : undefined
}

export function bytes(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}
