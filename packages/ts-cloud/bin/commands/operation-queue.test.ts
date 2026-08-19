import { describe, expect, it } from 'bun:test'
import { formatQueueDuration } from './operation-queue'

describe('operation queue CLI formatting', () => {
  it('formats queued, short, and longer operation durations', () => {
    expect(formatQueueDuration()).toBe('—')
    expect(formatQueueDuration('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.250Z')).toBe('250ms')
    expect(formatQueueDuration('2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z')).toBe('2m')
  })
})
