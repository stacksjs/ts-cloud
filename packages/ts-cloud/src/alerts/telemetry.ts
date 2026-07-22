import type { AlertEvaluation } from './evaluator'
import { TelemetryStore } from '../telemetry'
import { AlertEvaluator } from './evaluator'
import { AlertStore } from './store'

export function evaluateTelemetryAlertRules(
  store: AlertStore,
  projectId: string,
  environmentId?: string,
  now: Date = new Date(),
): AlertEvaluation[] {
  const telemetry = new TelemetryStore(store.controlPlane, { now: () => now })
  const evaluator = new AlertEvaluator(store)
  return store
    .listRules(projectId, environmentId)
    .filter((rule) => rule.enabled && !rule.healthCheckId)
    .map((rule) => {
      const from = new Date(now.getTime() - rule.windowMs).toISOString()
      const result = telemetry.query({
        projectId,
        environmentId,
        resourceIds: rule.resourceId ? [rule.resourceId] : undefined,
        kinds: ['metric'],
        names: [rule.signal],
        from,
        to: new Date(now.getTime() + 1).toISOString(),
        limit: 5000,
      })
      const values = result.records.flatMap((record) => (record.value == null ? [] : [record.value]))
      const value = values.length
        ? rule.operator === 'gt' || rule.operator === 'gte'
          ? Math.max(...values)
          : rule.operator === 'lt' || rule.operator === 'lte'
            ? Math.min(...values)
            : values.at(0)
        : undefined
      return evaluator.evaluate(rule, {
        value,
        status: value == null ? 'no_data' : undefined,
        timestamp: now.toISOString(),
        group: { resourceId: rule.resourceId ?? '', source: result.records[0]?.source ?? '' },
        evidence: {
          signal: rule.signal,
          windowMs: rule.windowMs,
          sampleCount: values.length,
          source: result.records[0]?.source ?? null,
        },
      })
    })
}
