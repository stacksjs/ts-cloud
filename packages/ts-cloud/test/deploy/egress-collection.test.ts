import type { EgressReport } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { collectEgressMetrics, egressReportMetrics, fetchEgressReport } from '../../src/deploy/egress-collection'

const NOW = '2026-08-06T18:00:00.000Z'
const GB = 1000 ** 3
const TB = 1000 ** 4

function report(overrides: Partial<EgressReport> = {}): EgressReport {
  return {
    today: '2026-08-06',
    todayBytes: 20 * GB,
    month: '2026-08',
    monthBytes: 120 * GB,
    budgetBytes: 5 * TB,
    budgetUsedPercent: 2.4,
    projectedMonthBytes: 620 * GB,
    days: [
      { date: '2026-08-04', bytes: 50 * GB, downloads: 400 },
      { date: '2026-08-05', bytes: 50 * GB, downloads: 410 },
      { date: '2026-08-06', bytes: 20 * GB, downloads: 180 },
    ],
    ...overrides,
  }
}

function byName(metrics: ReturnType<typeof egressReportMetrics>, name: string) {
  return metrics.filter(metric => metric.name === name)
}

describe('egressReportMetrics', () => {
  it('records the point-in-time picture at collection time', () => {
    const metrics = egressReportMetrics(report(), { name: 'registry', now: NOW })

    expect(byName(metrics, 'storage.egress.month')[0]).toMatchObject({ value: 120 * GB, timestamp: NOW })
    expect(byName(metrics, 'storage.egress.budget')[0]?.value).toBe(5 * TB)
    expect(byName(metrics, 'storage.egress.budget_used_percent')[0]?.value).toBe(2.4)
    expect(byName(metrics, 'storage.egress.projected_month')[0]?.value).toBe(620 * GB)
  })

  it('replays each day at its own timestamp, not the collection time', () => {
    const days = byName(egressReportMetrics(report(), { name: 'registry', now: NOW }), 'storage.egress.day')

    expect(days).toHaveLength(3)
    expect(days.map(day => day.value)).toEqual([50 * GB, 50 * GB, 20 * GB])
    // Noon, so the point stays inside its own day in any viewer timezone within
    // ±11h — a midnight stamp renders as the previous day west of UTC.
    expect(days[0].timestamp).toBe('2026-08-04T12:00:00.000Z')
  })

  it('produces stable timestamps so replaying a history is idempotent', () => {
    const first = egressReportMetrics(report(), { name: 'registry', now: NOW })
    const later = egressReportMetrics(report(), { name: 'registry', now: '2026-08-06T23:00:00.000Z' })

    const key = (metrics: typeof first) =>
      byName(metrics, 'storage.egress.day').map(metric => `${metric.timestamp}:${metric.value}`)
    // Same (name, timestamp) on every collection ⇒ the store's INSERT OR IGNORE
    // dedupes rather than double-counting a day.
    expect(key(later)).toEqual(key(first))
  })

  it('carries per-day download counts when the reporter sends them', () => {
    const counts = byName(egressReportMetrics(report(), { name: 'registry', now: NOW }), 'storage.egress.day_downloads')
    expect(counts.map(metric => metric.value)).toEqual([400, 410, 180])
  })

  it('derives the allowance share when the reporter omits it', () => {
    const metrics = egressReportMetrics(
      report({ budgetUsedPercent: null, monthBytes: 1 * TB, budgetBytes: 5 * TB }),
      { name: 'registry', now: NOW },
    )
    expect(byName(metrics, 'storage.egress.budget_used_percent')[0]?.value).toBe(20)
  })

  it('omits allowance series entirely when there is no allowance', () => {
    const metrics = egressReportMetrics(report({ budgetBytes: 0, budgetUsedPercent: null }), { name: 'registry', now: NOW })
    expect(byName(metrics, 'storage.egress.budget')).toHaveLength(0)
    expect(byName(metrics, 'storage.egress.budget_used_percent')).toHaveLength(0)
  })

  it('degrades to fewer series rather than failing on a partial report', () => {
    const metrics = egressReportMetrics({ monthBytes: 5 * GB }, { name: 'registry', now: NOW })
    expect(byName(metrics, 'storage.egress.month')[0]?.value).toBe(5 * GB)
    expect(byName(metrics, 'storage.egress.day')).toHaveLength(0)
  })

  it('drops malformed days and negative byte counts', () => {
    const metrics = egressReportMetrics(
      report({
        days: [
          { date: '2026-08-05', bytes: 10 * GB },
          { date: 'yesterday', bytes: 10 * GB },
          { date: '2026-08-04', bytes: -1 },
          null as never,
        ],
      }),
      { name: 'registry', now: NOW },
    )
    expect(byName(metrics, 'storage.egress.day')).toHaveLength(1)
  })

  it('returns nothing for a non-report', () => {
    expect(egressReportMetrics(null, { name: 'registry', now: NOW })).toEqual([])
    expect(egressReportMetrics('nope' as never, { name: 'registry', now: NOW })).toEqual([])
  })

  it('bounds how much history it replays', () => {
    const days = Array.from({ length: 200 }, (_, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
      bytes: GB,
    }))
    const metrics = egressReportMetrics(report({ days }), { name: 'registry', now: NOW, maxReplayDays: 45 })
    expect(byName(metrics, 'storage.egress.day')).toHaveLength(45)
  })

  it('tags every metric with its source so multiple buckets stay distinct', () => {
    const metrics = egressReportMetrics(report(), { name: 'cdn', now: NOW })
    expect(metrics.every(metric => metric.attributes.source === 'cdn')).toBe(true)
  })
})

