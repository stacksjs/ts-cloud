import type { JsonValue } from '../control-plane'

const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|session)/i
const SENSITIVE_TEXT =
  /\b(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)\s*[=:]\s*[^\s,;&\[]+/gi
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

export interface TelemetryRedactionOptions {
  redactEmail?: boolean
  redactIp?: boolean
  patterns?: RegExp[]
}

export function redactTelemetryText(value: string, options: TelemetryRedactionOptions = {}): string {
  let redacted = value.replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, '$1=[REDACTED]').replace(SENSITIVE_TEXT, '[REDACTED]')
  if (options.redactEmail !== false) redacted = redacted.replace(EMAIL, '[EMAIL]')
  if (options.redactIp) redacted = redacted.replace(IPV4, '[IP]')
  for (const pattern of options.patterns ?? []) redacted = redacted.replace(pattern, '[REDACTED]')
  return redacted
}

export function redactTelemetryValue(value: unknown, options: TelemetryRedactionOptions = {}, key?: string): JsonValue {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactTelemetryText(value, options)
  if (Array.isArray(value)) return value.map((item) => redactTelemetryValue(item, options))
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [childKey, child] of Object.entries(value))
      result[childKey] = redactTelemetryValue(child, options, childKey)
    return result
  }
  return String(value ?? '')
}

export function pathTemplate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const pathname = value.split('?', 1)[0]
  return pathname
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ':id')
    .replace(/\/(?:(?:\d{4,})|(?:[0-9a-f]{16,}))(?:\/|$)/gi, (match) => (match.endsWith('/') ? '/:id/' : '/:id'))
    .slice(0, 512)
}
