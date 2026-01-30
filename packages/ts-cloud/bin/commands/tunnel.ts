import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'

export function registerTunnelCommands(app: CLI): void {
  app
    .command('tunnel', 'Start a local tunnel to expose your local server')
    .option('--port <number>', 'Local port to expose', { default: '3000' })
    .option('--subdomain <name>', 'Custom subdomain (if available)')
    .option('--host <hostname>', 'Local hostname', { default: 'localhost' })
    .option('--server <url>', 'Tunnel server URL', { default: 'localtunnel.dev' })
    .option('--verbose', 'Enable verbose logging')
    .action(async (options: { port: string; subdomain?: string; host: string; server: string; verbose?: boolean }) => {
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

        const serverHost = options.server.replace(/^(wss?|https?):\/\//, '')
        const secure = options.server.startsWith('wss://') || options.server.startsWith('https://') || serverHost === 'localtunnel.dev'

        const client = new TunnelClient({
          localPort: port,
          localHost: options.host,
          subdomain: options.subdomain,
          host: serverHost,
          port: secure ? 443 : 80,
          secure,
          verbose: options.verbose,
        })

        client.on('connected', (info: { url: string; subdomain: string }) => {
          spinner.succeed('Connected!')
          cli.success(`\nYour tunnel URL: ${info.url}`)
          cli.info(`Subdomain: ${info.subdomain}`)
          cli.info(`\nForwarding: ${info.url} -> http://${options.host}:${port}`)
          cli.info('\nPress Ctrl+C to stop the tunnel')
        })

        client.on('request', (req: { method: string; url: string }) => {
          if (options.verbose) {
            cli.info(`→ ${req.method} ${req.url}`)
          }
        })

        client.on('response', (res: { status: number; size: number; duration?: number }) => {
          if (options.verbose) {
            cli.info(`← ${res.status} (${res.size} bytes${res.duration ? `, ${res.duration}ms` : ''})`)
          }
        })

        client.on('reconnecting', (info: { attempt: number; maxAttempts: number }) => {
          cli.info(`Reconnecting... (attempt ${info.attempt}/${info.maxAttempts})`)
        })

        client.on('error', (error: Error) => {
          cli.error(`Tunnel error: ${error.message}`)
        })

        client.on('close', () => {
          cli.info('\nTunnel closed')
        })

        // Handle process signals for graceful shutdown
        const cleanup = () => {
          cli.info('\nShutting down tunnel...')
          client.disconnect()
          process.exit(0)
        }

        process.on('SIGINT', cleanup)
        process.on('SIGTERM', cleanup)

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
        const serverUrl = options.server.startsWith('http')
          ? options.server
          : `https://${options.server}`

        const response = await fetch(`${serverUrl}/status`, {
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

          if (status.activeSubdomains?.length) {
            cli.info(`Active subdomains: ${status.activeSubdomains.join(', ')}`)
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
      cli.info('  - Binary data support')
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
    .command('tunnel:deploy', 'Deploy tunnel infrastructure to AWS')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--prefix <prefix>', 'Resource name prefix', { default: 'localtunnel' })
    .option('--verbose', 'Enable verbose logging')
    .action(async (options: { region: string; prefix: string; verbose?: boolean }) => {
      cli.header('Deploy Tunnel Infrastructure')

      cli.info(`Region: ${options.region}`)
      cli.info(`Prefix: ${options.prefix}`)
      cli.info('')

      cli.info('This will deploy:')
      cli.info('  - DynamoDB tables for connection tracking')
      cli.info('  - Lambda functions for handling requests')
      cli.info('  - Lambda Function URLs for public access')
      cli.info('')

      const confirmed = await cli.confirm('Deploy tunnel infrastructure?', false)
      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Deploying infrastructure...')
      spinner.start()

      try {
        // Try to import the deploy function from localtunnels
        let deployTunnelInfrastructure: any

        try {
          const cloudModule = await import('localtunnels/cloud')
          deployTunnelInfrastructure = cloudModule.deployTunnelInfrastructure
        }
        catch {
          spinner.fail('localtunnels package not found')
          cli.info('\nTo deploy tunnel infrastructure, install localtunnels:')
          cli.info('  bun add localtunnels')
          cli.info('\nOr deploy using the localtunnels CLI directly:')
          cli.info('  bunx localtunnels deploy --region us-east-1')
          return
        }

        const result = await deployTunnelInfrastructure({
          region: options.region,
          prefix: options.prefix,
          verbose: options.verbose,
        })

        spinner.succeed('Deployment complete!')

        cli.info('')
        cli.info('Resources created:')
        cli.info(`  DynamoDB Tables:`)
        cli.info(`    - ${result.connectionsTable}`)
        cli.info(`    - ${result.responsesTable}`)
        cli.info('')
        cli.info(`  Lambda Functions:`)
        cli.info(`    - ${result.functions.http}`)
        cli.info(`    - ${result.functions.message}`)
        cli.info('')

        if (result.httpUrl || result.wsUrl) {
          cli.info('Endpoints:')
          if (result.httpUrl) {
            cli.info(`  HTTP URL: ${result.httpUrl}`)
          }
          if (result.wsUrl) {
            cli.info(`  WebSocket URL: ${result.wsUrl}`)
          }
        }
      }
      catch (error: any) {
        spinner.fail('Deployment failed')
        cli.error(`Error: ${error.message}`)
        if (options.verbose) {
          console.error(error.stack)
        }
        process.exit(1)
      }
    })

  app
    .command('tunnel:destroy', 'Destroy tunnel infrastructure from AWS')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--prefix <prefix>', 'Resource name prefix', { default: 'localtunnel' })
    .option('--verbose', 'Enable verbose logging')
    .action(async (options: { region: string; prefix: string; verbose?: boolean }) => {
      cli.header('Destroy Tunnel Infrastructure')

      cli.info(`Region: ${options.region}`)
      cli.info(`Prefix: ${options.prefix}`)
      cli.info('')

      cli.warn('This will permanently delete:')
      cli.warn('  - All DynamoDB tables and data')
      cli.warn('  - All Lambda functions')
      cli.warn('  - All IAM roles and policies')
      cli.info('')

      const confirmed = await cli.confirm('Are you sure you want to destroy this infrastructure?', false)
      if (!confirmed) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Destroying infrastructure...')
      spinner.start()

      try {
        let destroyTunnelInfrastructure: any

        try {
          const cloudModule = await import('localtunnels/cloud')
          destroyTunnelInfrastructure = cloudModule.destroyTunnelInfrastructure
        }
        catch {
          spinner.fail('localtunnels package not found')
          cli.info('\nTo destroy tunnel infrastructure, install localtunnels:')
          cli.info('  bun add localtunnels')
          cli.info('\nOr destroy using the localtunnels CLI directly:')
          cli.info('  bunx localtunnels destroy --region us-east-1')
          return
        }

        await destroyTunnelInfrastructure({
          region: options.region,
          prefix: options.prefix,
          verbose: options.verbose,
        })

        spinner.succeed('Infrastructure destroyed!')
      }
      catch (error: any) {
        spinner.fail('Destruction failed')
        cli.error(`Error: ${error.message}`)
        if (options.verbose) {
          console.error(error.stack)
        }
        process.exit(1)
      }
    })

  app
    .command('tunnel:logs', 'View tunnel server logs')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--prefix <prefix>', 'Resource name prefix', { default: 'localtunnel' })
    .option('--tail', 'Tail the logs')
    .action(async (options: { region: string; prefix: string; tail?: boolean }) => {
      cli.header('Tunnel Server Logs')

      cli.info('Tunnel server log groups:')
      cli.info(`  - /aws/lambda/${options.prefix}-connect`)
      cli.info(`  - /aws/lambda/${options.prefix}-disconnect`)
      cli.info(`  - /aws/lambda/${options.prefix}-message`)
      cli.info(`  - /aws/lambda/${options.prefix}-http`)
      cli.info('')

      cli.info('To view logs:')
      cli.info(`  aws logs tail /aws/lambda/${options.prefix}-http --region ${options.region}${options.tail ? ' --follow' : ''}`)
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

  app
    .command('tunnel:server', 'Start a self-hosted tunnel server')
    .option('--port <number>', 'Port to listen on', { default: '3000' })
    .option('--host <hostname>', 'Host to bind to', { default: '0.0.0.0' })
    .option('--domain <domain>', 'Domain for tunnel URLs', { default: 'localhost' })
    .option('--verbose', 'Enable verbose logging')
    .action(async (options: { port: string; host: string; domain: string; verbose?: boolean }) => {
      cli.header('Local Tunnel Server')

      const port = Number.parseInt(options.port)

      cli.info(`Listening on: ${options.host}:${port}`)
      cli.info(`Domain: ${options.domain}`)
      cli.info('')

      const spinner = new cli.Spinner('Starting tunnel server...')
      spinner.start()

      try {
        let TunnelServer: any

        try {
          const localtunnels = await import('localtunnels')
          TunnelServer = localtunnels.TunnelServer
        }
        catch {
          spinner.fail('localtunnels package not found')
          cli.info('\nTo run a tunnel server, install localtunnels:')
          cli.info('  bun add localtunnels')
          cli.info('\nOr use the standalone CLI:')
          cli.info('  bunx localtunnels server --port 3000')
          return
        }

        const server = new TunnelServer({
          port,
          host: options.host,
          verbose: options.verbose,
        })

        server.on('connection', (info: { subdomain: string; totalConnections: number }) => {
          cli.info(`+ Client connected: ${info.subdomain} (total: ${info.totalConnections})`)
        })

        server.on('disconnection', (info: { subdomain: string }) => {
          cli.info(`- Client disconnected: ${info.subdomain}`)
        })

        // Handle process signals for graceful shutdown
        const cleanup = () => {
          cli.info('\nShutting down server...')
          server.stop()
          process.exit(0)
        }

        process.on('SIGINT', cleanup)
        process.on('SIGTERM', cleanup)

        await server.start()

        spinner.succeed('Server running!')

        cli.info('')
        cli.info(`WebSocket URL: ws://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`)
        cli.info(`HTTP URL: http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`)
        cli.info('')
        cli.info('Clients can connect with:')
        cli.info(`  cloud tunnel --port 3000 --server ${options.host === '0.0.0.0' ? 'localhost' : options.host}:${port}`)
        cli.info('')
        cli.info('Press Ctrl+C to stop the server')

        // Keep the process running
        await new Promise(() => {})
      }
      catch (error: any) {
        spinner.fail('Failed to start server')
        cli.error(`Error: ${error.message}`)
        process.exit(1)
      }
    })
}
