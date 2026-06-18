import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import { CloudWatchClient } from '../../src/aws/cloudwatch'
import { CloudWatchLogsClient } from '../../src/aws/cloudwatch-logs'
import { resolveServerlessFunctions } from '../../src/deploy/serverless-app'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

/** Parse a duration like `1h`, `30m`, `45s`, or a bare number of minutes. */
function durationToMs(d: string | undefined, fallbackMin = 15): number {
  if (!d) return fallbackMin * 60_000
  const m = /^(\d+)\s*([smhd])?$/.exec(d.trim())
  if (!m) return fallbackMin * 60_000
  const n = Number(m[1])
  const unit = m[2] ?? 'm'
  return n * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 60_000)
}

function printEvents(events: Array<{ timestamp?: number, message?: string }>, label?: string): void {
  for (const e of events) {
    const ts = e.timestamp ? new Date(e.timestamp).toISOString() : ''
    const tag = label ? `[${label}] ` : ''
    cli.info(`${ts}  ${tag}${(e.message ?? '').trimEnd()}`)
  }
}

export function registerLogsCommands(app: CLI): void {
  app
    .command('logs', 'Stream serverless application logs (http + queue + cli)')
    .option('--env <environment>', 'Environment (production, staging, development)', { default: 'production' })
    .option('--function <which>', 'Which function: http | queue | cli | all', { default: 'all' })
    .option('--tail', 'Continuously stream new log events')
    .option('--filter <pattern>', 'CloudWatch filter pattern')
    .option('--since <duration>', 'Look back (e.g. 1h, 30m, 15)', { default: '15m' })
    .action(async (options?: { env?: string, function?: string, tail?: boolean, filter?: string, since?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as EnvironmentType
        const { region, functions } = resolveServerlessFunctions(config, environment)
        const logs = new CloudWatchLogsClient(region)

        const which = (options?.function ?? 'all').toLowerCase()
        if (which !== 'all' && !['http', 'queue', 'cli'].includes(which)) {
          cli.error('--function must be one of: http, queue, cli, all')
          process.exitCode = 1
          return
        }
        const selected = which === 'all'
          ? (['http', 'queue', 'cli'] as const)
          : ([which] as Array<'http' | 'queue' | 'cli'>)
        const groups = selected.map(mode => ({ mode, group: `/aws/lambda/${functions[mode]}` }))

        cli.header(`Logs — ${config.project.slug} (${environment})`)
        let startTime = Date.now() - durationToMs(options?.since)

        const pull = async (): Promise<void> => {
          let maxTs = startTime
          for (const { mode, group } of groups) {
            try {
              const { events = [] } = await logs.filterLogEvents({ logGroupName: group, startTime, filterPattern: options?.filter, limit: 200 })
              printEvents(events, groups.length > 1 ? mode : undefined)
              for (const e of events) if ((e.timestamp ?? 0) > maxTs) maxTs = e.timestamp ?? maxTs
            }
            catch (err: any) {
              // A function with no traffic yet has no log group — skip quietly.
              if (!/ResourceNotFound/i.test(String(err?.message))) throw err
            }
          }
          startTime = maxTs + 1
        }

        await pull()
        if (options?.tail) {
          cli.info('\n(streaming — Ctrl+C to stop)')
          for (;;) {
            await new Promise(r => setTimeout(r, 3000))
            await pull()
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to read logs: ${error.message}`)
        process.exitCode = 1
      }
    })

  // Note: per-function log access already exists as `function:logs <name>` and
  // `server:logs <name>`; this file owns the env-aware aggregate `logs`.

  app
    .command('metrics', 'Show serverless function metrics (invocations, errors, duration, throttles)')
    .option('--env <environment>', 'Environment (production, staging, development)', { default: 'production' })
    .option('--since <duration>', 'Window (e.g. 1h, 24h)', { default: '1h' })
    .action(async (options?: { env?: string, since?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as EnvironmentType
        const { region, functions } = resolveServerlessFunctions(config, environment)
        const cw = new CloudWatchClient(region)
        const windowMs = durationToMs(options?.since, 60)
        const end = new Date()
        const start = new Date(end.getTime() - windowMs)
        const period = Math.max(60, Math.round(windowMs / 1000))

        cli.header(`Metrics — ${config.project.slug} (${environment}), last ${options?.since ?? '1h'}`)
        const rows: string[][] = []
        for (const mode of ['http', 'queue', 'cli'] as const) {
          const dims = [{ Name: 'FunctionName', Value: functions[mode] }]
          const stat = async (MetricName: string, kind: 'Sum' | 'Average' | 'Maximum'): Promise<number> => {
            const pts = await cw.getMetricStatistics({ Namespace: 'AWS/Lambda', MetricName, Dimensions: dims, StartTime: start, EndTime: end, Period: period, Statistics: [kind] })
            if (!pts.length) return 0
            if (kind === 'Sum') return pts.reduce((n, p) => n + (p.Sum ?? 0), 0)
            if (kind === 'Maximum') return Math.max(...pts.map(p => p.Maximum ?? 0))
            return pts.reduce((n, p) => n + (p.Average ?? 0), 0) / pts.length
          }
          const [invocations, errors, throttles, avgMs, maxMs] = await Promise.all([
            stat('Invocations', 'Sum'),
            stat('Errors', 'Sum'),
            stat('Throttles', 'Sum'),
            stat('Duration', 'Average'),
            stat('Duration', 'Maximum'),
          ])
          const errRate = invocations ? `${((errors / invocations) * 100).toFixed(2)}%` : '—'
          rows.push([mode, String(invocations), String(errors), errRate, String(throttles), `${avgMs.toFixed(0)}ms`, `${maxMs.toFixed(0)}ms`])
        }
        cli.table(['Function', 'Invocations', 'Errors', 'Error rate', 'Throttles', 'Avg', 'Max'], rows)
      }
      catch (error: any) {
        cli.error(`Failed to read metrics: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('metrics:dashboard', 'Print the CloudWatch console URL for this app')
    .option('--env <environment>', 'Environment (production, staging, development)', { default: 'production' })
    .action(async (options?: { env?: string }) => {
      try {
        const config = await loadValidatedConfig()
        const environment = (options?.env || 'production') as EnvironmentType
        const { region, functions } = resolveServerlessFunctions(config, environment)
        const metricsSpec = encodeURIComponent(JSON.stringify({
          metrics: (['http', 'queue', 'cli'] as const).flatMap(m => [
            ['AWS/Lambda', 'Invocations', 'FunctionName', functions[m]],
            ['AWS/Lambda', 'Errors', 'FunctionName', functions[m]],
          ]),
          view: 'timeSeries',
          region,
        }))
        cli.header('CloudWatch dashboard')
        cli.info(`https://console.aws.amazon.com/cloudwatch/home?region=${region}#metricsV2:graph=${metricsSpec}`)
      }
      catch (error: any) {
        cli.error(error.message)
        process.exitCode = 1
      }
    })

  app
    .command('alarms', 'List CloudWatch alarms')
    .option('--prefix <prefix>', 'Filter by alarm name prefix')
    .option('--region <region>', 'AWS region')
    .action(async (options?: { prefix?: string, region?: string }) => {
      cli.header('CloudWatch Alarms')
      let region = options?.region
      if (!region) {
        try { region = (await loadValidatedConfig()).project.region }
        catch { /* default below */ }
      }
      try {
        const cw = new CloudWatchClient(region || process.env.AWS_REGION || 'us-east-1')
        const alarms = await cw.describeAlarms({ AlarmNamePrefix: options?.prefix, MaxRecords: 100 })
        if (!alarms.length) {
          cli.info('No alarms found')
          return
        }
        cli.table(
          ['Name', 'State', 'Metric', 'Condition'],
          alarms.map(a => [a.AlarmName ?? '-', a.StateValue ?? '-', a.MetricName ?? '-', `${a.ComparisonOperator ?? ''} ${a.Threshold ?? ''}`.trim()]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list alarms: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('alarms:create', 'Create a CloudWatch alarm on a Lambda metric')
    .option('--name <name>', 'Alarm name')
    .option('--env <environment>', 'Environment', { default: 'production' })
    .option('--function <which>', 'Function: http | queue | cli', { default: 'http' })
    .option('--metric <metric>', 'Lambda metric (Errors, Throttles, Duration, Invocations)', { default: 'Errors' })
    .option('--threshold <value>', 'Threshold value')
    .option('--comparison <op>', 'GreaterThanThreshold | GreaterThanOrEqualToThreshold | LessThanThreshold', { default: 'GreaterThanThreshold' })
    .option('--statistic <stat>', 'Sum | Average | Maximum | Minimum', { default: 'Sum' })
    .action(async (options?: { name?: string, env?: string, function?: string, metric?: string, threshold?: string, comparison?: string, statistic?: string }) => {
      cli.header('Creating CloudWatch Alarm')
      if (!options?.name || options?.threshold == null) {
        cli.error('Missing required options: --name and --threshold')
        process.exitCode = 1
        return
      }
      try {
        const config = await loadValidatedConfig()
        const environment = (options.env || 'production') as EnvironmentType
        const { region, functions } = resolveServerlessFunctions(config, environment)
        const which = (options.function ?? 'http') as 'http' | 'queue' | 'cli'
        const cw = new CloudWatchClient(region)
        await cw.putMetricAlarm({
          AlarmName: options.name,
          Namespace: 'AWS/Lambda',
          MetricName: options.metric ?? 'Errors',
          ComparisonOperator: options.comparison ?? 'GreaterThanThreshold',
          Threshold: Number(options.threshold),
          EvaluationPeriods: 1,
          Period: 300,
          Statistic: (options.statistic ?? 'Sum') as 'Sum',
          Dimensions: [{ Name: 'FunctionName', Value: functions[which] }],
          AlarmDescription: `ts-cloud: ${functions[which]} ${options.metric} ${options.comparison} ${options.threshold}`,
        })
        cli.success(`Alarm '${options.name}' created on ${functions[which]} ${options.metric}`)
      }
      catch (error: any) {
        cli.error(`Failed to create alarm: ${error.message}`)
        process.exitCode = 1
      }
    })
}
