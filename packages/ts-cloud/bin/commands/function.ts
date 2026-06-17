import type { CLI } from '@stacksjs/clapp'
import { CloudWatchLogsClient } from '../../src/aws/cloudwatch-logs'
import { LambdaClient } from '../../src/aws/lambda'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

/** Resolve region from config/env without forcing a full serverless app config. */
async function resolveRegion(): Promise<string> {
  try {
    const config = await loadValidatedConfig()
    return config.project.region || process.env.AWS_REGION || 'us-east-1'
  }
  catch {
    return process.env.AWS_REGION || 'us-east-1'
  }
}

export function registerFunctionCommands(app: CLI): void {
  app
    .command('function:list', 'List all Lambda functions')
    .option('--region <region>', 'AWS region')
    .action(async (options?: { region?: string }) => {
      cli.header('Lambda Functions')
      const region = options?.region || (await resolveRegion())
      const lambda = new LambdaClient(region)

      try {
        const { Functions = [] } = await lambda.listFunctions({ MaxItems: 50 })
        if (!Functions.length) {
          cli.info('No functions found')
          return
        }
        cli.table(
          ['Name', 'Runtime', 'Memory', 'Timeout', 'Last Modified'],
          Functions.map(f => [
            f.FunctionName ?? '-',
            f.Runtime ?? '-',
            f.MemorySize ? `${f.MemorySize} MB` : '-',
            f.Timeout ? `${f.Timeout}s` : '-',
            f.LastModified ?? '-',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list functions: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('function:invoke <name>', 'Invoke a Lambda function')
    .option('--payload <json>', 'Event payload as JSON', { default: '{}' })
    .option('--async', 'Fire-and-forget (Event invocation)')
    .option('--region <region>', 'AWS region')
    .action(async (name: string, options?: { payload?: string, async?: boolean, region?: string }) => {
      cli.header(`Invoking ${name}`)
      const region = options?.region || (await resolveRegion())
      const lambda = new LambdaClient(region)

      const spinner = new cli.Spinner('Invoking function...')
      spinner.start()
      try {
        const result = await lambda.invoke({
          FunctionName: name,
          InvocationType: options?.async ? 'Event' : 'RequestResponse',
          Payload: options?.payload || '{}',
          LogType: options?.async ? 'None' : 'Tail',
        })
        if (result.FunctionError) {
          spinner.fail(`Function returned an error (${result.FunctionError})`)
          if (result.Payload) cli.info(result.Payload)
          process.exitCode = 1
          return
        }
        spinner.succeed(`Invoked (status ${result.StatusCode})`)
        if (result.Payload) {
          cli.info('\nResponse:')
          cli.info(result.Payload)
        }
        if (result.LogResult) {
          cli.info('\nLogs:')
          cli.info(Buffer.from(result.LogResult, 'base64').toString('utf-8'))
        }
      }
      catch (error: any) {
        spinner.fail(`Invocation failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  app
    .command('function:logs <name>', 'View recent function logs')
    .option('--tail', 'Continuously stream new log events')
    .option('--filter <pattern>', 'CloudWatch filter pattern')
    .option('--since <minutes>', 'Look back this many minutes', { default: '15' })
    .option('--region <region>', 'AWS region')
    .action(async (name: string, options?: { tail?: boolean, filter?: string, since?: string, region?: string }) => {
      cli.header(`Logs for ${name}`)
      const region = options?.region || (await resolveRegion())
      const logs = new CloudWatchLogsClient(region)
      const logGroupName = name.startsWith('/aws/lambda/') ? name : `/aws/lambda/${name}`
      const sinceMinutes = Number(options?.since ?? 15)

      const printEvents = (events: Array<{ timestamp?: number, message?: string }>): void => {
        for (const e of events) {
          const ts = e.timestamp ? new Date(e.timestamp).toISOString() : ''
          cli.info(`${ts}  ${(e.message ?? '').trimEnd()}`)
        }
      }

      try {
        let startTime = Date.now() - sinceMinutes * 60_000
        const { events = [] } = await logs.filterLogEvents({ logGroupName, startTime, filterPattern: options?.filter, limit: 200 })
        printEvents(events)
        if (events.length) startTime = (events[events.length - 1].timestamp ?? startTime) + 1

        if (options?.tail) {
          cli.info('\n(streaming — Ctrl+C to stop)')
          for (;;) {
            await new Promise(r => setTimeout(r, 3000))
            const { events: more = [] } = await logs.filterLogEvents({ logGroupName, startTime, filterPattern: options?.filter, limit: 200 })
            if (more.length) {
              printEvents(more)
              startTime = (more[more.length - 1].timestamp ?? startTime) + 1
            }
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to read logs: ${error.message}`)
        process.exitCode = 1
      }
    })
}
