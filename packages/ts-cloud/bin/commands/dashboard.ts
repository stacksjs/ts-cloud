import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { startLocalDashboardServer } from '../../src/deploy/local-dashboard-server'

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

      await new Promise(() => {})
    })
}
