import { describe, expect, it } from 'bun:test'
import { TelemetryCollectionCache, telemetryRecordsFromLog } from './telemetry-collection'

describe('telemetry log correlation', () => {
  it('derives request golden signals without retaining query values or bodies', () => {
    const records = telemetryRecordsFromLog({
      projectId: 'project',
      environmentId: 'production',
      resourceId: 'api',
      source: 'journald',
      name: 'api.log',
      timestamp: '2026-07-21T11:00:00Z',
      message: JSON.stringify({
        level: 'error',
        method: 'GET',
        path: '/users/123456?token=secret',
        statusCode: 503,
        durationMs: 82,
        requestId: 'req-1',
        traceId: 'trace-1',
        releaseId: 'release-42',
        body: 'must not become a first-class field',
      }),
    })
    expect(records.map((record) => record.kind)).toEqual(['log', 'request', 'metric', 'metric', 'metric'])
    expect(records.find((record) => record.kind === 'request')).toMatchObject({
      method: 'GET',
      pathTemplate: '/users/:id',
      statusCode: 503,
      durationMs: 82,
      requestId: 'req-1',
      traceId: 'trace-1',
      releaseId: 'release-42',
    })
    expect(records.filter((record) => record.kind === 'metric').map((record) => record.name)).toEqual([
      'request.duration',
      'request.count',
      'request.error',
    ])
    expect(records.every((record) => !Object.hasOwn(record, 'body'))).toBeTrue()
    expect(records[0].message).not.toContain('must not become')
  })
})

describe('telemetry provider cache', () => {
  it('deduplicates expensive reads, expires by source TTL, and supports explicit refresh', async () => {
    let now = 1_000
    let calls = 0
    const cache = new TelemetryCollectionCache<number>(() => now)
    const load = async () => ++calls
    expect(await cache.getOrCreate('aws', 300_000, false, load)).toEqual({ value: 1, cached: false })
    expect(await cache.getOrCreate('aws', 300_000, false, load)).toEqual({ value: 1, cached: true })
    expect(await cache.getOrCreate('aws', 300_000, true, load)).toEqual({ value: 2, cached: false })
    now += 300_001
    expect(await cache.getOrCreate('aws', 300_000, false, load)).toEqual({ value: 3, cached: false })
  })
})
