import type { JsonValue } from '../control-plane'

export type TelemetryKind = 'metric' | 'log' | 'trace' | 'request' | 'event'
export type TelemetryAggregation = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'p50' | 'p90' | 'p95' | 'p99'
export type TelemetryFreshness = 'live' | 'stale' | 'unavailable'

export interface TelemetryCorrelation {
  traceId?: string
  requestId?: string
  deploymentId?: string
  releaseId?: string
  workloadId?: string
}

export interface TelemetryRecord extends TelemetryCorrelation {
  id: string
  projectId: string
  environmentId?: string
  resourceId?: string
  kind: TelemetryKind
  source: string
  name: string
  timestamp: string
  observedAt: string
  value?: number
  unit?: string
  level?: string
  message?: string
  durationMs?: number
  statusCode?: number
  method?: string
  host?: string
  pathTemplate?: string
  bytesIn?: number
  bytesOut?: number
  region?: string
  cacheResult?: string
  upstream?: string
  sampled: boolean
  attributes: Record<string, JsonValue>
  ingestedBytes: number
}

export interface AppendTelemetryInput extends Omit<TelemetryRecord, 'id' | 'observedAt' | 'sampled' | 'attributes' | 'ingestedBytes'> {
  id?: string
  observedAt?: string
  sampled?: boolean
  attributes?: Record<string, unknown>
}

export interface TelemetryQuery {
  projectId: string
  environmentId?: string
  resourceIds?: string[]
  kinds?: TelemetryKind[]
  names?: string[]
  sources?: string[]
  levels?: string[]
  from: string
  to: string
  text?: string
  traceId?: string
  requestId?: string
  deploymentId?: string
  releaseId?: string
  workloadId?: string
  cursor?: string
  limit?: number
}

export interface TelemetryQueryResult {
  records: TelemetryRecord[]
  nextCursor?: string
  truncated: boolean
  scannedRange: { from: string, to: string }
  sources: Array<{ source: string, latestAt: string, freshness: TelemetryFreshness, count: number }>
  gaps: Array<{ from: string, to: string, source?: string }>
}

export interface TelemetrySeriesQuery extends TelemetryQuery {
  bucketMs: number
  aggregation: TelemetryAggregation
  timezone?: string
  compareFrom?: string
  compareTo?: string
}

export interface TelemetrySeriesPoint {
  timestamp: string
  label: string
  value?: number
  count: number
  gap: boolean
}

export interface TelemetrySeries {
  name: string
  source: string
  unit?: string
  aggregation: TelemetryAggregation
  bucketMs: number
  points: TelemetrySeriesPoint[]
  comparison?: TelemetrySeriesPoint[]
}

export interface TelemetryRetentionPolicy {
  rawDays: number
  downsampleAfterDays: number
  downsampleBucketMs: number
  maxRecords: number
}

export interface TelemetryCollectionStatus {
  source: string
  freshness: TelemetryFreshness
  lastObservedAt?: string
  lagSeconds?: number
  samplingRate: number
  retentionDays: number
  estimatedDailyBytes: number
  estimatedMonthlyCostUsd?: number
  message?: string
}

export interface SavedTelemetryQuery {
  id: string
  projectId: string
  actorId?: string
  name: string
  query: TelemetryQuery
  createdAt: string
  updatedAt: string
}
