import type { Alert, AlertRule, AlertSample } from './model'
import { createHash } from 'node:crypto'
import { sanitizeControlPlaneValue } from '../control-plane'
import { AlertStore } from './store'

export interface AlertEvaluation {
  alert?: Alert
  transition: 'ignored' | 'pending' | 'firing' | 'updated' | 'resolved' | 'silenced'
  notify: boolean
}

function compare(operator: AlertRule['operator'], value: number, threshold: number): boolean {
  if (operator === 'gt') return value > threshold
  if (operator === 'gte') return value >= threshold
  if (operator === 'lt') return value < threshold
  if (operator === 'lte') return value <= threshold
  return value === threshold
}

function failing(rule: AlertRule, sample: AlertSample, recovering: boolean): boolean | undefined {
  if (sample.status === 'no_data' || (sample.status == null && sample.value == null)) return undefined
  if (rule.operator === 'unhealthy') return sample.status === 'unhealthy'
  if (sample.value == null || rule.threshold == null) return undefined
  return compare(
    rule.operator,
    sample.value,
    recovering && rule.recoveryThreshold != null ? rule.recoveryThreshold : rule.threshold,
  )
}

function group(rule: AlertRule, sample: AlertSample): { key: string; values: Record<string, string> } {
  const values = Object.fromEntries(
    rule.groupBy.flatMap((key) => (sample.group?.[key] == null ? [] : [[key, String(sample.group[key])]])),
  )
  const key =
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',') || 'default'
  return { key, values }
}

function dedup(ruleId: string, groupKey: string): string {
  return createHash('sha256').update(`${ruleId}\0${groupKey}`).digest('hex')
}

export class AlertEvaluator {
  constructor(private readonly store: AlertStore) {}

  evaluate(rule: AlertRule, sample: AlertSample): AlertEvaluation {
    if (!rule.enabled) return { transition: 'ignored', notify: false }
    const grouped = group(rule, sample),
      key = dedup(rule.id, grouped.key),
      current = this.store.getAlertByDedup(key)
    const wasActive = current?.state === 'firing' || current?.state === 'silenced'
    const isFailure = failing(rule, sample, wasActive)
    if (isFailure == null && rule.noDataPolicy === 'ignore')
      return { alert: current, transition: 'ignored', notify: false }
    const breach = isFailure ?? rule.noDataPolicy === 'firing'
    const pendingNoData = isFailure == null && rule.noDataPolicy === 'pending'
    const timestamp = new Date(sample.timestamp).toISOString()
    const evidence = sanitizeControlPlaneValue({
      ...(sample.evidence ?? {}),
      ...(sample.value == null ? {} : { value: sample.value }),
      ...(sample.status ? { healthStatus: sample.status } : {}),
      group: grouped.values,
    }) as Record<string, any>
    let next: Alert
    if (!current) {
      const failureCount = breach || pendingNoData ? 1 : 0
      const state = breach && failureCount >= rule.consecutive ? 'firing' : 'pending'
      next = {
        id: crypto.randomUUID(),
        ruleId: rule.id,
        projectId: rule.projectId,
        environmentId: rule.environmentId,
        resourceId: rule.resourceId,
        dedupKey: key,
        groupKey: grouped.key,
        state,
        severity: rule.severity,
        title: rule.name,
        evidence,
        failureCount,
        recoveryCount: 0,
        occurrenceCount: 1,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        firingAt: state === 'firing' ? timestamp : undefined,
        updatedAt: timestamp,
      }
    } else if (breach || pendingNoData) {
      const restarted = current.state === 'resolved'
      const failureCount = (restarted ? 0 : current.failureCount) + 1
      const activeSilence = current.silencedUntil && new Date(current.silencedUntil) > new Date(timestamp)
      let state: Alert['state'] = pendingNoData ? 'pending' : failureCount >= rule.consecutive ? 'firing' : 'pending'
      if ((activeSilence || this.store.isSilenced(rule, grouped.values, timestamp)) && state === 'firing')
        state = 'silenced'
      next = {
        ...current,
        state,
        severity: rule.severity,
        title: rule.name,
        evidence,
        failureCount,
        recoveryCount: 0,
        occurrenceCount: current.occurrenceCount + 1,
        firstSeenAt: restarted ? timestamp : current.firstSeenAt,
        lastSeenAt: timestamp,
        firingAt: state === 'firing' || state === 'silenced' ? (current.firingAt ?? timestamp) : undefined,
        resolvedAt: undefined,
        updatedAt: timestamp,
      }
    } else {
      const recoveryCount = current.recoveryCount + 1
      const resolved = recoveryCount >= rule.recoveryConsecutive
      next = {
        ...current,
        state: resolved ? 'resolved' : current.state,
        evidence,
        failureCount: resolved ? 0 : current.failureCount,
        recoveryCount,
        lastSeenAt: timestamp,
        resolvedAt: resolved ? timestamp : current.resolvedAt,
        silencedUntil: resolved ? undefined : current.silencedUntil,
        updatedAt: timestamp,
      }
    }
    const changed = current?.state !== next.state
    const transition: AlertEvaluation['transition'] =
      next.state === 'pending'
        ? 'pending'
        : next.state === 'firing'
          ? changed
            ? 'firing'
            : 'updated'
          : next.state === 'silenced'
            ? 'silenced'
            : changed
              ? 'resolved'
              : 'updated'
    const saved = this.store.saveAlert(next, changed || !current ? transition : 'observed')
    return { alert: saved, transition, notify: transition === 'firing' || transition === 'resolved' }
  }
}
