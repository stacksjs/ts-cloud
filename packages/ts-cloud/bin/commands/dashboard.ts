import type { CLI } from '@stacksjs/clapp'
import type { ControlPlaneSnapshot } from '../../src/control-plane'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { ControlPlaneStore } from '../../src/control-plane'
import * as cli from '../../src/utils/cli'
import { startLocalDashboardServer } from '../../src/deploy/local-dashboard-server'

function openControlPlane(path?: string): ControlPlaneStore {
  return new ControlPlaneStore(path ? { path: resolve(path) } : {})
}

function printControlPlaneHealth(store: ControlPlaneStore): void {
  const health = store.health()
  cli.header('Control-plane diagnostics')
  cli.info(`Database: ${health.path}`)
  cli.info(`Schema: ${health.schemaVersion}/${health.supportedSchemaVersion}`)
  cli.info(`Integrity: ${health.integrity}`)
  cli.info(`Journal: ${health.journalMode}`)
  cli.info(`Size: ${health.databaseBytes.toLocaleString()} bytes`)
  cli.info(`Last backup: ${health.lastBackupAt ?? 'never'}`)
  cli.info(`Operations: ${Object.entries(health.operations).map(([state, count]) => `${state}=${count}`).join(', ')}`)
  cli.info(`Pending/retryable: ${health.pendingRetryableOperations}`)
}

export function registerDashboardCommands(app: CLI): void {
  app
    .command('dashboard:serve', 'Run the local Forge-style cloud management UI')
    .option('--host <host>', 'Host to bind', { default: '127.0.0.1' })
    .option('--port <port>', 'Port to bind', { default: '7676' })
    .option('--env <environment>', 'Environment to manage')
    .option('--box', 'Box mode: run on the provisioned server (operate on localhost)')
    .option('--open', 'Print the URL for opening in a browser')
    .option('--verbose', 'Print server errors')
    .action(async (options?: { host?: string, port?: string, env?: string, box?: boolean, open?: boolean, verbose?: boolean }) => {
      const server = await startLocalDashboardServer({
        host: options?.host,
        port: Number(options?.port ?? 7676),
        environment: options?.env as any,
        box: options?.box,
        verbose: options?.verbose,
      })

      cli.header('ts-cloud Local Dashboard')
      cli.success(`Serving ${server.url}`)
      cli.info('Use Ctrl+C to stop.')

      await new Promise<void>((resolve) => {
        const stop = (): void => {
          server.server.stop(true)
          resolve()
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
    })

  app
    .command('control-plane:status', 'Inspect local control-plane storage health')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        printControlPlaneHealth(store)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:backup', 'Create a consistent local control-plane backup')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((options?: { path?: string }) => {
      const store = openControlPlane(options?.path)
      try {
        const backup = store.createBackup('cli')
        cli.success(`Backup written to ${backup}`)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:export <file>', 'Export portable control-plane metadata and history')
    .option('--path <path>', 'Use a non-default control-plane database')
    .action((file: string, options?: { path?: string }) => {
      const output = resolve(file)
      const store = openControlPlane(options?.path)
      try {
        mkdirSync(dirname(output), { recursive: true })
        writeFileSync(output, `${JSON.stringify(store.exportSnapshot(), null, 2)}\n`, { mode: 0o600 })
        chmodSync(output, 0o600)
        cli.success(`Control-plane snapshot exported to ${output}`)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:import <file>', 'Import a portable control-plane snapshot')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--replace', 'Replace existing control-plane records')
    .action((file: string, options?: { path?: string, replace?: boolean }) => {
      const input = resolve(file)
      const snapshot = JSON.parse(readFileSync(input, 'utf8')) as ControlPlaneSnapshot
      const store = openControlPlane(options?.path)
      try {
        const backup = options?.replace ? store.createBackup('pre-import') : undefined
        store.importSnapshot(snapshot, { replace: options?.replace })
        cli.success(`Imported control-plane snapshot from ${input}`)
        if (backup)
          cli.info(`Previous state backed up to ${backup}`)
      }
      finally {
        store.close()
      }
    })

  app
    .command('control-plane:compact', 'Apply history retention and compact control-plane storage')
    .option('--path <path>', 'Use a non-default control-plane database')
    .option('--event-days <days>', 'Retain event history for this many days', { default: '90' })
    .option('--operation-days <days>', 'Retain terminal operations for this many days', { default: '365' })
    .option('--no-vacuum', 'Delete expired records without reclaiming file space')
    .action((options?: { path?: string, eventDays?: string, operationDays?: string, vacuum?: boolean }) => {
      const store = openControlPlane(options?.path)
      try {
        const result = store.compact({
          eventRetentionDays: Number(options?.eventDays ?? 90),
          operationRetentionDays: Number(options?.operationDays ?? 365),
          vacuum: options?.vacuum !== false,
        })
        cli.success(`Removed ${result.deletedEvents} event(s) and ${result.deletedOperations} terminal operation(s).`)
        if (result.vacuumed)
          cli.info('Database file compacted.')
      }
      finally {
        store.close()
      }
    })
}
