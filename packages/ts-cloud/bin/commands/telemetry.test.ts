import { describe, expect, it } from 'bun:test'
import { telemetryWindow } from './telemetry'

describe('telemetry CLI window', () => {
  it('resolves relative ranges and validates explicit instants', () => {
    expect(telemetryWindow({ range: '6h' }, new Date('2026-07-21T12:00:00Z'))).toEqual({
      from: '2026-07-21T06:00:00.000Z',
      to: '2026-07-21T12:00:00.000Z',
    })
    expect(() => telemetryWindow({ range: 'forever' })).toThrow('minutes, hours, or days')
    expect(() => telemetryWindow({ from: 'not-a-date' })).toThrow('--from')
  })
})