describe('fetchEgressReport', () => {
  it('sends a bearer token from the named environment variable', async () => {
    let seen: string | null | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('authorization')
      return new Response(JSON.stringify({ monthBytes: 1 }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchEgressReport(
      { name: 'r', url: 'https://example.test/api/egress', tokenEnv: 'EGRESS_TOKEN' },
      { EGRESS_TOKEN: 'secret-value' } as NodeJS.ProcessEnv,
      fetchImpl,
    )
    expect(seen).toBe('Bearer secret-value')
  })

  it('sends no authorization header for a public endpoint', async () => {
    let seen: string | null | undefined = 'unset'
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('authorization')
      return new Response(JSON.stringify({ monthBytes: 1 }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchEgressReport({ name: 'r', url: 'https://example.test/api/egress' }, {} as NodeJS.ProcessEnv, fetchImpl)
    expect(seen).toBeNull()
  })

  it('throws on a non-OK response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await expect(
      fetchEgressReport({ name: 'r', url: 'https://example.test/api/egress' }, {} as NodeJS.ProcessEnv, fetchImpl),
    ).rejects.toThrow('HTTP 503')
  })
})

describe('collectEgressMetrics', () => {
  const ok = (async () => new Response(JSON.stringify(report()), { status: 200 })) as unknown as typeof fetch

  it('does nothing when no endpoints are configured', async () => {
    expect(await collectEgressMetrics(undefined, { now: NOW })).toEqual({ metrics: [], errors: [] })
    expect(await collectEgressMetrics([], { now: NOW })).toEqual({ metrics: [], errors: [] })
  })

  it('collects from every configured endpoint', async () => {
    const result = await collectEgressMetrics(
      [
        { name: 'registry', url: 'https://a.test/api/egress' },
        { name: 'cdn', url: 'https://b.test/api/egress' },
      ],
      { now: NOW, fetchImpl: ok },
    )
    expect(result.errors).toEqual([])
    expect(new Set(result.metrics.map(metric => metric.attributes.source))).toEqual(new Set(['registry', 'cdn']))
  })

  it('reports a failing endpoint as an error without losing the healthy ones', async () => {
    const flaky = (async (url: string) => {
      if (String(url).includes('broken')) throw new Error('connection refused')
      return new Response(JSON.stringify(report()), { status: 200 })
    }) as unknown as typeof fetch

    const result = await collectEgressMetrics(
      [
        { name: 'broken', url: 'https://broken.test/api/egress' },
        { name: 'registry', url: 'https://a.test/api/egress' },
      ],
      { now: NOW, fetchImpl: flaky },
    )

    expect(result.errors).toEqual([{ source: 'egress:broken', message: 'connection refused' }])
    expect(result.metrics.every(metric => metric.attributes.source === 'registry')).toBe(true)
    expect(result.metrics.length).toBeGreaterThan(0)
  })

  it('rejects an endpoint missing a name or url', async () => {
    const result = await collectEgressMetrics(
      [{ name: '', url: 'https://a.test' }, { name: 'x', url: '' }] as never,
      { now: NOW, fetchImpl: ok },
    )
    expect(result.metrics).toEqual([])
    expect(result.errors).toHaveLength(2)
  })
})
