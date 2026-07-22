import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import type { TelemetryKind, TelemetryQuery } from '../../src/telemetry'
import * as output from '../../src/utils/cli'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { collectDashboardTelemetry } from '../../src/deploy/telemetry-collection'
import { loadTelemetryPolicy, saveTelemetryPolicy, telemetryEstimatedMonthlyCost, TelemetryStore } from '../../src/telemetry'
import { loadValidatedConfig } from './shared'

interface TelemetryOptions {
  env?: string
  from?: string
  to?: string
  range?: string
  kind?: string
  name?: string
  source?: string
  text?: string
  limit?: string
  output?: string
  force?: boolean
  json?: boolean
}

export function telemetryWindow(
  options: Pick<TelemetryOptions, 'from' | 'to' | 'range'>,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = options.to ? new Date(options.to) : now
  if (!Number.isFinite(to.getTime())) throw new Error('--to must be a valid ISO-8601 instant')
  if (options.from) {
    const from = new Date(options.from)
    if (!Number.isFinite(from.getTime())) throw new Error('--from must be a valid ISO-8601 instant')
    return { from: from.toISOString(), to: to.toISOString() }
  }
  const match = String(options.range ?? '1h').match(/^(\d+)(m|h|d)$/)
  if (!match) throw new Error('--range must use minutes, hours, or days (for example 30m, 6h, or 7d)')
  const factor = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000
  return { from: new Date(to.getTime() - Number(match[1]) * factor).toISOString(), to: to.toISOString() }
}

async function context(environment?: string) {
  const config = await loadValidatedConfig()
  const env = (environment ?? Object.keys(config.environments ?? {})[0] ?? 'production') as EnvironmentType
  if (!Object.hasOwn(config.environments ?? {}, env)) throw new Error(`Environment ${env} was not found`)
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  const environmentRecord = controlPlane.environments.get(env)
  const telemetry = new TelemetryStore(controlPlane.store)
  return { config, env, controlPlane, environmentRecord, telemetry }
}

function query(options: TelemetryOptions, projectId: string, environmentId?: string): TelemetryQuery {
  const list = (value?: string): string[] | undefined =>
    value
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean) || undefined
  const kinds = list(options.kind)?.filter((item) => ['metric', 'log', 'trace', 'request', 'event'].includes(item)) as
    TelemetryKind[] | undefined
  return {
    projectId,
    environmentId,
    ...telemetryWindow(options),
    kinds,
    names: list(options.name),
    sources: list(options.source),
    text: options.text,
    limit: Math.min(5_000, Math.max(1, Number(options.limit) || 200)),
  }
}

function csv(records: ReturnType<TelemetryStore['query']>['records']): string {
  const columns = [
    'timestamp',
    'kind',
    'source',
    'name',
    'level',
    'value',
    'unit',
    'message',
    'traceId',
    'requestId',
    'deploymentId',
    'releaseId',
    'workloadId',
  ]
  return [
    columns.join(','),
    ...records.map((record) =>
      columns.map((column) => `"${String((record as any)[column] ?? '').replaceAll('"', '""')}"`).join(','),
    ),
  ].join('\n')
}

