import type { SQLQueryBindings } from 'bun:sqlite'
import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type {
  AppendTelemetryInput,
  TelemetryAggregation,
  TelemetryCollectionStatus,
  TelemetryQuery,
  TelemetryQueryResult,
  TelemetryRecord,
  TelemetryRetentionPolicy,
  SavedTelemetryQuery,
  TelemetrySeries,
  TelemetrySeriesPoint,
  TelemetrySeriesQuery,
} from './model'
import { pathTemplate, redactTelemetryText, redactTelemetryValue, type TelemetryRedactionOptions } from './redaction'

type Row = Record<string, unknown>
const MAX_RECORD_BYTES = 64 * 1024
const MAX_QUERY_RANGE_MS = 31 * 24 * 60 * 60 * 1000
const KINDS = new Set(['metric', 'log', 'trace', 'request', 'event'])

function optional(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function optionalNumber(value: unknown): number | undefined { return value == null ? undefined : Number(value) }
function json(value: unknown): Record<string, JsonValue> {
  if (typeof value !== 'string') return {}
  try { return JSON.parse(value) as Record<string, JsonValue> } catch { return {} }
}

function mapRecord(row: Row): TelemetryRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), environmentId: optional(row.environment_id), resourceId: optional(row.resource_id),
    kind: String(row.kind) as TelemetryRecord['kind'], source: String(row.source), name: String(row.name), timestamp: String(row.timestamp), observedAt: String(row.observed_at),
    value: optionalNumber(row.value), unit: optional(row.unit), level: optional(row.level), message: optional(row.message), durationMs: optionalNumber(row.duration_ms),
    statusCode: optionalNumber(row.status_code), method: optional(row.method), host: optional(row.host), pathTemplate: optional(row.path_template), bytesIn: optionalNumber(row.bytes_in), bytesOut: optionalNumber(row.bytes_out),
    region: optional(row.region), cacheResult: optional(row.cache_result), upstream: optional(row.upstream), traceId: optional(row.trace_id), requestId: optional(row.request_id),
    deploymentId: optional(row.deployment_id), releaseId: optional(row.release_id), workloadId: optional(row.workload_id), sampled: Number(row.sampled) === 1,
    attributes: json(row.attributes), ingestedBytes: Number(row.ingested_bytes),
  }
}

function instant(value: string, name: string): Date {
  const parsed = new Date(value)
  if (!value || !Number.isFinite(parsed.getTime())) throw new Error(`${name} must be a valid ISO-8601 instant.`)
  return parsed
}

function range(query: Pick<TelemetryQuery, 'from' | 'to'>): { from: Date, to: Date } {
  const from = instant(query.from, 'from'); const to = instant(query.to, 'to')
  if (from >= to) throw new Error('Telemetry from must be earlier than to.')
  if (to.getTime() - from.getTime() > MAX_QUERY_RANGE_MS) throw new Error('Telemetry queries are limited to 31 days.')
  return { from, to }
}

function cursor(value?: string): { timestamp: string, id: string } | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed?.timestamp !== 'string' || typeof parsed?.id !== 'string') throw new Error()
    return parsed
  }
  catch { throw new Error('Telemetry cursor is invalid.') }
}

function nextCursor(record?: TelemetryRecord): string | undefined {
  return record ? Buffer.from(JSON.stringify({ timestamp: record.timestamp, id: record.id })).toString('base64url') : undefined
}

export function telemetryPercentile(values: number[], percentile: number): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1))
  return sorted[rank]
}

function aggregate(values: number[], aggregation: TelemetryAggregation): number | undefined {
  if (aggregation === 'count') return values.length
  if (!values.length) return undefined
  if (aggregation === 'sum') return values.reduce((sum, value) => sum + value, 0)
  if (aggregation === 'avg') return values.reduce((sum, value) => sum + value, 0) / values.length
  if (aggregation === 'min') return Math.min(...values)
  if (aggregation === 'max') return Math.max(...values)
  return telemetryPercentile(values, Number(aggregation.slice(1)))
}

