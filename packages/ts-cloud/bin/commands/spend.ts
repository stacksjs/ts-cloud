/**
 * `cloud usage`, `cloud budget:*`, and `cloud spend:*`.
 *
 * The CLI surface deliberately mirrors the API rather than adding its own
 * model: a budget created here is the same record `POST /api/v1/spend/budgets`
 * creates, and both go through `SpendStore` so validation cannot drift.
 *
 * One difference from the API, and it is intentional: a budget created here
 * enforces by default, while one created over the API starts in dry run. An
 * operator at a terminal has read the flags they typed; an agent calling an
 * endpoint may not have. `--dry-run` is always available, and the command
 * prints which mode it used.
 */
import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import type { BudgetPeriod, EnforcementAction } from '../../src/spend'
import * as output from '../../src/utils/cli'
import { AlertStore } from '../../src/alerts'
import { resolveAuthEncryptionKey } from '../../src/auth'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import {
  DEFAULT_THRESHOLDS,
  ENFORCEMENT_ACTIONS,
  formatCents,
  METERS,
  DETECTABLE_SIGNALS,
  SPEND_CYCLE_SECONDS,
  SpendGate,
  SpendLoopLease,
  SpendRunner,
  SpendService,
  SpendStore,
  startSpendLoop,
} from '../../src/spend'
import { loadValidatedConfig } from './shared'

async function context(environment?: string) {
  const config = await loadValidatedConfig()
  const env = (environment ?? Object.keys(config.environments ?? {})[0] ?? 'production') as EnvironmentType
  if (!Object.hasOwn(config.environments ?? {}, env)) throw new Error(`Environment ${env} was not found`)
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  const environmentRecord = controlPlane.environments.get(env)
  const store = new SpendStore(controlPlane.store)
  const alerts = new AlertStore(controlPlane.store, { encryptionKey: resolveAuthEncryptionKey(process.cwd()) })
  return {
    config,
    env,
    controlPlane,
    environmentRecord,
    store,
    alerts,
    service: new SpendService(store),
    gate: new SpendGate(controlPlane.store),
    organizationId: controlPlane.organization.id,
    projectId: controlPlane.project.id,
  }
}

/** Accept `$50`, `50`, or `5000c`. Money on a command line is written in dollars. */
export function parseMoneyToCents(value: string | number | undefined): number | undefined {
  if (value == null) return undefined
  const text = String(value).trim().replace(/[$,\s]/g, '')
  if (!text) return undefined
  if (/^\d+c$/i.test(text)) return Number.parseInt(text, 10)
  const dollars = Number(text)
  if (!Number.isFinite(dollars) || dollars < 0) throw new Error(`Invalid amount: ${value}`)
  return Math.round(dollars * 100)
}

/** `notify,block_builds` into a validated action list. */
export function parseActions(value: string | undefined): EnforcementAction[] | undefined {
  if (!value) return undefined
  const actions = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  for (const action of actions)
    if (!(ENFORCEMENT_ACTIONS as readonly string[]).includes(action))
      throw new Error(`Unknown enforcement action '${action}'. Valid: ${ENFORCEMENT_ACTIONS.join(', ')}`)
  return actions as EnforcementAction[]
}

function periodOf(value: string | undefined): BudgetPeriod {
  if (value == null) return 'monthly'
  if (value === 'daily' || value === 'weekly' || value === 'monthly') return value
  throw new Error(`Unknown period '${value}'. Valid: daily, weekly, monthly`)
}

function meterLabel(meter: string): string {
  return METERS[meter]?.label ?? meter
}

