/**
 * Budget period windows, in the operator's timezone.
 *
 * A monthly cap that rolls over at UTC midnight is wrong for most of the world
 * - it resets in the middle of a Californian afternoon, and the "month" it
 * measures does not match the month on the invoice. Periods are therefore
 * computed against an IANA timezone.
 *
 * Dependency-free: `Intl.DateTimeFormat` already knows every zone and every DST
 * rule, so the offset is read from it rather than from a bundled tz database.
 * DST is why the offset is resolved twice - the naive instant for local
 * midnight can land on the wrong side of a transition, and the second pass
 * corrects it.
 */
import type { BudgetPeriod, BudgetWindow } from './model'

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, cached)
  }
  return cached
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Validate a timezone once; an unknown zone should fail loudly, not silently bill in UTC. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(instant)
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '0'
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: Number(pick('hour')),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
    weekday: WEEKDAYS[pick('weekday')] ?? 0,
  }
}

/** Milliseconds the zone is ahead of UTC at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  // formatToParts drops sub-second precision; align before differencing.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The UTC instant of a given local wall-clock time.
 *
 * Two passes: the first offset is read at the naive guess, the second at the
 * corrected instant. On a DST boundary those differ, and only the second is
 * right. Times that do not exist locally (the spring-forward gap) resolve
 * forward, which is the conventional and the safe direction for a period start.
 */
export function utcInstantOfLocal(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour)
  const firstPass = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
  return new Date(naive - zoneOffsetMs(firstPass, timeZone))
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * The window `now` falls inside for a period, plus how far through it we are.
 *
 * Weeks start Monday: a Sunday-start week splits the working week across two
 * budgets, which makes every week-over-week comparison lie.
 */
export function budgetWindow(period: BudgetPeriod, timeZone: string, now: Date = new Date()): BudgetWindow {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC'
  const parts = zonedParts(now, zone)
  let start: Date
  let end: Date
  let label: string
  if (period === 'daily') {
    start = utcInstantOfLocal(zone, parts.year, parts.month, parts.day)
    end = utcInstantOfLocal(zone, parts.year, parts.month, parts.day + 1)
    label = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
  } else if (period === 'weekly') {
    const sinceMonday = (parts.weekday + 6) % 7
    start = utcInstantOfLocal(zone, parts.year, parts.month, parts.day - sinceMonday)
    end = utcInstantOfLocal(zone, parts.year, parts.month, parts.day - sinceMonday + 7)
    const startParts = zonedParts(start, zone)
    label = `week of ${startParts.year}-${String(startParts.month).padStart(2, '0')}-${String(startParts.day).padStart(2, '0')}`
  } else {
    start = utcInstantOfLocal(zone, parts.year, parts.month, 1)
    end = utcInstantOfLocal(zone, parts.year, parts.month + 1, 1)
    label = monthLabel(parts.year, parts.month)
  }
  const totalMs = end.getTime() - start.getTime()
  const elapsedMs = Math.max(0, Math.min(totalMs, now.getTime() - start.getTime()))
  return { start: start.toISOString(), end: end.toISOString(), elapsedMs, totalMs, label }
}

/** The window immediately before the one containing `now`. Used for comparisons. */
export function previousBudgetWindow(period: BudgetPeriod, timeZone: string, now: Date = new Date()): BudgetWindow {
  const current = budgetWindow(period, timeZone, now)
  // One millisecond before the current start is always inside the prior window,
  // regardless of month length or a DST shift.
  const inside = new Date(new Date(current.start).getTime() - 1)
  const previous = budgetWindow(period, timeZone, inside)
  return { ...previous, elapsedMs: previous.totalMs }
}

/** Truncate an instant to the start of its UTC hour - the rollup bucket. */
export function hourBucket(instant: Date | string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant
  const ms = date.getTime()
  if (!Number.isFinite(ms)) throw new Error('hourBucket requires a valid date')
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString()
}

/** Every hour bucket in `[from, to)`, ascending. Bounded so a bad range cannot hang. */
export function hourBucketsBetween(from: string, to: string, maxBuckets: number = 24 * 400): string[] {
  const start = Math.floor(new Date(from).getTime() / 3_600_000) * 3_600_000
  const end = new Date(to).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('hourBucketsBetween requires valid dates')
  const buckets: string[] = []
  for (let ms = start; ms < end && buckets.length < maxBuckets; ms += 3_600_000)
    buckets.push(new Date(ms).toISOString())
  return buckets
}
