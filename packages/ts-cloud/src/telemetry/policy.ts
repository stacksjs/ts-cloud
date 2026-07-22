import type { ControlPlaneStore, JsonValue } from '../control-plane'
import type { TelemetryPolicy } from './model'

export const DEFAULT_TELEMETRY_POLICY: Readonly<TelemetryPolicy> = Object.freeze({
  rawDays: 30,
  downsampleAfterDays: 7,
  downsampleBucketMs: 3_600_000,
  maxRecords: 1_000_000,
  samplingRate: 1,
  collectLogs: true,
  collectTraces: true,
  collectRequestAnalytics: true,
  estimatedStorageUsdPerGbMonth: 0,
})

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function normalizeTelemetryPolicy(input: unknown, base: TelemetryPolicy = { ...DEFAULT_TELEMETRY_POLICY }): TelemetryPolicy {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const rawDays = integer(value.rawDays, base.rawDays, 1, 3650)
  const downsampleAfterDays = integer(value.downsampleAfterDays, base.downsampleAfterDays, 1, rawDays)
  return {
    rawDays,
    downsampleAfterDays,
    downsampleBucketMs: integer(value.downsampleBucketMs, base.downsampleBucketMs, 60_000, 86_400_000),
    maxRecords: integer(value.maxRecords, base.maxRecords, 1_000, 100_000_000),
    samplingRate: number(value.samplingRate, base.samplingRate, 0.01, 1),
    collectLogs: boolean(value.collectLogs, base.collectLogs),
    collectTraces: boolean(value.collectTraces, base.collectTraces),
    collectRequestAnalytics: boolean(value.collectRequestAnalytics, base.collectRequestAnalytics),
    estimatedStorageUsdPerGbMonth: number(value.estimatedStorageUsdPerGbMonth, base.estimatedStorageUsdPerGbMonth, 0, 10_000),
  }
}

export function telemetryPolicyKey(projectId: string): string { return `telemetry.policy:${projectId}` }

export function loadTelemetryPolicy(store: ControlPlaneStore, projectId: string): TelemetryPolicy {
  return normalizeTelemetryPolicy(store.getSetting(telemetryPolicyKey(projectId)))
}

export function saveTelemetryPolicy(store: ControlPlaneStore, projectId: string, input: unknown): TelemetryPolicy {
  const policy = normalizeTelemetryPolicy(input, loadTelemetryPolicy(store, projectId))
  store.setSetting(telemetryPolicyKey(projectId), policy as unknown as JsonValue)
  return policy
}

export function telemetryEstimatedMonthlyCost(estimatedMonthlyBytes: number, policy: TelemetryPolicy): number {
  return Number(((Math.max(0, estimatedMonthlyBytes) / (1024 ** 3)) * policy.estimatedStorageUsdPerGbMonth).toFixed(4))
}
