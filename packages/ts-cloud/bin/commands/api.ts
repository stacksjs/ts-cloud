import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

export function registerApiCommands(app: CLI): void {
  app
    .command('api:list', 'List all API Gateway APIs')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('API Gateway APIs')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        // Use Lambda client which has API Gateway methods
        const { LambdaClient } = await import('../../src/aws/lambda')
        const lambda = new LambdaClient(region)

        const spinner = new cli.Spinner('Fetching APIs...')
        spinner.start()

        // Show a simplified view using CloudFormation
        const { CloudFormationClient } = await import('../../src/aws/cloudformation')
        const cfn = new CloudFormationClient(region)

        const stacks = await cfn.listStacks(['CREATE_COMPLETE', 'UPDATE_COMPLETE'])
        const apiStacks = stacks.StackSummaries.filter(s =>
          s.StackName?.includes('api') || s.StackName?.includes('Api') || s.StackName?.includes('API'),
        )

        spinner.succeed('APIs listed')

        cli.info('\nAPI-related CloudFormation stacks:')
        if (apiStacks.length === 0) {
          cli.info('No API Gateway stacks found')
          cli.info('\nTo create an API, you can:')
          cli.info('  1. Use cloud.config.ts to define your API')
          cli.info('  2. Deploy with `cloud deploy`')
        }
        else {
          cli.table(
            ['Stack Name', 'Status', 'Created'],
            apiStacks.map(stack => [
              stack.StackName || 'N/A',
              stack.StackStatus || 'N/A',
              stack.CreationTime ? new Date(stack.CreationTime).toLocaleDateString() : 'N/A',
            ]),
          )
        }

        cli.info('\nTip: Use AWS Console or `aws apigateway get-rest-apis` for detailed API listing')
      }
      catch (error: any) {
        cli.error(`Failed to list APIs: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:describe <apiId>', 'Show API Gateway API details')
    .option('--region <region>', 'AWS region')
    .action(async (apiId: string, options: { region?: string }) => {
      cli.header(`API: ${apiId}`)

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        cli.info(`API ID: ${apiId}`)
        cli.info(`Region: ${region}`)
        cli.info('')
        cli.info('For detailed API information, use AWS CLI:')
        cli.info(`  aws apigateway get-rest-api --rest-api-id ${apiId} --region ${region}`)
        cli.info(`  aws apigateway get-resources --rest-api-id ${apiId} --region ${region}`)
        cli.info(`  aws apigateway get-stages --rest-api-id ${apiId} --region ${region}`)
      }
      catch (error: any) {
        cli.error(`Failed to describe API: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:stages <apiId>', 'List API stages')
    .option('--region <region>', 'AWS region')
    .action(async (apiId: string, options: { region?: string }) => {
      cli.header(`API Stages: ${apiId}`)

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        cli.info(`API ID: ${apiId}`)
        cli.info(`Region: ${region}`)
        cli.info('')
        cli.info('Common stages:')
        cli.info('  - prod (production)')
        cli.info('  - staging')
        cli.info('  - dev (development)')
        cli.info('')
        cli.info('For detailed stage information, use AWS CLI:')
        cli.info(`  aws apigateway get-stages --rest-api-id ${apiId} --region ${region}`)
      }
      catch (error: any) {
        cli.error(`Failed to list stages: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:deploy <apiId>', 'Deploy API to a stage')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--stage <name>', 'Stage name', { default: 'prod' })
    .option('--description <text>', 'Deployment description')
    .action(async (apiId: string, options: { region: string; stage: string; description?: string }) => {
      cli.header('Deploy API')

      try {
        cli.info(`API ID: ${apiId}`)
        cli.info(`Stage: ${options.stage}`)

        const confirmed = await cli.confirm('\nDeploy to this stage?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        cli.info('')
        cli.info('To deploy an API Gateway API:')
        cli.info(`  aws apigateway create-deployment \\`)
        cli.info(`    --rest-api-id ${apiId} \\`)
        cli.info(`    --stage-name ${options.stage} \\`)
        cli.info(`    --region ${options.region}`)

        if (options.description) {
          cli.info(`    --description "${options.description}"`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to deploy API: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:domains', 'List custom domain names')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('API Gateway Custom Domains')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        cli.info(`Region: ${region}`)
        cli.info('')
        cli.info('To list custom domains, use AWS CLI:')
        cli.info(`  aws apigateway get-domain-names --region ${region}`)
        cli.info('')
        cli.info('To create a custom domain:')
        cli.info('  1. Request or import an SSL certificate in ACM')
        cli.info('  2. Create a custom domain in API Gateway')
        cli.info('  3. Create a base path mapping to your API')
        cli.info('  4. Add a DNS record pointing to the distribution')
      }
      catch (error: any) {
        cli.error(`Failed to list domains: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:usage <apiId>', 'Show API usage statistics')
    .option('--region <region>', 'AWS region')
    .option('--stage <name>', 'Stage name', { default: 'prod' })
    .option('--days <number>', 'Number of days to show', { default: '7' })
    .action(async (apiId: string, options: { region?: string; stage: string; days: string }) => {
      cli.header('API Usage Statistics')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        cli.info(`API ID: ${apiId}`)
        cli.info(`Stage: ${options.stage}`)
        cli.info(`Period: Last ${options.days} days`)
        cli.info('')

        // Calculate date range
        const endDate = new Date()
        const startDate = new Date()
        startDate.setDate(startDate.getDate() - Number.parseInt(options.days))

        cli.info('To view API metrics in CloudWatch:')
        cli.info(`  aws cloudwatch get-metric-statistics \\`)
        cli.info(`    --namespace AWS/ApiGateway \\`)
        cli.info(`    --metric-name Count \\`)
        cli.info(`    --dimensions Name=ApiName,Value=${apiId} Name=Stage,Value=${options.stage} \\`)
        cli.info(`    --start-time ${startDate.toISOString()} \\`)
        cli.info(`    --end-time ${endDate.toISOString()} \\`)
        cli.info(`    --period 86400 \\`)
        cli.info(`    --statistics Sum \\`)
        cli.info(`    --region ${region}`)

        cli.info('')
        cli.info('Available metrics:')
        cli.info('  - Count: Total API calls')
        cli.info('  - Latency: Response latency')
        cli.info('  - 4XXError: Client errors')
        cli.info('  - 5XXError: Server errors')
        cli.info('  - IntegrationLatency: Backend latency')
      }
      catch (error: any) {
        cli.error(`Failed to get usage: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:export <apiId>', 'Export API specification')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--stage <name>', 'Stage name', { default: 'prod' })
    .option('--format <format>', 'Export format (oas30, swagger)', { default: 'oas30' })
    .option('--output <file>', 'Output file path')
    .action(async (apiId: string, options: { region: string; stage: string; format: string; output?: string }) => {
      cli.header('Export API Specification')

      try {
        cli.info(`API ID: ${apiId}`)
        cli.info(`Stage: ${options.stage}`)
        cli.info(`Format: ${options.format === 'oas30' ? 'OpenAPI 3.0' : 'Swagger 2.0'}`)
        cli.info('')

        const exportType = options.format === 'oas30' ? 'oas30' : 'swagger'

        cli.info('To export the API specification:')
        cli.info(`  aws apigateway get-export \\`)
        cli.info(`    --rest-api-id ${apiId} \\`)
        cli.info(`    --stage-name ${options.stage} \\`)
        cli.info(`    --export-type ${exportType} \\`)
        cli.info(`    --accepts application/json \\`)
        cli.info(`    --region ${options.region} \\`)
        cli.info(`    ${options.output || 'api-spec.json'}`)
      }
      catch (error: any) {
        cli.error(`Failed to export API: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:logs <apiId>', 'View API Gateway logs')
    .option('--region <region>', 'AWS region')
    .option('--stage <name>', 'Stage name', { default: 'prod' })
    .option('--tail', 'Tail the logs')
    .action(async (apiId: string, options: { region?: string; stage: string; tail?: boolean }) => {
      cli.header('API Gateway Logs')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        const logGroupName = `API-Gateway-Execution-Logs_${apiId}/${options.stage}`

        cli.info(`Log Group: ${logGroupName}`)
        cli.info('')
        cli.info('To view logs:')
        cli.info(`  aws logs filter-log-events \\`)
        cli.info(`    --log-group-name "${logGroupName}" \\`)
        cli.info(`    --region ${region}`)

        if (options.tail) {
          cli.info('')
          cli.info('For real-time log tailing, use:')
          cli.info(`  aws logs tail "${logGroupName}" --follow --region ${region}`)
        }

        cli.info('')
        cli.info('Note: Ensure logging is enabled for the API stage.')
        cli.info('You can enable it in the stage settings.')
      }
      catch (error: any) {
        cli.error(`Failed to get logs: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('api:test <apiId> <path>', 'Test an API endpoint')
    .option('--region <region>', 'AWS region')
    .option('--stage <name>', 'Stage name', { default: 'prod' })
    .option('--method <method>', 'HTTP method', { default: 'GET' })
    .option('--body <json>', 'Request body (JSON)')
    .option('--header <header>', 'Request header (can be specified multiple times)')
    .action(async (apiId: string, path: string, options: {
      region?: string
      stage: string
      method: string
      body?: string
      header?: string | string[]
    }) => {
      cli.header('Test API Endpoint')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'

        // Build the API URL
        const apiUrl = `https://${apiId}.execute-api.${region}.amazonaws.com/${options.stage}${path.startsWith('/') ? path : `/${path}`}`

        cli.info(`URL: ${apiUrl}`)
        cli.info(`Method: ${options.method}`)

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }

        if (options.header) {
          const headerList = Array.isArray(options.header) ? options.header : [options.header]
          for (const h of headerList) {
            const [key, ...valueParts] = h.split(':')
            headers[key.trim()] = valueParts.join(':').trim()
          }
        }

        cli.info('Headers:')
        for (const [key, value] of Object.entries(headers)) {
          cli.info(`  ${key}: ${value}`)
        }

        if (options.body) {
          cli.info(`Body: ${options.body}`)
        }

        const confirmed = await cli.confirm('\nSend request?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Sending request...')
        spinner.start()

        const startTime = Date.now()

        const response = await fetch(apiUrl, {
          method: options.method,
          headers,
          body: options.body,
        })

        const elapsed = Date.now() - startTime
        const responseBody = await response.text()

        spinner.succeed(`Response received (${elapsed}ms)`)

        cli.info(`\nStatus: ${response.status} ${response.statusText}`)

        cli.info('\nResponse Headers:')
        response.headers.forEach((value, key) => {
          cli.info(`  ${key}: ${value}`)
        })

        cli.info('\nResponse Body:')
        try {
          const json = JSON.parse(responseBody)
          console.log(JSON.stringify(json, null, 2))
        }
        catch {
          console.log(responseBody)
        }
      }
      catch (error: any) {
        cli.error(`Failed to test API: ${error.message}`)
        process.exit(1)
      }
    })
}
