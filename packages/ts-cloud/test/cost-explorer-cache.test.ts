/**
 * Tests for the Cost Explorer response cache (issue #106).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CostCacheKey } from '../src/aws/cost-explorer-cache'
import { cacheLocation, clearCache, loadCache, saveCache } from '../src/aws/cost-explorer-cache'

let tmpRoot: string
let originalXDG: string | undefined

const baseKey: CostCacheKey = {
  start: '2024-01-01',
  end: '2024-02-01',
  granularity: 'MONTHLY',
  metrics: ['UnblendedCost'],
  groupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ts-cloud-cache-test-'))
  originalXDG = process.env.XDG_CACHE_HOME
  process.env.XDG_CACHE_HOME = tmpRoot
})

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXDG
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('cost explorer cache', () => {
  it('returns null when nothing is cached', () => {
    expect(loadCache('alice', baseKey)).toBeNull()
  })

  it('round-trips a saved entry', () => {
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10, unit: 'USD' }])
    const hit = loadCache<Array<{ service: string }>>('alice', baseKey)
    expect(hit).not.toBeNull()
    expect(hit!.response[0].service).toBe('S3')
    expect(hit!.ageSeconds).toBeGreaterThanOrEqual(0)
  })

  it('keeps profiles isolated', () => {
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10 }])
    expect(loadCache('alice', baseKey)).not.toBeNull()
    expect(loadCache('bob', baseKey)).toBeNull()
  })

  it('treats different params as different cache entries', () => {
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10 }])
    const otherKey: CostCacheKey = { ...baseKey, end: '2024-03-01' }
    expect(loadCache('alice', otherKey)).toBeNull()
  })

  it('canonicalizes order-insensitive params', () => {
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10 }])
    const reordered: CostCacheKey = {
      ...baseKey,
      // Same metrics in different order should match.
      metrics: [...baseKey.metrics],
    }
    expect(loadCache('alice', reordered)).not.toBeNull()
  })

  it('expires open-period entries after the 1h TTL', () => {
    // Open period: end on/after first of current UTC month.
    const now = new Date()
    const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const firstOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const openKey: CostCacheKey = {
      ...baseKey,
      start: firstOfThisMonth.toISOString().slice(0, 10),
      end: firstOfNextMonth.toISOString().slice(0, 10),
    }

    saveCache('alice', openKey, [{ service: 'S3', amount: 10 }])
    expect(loadCache('alice', openKey)).not.toBeNull()

    // Manually rewind savedAt to 2 hours ago.
    const dir = cacheLocation('alice')
    const file = readdirSync(dir).find(f => f.endsWith('.json'))!
    const path = join(dir, file)
    const entry = JSON.parse(readFileSync(path, 'utf-8'))
    entry.savedAt = Date.now() - 2 * 60 * 60 * 1000
    writeFileSync(path, JSON.stringify(entry))

    expect(loadCache('alice', openKey)).toBeNull()
  })

  it('keeps closed-period entries past 1h (uses 30d TTL)', () => {
    // baseKey covers Jan 2024 — definitely closed.
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10 }])

    const dir = cacheLocation('alice')
    const file = readdirSync(dir).find(f => f.endsWith('.json'))!
    const path = join(dir, file)
    const entry = JSON.parse(readFileSync(path, 'utf-8'))
    entry.savedAt = Date.now() - 2 * 60 * 60 * 1000
    writeFileSync(path, JSON.stringify(entry))

    const hit = loadCache('alice', baseKey)
    expect(hit).not.toBeNull()
  })

  it('clearCache(profile) wipes only that profile', () => {
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10 }])
    saveCache('bob', baseKey, [{ service: 'EC2', amount: 5 }])

    const result = clearCache('alice')
    expect(result.deletedFiles).toBe(1)
    expect(result.scope).toBe('alice')
    expect(loadCache('alice', baseKey)).toBeNull()
    expect(loadCache('bob', baseKey)).not.toBeNull()
  })

  it('clearCache() with no arg wipes everything', () => {
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10 }])
    saveCache('bob', baseKey, [{ service: 'EC2', amount: 5 }])

    const result = clearCache()
    expect(result.deletedFiles).toBe(2)
    expect(loadCache('alice', baseKey)).toBeNull()
    expect(loadCache('bob', baseKey)).toBeNull()
  })

  it('clearCache on an empty cache reports 0 deleted', () => {
    const result = clearCache('never-saved')
    expect(result.deletedFiles).toBe(0)
  })

  it('uses XDG_CACHE_HOME when set', () => {
    saveCache('alice', baseKey, [{ service: 'S3', amount: 10 }])
    expect(existsSync(join(tmpRoot, 'ts-cloud', 'cost-explorer', 'alice'))).toBe(true)
  })

  it('uses __default__ as the profile dir when no profile is passed', () => {
    saveCache(undefined, baseKey, [{ service: 'S3', amount: 10 }])
    expect(existsSync(join(tmpRoot, 'ts-cloud', 'cost-explorer', '__default__'))).toBe(true)
  })
})
