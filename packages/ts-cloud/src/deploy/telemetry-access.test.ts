import { describe, expect, it } from 'bun:test'
import { resolveTelemetryResourceIds } from './telemetry-access'

describe('telemetry resource access', () => {
  const resources = [{ id: 'resource-api', slug: 'api' }]

  it('allows an environment-wide principal to omit resource filters', () => {
    expect(resolveTelemetryResourceIds(resources, true, undefined)).toBeUndefined()
  })

  it('forces resource-grant principals into their allowed scope', () => {
    expect(resolveTelemetryResourceIds(resources, false, undefined)).toEqual(['resource-api'])
    expect(resolveTelemetryResourceIds([], false, undefined)).toEqual(['__no_authorized_telemetry_resources__'])
    expect(resolveTelemetryResourceIds(resources, false, 'api')).toEqual(['resource-api'])
    expect(() => resolveTelemetryResourceIds(resources, false, 'other')).toThrow('outside your authorized scope')
  })
})
