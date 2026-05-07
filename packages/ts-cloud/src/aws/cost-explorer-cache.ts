/**
 * Filesystem-backed cache for Cost Explorer responses.
 *
 * Cost Explorer charges $0.01 per GetCostAndUsage request. Running cost:analyze
 * a few times in a day adds up — and closed-month data never changes, so we
 * shouldn't keep paying to fetch it. This cache persists across CLI invocations
 * under ~/.cache/ts-cloud/cost-explorer/<profile>/<sha>.json.
 *
 * TTL:
 *   - Open period (end is on/after the first of the current UTC month): 1 hour
 *   - Closed period (end is before the first of the current UTC month): 30 days
 *     Closed months are immutable in Cost Explorer, so this is effectively
 *     infinite while still bounding disk usage if many historical periods are
 *     queried.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_SCHEMA_VERSION = 1
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const OPEN_PERIOD_TTL_MS = HOUR_MS
const CLOSED_PERIOD_TTL_MS = 30 * DAY_MS

export interface CostCacheKey {
  start: string
  end: string
  granularity: string
  metrics: string[]
  groupBy: Array<{ Type: string, Key: string }>
}

interface CacheEntry<T> {
  schema: number
  savedAt: number
  key: CostCacheKey
  response: T
}

export interface CacheHit<T> {
  response: T
  ageSeconds: number
}

function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.cache'), 'ts-cloud', 'cost-explorer')
}

function profileDir(profile: string | undefined): string {
  return join(cacheRoot(), profile ?? '__default__')
}

function hashKey(key: CostCacheKey): string {
  // Canonicalize: sort each shape's keys so logically-equal inputs hash equal.
  const canonical = {
    s: key.start,
    e: key.end,
    g: key.granularity,
    m: [...key.metrics].sort(),
    gb: [...key.groupBy].map(g => `${g.Type}:${g.Key}`).sort(),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24)
}

function isClosedPeriod(start: string, end: string): boolean {
  // Cost Explorer end is exclusive (e.g. period [2026-04-01, 2026-05-01)).
  // The period is fully closed once `end` is on or before the first day of
  // the current UTC month.
  const endTs = Date.parse(`${end}T00:00:00Z`)
  if (Number.isNaN(endTs)) return false
  const now = new Date()
  const firstOfThisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  // start is included for completeness; if either bound is in the future the
  // period isn't closed yet.
  void start
  return endTs <= firstOfThisMonth
}

function ttlForPeriod(key: CostCacheKey): number {
  return isClosedPeriod(key.start, key.end) ? CLOSED_PERIOD_TTL_MS : OPEN_PERIOD_TTL_MS
}

export function loadCache<T>(profile: string | undefined, key: CostCacheKey): CacheHit<T> | null {
  const file = join(profileDir(profile), `${hashKey(key)}.json`)
  if (!existsSync(file)) return null

  let entry: CacheEntry<T>
  try {
    entry = JSON.parse(readFileSync(file, 'utf-8')) as CacheEntry<T>
  }
  catch {
    return null
  }

  if (entry.schema !== CACHE_SCHEMA_VERSION) return null

  const ageMs = Date.now() - entry.savedAt
  if (ageMs < 0 || ageMs > ttlForPeriod(key)) return null

  return { response: entry.response, ageSeconds: Math.floor(ageMs / 1000) }
}

export function saveCache<T>(profile: string | undefined, key: CostCacheKey, response: T): void {
  const dir = profileDir(profile)
  mkdirSync(dir, { recursive: true })
  const entry: CacheEntry<T> = {
    schema: CACHE_SCHEMA_VERSION,
    savedAt: Date.now(),
    key,
    response,
  }
  writeFileSync(join(dir, `${hashKey(key)}.json`), JSON.stringify(entry))
}

export interface ClearResult {
  deletedFiles: number
  scope: string
}

/**
 * Wipe cache entries. Pass a profile to scope; pass nothing to wipe everything.
 */
export function clearCache(profile?: string): ClearResult {
  const target = profile === undefined ? cacheRoot() : profileDir(profile)
  if (!existsSync(target)) {
    return { deletedFiles: 0, scope: profile ?? 'all profiles' }
  }

  let deletedFiles = 0
  function visit(dir: string): void {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name)
      if (name.isDirectory()) visit(full)
      else if (name.isFile() && name.name.endsWith('.json')) deletedFiles++
    }
  }
  visit(target)
  rmSync(target, { recursive: true, force: true })
  return { deletedFiles, scope: profile ?? 'all profiles' }
}

export function cacheLocation(profile?: string): string {
  return profile === undefined ? cacheRoot() : profileDir(profile)
}
