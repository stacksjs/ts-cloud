import { afterEach, describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import {
  DEFAULT_TELEMETRY_POLICY,
  loadTelemetryPolicy,
  normalizeTelemetryPolicy,
  saveTelemetryPolicy,
  telemetryEstimatedMonthlyCost,
} from '.'

const stores: ControlPlaneStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('telemetry policy', () => {
  it('loads safe defaults and persists bounded project policy', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    stores.push(store)
    expect(loadTelemetryPolicy(store, 'project')).toEqual(DEFAULT_TELEMETRY_POLICY)
    const policy = saveTelemetryPolicy(store, 'project', {
      rawDays: 90,
      downsampleAfterDays: 120,
      samplingRate: 0,
      maxRecords: 5,
      estimatedStorageUsdPerGbMonth: 0.25,
      collectTraces: false,
    })
    expect(policy).toMatchObject({
      rawDays: 90,
      downsampleAfterDays: 90,
      samplingRate: 0.01,
      maxRecords: 1_000,
      estimatedStorageUsdPerGbMonth: 0.25,
      collectTraces: false,
    })
    expect(loadTelemetryPolicy(store, 'project')).toEqual(policy)
  })

  it('keeps unspecified values and calculates only configured storage cost', () => {
    const existing = normalizeTelemetryPolicy({ rawDays: 60, samplingRate: 0.5 })
    expect(normalizeTelemetryPolicy({ collectLogs: false }, existing)).toMatchObject({
      rawDays: 60,
      samplingRate: 0.5,
      collectLogs: false,
    })
    expect(telemetryEstimatedMonthlyCost(2 * 1024 ** 3, { ...existing, estimatedStorageUsdPerGbMonth: 0.1 })).toBe(0.2)
  })
})