export function registerTelemetryCommands(app: CLI): void {
  app
    .command('telemetry:collect', 'Collect normalized host/runtime or AWS telemetry into the local control plane')
    .option('--env <environment>', 'Target environment')
    .option('--force', 'Bypass the provider-query cache')
    .option('--json', 'Print structured JSON')
    .action(async (options: TelemetryOptions) => {
      const value = await context(options.env)
      try {
        const result = await collectDashboardTelemetry({
          controlPlane: value.controlPlane.store,
          projectId: value.controlPlane.project.id,
          environmentId: value.environmentRecord?.id,
          config: value.config,
          environment: value.env,
          force: options.force,
        })
        if (options.json) output.info(JSON.stringify(result, null, 2))
        else {
          output.success(
            `Collected ${result.collected} normalized records${result.cached ? ' (cached provider result)' : ''}.`,
          )
          output.table(
            ['Source', 'Freshness', 'Lag', 'Sampling', 'Retention'],
            result.statuses.map((item) => [
              item.source,
              item.freshness,
              item.lagSeconds == null ? '—' : `${item.lagSeconds}s`,
              `${Math.round(item.samplingRate * 100)}%`,
              `${item.retentionDays}d`,
            ]),
          )
        }
      } finally {
        value.controlPlane.store.close()
      }
    })

  app
    .command('telemetry:query', 'Query bounded normalized metrics, logs, traces, requests, and events')
    .option('--env <environment>', 'Target environment')
    .option('--from <instant>', 'ISO-8601 start')
    .option('--to <instant>', 'ISO-8601 end')
    .option('--range <duration>', 'Relative window such as 1h or 7d', { default: '1h' })
    .option('--kind <kinds>', 'Comma-separated kinds')
    .option('--name <names>', 'Comma-separated signal names')
    .option('--source <sources>', 'Comma-separated sources')
    .option('--text <query>', 'Search name/message')
    .option('--limit <count>', 'Maximum records', { default: '200' })
    .option('--json', 'Print structured JSON')
    .action(async (options: TelemetryOptions) => {
      const value = await context(options.env)
      try {
        const result = value.telemetry.query(query(options, value.controlPlane.project.id, value.environmentRecord?.id))
        if (options.json) output.info(JSON.stringify(result, null, 2))
        else
          output.table(
            ['Time', 'Kind', 'Source', 'Signal', 'Value / message', 'Correlation'],
            result.records.map((item) => [
              item.timestamp,
              item.kind,
              item.source,
              item.name,
              item.message ?? (item.value == null ? '—' : `${item.value} ${item.unit ?? ''}`),
              item.requestId ?? item.traceId ?? item.releaseId ?? item.deploymentId ?? '—',
            ]),
          )
        if (result.truncated)
          output.warn('More records are available; narrow the window or use the dashboard cursor explorer.')
      } finally {
        value.controlPlane.store.close()
      }
    })

  app
    .command('telemetry:export <file>', 'Export a bounded telemetry query as JSON or CSV')
    .option('--env <environment>', 'Target environment')
    .option('--from <instant>', 'ISO-8601 start')
    .option('--to <instant>', 'ISO-8601 end')
    .option('--range <duration>', 'Relative window', { default: '1h' })
    .option('--kind <kinds>', 'Comma-separated kinds')
    .option('--name <names>', 'Comma-separated signal names')
    .option('--source <sources>', 'Comma-separated sources')
    .option('--text <query>', 'Search name/message')
    .option('--limit <count>', 'Maximum records', { default: '5000' })
    .action(async (file: string, options: TelemetryOptions) => {
      const value = await context(options.env)
      try {
        const requested = query(options, value.controlPlane.project.id, value.environmentRecord?.id)
        const result = value.telemetry.query(requested)
        await Bun.write(
          file,
          file.toLowerCase().endsWith('.csv')
            ? csv(result.records)
            : JSON.stringify({ exportedAt: new Date().toISOString(), query: requested, ...result }, null, 2),
        )
        output.success(
          `Exported ${result.records.length} records to ${file}${result.truncated ? ' (bounded result)' : ''}.`,
        )
      } finally {
        value.controlPlane.store.close()
      }
    })

  app
    .command('telemetry:compact', 'Downsample old metrics and enforce configured retention')
    .option('--env <environment>', 'Target environment')
    .action(async (options: TelemetryOptions) => {
      const value = await context(options.env)
      try {
        const policy = loadTelemetryPolicy(value.controlPlane.store, value.controlPlane.project.id)
        output.info(JSON.stringify(value.telemetry.enforceRetention(policy, value.controlPlane.project.id), null, 2))
      } finally {
        value.controlPlane.store.close()
      }
    })

  app
    .command('telemetry:policy', 'Show or update sampling, retention, and local storage cost assumptions')
    .option('--env <environment>', 'Target environment')
    .option('--raw-days <days>', 'Raw retention days')
    .option('--downsample-days <days>', 'Downsample after days')
    .option('--sampling <rate>', 'Sampling rate from 0.01 to 1')
    .option('--storage-usd-gb-month <amount>', 'Local storage cost assumption')
    .option('--json', 'Print structured JSON')
    .action(
      async (
        options: TelemetryOptions & {
          rawDays?: string
          downsampleDays?: string
          sampling?: string
          storageUsdGbMonth?: string
        },
      ) => {
        const value = await context(options.env)
        try {
          const changes: Record<string, number> = {}
          if (options.rawDays != null) changes.rawDays = Number(options.rawDays)
          if (options.downsampleDays != null) changes.downsampleAfterDays = Number(options.downsampleDays)
          if (options.sampling != null) changes.samplingRate = Number(options.sampling)
          if (options.storageUsdGbMonth != null)
            changes.estimatedStorageUsdPerGbMonth = Number(options.storageUsdGbMonth)
          const policy = Object.keys(changes).length
            ? saveTelemetryPolicy(value.controlPlane.store, value.controlPlane.project.id, changes)
            : loadTelemetryPolicy(value.controlPlane.store, value.controlPlane.project.id)
          const statuses = value.telemetry.status(
            value.controlPlane.project.id,
            value.environmentRecord?.id,
            policy.rawDays,
            policy.samplingRate,
          )
          const monthlyBytes = statuses.reduce((sum, item) => sum + item.estimatedDailyBytes * 30, 0)
          const result = {
            policy,
            estimatedMonthlyBytes: monthlyBytes,
            estimatedMonthlyCostUsd: telemetryEstimatedMonthlyCost(monthlyBytes, policy),
            costEstimateConfigured: policy.estimatedStorageUsdPerGbMonth > 0,
          }
          if (options.json) output.info(JSON.stringify(result, null, 2))
          else {
            output.info(JSON.stringify(policy, null, 2))
            output.info(
              result.costEstimateConfigured
                ? `Estimated local storage: $${result.estimatedMonthlyCostUsd}/month`
                : 'Storage cost remains unavailable until --storage-usd-gb-month is set.',
            )
          }
        } finally {
          value.controlPlane.store.close()
        }
      },
    )
}