function bar(percent: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function fail(error: unknown): void {
  output.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

export function registerSpendCommands(app: CLI): void {
  app
    .command('usage', 'Show current usage, cost, and remaining budget headroom')
    .option('--env <environment>', 'Target environment')
    .option('--period <period>', 'daily, weekly, or monthly (default monthly)')
    .option('--timezone <tz>', 'IANA timezone for period boundaries (default UTC)')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; period?: string; timezone?: string; json?: boolean }) => {
      try {
        const value = await context(options.env)
        const report = value.service.usageReport({
          organizationId: value.organizationId,
          projectId: value.projectId,
          period: periodOf(options.period),
          timezone: options.timezone,
        }) as any
        if (options.json) {
          output.info(JSON.stringify(report, null, 2))
          return
        }
        output.header(`Usage — ${report.window.label}`)
        output.info(`Total: ${formatCents(report.totalCents, report.currency)}`)
        if (report.byMeter.length === 0) output.info('No metered usage in this window yet.')
        else
          output.table(
            ['Meter', 'Provider', 'Quantity', 'Cost'],
            report.byMeter.map((row: any) => [
              meterLabel(row.meter),
              row.provider || '-',
              row.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 }),
              formatCents(row.costCents, report.currency),
            ]),
          )
        if (report.budgets.length === 0) {
          output.warn('No budgets are configured. Nothing is capping this project.')
          output.info("Create one with: cloud budget:create --name 'Monthly' --hard 200")
          return
        }
        output.header('Budgets')
        output.table(
          ['Name', 'Period', 'Spent', 'Limit', 'Used', 'Projected', 'Time to cap', 'State'],
          report.budgets.map((budget: any) => [
            budget.name + (budget.dryRun ? ' (dry run)' : ''),
            budget.period,
            formatCents(budget.spentCents, report.currency),
            budget.limitCents == null ? '-' : formatCents(budget.limitCents, report.currency),
            `${bar(budget.usedPercent)} ${budget.usedPercent.toFixed(0)}%`,
            `${formatCents(budget.projectedCents, report.currency)} (${(budget.projectionConfidence * 100).toFixed(0)}% conf)`,
            budget.timeToCap || '-',
            budget.level,
          ]),
        )
        if (report.enforcement.strongestAction)
          output.warn(`Enforcement in force: ${report.enforcement.strongestAction}`)
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('budget:list', 'List budgets governing this project')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; json?: boolean }) => {
      try {
        const value = await context(options.env)
        const budgets = value.store.listBudgets({
          organizationId: value.organizationId,
          projectId: value.projectId,
        })
        if (options.json) {
          output.info(JSON.stringify(budgets, null, 2))
          return
        }
        if (budgets.length === 0) {
          output.warn('No budgets configured.')
          return
        }
        output.table(
          ['ID', 'Name', 'Scope', 'Period', 'Soft', 'Hard', 'Mode', 'Enabled'],
          budgets.map((budget) => [
            budget.id.slice(0, 8),
            budget.name,
            budget.environmentId ? 'environment' : budget.projectId ? 'project' : 'organization',
            budget.period,
            budget.softLimitCents == null ? '-' : formatCents(budget.softLimitCents, budget.currency),
            budget.hardLimitCents == null ? '-' : formatCents(budget.hardLimitCents, budget.currency),
            budget.dryRun ? 'dry run' : 'enforcing',
            budget.enabled ? 'yes' : 'no',
          ]),
        )
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('budget:create', 'Create a spend budget')
    .option('--name <name>', 'Budget name')
    .option('--soft <amount>', 'Soft limit in dollars (warn only)')
    .option('--hard <amount>', 'Hard limit in dollars (enforces)')
    .option('--period <period>', 'daily, weekly, or monthly (default monthly)')
    .option('--timezone <tz>', 'IANA timezone for period boundaries (default UTC)')
    .option('--scope <scope>', 'organization, project, or environment (default project)')
    .option('--actions <list>', 'Comma-separated actions to run at 100% (default notify,block_builds,block_deployments)')
    .option('--grace <seconds>', 'Seconds a breach must persist before enforcing')
    .option('--dry-run', 'Evaluate and report but never enforce')
    .option('--env <environment>', 'Target environment')
    .action(
      async (options: {
        name?: string
        soft?: string
        hard?: string
        period?: string
        timezone?: string
        scope?: string
        actions?: string
        grace?: string
        dryRun?: boolean
        env?: string
      }) => {
        try {
          if (!options.name) throw new Error('--name is required.')
          const value = await context(options.env)
          const scope = options.scope ?? 'project'
          if (!['organization', 'project', 'environment'].includes(scope))
            throw new Error(`Unknown scope '${scope}'. Valid: organization, project, environment`)
          const actions = parseActions(options.actions)
          const budget = value.store.createBudget({
            organizationId: value.organizationId,
            projectId: scope === 'organization' ? undefined : value.projectId,
            environmentId: scope === 'environment' ? value.environmentRecord?.id : undefined,
            name: options.name,
            period: periodOf(options.period),
            timezone: options.timezone,
            softLimitCents: parseMoneyToCents(options.soft),
            hardLimitCents: parseMoneyToCents(options.hard),
            graceSeconds: options.grace == null ? undefined : Number(options.grace),
            // A ladder given on the command line replaces the default entirely,
            // so `--actions notify` really does mean warn-only.
            thresholds: actions
              ? [
                  { atPercent: 80, actions: ['notify'] },
                  { atPercent: 100, actions },
                ]
              : [...DEFAULT_THRESHOLDS],
            dryRun: options.dryRun === true,
          })
          output.success(`Created budget '${budget.name}' (${budget.id}).`)
          output.info(`Mode: ${budget.dryRun ? 'dry run — reports only, enforces nothing' : 'enforcing'}`)
          output.info(
            `Ladder: ${budget.thresholds.map((threshold) => `${threshold.atPercent}% → ${threshold.actions.join('+')}`).join(', ')}`,
          )
        } catch (error) {
          fail(error)
        }
      },
    )

  app
    .command('budget:update <budgetId>', 'Update a budget')
    .option('--soft <amount>', 'Soft limit in dollars')
    .option('--hard <amount>', 'Hard limit in dollars')
    .option('--enable', 'Enable the budget')
    .option('--disable', 'Disable the budget')
    .option('--enforce', 'Leave dry run and start enforcing')
    .option('--dry-run', 'Return to dry run')
    .option('--env <environment>', 'Target environment')
    .action(
      async (
        budgetId: string,
        options: { soft?: string; hard?: string; enable?: boolean; disable?: boolean; enforce?: boolean; dryRun?: boolean; env?: string },
      ) => {
        try {
          const value = await context(options.env)
          const existing = value.store.getBudget(budgetId)
          if (!existing) throw new Error(`Budget '${budgetId}' was not found.`)
          const updated = value.store.updateBudget(budgetId, {
            softLimitCents: parseMoneyToCents(options.soft) ?? existing.softLimitCents,
            hardLimitCents: parseMoneyToCents(options.hard) ?? existing.hardLimitCents,
            enabled: options.disable ? false : options.enable ? true : existing.enabled,
            dryRun: options.enforce ? false : options.dryRun ? true : existing.dryRun,
          })
          output.success(`Updated budget '${updated.name}'.`)
          output.info(`Mode: ${updated.dryRun ? 'dry run' : 'enforcing'} · Enabled: ${updated.enabled ? 'yes' : 'no'}`)
        } catch (error) {
          fail(error)
        }
      },
    )

  app
    .command('budget:delete <budgetId>', 'Delete a budget and lift anything it was enforcing')
    .option('--env <environment>', 'Target environment')
    .action(async (budgetId: string, options: { env?: string }) => {
      try {
        const value = await context(options.env)
        const existing = value.store.getBudget(budgetId)
        if (!existing) throw new Error(`Budget '${budgetId}' was not found.`)
        // Lift the gate first. Deleting the budget without this leaves entries
        // refusing deploys with nothing left in the UI to explain why.
        const lifted = value.gate.closeBudget(budgetId)
        value.store.deleteBudget(budgetId)
        output.success(`Deleted budget '${existing.name}'.`)
        if (lifted > 0) output.info(`Lifted ${lifted} enforcement action(s) it had in force.`)
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('spend:check', 'Run one spend cycle now and report what it would do')
    .option('--env <environment>', 'Target environment')
    .option('--apply', 'Actually apply enforcement (default is a preview)')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; apply?: boolean; json?: boolean }) => {
      try {
        const value = await context(options.env)
        const runner = new SpendRunner({
          controlPlane: value.controlPlane.store,
          store: value.store,
          alerts: options.apply ? value.alerts : undefined,
        })
        if (!options.apply) {
          // Preview: evaluate every governing budget without opening the gate
          // or calling a transport. `--apply` is what makes a cycle real.
          const budgets = value.store.budgetsForScope(value.organizationId, value.projectId)
          const statuses = budgets.map((budget) => value.service.status(budget))
          if (options.json) {
            output.info(JSON.stringify(statuses, null, 2))
            return
          }
          output.header('Spend check (preview — nothing was applied)')
          if (statuses.length === 0) {
            output.warn('No budgets govern this project.')
            return
          }
          output.table(
            ['Budget', 'Used', 'Projected', 'Level', 'Would apply'],
            statuses.map((status) => [
              status.budget.name,
              `${status.decision.usedPercent.toFixed(1)}%`,
              `${status.decision.projectedPercent.toFixed(1)}%`,
              status.decision.level,
              status.decision.actions.join(', ') || '-',
            ]),
          )
          output.info('\nRun with --apply to enforce.')
          return
        }
        const result = await runner.run({
          organizationId: value.organizationId,
          projectId: value.projectId,
          environmentId: value.environmentRecord?.id,
          environmentKind: value.environmentRecord?.kind,
        })
        if (options.json) {
          output.info(JSON.stringify(result, null, 2))
          return
        }
        output.header('Spend cycle')
        output.info(`Evaluated ${result.decisions.length} budget(s) in ${result.durationMs}ms.`)
        if (result.applied.length > 0) output.warn(`Applied: ${result.applied.join(', ')}`)
        if (result.released.length > 0) output.success(`Released: ${result.released.join(', ')}`)
        if (result.withheld.length > 0) output.warn(`Withheld pending approval: ${result.withheld.join(', ')}`)
        if (result.anomalies.length > 0) output.warn(`${result.anomalies.length} anomaly(ies) detected.`)
        output.info(`Notifications queued: ${result.notificationsSent}`)
        for (const warning of result.warnings) output.warn(warning)
        if (result.applied.length === 0 && result.released.length === 0) output.success('Nothing to change.')
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('spend:work', 'Run the spend loop continuously: meter, evaluate, enforce, notify')
    .option('--env <environment>', 'Target environment')
    .option('--interval <seconds>', `Seconds between cycles (default ${SPEND_CYCLE_SECONDS})`)
    .option('--once', 'Run a single cycle and exit')
    .action(async (options: { env?: string; interval?: string; once?: boolean }) => {
      try {
        const value = await context(options.env)
        const runner = new SpendRunner({
          controlPlane: value.controlPlane.store,
          store: value.store,
          alerts: value.alerts,
        })
        const scope = {
          organizationId: value.organizationId,
          projectId: value.projectId,
          environmentId: value.environmentRecord?.id,
          environmentKind: value.environmentRecord?.kind,
        }
        if (options.once) {
          const result = await runner.run(scope)
          output.success(`Cycle finished in ${result.durationMs}ms.`)
          for (const warning of result.warnings) output.warn(warning)
          return
        }
        const seconds = Math.max(10, Number(options.interval ?? SPEND_CYCLE_SECONDS))
        // The dashboard server runs this loop too, so the lease keeps the two
        // from evaluating every budget twice a minute against the same data.
        const lease = new SpendLoopLease(value.controlPlane.store, { owner: `cli:${process.pid}` })
        output.header(`Spend worker (every ${seconds}s)`)
        output.info('Press Ctrl+C to stop.')
        const stop = startSpendLoop(runner, {
          intervalSeconds: seconds,
          lease,
          immediate: true,
          onResult: (results) => {
            const applied = results.flatMap((result) => result.applied)
            const released = results.flatMap((result) => result.released)
            const warnings = results.flatMap((result) => result.warnings)
            if (applied.length > 0) output.warn(`Applied: ${applied.join(', ')}`)
            if (released.length > 0) output.success(`Released: ${released.join(', ')}`)
            for (const warning of warnings) output.warn(warning)
          },
          onSkip: (holder) => output.info(`Skipped: ${holder} holds the loop lease.`),
          onError: (error) => output.error(error instanceof Error ? error.message : String(error)),
        })
        const shutdown = () => {
          stop()
          output.info('\nSpend worker stopped; the loop lease was released.')
          process.exit(0)
        }
        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
        // Keep the process alive: startSpendLoop unrefs its timer so it never
        // holds a one-shot command open, which means a worker must hold itself.
        await new Promise(() => {})
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('spend:status', 'Show enforcement currently in force')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; json?: boolean }) => {
      try {
        const value = await context(options.env)
        const entries = value.gate.listUnder({ organizationId: value.organizationId })
        if (options.json) {
          output.info(JSON.stringify(entries, null, 2))
          return
        }
        if (entries.length === 0) {
          output.success('No spend enforcement is in force.')
          return
        }
        output.table(
          ['Action', 'Budget', 'Scope', 'Mode', 'Since', 'Reason'],
          entries.map((entry) => [
            entry.action,
            entry.budgetId.slice(0, 8),
            entry.environmentId ? 'environment' : entry.projectId ? 'project' : 'organization',
            entry.simulated ? 'dry run' : 'enforcing',
            entry.appliedAt,
            entry.reason,
          ]),
        )
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('spend:release <budgetId> <action>', 'Manually lift one enforcement action')
    .option('--env <environment>', 'Target environment')
    .action(async (budgetId: string, action: string, options: { env?: string }) => {
      try {
        const value = await context(options.env)
        const parsed = parseActions(action)?.[0]
        if (!parsed) throw new Error('An action is required.')
        if (!value.gate.close(budgetId, parsed))
          throw new Error(`${parsed} was not in force for budget ${budgetId}.`)
        output.success(`Lifted ${parsed} for budget ${budgetId}.`)
        // Say the quiet part: the next cycle re-applies it unless the cause is
        // fixed, so a manual release is a stopgap and not a resolution.
        output.warn('The next spend cycle will re-apply this if spend is still over the threshold.')
      } catch (error) {
        fail(error)
      }
    })

  app
    .command('anomaly:config', 'Tune anomaly detection for a signal')
    .option('--signal <signal>', 'Signal to configure (default cost)')
    .option('--sensitivity <level>', 'low, medium, or high')
    .option('--season <points>', 'Points per season: 24 for daily, 168 for weekly')
    .option('--min-delta <amount>', "Absolute change below which nothing is reported, in the signal's units")
    .option('--severity <severity>', 'info, warning, or critical')
    .option('--disable', 'Stop detecting this signal')
    .option('--enable', 'Resume detecting this signal')
    .option('--list', 'List configured signals instead of changing one')
    .option('--signals', 'List every detectable signal and its data rules')
    .option('--env <environment>', 'Target environment')
    .action(
      async (options: {
        signal?: string
        sensitivity?: string
        season?: string
        minDelta?: string
        severity?: string
        disable?: boolean
        enable?: boolean
        list?: boolean
        signals?: boolean
        env?: string
      }) => {
        try {
          if (options.signals) {
            output.table(
              ['Signal', 'Source', 'Empty hour', 'Min samples', 'Unit'],
              DETECTABLE_SIGNALS.map((signal) => [
                signal.key,
                signal.source,
                // The distinction that decides whether the baseline is honest.
                signal.gapPolicy === 'zero' ? 'counts as zero' : 'ignored',
                String(signal.minSamples),
                signal.unit,
              ]),
            )
            return
          }
          const value = await context(options.env)
          const configs = value.service.anomalyConfigs
          if (options.list) {
            const all = configs.list({ organizationId: value.organizationId, projectId: value.projectId })
            if (all.length === 0) {
              output.info('No signals are configured; every one uses its shipped defaults.')
              return
            }
            output.table(
              ['Signal', 'Enabled', 'Sensitivity', 'Season', 'Min delta', 'Severity'],
              all.map((config) => [
                config.signal,
                config.enabled ? 'yes' : 'no',
                config.sensitivity,
                String(config.seasonLength),
                String(config.minAbsoluteDelta),
                config.severity,
              ]),
            )
            return
          }
          const sensitivity = options.sensitivity as 'low' | 'medium' | 'high' | undefined
          if (sensitivity && !['low', 'medium', 'high'].includes(sensitivity))
            throw new Error('--sensitivity must be low, medium, or high.')
          const config = configs.upsert({
            organizationId: value.organizationId,
            projectId: value.projectId,
            signal: options.signal ?? 'cost',
            sensitivity,
            seasonLength: options.season == null ? undefined : Number(options.season),
            minAbsoluteDelta: options.minDelta == null ? undefined : Number(options.minDelta),
            severity: options.severity as never,
            enabled: options.disable ? false : options.enable ? true : undefined,
          })
          output.success(`Anomaly detection for '${config.signal}' updated.`)
          output.info(
            `${config.enabled ? 'Enabled' : 'Disabled'} · ${config.sensitivity} sensitivity · season ${config.seasonLength} · floor ${config.minAbsoluteDelta} · ${config.severity}`,
          )
        } catch (error) {
          fail(error)
        }
      },
    )

  app
    .command('anomaly:silence', 'Skip detection for a signal, route, or status code')
    .option('--signal <signal>', 'Signal to silence')
    .option('--route <pattern>', 'Route glob, e.g. /webhooks/**')
    .option('--status <code>', 'HTTP status code')
    .option('--reason <reason>', 'Why — required')
    .option('--until <timestamp>', 'ISO timestamp the silence expires')
    .option('--list', 'List active silences')
    .option('--remove <id>', 'Remove a silence')
    .option('--env <environment>', 'Target environment')
    .action(
      async (options: {
        signal?: string
        route?: string
        status?: string
        reason?: string
        until?: string
        list?: boolean
        remove?: string
        env?: string
      }) => {
        try {
          const value = await context(options.env)
          const configs = value.service.anomalyConfigs
          if (options.remove) {
            output.success(
              configs.removeSilence(options.remove) ? 'Silence removed.' : 'That silence was not found.',
            )
            return
          }
          if (options.list) {
            const silences = configs.listSilences({
              organizationId: value.organizationId,
              projectId: value.projectId,
            })
            if (silences.length === 0) {
              output.success('No active silences.')
              return
            }
            output.table(
              ['ID', 'Signal', 'Route', 'Status', 'Expires', 'Reason'],
              silences.map((silence) => [
                silence.id.slice(0, 8),
                silence.signal ?? '-',
                silence.routePattern ?? '-',
                silence.statusCode == null ? '-' : String(silence.statusCode),
                silence.expiresAt ?? 'never',
                silence.reason,
              ]),
            )
            return
          }
          if (!options.reason) throw new Error('--reason is required: someone will ask why this stopped alerting.')
          const silence = configs.silence({
            organizationId: value.organizationId,
            projectId: value.projectId,
            signal: options.signal,
            routePattern: options.route,
            statusCode: options.status == null ? undefined : Number(options.status),
            reason: options.reason,
            expiresAt: options.until,
          })
          output.success(`Silenced (${silence.id.slice(0, 8)}).`)
          if (!silence.expiresAt)
            output.warn('This silence never expires. Pass --until to bound it, or it will outlive the reason for it.')
        } catch (error) {
          fail(error)
        }
      },
    )

  app
    .command('spend:anomalies', 'List detected spend anomalies')
    .option('--env <environment>', 'Target environment')
    .option('--unacknowledged', 'Only anomalies nobody has acknowledged')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; unacknowledged?: boolean; json?: boolean }) => {
      try {
        const value = await context(options.env)
        const anomalies = value.store.listAnomalies({
          organizationId: value.organizationId,
          projectId: value.projectId,
          unacknowledgedOnly: options.unacknowledged === true,
        })
        if (options.json) {
          output.info(JSON.stringify(anomalies, null, 2))
          return
        }
        if (anomalies.length === 0) {
          output.success('No anomalies detected.')
          return
        }
        output.table(
          ['Hour', 'Signal', 'Direction', 'Observed', 'Expected', 'Score', 'Severity'],
          anomalies.map((anomaly) => [
            anomaly.bucketStart,
            anomaly.signal,
            anomaly.direction,
            formatCents(anomaly.observed),
            formatCents(anomaly.expected),
            anomaly.score.toFixed(1),
            anomaly.severity,
          ]),
        )
      } catch (error) {
        fail(error)
      }
    })
}
