import type { CLI } from '@stacksjs/clapp'
import type { EnvironmentType } from '@ts-cloud/core'
import * as output from '../../src/utils/cli'
import { AlertStore, evaluateTelemetryAlertRules, HealthCheckRunner, NotificationRouter } from '../../src/alerts'
import { resolveAuthEncryptionKey } from '../../src/auth'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { loadValidatedConfig } from './shared'

async function context(environment?: string) {
  const config = await loadValidatedConfig()
  const env = (environment ?? Object.keys(config.environments ?? {})[0] ?? 'production') as EnvironmentType
  if (!Object.hasOwn(config.environments ?? {}, env)) throw new Error(`Environment ${env} was not found`)
  const controlPlane = initializeDashboardControlPlane(process.cwd(), config)
  const environmentRecord = controlPlane.environments.get(env)
  const alerts = new AlertStore(controlPlane.store, { encryptionKey: resolveAuthEncryptionKey(process.cwd()) })
  return { config, env, controlPlane, environmentRecord, alerts }
}

function notificationRouter(store: AlertStore): NotificationRouter {
  return new NotificationRouter(store, {
    emailImpl: async (input) => {
      const { email } = await import('../../src/aws/email')
      return email.send(input)
    },
  })
}

export function registerAlertingCommands(app: CLI): void {
  app
    .command('health:list', 'List configured health checks and latest results')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; json?: boolean }) => {
      const value = await context(options.env)
      try {
        const checks = value.alerts
          .listHealthChecks(value.controlPlane.project.id, value.environmentRecord?.id)
          .map((check) => ({ ...check, latest: value.alerts.listHealthResults(check.id, 1)[0] }))
        if (options.json) output.info(JSON.stringify(checks, null, 2))
        else
          output.table(
            ['ID', 'Name', 'Kind', 'Target', 'Status', 'Interval', 'Enabled'],
            checks.map((item) => [
              item.id,
              item.name,
              item.kind,
              item.target,
              item.latest?.status ?? 'no data',
              `${item.intervalSeconds}s`,
              item.enabled ? 'yes' : 'no',
            ]),
          )
      } finally {
        value.controlPlane.store.close()
      }
    })
  app
    .command('health:run <check>', 'Run one health check and evaluate linked alert rules')
    .option('--env <environment>', 'Target environment')
    .option('--test', 'Preview without persisting results or incidents')
    .action(async (id: string, options: { env?: string; test?: boolean }) => {
      const value = await context(options.env)
      try {
        const check =
          value.alerts.getHealthCheck(id) ??
          value.alerts
            .listHealthChecks(value.controlPlane.project.id, value.environmentRecord?.id)
            .find((item) => item.name === id)
        if (!check) throw new Error('Health check was not found')
        const runner = new HealthCheckRunner(value.alerts)
        if (options.test) {
          const result = await runner.probe(check)
          output.info(JSON.stringify({ ...result, productionIncidentCreated: false }, null, 2))
          return
        }
        const outcome = await runner.runAndEvaluate(check)
        output.info(JSON.stringify(outcome, null, 2))
        if (outcome.result.status === 'healthy') output.success(`${check.name} is healthy.`)
        else output.warn(`${check.name} is ${outcome.result.status}.`)
      } finally {
        value.controlPlane.store.close()
      }
    })
  app
    .command('alerts:list', 'List pending, firing, silenced, and resolved alerts')
    .option('--env <environment>', 'Target environment')
    .option('--state <states>', 'Comma-separated states')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; state?: string; json?: boolean }) => {
      const value = await context(options.env)
      try {
        const alerts = value.alerts.listAlerts(value.controlPlane.project.id, {
          environmentId: value.environmentRecord?.id,
          states: options.state?.split(',').filter(Boolean),
        })
        if (options.json) output.info(JSON.stringify(alerts, null, 2))
        else
          output.table(
            ['ID', 'State', 'Severity', 'Title', 'Owner', 'First seen', 'Last seen'],
            alerts.map((item) => [
              item.id,
              item.state,
              item.severity,
              item.title,
              item.ownerActorId ?? 'unassigned',
              item.firstSeenAt,
              item.lastSeenAt,
            ]),
          )
      } finally {
        value.controlPlane.store.close()
      }
    })
  app
    .command('alerts:evaluate', 'Evaluate persisted telemetry rules now')
    .option('--env <environment>', 'Target environment')
    .action(async (options: { env?: string }) => {
      const value = await context(options.env)
      try {
        const results = evaluateTelemetryAlertRules(
          value.alerts,
          value.controlPlane.project.id,
          value.environmentRecord?.id,
        )
        output.info(JSON.stringify(results, null, 2))
      } finally {
        value.controlPlane.store.close()
      }
    })
  app
    .command('alerts:ack <alert>', 'Acknowledge an alert as the CLI actor')
    .option('--env <environment>', 'Target environment')
    .action(async (id: string, options: { env?: string }) => {
      const value = await context(options.env)
      try {
        const actor =
          value.controlPlane.store.getActorByExternalId('system', 'cli') ??
          value.controlPlane.store.createActor({ kind: 'system', externalId: 'cli', displayName: 'ts-cloud CLI' })
        output.success(`Acknowledged ${value.alerts.acknowledge(id, actor.id).title}.`)
      } finally {
        value.controlPlane.store.close()
      }
    })
  app
    .command('notifications:list', 'List notification channels, routes, and recent delivery diagnostics')
    .option('--env <environment>', 'Target environment')
    .option('--json', 'Print structured JSON')
    .action(async (options: { env?: string; json?: boolean }) => {
      const value = await context(options.env)
      try {
        const data = {
          channels: value.alerts.listChannels(value.controlPlane.organization.id),
          routes: value.alerts.listRoutes(value.controlPlane.organization.id),
          deliveries: value.alerts.listDeliveries({ limit: 100 }),
        }
        if (options.json) output.info(JSON.stringify(data, null, 2))
        else {
          output.table(
            ['Channel', 'Type', 'Status', 'Tested', 'Error'],
            data.channels.map((item) => [
              item.name,
              item.kind,
              item.status,
              item.lastTestedAt ?? 'never',
              item.lastError ?? '—',
            ]),
          )
          output.table(
            ['Event', 'State', 'Attempts', 'Status', 'Error'],
            data.deliveries.map((item) => [
              item.eventType,
              item.state,
              `${item.attempt}/${item.maxAttempts}`,
              String(item.responseStatus ?? '—'),
              item.error ?? '—',
            ]),
          )
        }
      } finally {
        value.controlPlane.store.close()
      }
    })
  app
    .command('notifications:test <channel>', 'Send a channel test without creating a production incident')
    .option('--env <environment>', 'Target environment')
    .action(async (id: string, options: { env?: string }) => {
      const value = await context(options.env)
      try {
        const channel =
          value.alerts.getChannel(id) ??
          value.alerts.listChannels(value.controlPlane.organization.id).find((item) => item.name === id)
        if (!channel) throw new Error('Notification channel was not found')
        const result = await notificationRouter(value.alerts).testChannel(channel.id)
        if (result.ok) output.success('Test delivered; no production incident was created.')
        else throw new Error(result.error)
      } finally {
        value.controlPlane.store.close()
      }
    })
  app
    .command('notifications:retry <delivery>', 'Retry one failed notification delivery')
    .option('--env <environment>', 'Target environment')
    .action(async (id: string, options: { env?: string }) => {
      const value = await context(options.env)
      try {
        const current = value.alerts.getDelivery(id)
        if (!current) throw new Error('Notification delivery was not found')
        value.alerts.updateDelivery(id, {
          state: 'retrying',
          attempt: Math.max(0, current.attempt - 1),
          nextAttemptAt: new Date().toISOString(),
        })
        output.info(JSON.stringify(await notificationRouter(value.alerts).deliver(id), null, 2))
      } finally {
        value.controlPlane.store.close()
      }
    })
}