export function telemetryBucketLabel(timestamp: Date, timezone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(timestamp)
  }
  catch { throw new Error(`Unknown telemetry timezone: ${timezone}`) }
}

export class TelemetryStore {
  constructor(private readonly controlPlane: ControlPlaneStore, private readonly options: { now?: () => Date, redaction?: TelemetryRedactionOptions } = {}) {}
  private now(): Date { return this.options.now?.() ?? new Date() }

  append(input: AppendTelemetryInput): TelemetryRecord {
    if (!KINDS.has(input.kind)) throw new Error(`Unsupported telemetry kind: ${input.kind}`)
    const timestamp = instant(input.timestamp, 'timestamp').toISOString()
    const observedAt = input.observedAt ? instant(input.observedAt, 'observedAt').toISOString() : this.now().toISOString()
    const attributes = redactTelemetryValue(input.attributes ?? {}, this.options.redaction) as Record<string, JsonValue>
    const message = input.message ? redactTelemetryText(input.message, this.options.redaction).slice(0, 32 * 1024) : undefined
    const normalizedPath = pathTemplate(input.pathTemplate)
    const id = input.id ?? crypto.randomUUID()
    const serialized = JSON.stringify({ ...input, id, timestamp, observedAt, attributes, message, pathTemplate: normalizedPath })
    const ingestedBytes = Buffer.byteLength(serialized)
    if (ingestedBytes > MAX_RECORD_BYTES) throw new Error(`Telemetry records are limited to ${MAX_RECORD_BYTES} bytes.`)
    this.controlPlane.database.run(`INSERT OR IGNORE INTO telemetry_records (id, project_id, environment_id, resource_id, kind, source, name, timestamp, observed_at, value, unit, level, message, duration_ms, status_code, method, host, path_template, bytes_in, bytes_out, region, cache_result, upstream, trace_id, request_id, deployment_id, release_id, workload_id, sampled, attributes, ingested_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, input.projectId, input.environmentId ?? null, input.resourceId ?? null, input.kind, input.source.slice(0, 128), input.name.slice(0, 256), timestamp, observedAt,
      input.value ?? null, input.unit ?? null, input.level ?? null, message ?? null, input.durationMs ?? null, input.statusCode ?? null, input.method?.slice(0, 16) ?? null,
      input.host?.slice(0, 256) ?? null, normalizedPath ?? null, input.bytesIn ?? null, input.bytesOut ?? null, input.region?.slice(0, 64) ?? null, input.cacheResult?.slice(0, 64) ?? null,
      input.upstream?.slice(0, 256) ?? null, input.traceId?.slice(0, 256) ?? null, input.requestId?.slice(0, 256) ?? null, input.deploymentId?.slice(0, 256) ?? null,
      input.releaseId?.slice(0, 256) ?? null, input.workloadId?.slice(0, 512) ?? null, input.sampled === false ? 0 : 1, JSON.stringify(attributes), ingestedBytes,
    ])
    return this.get(id)!
  }

  appendMany(inputs: AppendTelemetryInput[]): TelemetryRecord[] {
    if (inputs.length > 10_000) throw new Error('Telemetry batches are limited to 10,000 records.')
    const transaction = this.controlPlane.database.transaction((items: AppendTelemetryInput[]) => items.map(item => this.append(item)))
    return transaction(inputs)
  }

  get(id: string): TelemetryRecord | undefined {
    const row = this.controlPlane.database.query<Row, [string]>('SELECT * FROM telemetry_records WHERE id=?').get(id)
    return row ? mapRecord(row) : undefined
  }

  query(input: TelemetryQuery): TelemetryQueryResult {
    const { from, to } = range(input)
    const limit = Math.min(5_000, Math.max(1, Math.floor(input.limit ?? 500)))
    const clauses = ['project_id=?', 'timestamp>=?', 'timestamp<?']
    const bindings: SQLQueryBindings[] = [input.projectId, from.toISOString(), to.toISOString()]
    const addScalar = (column: string, value?: string) => { if (value) { clauses.push(`${column}=?`); bindings.push(value) } }
    const addList = (column: string, values?: string[]) => {
      const bounded = [...new Set(values ?? [])].slice(0, 100)
      if (bounded.length) { clauses.push(`${column} IN (${bounded.map(() => '?').join(',')})`); bindings.push(...bounded) }
    }
    addScalar('environment_id', input.environmentId); addList('resource_id', input.resourceIds); addList('kind', input.kinds); addList('name', input.names)
    addList('source', input.sources); addList('level', input.levels); addScalar('trace_id', input.traceId); addScalar('request_id', input.requestId)
    addScalar('deployment_id', input.deploymentId); addScalar('release_id', input.releaseId); addScalar('workload_id', input.workloadId)
    if (input.text) { clauses.push('(message LIKE ? OR name LIKE ?)'); bindings.push(`%${input.text.slice(0, 256)}%`, `%${input.text.slice(0, 256)}%`) }
    const after = cursor(input.cursor)
    if (after) { clauses.push('(timestamp<? OR (timestamp=? AND id<?))'); bindings.push(after.timestamp, after.timestamp, after.id) }
    const rows = this.controlPlane.database.query<Row, SQLQueryBindings[]>(`SELECT * FROM telemetry_records WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC, id DESC LIMIT ?`).all(...bindings, limit + 1)
    const records = rows.slice(0, limit).map(mapRecord)
    const truncated = rows.length > limit
    const bySource = new Map<string, TelemetryRecord[]>()
    for (const record of records) bySource.set(record.source, [...(bySource.get(record.source) ?? []), record])
    const now = this.now().getTime()
    const sources = [...bySource].map(([source, items]) => {
      const latestAt = items.reduce((latest, item) => item.observedAt > latest ? item.observedAt : latest, items[0].observedAt)
      const lag = now - new Date(latestAt).getTime()
      return { source, latestAt, freshness: (lag <= 120_000 ? 'live' : lag <= 600_000 ? 'stale' : 'unavailable') as 'live' | 'stale' | 'unavailable', count: items.length }
    })
    const gapThreshold = Math.max(60_000, (to.getTime() - from.getTime()) / 100)
    const gaps = [...bySource].flatMap(([source, items]) => {
      const times = [...new Set(items.map(item => new Date(item.timestamp).getTime()))].sort((a, b) => a - b)
      return times.slice(1).flatMap((time, index) => time - times[index] > gapThreshold ? [{ from: new Date(times[index]).toISOString(), to: new Date(time).toISOString(), source }] : [])
    })
    return { records, nextCursor: truncated ? nextCursor(records.at(-1)) : undefined, truncated, scannedRange: { from: from.toISOString(), to: to.toISOString() }, sources, gaps }
  }

  series(input: TelemetrySeriesQuery): TelemetrySeries[] {
    const { from, to } = range(input)
    const bucketMs = Math.min(24 * 60 * 60 * 1000, Math.max(1_000, Math.floor(input.bucketMs)))
    if ((to.getTime() - from.getTime()) / bucketMs > 2_000) throw new Error('Telemetry series are limited to 2,000 buckets.')
    const result = this.query({ ...input, kinds: ['metric'], limit: 5_000, cursor: undefined })
    const groups = new Map<string, TelemetryRecord[]>()
    for (const record of result.records) groups.set(`${record.source}\0${record.name}`, [...(groups.get(`${record.source}\0${record.name}`) ?? []), record])
    const build = (items: TelemetryRecord[], start: Date, end: Date): TelemetrySeriesPoint[] => {
      const values = new Map<number, number[]>()
      for (const item of items) {
        const bucket = start.getTime() + Math.floor((new Date(item.timestamp).getTime() - start.getTime()) / bucketMs) * bucketMs
        if (bucket >= start.getTime() && bucket < end.getTime() && item.value != null) values.set(bucket, [...(values.get(bucket) ?? []), item.value])
      }
      const points: TelemetrySeriesPoint[] = []
      for (let timestamp = start.getTime(); timestamp < end.getTime(); timestamp += bucketMs) {
        const bucketValues = values.get(timestamp) ?? []; const value = aggregate(bucketValues, input.aggregation)
        points.push({ timestamp: new Date(timestamp).toISOString(), label: telemetryBucketLabel(new Date(timestamp), input.timezone), value, count: bucketValues.length, gap: value == null })
      }
      return points
    }
    return [...groups].map(([key, items]) => {
      const [source, name] = key.split('\0')
      const series: TelemetrySeries = { name, source, unit: items.find(item => item.unit)?.unit, aggregation: input.aggregation, bucketMs, points: build(items, from, to) }
      if (input.compareFrom && input.compareTo) {
        const comparison = this.query({ ...input, from: input.compareFrom, to: input.compareTo, kinds: ['metric'], limit: 5_000, cursor: undefined }).records.filter(item => item.source === source && item.name === name)
        series.comparison = build(comparison, instant(input.compareFrom, 'compareFrom'), instant(input.compareTo, 'compareTo'))
      }
      return series
    })
  }

  status(projectId: string, environmentId?: string, retentionDays = 30): TelemetryCollectionStatus[] {
    const bindings: SQLQueryBindings[] = [projectId]
    const environment = environmentId ? ' AND environment_id=?' : ''
    if (environmentId) bindings.push(environmentId)
    const rows = this.controlPlane.database.query<Row, SQLQueryBindings[]>(`SELECT source, MAX(observed_at) latest, SUM(ingested_bytes) bytes, COUNT(*) count, MIN(observed_at) first FROM telemetry_records WHERE project_id=?${environment} GROUP BY source`).all(...bindings)
    const now = this.now().getTime()
    return rows.map((row) => {
      const latest = String(row.latest); const lagSeconds = Math.max(0, Math.floor((now - new Date(latest).getTime()) / 1000))
      const spanDays = Math.max(1, (new Date(latest).getTime() - new Date(String(row.first)).getTime()) / 86_400_000)
      return { source: String(row.source), freshness: lagSeconds <= 120 ? 'live' : lagSeconds <= 600 ? 'stale' : 'unavailable', lastObservedAt: latest, lagSeconds, samplingRate: 1, retentionDays, estimatedDailyBytes: Math.round(Number(row.bytes) / spanDays) }
    })
  }

  saveQuery(projectId: string, actorId: string | undefined, name: string, query: TelemetryQuery): SavedTelemetryQuery {
    const normalizedName = name.trim().slice(0, 80)
    if (!normalizedName) throw new Error('Saved telemetry queries require a name.')
    range(query)
    if (query.projectId !== projectId) throw new Error('Saved telemetry queries cannot cross project scope.')
    const now = this.now().toISOString(); const encoded = JSON.stringify(redactTelemetryValue(query, this.options.redaction))
    if (Buffer.byteLength(encoded) > 16 * 1024) throw new Error('Saved telemetry queries are limited to 16 KB.')
    const existing = this.controlPlane.database.query<Row, [string, string | null, string]>('SELECT * FROM telemetry_saved_queries WHERE project_id=? AND actor_id IS ? AND name=?').get(projectId, actorId ?? null, normalizedName)
    const id = existing ? String(existing.id) : crypto.randomUUID()
    this.controlPlane.database.run(`INSERT INTO telemetry_saved_queries (id, project_id, actor_id, name, query, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, actor_id, name) DO UPDATE SET query=excluded.query, updated_at=excluded.updated_at`, [id, projectId, actorId ?? null, normalizedName, encoded, existing ? String(existing.created_at) : now, now])
    return { id, projectId, actorId, name: normalizedName, query: JSON.parse(encoded), createdAt: existing ? String(existing.created_at) : now, updatedAt: now }
  }

  listSavedQueries(projectId: string, actorId?: string): SavedTelemetryQuery[] {
    return this.controlPlane.database.query<Row, [string, string | null]>('SELECT * FROM telemetry_saved_queries WHERE project_id=? AND actor_id IS ? ORDER BY updated_at DESC').all(projectId, actorId ?? null).map(row => ({ id: String(row.id), projectId: String(row.project_id), actorId: optional(row.actor_id), name: String(row.name), query: JSON.parse(String(row.query)), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }))
  }

  deleteSavedQuery(projectId: string, actorId: string | undefined, id: string): boolean {
    return this.controlPlane.database.run('DELETE FROM telemetry_saved_queries WHERE id=? AND project_id=? AND actor_id IS ?', [id, projectId, actorId ?? null]).changes > 0
  }

  downsample(policy: TelemetryRetentionPolicy, projectId?: string): { compacted: number, rollups: number } {
    const bucketMs = Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(policy.downsampleBucketMs)))
    const olderThan = new Date(this.now().getTime() - Math.max(1, policy.downsampleAfterDays) * 86_400_000).toISOString()
    const retainAfter = new Date(this.now().getTime() - Math.max(1, policy.rawDays) * 86_400_000).toISOString()
    const rows = this.controlPlane.database.query<Row, SQLQueryBindings[]>(`SELECT * FROM telemetry_records WHERE kind='metric' AND source NOT LIKE '%:rollup' AND timestamp>=? AND timestamp<?${projectId ? ' AND project_id=?' : ''} ORDER BY timestamp ASC LIMIT 50001`).all(retainAfter, olderThan, ...(projectId ? [projectId] : []))
    if (rows.length > 50_000) throw new Error('Telemetry downsampling is limited to 50,000 raw points per pass; run compaction more frequently.')
    const records = rows.map(mapRecord)
    const groups = new Map<string, TelemetryRecord[]>()
    for (const record of records) {
      const bucket = Math.floor(new Date(record.timestamp).getTime() / bucketMs) * bucketMs
      const key = JSON.stringify([record.projectId, record.environmentId ?? '', record.resourceId ?? '', record.source, record.name, record.unit ?? '', bucket])
      groups.set(key, [...(groups.get(key) ?? []), record])
    }
    const transaction = this.controlPlane.database.transaction(() => {
      for (let index = 0; index < records.length; index += 500) {
        const ids = records.slice(index, index + 500).map(record => record.id)
        if (ids.length) this.controlPlane.database.run(`DELETE FROM telemetry_records WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
      }
      for (const [key, items] of groups) {
        const [scopeProject, environmentId, resourceId, source, name, unit, bucket] = JSON.parse(key) as [string, string, string, string, string, string, number]
        const values = items.flatMap(item => item.value == null ? [] : [item.value])
        this.append({
          projectId: scopeProject, environmentId: environmentId || undefined, resourceId: resourceId || undefined,
          kind: 'metric', source: `${source}:rollup`, name, unit: unit || undefined, timestamp: new Date(bucket).toISOString(), value: aggregate(values, 'avg'),
          attributes: { downsampled: true, count: values.length, min: aggregate(values, 'min'), max: aggregate(values, 'max'), p95: aggregate(values, 'p95'), bucketMs },
        })
      }
    })
    transaction()
    return { compacted: records.length, rollups: groups.size }
  }

  enforceRetention(policy: TelemetryRetentionPolicy, projectId?: string): { deleted: number, compacted: number, rollups: number } {
    const downsampled = this.downsample(policy, projectId)
    const rawDays = Math.min(3650, Math.max(1, Math.floor(policy.rawDays)))
    const cutoff = new Date(this.now().getTime() - rawDays * 86_400_000).toISOString()
    const scope = projectId ? ' AND project_id=?' : ''
    const removed = this.controlPlane.database.run(`DELETE FROM telemetry_records WHERE timestamp<?${scope}`, projectId ? [cutoff, projectId] : [cutoff]).changes
    const excess = Number(this.controlPlane.database.query<Row, SQLQueryBindings[]>(`SELECT MAX(0, COUNT(*)-?) excess FROM telemetry_records${projectId ? ' WHERE project_id=?' : ''}`).get(policy.maxRecords, ...(projectId ? [projectId] : []))?.excess ?? 0)
    if (excess > 0) this.controlPlane.database.run(`DELETE FROM telemetry_records WHERE id IN (SELECT id FROM telemetry_records${projectId ? ' WHERE project_id=?' : ''} ORDER BY timestamp ASC LIMIT ?)`, projectId ? [projectId, excess] : [excess])
    return { deleted: removed + excess, ...downsampled }
  }
}
