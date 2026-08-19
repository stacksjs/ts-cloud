/**
 * Object-storage egress collection.
 *
 * Host network counters answer a different question than the one an
 * object-storage invoice asks. When an application redirects downloads to a
 * bucket (or to a CDN in front of one), those bytes never traverse the host's
 * NIC — the box can sit idle while the bucket serves terabytes. The only
 * component that knows a transfer happened, and how large it was, is the
 * application that authorized it, so this polls it instead of guessing.
 *
 * The reports carry a per-day history rather than a single counter, and that is
 * deliberately exploited here: each day becomes one metric point stamped with
 * that day's own timestamp. Because record ids are a deterministic hash of
 * (source, name, timestamp) and the store inserts with OR IGNORE, replaying a
 * history is idempotent. A collector that was down for six hours — or six days
 * — backfills what it missed on its next run instead of leaving a hole, and
 * re-reading the same day never double-counts it.
 */

import type { EgressEndpointConfig, EgressReport } from '@ts-cloud/core'

/** Days of history to replay from a report. Beyond this, points already exist. */
const MAX_REPLAY_DAYS = 45

/** Give up on a slow endpoint rather than stalling the whole collection. */
const FETCH_TIMEOUT_MS = 10_000

export interface EgressMetric {
  name: string
  value: number
  unit: string
  /** ISO timestamp this point belongs to. */
  timestamp: string
  attributes: Record<string, string>
}

export interface EgressCollectionResult {
  metrics: EgressMetric[]
  errors: Array<{ source: string, message: string }>
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * A day's totals become a point at that day's UTC noon.
 *
 * Noon rather than midnight so the point lands unambiguously inside its own day
 * in any viewer timezone within ±11 hours — a midnight stamp renders as the
 * previous day for anyone west of UTC, which makes a daily chart quietly wrong.
 */
function dayTimestamp(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return null
  const parsed = Date.parse(`${date}T12:00:00.000Z`)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/**
 * Turn one report into metric points.
 *
 * Pure: no clock, no network. `now` is the timestamp for the point-in-time
 * series (month-to-date, projection, allowance), which describe the moment of
 * collection rather than a calendar day.
 */
export function egressReportMetrics(
  report: EgressReport | null | undefined,
  options: { name: string, now: string, maxReplayDays?: number },
): EgressMetric[] {
  if (!report || typeof report !== 'object')
    return []
  const attributes = { source: options.name }
  const metrics: EgressMetric[] = []
  const at = options.now

  const push = (name: string, value: number | null, unit: string, timestamp = at): void => {
    if (value !== null)
      metrics.push({ name, value, unit, timestamp, attributes })
  }

  // Point-in-time: what the situation looks like right now.
  push('storage.egress.month', finite(report.monthBytes), 'bytes')
  push('storage.egress.today', finite(report.todayBytes), 'bytes')
  push('storage.egress.projected_month', finite(report.projectedMonthBytes), 'bytes')

  const budget = finite(report.budgetBytes)
  if (budget !== null && budget > 0) {
    push('storage.egress.budget', budget, 'bytes')
    // Prefer the reporter's own percentage — it knows its allowance semantics —
    // but derive one when it is absent so a chart is never blank for want of a
    // field the endpoint simply did not send.
    const reported = report.budgetUsedPercent
    const percent = typeof reported === 'number' && Number.isFinite(reported)
      ? reported
      : finite(report.monthBytes) !== null
        ? Math.round((finite(report.monthBytes)! / budget) * 1000) / 10
        : null
    push('storage.egress.budget_used_percent', percent, 'percent')
  }

  // Historical: one point per day, stamped with the day it describes.
  const limit = options.maxReplayDays ?? MAX_REPLAY_DAYS
  const days = Array.isArray(report.days) ? report.days.slice(-limit) : []
  for (const day of days) {
    const timestamp = dayTimestamp(String((day as { date?: unknown })?.date ?? ''))
    const bytes = finite((day as { bytes?: unknown })?.bytes)
    if (!timestamp || bytes === null)
      continue
    metrics.push({ name: 'storage.egress.day', value: bytes, unit: 'bytes', timestamp, attributes })
    const downloads = finite((day as { downloads?: unknown })?.downloads)
    if (downloads !== null)
      metrics.push({ name: 'storage.egress.day_downloads', value: downloads, unit: 'count', timestamp, attributes })
  }

  return metrics
}

/**
 * Fetch one endpoint's report.
 *
 * Returns null on any failure. An egress endpoint is supplementary — it must
 * never be able to fail a telemetry collection that is also carrying host
 * metrics, so problems surface as an error entry rather than a throw.
 */
export async function fetchEgressReport(
  endpoint: EgressEndpointConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<EgressReport | null> {
  const token = endpoint.tokenEnv ? env[endpoint.tokenEnv] : undefined
  const response = await fetchImpl(endpoint.url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok)
    throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as EgressReport
}

/** Poll every configured endpoint and flatten the results. */
export async function collectEgressMetrics(
  endpoints: EgressEndpointConfig[] | undefined,
  options: { now: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch },
): Promise<EgressCollectionResult> {
  const metrics: EgressMetric[] = []
  const errors: Array<{ source: string, message: string }> = []
  if (!Array.isArray(endpoints) || endpoints.length === 0)
    return { metrics, errors }

  const results = await Promise.all(endpoints.map(async (endpoint) => {
    if (!endpoint?.name || !endpoint?.url)
      return { endpoint, error: 'egress endpoint needs both a name and a url' }
    try {
      const report = await fetchEgressReport(endpoint, options.env, options.fetchImpl)
      return { endpoint, report }
    }
    catch (error) {
      return { endpoint, error: error instanceof Error ? error.message : String(error) }
    }
  }))

  for (const result of results) {
    const source = `egress:${result.endpoint?.name ?? 'unnamed'}`
    if ('error' in result && result.error) {
      errors.push({ source, message: result.error })
      continue
    }
    metrics.push(...egressReportMetrics(result.report, { name: result.endpoint.name, now: options.now }))
  }

  return { metrics, errors }
}
