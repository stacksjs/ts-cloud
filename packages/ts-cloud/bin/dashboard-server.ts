import process from 'node:process'
import { startLocalDashboardServer } from '../src/deploy/local-dashboard-server'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function enabled(name: string): boolean {
  return process.argv.includes(name)
}

async function main(): Promise<void> {
  const server = await startLocalDashboardServer({
    host: option('--host') ?? '127.0.0.1',
    port: Number(option('--port') ?? 7676),
    environment: option('--env') as any,
    box: enabled('--box'),
    verbose: enabled('--verbose'),
  })

  console.log('ts-cloud Local Dashboard')
  console.log(`Serving ${server.url}`)

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.server.stop(true)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

void main()
