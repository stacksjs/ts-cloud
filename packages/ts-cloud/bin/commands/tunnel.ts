import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'

export function registerTunnelCommands(app: CLI): void {
  app
    .command('tunnel', 'Start a local tunnel to expose your local server')
    .option('--port <number>', 'Local port to expose', { default: '3000' })
    .option('--subdomain <name>', 'Custom subdomain (if available)')
    .option('--host <hostname>', 'Local hostname', { default: 'localhost' })
    .option('--server <url>', 'Tunnel server URL', { default: 'wss://localtunnel.dev' })
    .action(async (options: { port: string; subdomain?: string; host: string; server: string }) => {
      cli.header('Local Tunnel')

      const port = Number.parseInt(options.port)

      cli.info(`Local server: ${options.host}:${port}`)
      cli.info(`Tunnel server: ${options.server}`)

      if (options.subdomain) {
        cli.info(`Requested subdomain: ${options.subdomain}`)
      }

      const spinner = new cli.Spinner('Connecting to tunnel server...')
      spinner.start()

      try {
        // Try to dynamically import localtunnels
        let TunnelClient: any

        try {
          const localtunnels = await import('localtunnels')
          TunnelClient = localtunnels.TunnelClient
        }
        catch {
          spinner.fail('localtunnels package not found')
          cli.info('\nTo use tunnels, install the localtunnels package:')
          cli.info('  bun add localtunnels')
          cli.info('\nOr use the standalone CLI:')
          cli.info('  bunx localtunnels --port 3000')
          return
        }

        const client = new TunnelClient({
          localPort: port,
          localHost: options.host,
          subdomain: options.subdomain,
          server: options.server,
        })

        client.on('connected', (info: { url: string; subdomain: string }) => {
          spinner.succeed('Connected!')
          cli.success(`\nYour tunnel URL: ${info.url}`)
          cli.info(`Subdomain: ${info.subdomain}`)
          cli.info(`\nForwarding: ${info.url} -> http://${options.host}:${port}`)
          cli.info('\nPress Ctrl+C to stop the tunnel')
        })

        client.on('request', (req: { method: string; url: string }) => {
          cli.info(`${new Date().toISOString()} ${req.method} ${req.url}`)
        })

        client.on('error', (error: Error) => {
          cli.error(`Tunnel error: ${error.message}`)
        })

        client.on('close', () => {
          cli.info('\nTunnel closed')
        })

        await client.connect()

        // Keep the process running
        await new Promise(() => {})
      }
      catch (error: any) {
        spinner.fail('Failed to connect')
        cli.error(`Error: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('tunnel:status', 'Check tunnel server status')
    .option('--server <url>', 'Tunnel server URL', { default: 'https://localtunnel.dev' })
    .action(async (options: { server: string }) => {
      cli.header('Tunnel Server Status')

      const spinner = new cli.Spinner('Checking server status...')
      spinner.start()

      try {
        const response = await fetch(`${options.server}/status`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        })

        if (response.ok) {
          const status = await response.json()
          spinner.succeed('Server is online')

          cli.info(`\nServer: ${options.server}`)
          cli.info(`Status: ${status.status || 'operational'}`)

          if (status.version) {
            cli.info(`Version: ${status.version}`)
          }

          if (status.connections !== undefined) {
            cli.info(`Active connections: ${status.connections}`)
          }

          if (status.uptime) {
            cli.info(`Uptime: ${status.uptime}`)
          }
        }
        else {
          spinner.fail(`Server returned status ${response.status}`)
        }
      }
      catch (error: any) {
        spinner.fail('Failed to check server status')
        cli.error(`Error: ${error.message}`)
        cli.info('\nThe tunnel server may be offline or unreachable.')
      }
    })

  app
    .command('tunnel:info', 'Show tunnel configuration and setup info')
    .action(async () => {
      cli.header('Local Tunnel Information')

      cli.info('ts-cloud uses localtunnels for secure tunnel connections.')
      cli.info('')
      cli.info('Default server: localtunnel.dev')
      cli.info('')
      cli.info('Usage:')
      cli.info('  cloud tunnel --port 3000              # Expose port 3000')
      cli.info('  cloud tunnel --port 8080 --subdomain myapp')
      cli.info('')
      cli.info('Features:')
      cli.info('  - Secure WebSocket-based tunnels')
      cli.info('  - Custom subdomains (when available)')
      cli.info('  - Automatic reconnection')
      cli.info('  - Request logging')
      cli.info('')
      cli.info('Self-hosted tunnel server:')
      cli.info('  You can run your own tunnel server using localtunnels.')
      cli.info('  See: https://github.com/stacksjs/localtunnels')
      cli.info('')
      cli.info('Environment variables:')
      cli.info('  TUNNEL_SERVER - Custom tunnel server URL')
      cli.info('  TUNNEL_SUBDOMAIN - Default subdomain to request')
    })

  app
    .command('tunnel:deploy', 'Deploy the localtunnel.dev infrastructure')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--domain <domain>', 'Custom domain', { default: 'localtunnel.dev' })
    .action(async (options: { region: string; domain: string }) => {
      cli.header('Deploy Tunnel Infrastructure')

      cli.info(`Region: ${options.region}`)
      cli.info(`Domain: ${options.domain}`)
      cli.info('')

      cli.info('This will deploy:')
      cli.info('  - API Gateway WebSocket API for tunnel connections')
      cli.info('  - API Gateway HTTP API for proxying requests')
      cli.info('  - Lambda functions for handling connections')
      cli.info('  - DynamoDB table for connection tracking')
      cli.info('')

      const confirmed = await cli.confirm('Deploy tunnel infrastructure?', false)
      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      cli.info('')
      cli.info('To deploy the tunnel server infrastructure:')
      cli.info('')
      cli.info('1. Clone the localtunnels repository:')
      cli.info('   git clone https://github.com/stacksjs/localtunnels')
      cli.info('')
      cli.info('2. Navigate to the project:')
      cli.info('   cd localtunnels')
      cli.info('')
      cli.info('3. Install dependencies:')
      cli.info('   bun install')
      cli.info('')
      cli.info('4. Deploy using CDK:')
      cli.info('   cd src/cloud && cdk deploy')
      cli.info('')
      cli.info('5. Configure your domain DNS:')
      cli.info(`   Point ${options.domain} to the API Gateway endpoint`)
      cli.info('')
      cli.info('For the localtunnel.dev deployment, use bunpress:')
      cli.info('   bunx bunpress deploy')
    })

  app
    .command('tunnel:logs', 'View tunnel server logs')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--tail', 'Tail the logs')
    .action(async (options: { region: string; tail?: boolean }) => {
      cli.header('Tunnel Server Logs')

      cli.info('Tunnel server log groups:')
      cli.info('  - /aws/lambda/tunnel-connect')
      cli.info('  - /aws/lambda/tunnel-disconnect')
      cli.info('  - /aws/lambda/tunnel-https')
      cli.info('')

      cli.info('To view logs:')
      cli.info(`  aws logs tail /aws/lambda/tunnel-connect --region ${options.region}${options.tail ? ' --follow' : ''}`)
      cli.info('')

      cli.info('Or use CloudWatch Insights:')
      cli.info(`  1. Go to CloudWatch > Logs Insights`)
      cli.info(`  2. Select the tunnel log groups`)
      cli.info(`  3. Run queries like:`)
      cli.info(`     fields @timestamp, @message | filter @message like /error/i`)
    })

  app
    .command('tunnel:test <url>', 'Test a tunnel connection')
    .action(async (url: string) => {
      cli.header('Test Tunnel Connection')

      const spinner = new cli.Spinner(`Testing ${url}...`)
      spinner.start()

      try {
        const startTime = Date.now()
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'ts-cloud-tunnel-test',
          },
        })

        const elapsed = Date.now() - startTime

        spinner.succeed(`Connected in ${elapsed}ms`)

        cli.info(`\nStatus: ${response.status} ${response.statusText}`)
        cli.info('\nResponse headers:')
        response.headers.forEach((value, key) => {
          cli.info(`  ${key}: ${value}`)
        })

        const body = await response.text()
        if (body.length > 0) {
          cli.info('\nResponse body (first 500 chars):')
          console.log(body.substring(0, 500))
          if (body.length > 500) {
            cli.info(`... (${body.length - 500} more characters)`)
          }
        }
      }
      catch (error: any) {
        spinner.fail('Connection failed')
        cli.error(`Error: ${error.message}`)
      }
    })
}
