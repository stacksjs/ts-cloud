import { describe, expect, it } from 'bun:test'
import {
  budgetWindow,
  hourBucket,
  hourBucketsBetween,
  isValidTimeZone,
  previousBudgetWindow,
  utcInstantOfLocal,
  zoneOffsetMs,
} from './window'

describe('timezone offsets', () => {
  it('reads the offset from the zone, including DST', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/Los_Angeles')).toBe(-8 * 3_600_000)
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'America/Los_Angeles')).toBe(-7 * 3_600_000)
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'UTC')).toBe(0)
  })

  it('resolves local midnight to the right UTC instant on both sides of DST', () => {
    expect(utcInstantOfLocal('America/Los_Angeles', 2026, 1, 15).toISOString()).toBe('2026-01-15T08:00:00.000Z')
    expect(utcInstantOfLocal('America/Los_Angeles', 2026, 7, 15).toISOString()).toBe('2026-07-15T07:00:00.000Z')
  })

  it('resolves midnight on the spring-forward day itself', () => {
    // US DST starts 2026-03-08. Midnight still exists; 02:00-03:00 does not.
    expect(utcInstantOfLocal('America/Los_Angeles', 2026, 3, 8).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(utcInstantOfLocal('America/Los_Angeles', 2026, 3, 9).toISOString()).toBe('2026-03-09T07:00:00.000Z')
  })

  it('rejects an unknown zone rather than pretending it is UTC', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('Europe/Berlin')).toBe(true)
  })
})

describe('budget windows', () => {
  it('bounds a daily window at local midnight', () => {
    const window = budgetWindow('daily', 'America/Los_Angeles', new Date('2026-07-15T20:30:00Z'))
    expect(window.start).toBe('2026-07-15T07:00:00.000Z')
    expect(window.end).toBe('2026-07-16T07:00:00.000Z')
    expect(window.totalMs).toBe(24 * 3_600_000)
    expect(window.elapsedMs).toBe(13.5 * 3_600_000)
  })

  it('starts weekly windows on Monday', () => {
    // 2026-07-15 is a Wednesday.
    const window = budgetWindow('weekly', 'UTC', new Date('2026-07-15T12:00:00Z'))
    expect(window.start).toBe('2026-07-13T00:00:00.000Z')
    expect(window.end).toBe('2026-07-20T00:00:00.000Z')
    expect(window.label).toBe('week of 2026-07-13')
  })

  it('keeps a Monday inside its own week rather than the previous one', () => {
    const window = budgetWindow('weekly', 'UTC', new Date('2026-07-13T00:00:01Z'))
    expect(window.start).toBe('2026-07-13T00:00:00.000Z')
  })

  it('bounds a monthly window at the local first of the month', () => {
    const window = budgetWindow('monthly', 'Europe/Berlin', new Date('2026-07-15T12:00:00Z'))
    expect(window.start).toBe('2026-06-30T22:00:00.000Z')
    expect(window.end).toBe('2026-07-31T22:00:00.000Z')
    expect(window.label).toBe('July 2026')
  })

  it('rolls a December monthly window into January', () => {
    const window = budgetWindow('monthly', 'UTC', new Date('2026-12-20T12:00:00Z'))
    expect(window.end).toBe('2027-01-01T00:00:00.000Z')
  })

  it('measures a DST-shortened day as 23 hours, not 24', () => {
    const window = budgetWindow('daily', 'America/Los_Angeles', new Date('2026-03-08T20:00:00Z'))
    expect(window.totalMs).toBe(23 * 3_600_000)
  })

  it('clamps elapsed time to the window', () => {
    const window = budgetWindow('daily', 'UTC', new Date('2026-07-15T00:00:00Z'))
    expect(window.elapsedMs).toBe(0)
  })

  it('falls back to UTC for an unusable zone instead of throwing mid-evaluation', () => {
    const window = budgetWindow('daily', 'Mars/Olympus', new Date('2026-07-15T06:00:00Z'))
    expect(window.start).toBe('2026-07-15T00:00:00.000Z')
  })
})

describe('previous window', () => {
  it('returns the adjacent earlier window, fully elapsed', () => {
    const previous = previousBudgetWindow('monthly', 'UTC', new Date('2026-07-15T12:00:00Z'))
    expect(previous.start).toBe('2026-06-01T00:00:00.000Z')
    expect(previous.end).toBe('2026-07-01T00:00:00.000Z')
    expect(previous.elapsedMs).toBe(previous.totalMs)
  })

  it('handles the January boundary', () => {
    const previous = previousBudgetWindow('monthly', 'UTC', new Date('2026-01-10T12:00:00Z'))
    expect(previous.start).toBe('2025-12-01T00:00:00.000Z')
  })
})

describe('hour buckets', () => {
  it('truncates to the hour', () => {
    expect(hourBucket('2026-07-15T12:34:56.789Z')).toBe('2026-07-15T12:00:00.000Z')
    expect(hourBucket(new Date('2026-07-15T12:00:00Z'))).toBe('2026-07-15T12:00:00.000Z')
  })

  it('rejects an invalid instant', () => {
    expect(() => hourBucket('not-a-date')).toThrow('valid date')
  })

  it('enumerates a half-open range', () => {
    expect(hourBucketsBetween('2026-07-15T00:30:00Z', '2026-07-15T03:00:00Z')).toEqual([
      '2026-07-15T00:00:00.000Z',
      '2026-07-15T01:00:00.000Z',
      '2026-07-15T02:00:00.000Z',
    ])
  })

  it('caps the enumeration so a bad range cannot hang the evaluator', () => {
    expect(hourBucketsBetween('2000-01-01T00:00:00Z', '2030-01-01T00:00:00Z', 10)).toHaveLength(10)
  })
})
