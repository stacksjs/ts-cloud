import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { DynamoDBClient } from '../../src/aws/dynamodb'

export function registerAnalyticsCommands(app: CLI): void {
  app
    .command('analytics:sites:list', 'List all analytics sites')
    .option('--table <name>', 'DynamoDB table name', { default: 'ts-analytics' })
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (options: { table: string; region: string }) => {
      cli.header('Analytics Sites')

      try {
        const dynamodb = new DynamoDBClient(options.region)

        const spinner = new cli.Spinner('Fetching sites...')
        spinner.start()

        const result = await dynamodb.scan({
          TableName: options.table,
          FilterExpression: 'begins_with(pk, :pk)',
          ExpressionAttributeValues: {
            ':pk': { S: 'SITE#' },
          },
        })

        spinner.succeed(`Found ${result.Items?.length || 0} site(s)`)

        if (!result.Items || result.Items.length === 0) {
          cli.info('No analytics sites found')
          cli.info('Use `cloud analytics:sites:create` to create a new site')
          return
        }

        const sites = result.Items.map(item => DynamoDBClient.unmarshal(item))

        cli.table(
          ['ID', 'Name', 'Domains', 'Active', 'Created'],
          sites.map(site => [
            site.siteId || 'N/A',
            site.name || 'Unnamed',
            (site.domains || []).join(', ') || '-',
            site.isActive ? 'Yes' : 'No',
            site.createdAt ? new Date(site.createdAt).toLocaleDateString() : 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list sites: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('analytics:sites:create', 'Create a new analytics site')
    .option('--table <name>', 'DynamoDB table name', { default: 'ts-analytics' })
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--name <name>', 'Site name')
    .option('--domain <domain>', 'Site domain(s) (can be specified multiple times)')
    .action(async (options: { table: string; region: string; name?: string; domain?: string | string[] }) => {
      cli.header('Create Analytics Site')

      try {
        const dynamodb = new DynamoDBClient(options.region)

        // Get site name
        const name = options.name || await cli.prompt('Site name', 'My Site')

        // Get domains
        let domains: string[] = []
        if (options.domain) {
          domains = Array.isArray(options.domain) ? options.domain : [options.domain]
        }
        else {
          const domainInput = await cli.prompt('Site domains (comma-separated)', 'example.com')
          domains = domainInput.split(',').map(d => d.trim()).filter(Boolean)
        }

        cli.info(`\nCreating site: ${name}`)
        cli.info(`Domains: ${domains.join(', ')}`)

        const confirm = await cli.confirm('\nCreate this site?', true)
        if (!confirm) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating site...')
        spinner.start()

        // Generate site ID
        const siteId = `site_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

        const now = new Date().toISOString()

        await dynamodb.putItem({
          TableName: options.table,
          Item: {
            pk: { S: `SITE#${siteId}` },
            sk: { S: `SITE#${siteId}` },
            siteId: { S: siteId },
            name: { S: name },
            domains: { L: domains.map(d => ({ S: d })) },
            isActive: { BOOL: true },
            createdAt: { S: now },
            updatedAt: { S: now },
          },
        })

        spinner.succeed('Site created successfully')

        cli.success(`\nSite ID: ${siteId}`)
        cli.info('\nAdd the tracking script to your website:')
        cli.info(`  <script src="https://analytics.stacksjs.com/track.js" data-site-id="${siteId}"></script>`)
      }
      catch (error: any) {
        cli.error(`Failed to create site: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('analytics:sites:update <siteId>', 'Update an analytics site')
    .option('--table <name>', 'DynamoDB table name', { default: 'ts-analytics' })
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--name <name>', 'New site name')
    .option('--domain <domain>', 'Set domains (replaces existing)')
    .option('--active <boolean>', 'Set site active/inactive status')
    .action(async (siteId: string, options: { table: string; region: string; name?: string; domain?: string | string[]; active?: string }) => {
      cli.header('Update Analytics Site')

      try {
        const dynamodb = new DynamoDBClient(options.region)

        // First, verify the site exists
        const result = await dynamodb.getItem({
          TableName: options.table,
          Key: {
            pk: { S: `SITE#${siteId}` },
            sk: { S: `SITE#${siteId}` },
          },
        })

        if (!result.Item) {
          cli.error(`Site not found: ${siteId}`)
          process.exit(1)
        }

        const site = DynamoDBClient.unmarshal(result.Item)
        cli.info(`Updating site: ${site.name || 'Unnamed'} (${siteId})`)
        cli.info('')

        // Build update expression
        const updates: string[] = []
        const expressionNames: Record<string, string> = {}
        const expressionValues: Record<string, any> = {}

        if (options.name) {
          updates.push('#n = :name')
          expressionNames['#n'] = 'name'
          expressionValues[':name'] = { S: options.name }
          cli.info(`  Name: ${site.name} -> ${options.name}`)
        }

        if (options.domain !== undefined) {
          const domains = Array.isArray(options.domain) ? options.domain : [options.domain]
          updates.push('domains = :domains')
          expressionValues[':domains'] = { L: domains.map(d => ({ S: d })) }
          cli.info(`  Domains: ${JSON.stringify(site.domains || [])} -> ${JSON.stringify(domains)}`)
        }

        if (options.active !== undefined) {
          const isActive = options.active === 'true' || options.active === '1'
          updates.push('isActive = :active')
          expressionValues[':active'] = { BOOL: isActive }
          cli.info(`  Active: ${site.isActive} -> ${isActive}`)
        }

        if (updates.length === 0) {
          cli.warn('No updates specified. Use --name, --domain, or --active options.')
          return
        }

        // Always update updatedAt
        updates.push('updatedAt = :updatedAt')
        expressionValues[':updatedAt'] = { S: new Date().toISOString() }

        await dynamodb.updateItem({
          TableName: options.table,
          Key: {
            pk: { S: `SITE#${siteId}` },
            sk: { S: `SITE#${siteId}` },
          },
          UpdateExpression: `SET ${updates.join(', ')}`,
          ExpressionAttributeNames: Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
          ExpressionAttributeValues: expressionValues,
        })

        cli.info('')
        cli.success('Site updated successfully')
      }
      catch (error: any) {
        cli.error(`Failed to update site: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('analytics:query <siteId>', 'Query analytics data for a site')
    .option('--table <name>', 'DynamoDB table name', { default: 'ts-analytics' })
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--limit <n>', 'Max items to return', { default: '10' })
    .option('--type <type>', 'Filter by type (pageview, event, etc.)')
    .action(async (siteId: string, options: { table: string; region: string; limit: string; type?: string }) => {
      cli.header(`Analytics Data: ${siteId}`)

      try {
        const dynamodb = new DynamoDBClient(options.region)

        const spinner = new cli.Spinner('Querying data...')
        spinner.start()

        const result = await dynamodb.query({
          TableName: options.table,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': { S: `SITE#${siteId}` },
          },
          ScanIndexForward: false,
          Limit: parseInt(options.limit, 10),
        })

        spinner.succeed(`Found ${result.Items?.length || 0} items`)

        if (!result.Items || result.Items.length === 0) {
          cli.info('No data found for this site')
          return
        }

        const items = result.Items.map(item => DynamoDBClient.unmarshal(item))

        for (const item of items) {
          cli.info('')
          cli.info(`SK: ${item.sk}`)
          if (item.path) cli.info(`  Path: ${item.path}`)
          if (item.timestamp) cli.info(`  Time: ${item.timestamp}`)
          if (item.visitorId) cli.info(`  Visitor: ${item.visitorId}`)
          if (item.browser) cli.info(`  Browser: ${item.browser}`)
          if (item.country) cli.info(`  Country: ${item.country}`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to query data: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('analytics:realtime <siteId>', 'Check realtime visitors for a site')
    .option('--table <name>', 'DynamoDB table name', { default: 'ts-analytics' })
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--minutes <n>', 'Minutes to look back', { default: '5' })
    .action(async (siteId: string, options: { table: string; region: string; minutes: string }) => {
      cli.header(`Realtime: ${siteId}`)

      try {
        const dynamodb = new DynamoDBClient(options.region)

        const spinner = new cli.Spinner('Checking realtime...')
        spinner.start()

        const minutesAgo = parseInt(options.minutes, 10)
        const cutoff = new Date(Date.now() - minutesAgo * 60 * 1000)

        const result = await dynamodb.query({
          TableName: options.table,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': { S: `SITE#${siteId}` },
            ':start': { S: `PAGEVIEW#${cutoff.toISOString()}` },
            ':end': { S: 'PAGEVIEW#Z' },
          },
          ScanIndexForward: false,
        })

        spinner.succeed(`Found ${result.Items?.length || 0} pageviews in last ${minutesAgo} minutes`)

        if (!result.Items || result.Items.length === 0) {
          cli.warn('No recent pageviews found')
          cli.info('')
          cli.info('Possible issues:')
          cli.info('  1. Tracking script not installed correctly')
          cli.info('  2. Site ID mismatch')
          cli.info('  3. CORS or network issues')
          return
        }

        const items = result.Items.map(item => DynamoDBClient.unmarshal(item))
        const uniqueVisitors = new Set(items.map(i => i.visitorId)).size

        cli.info('')
        cli.success(`${uniqueVisitors} unique visitor(s) online`)
        cli.info('')

        // Group by path
        const byPath: Record<string, number> = {}
        for (const item of items) {
          const path = item.path || '/'
          byPath[path] = (byPath[path] || 0) + 1
        }

        cli.info('Active pages:')
        for (const [path, count] of Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
          cli.info(`  ${path}: ${count} view(s)`)
        }

        cli.info('')
        cli.info('Recent pageviews:')
        for (const item of items.slice(0, 5)) {
          cli.info(`  ${item.timestamp} - ${item.path} (${item.browser || 'Unknown'})`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to check realtime: ${error.message}`)
        process.exit(1)
      }
    })
}
