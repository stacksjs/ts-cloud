import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { loadValidatedConfig } from './shared'

// CloudTrail client will be created inline since it may not exist
async function getCloudTrailClient(region: string) {
  const { AWSClient } = await import('../../src/aws/client')

  class CloudTrailClient {
    private client: InstanceType<typeof AWSClient>
    private region: string

    constructor(region: string) {
      this.region = region
      this.client = new AWSClient()
    }

    private async jsonRpcRequest(action: string, params: Record<string, any>): Promise<any> {
      return this.client.request({
        service: 'cloudtrail',
        region: this.region,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': `com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.${action}`,
        },
        body: JSON.stringify(params),
      })
    }

    async describeTrails() {
      return this.jsonRpcRequest('DescribeTrails', {})
    }

    async getTrailStatus(name: string) {
      return this.jsonRpcRequest('GetTrailStatus', { Name: name })
    }

    async lookupEvents(params: {
      LookupAttributes?: Array<{ AttributeKey: string; AttributeValue: string }>
      StartTime?: Date
      EndTime?: Date
      MaxResults?: number
    }) {
      return this.jsonRpcRequest('LookupEvents', {
        ...params,
        StartTime: params.StartTime?.toISOString(),
        EndTime: params.EndTime?.toISOString(),
      })
    }

    async getEventSelectors(trailName: string) {
      return this.jsonRpcRequest('GetEventSelectors', { TrailName: trailName })
    }

    async createTrail(params: {
      Name: string
      S3BucketName: string
      S3KeyPrefix?: string
      IncludeGlobalServiceEvents?: boolean
      IsMultiRegionTrail?: boolean
      EnableLogFileValidation?: boolean
    }) {
      return this.jsonRpcRequest('CreateTrail', params)
    }

    async startLogging(name: string) {
      return this.jsonRpcRequest('StartLogging', { Name: name })
    }

    async stopLogging(name: string) {
      return this.jsonRpcRequest('StopLogging', { Name: name })
    }

    async deleteTrail(name: string) {
      return this.jsonRpcRequest('DeleteTrail', { Name: name })
    }
  }

  return new CloudTrailClient(region)
}

export function registerAuditCommands(app: CLI): void {
  app
    .command('audit:trails', 'List CloudTrail trails')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('CloudTrail Trails')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const cloudtrail = await getCloudTrailClient(region)

        const spinner = new cli.Spinner('Fetching trails...')
        spinner.start()

        const result = await cloudtrail.describeTrails()
        const trails = result.trailList || []

        spinner.succeed(`Found ${trails.length} trail(s)`)

        if (trails.length === 0) {
          cli.info('No CloudTrail trails found')
          cli.info('Use `cloud audit:create` to create a new trail')
          return
        }

        cli.table(
          ['Name', 'Multi-Region', 'S3 Bucket', 'Log Validation', 'Home Region'],
          trails.map((trail: any) => [
            trail.Name || 'N/A',
            trail.IsMultiRegionTrail ? 'Yes' : 'No',
            trail.S3BucketName || 'N/A',
            trail.LogFileValidationEnabled ? 'Yes' : 'No',
            trail.HomeRegion || 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list trails: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('audit:trail <trailName>', 'Show CloudTrail trail details')
    .option('--region <region>', 'AWS region')
    .action(async (trailName: string, options: { region?: string }) => {
      cli.header(`CloudTrail: ${trailName}`)

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const cloudtrail = await getCloudTrailClient(region)

        const spinner = new cli.Spinner('Fetching trail details...')
        spinner.start()

        const [trailsResult, statusResult] = await Promise.all([
          cloudtrail.describeTrails(),
          cloudtrail.getTrailStatus(trailName),
        ])

        const trail = (trailsResult.trailList || []).find((t: any) => t.Name === trailName)

        if (!trail) {
          spinner.fail('Trail not found')
          return
        }

        spinner.succeed('Trail details loaded')

        cli.info('\nTrail Configuration:')
        cli.info(`  Name: ${trail.Name}`)
        cli.info(`  ARN: ${trail.TrailARN}`)
        cli.info(`  Home Region: ${trail.HomeRegion}`)
        cli.info(`  Multi-Region: ${trail.IsMultiRegionTrail ? 'Yes' : 'No'}`)
        cli.info(`  Organization Trail: ${trail.IsOrganizationTrail ? 'Yes' : 'No'}`)

        cli.info('\nStorage:')
        cli.info(`  S3 Bucket: ${trail.S3BucketName}`)
        if (trail.S3KeyPrefix) {
          cli.info(`  S3 Prefix: ${trail.S3KeyPrefix}`)
        }
        cli.info(`  Log Validation: ${trail.LogFileValidationEnabled ? 'Enabled' : 'Disabled'}`)

        if (trail.CloudWatchLogsLogGroupArn) {
          cli.info('\nCloudWatch Logs:')
          cli.info(`  Log Group: ${trail.CloudWatchLogsLogGroupArn}`)
        }

        if (trail.KMSKeyId) {
          cli.info('\nEncryption:')
          cli.info(`  KMS Key: ${trail.KMSKeyId}`)
        }

        cli.info('\nStatus:')
        cli.info(`  Logging: ${statusResult.IsLogging ? 'Active' : 'Stopped'}`)

        if (statusResult.LatestDeliveryTime) {
          cli.info(`  Latest Delivery: ${new Date(statusResult.LatestDeliveryTime).toLocaleString()}`)
        }

        if (statusResult.LatestDeliveryError) {
          cli.warn(`  Latest Error: ${statusResult.LatestDeliveryError}`)
        }

        // Get event selectors
        try {
          const selectors = await cloudtrail.getEventSelectors(trailName)

          if (selectors.EventSelectors && selectors.EventSelectors.length > 0) {
            cli.info('\nEvent Selectors:')
            for (const selector of selectors.EventSelectors) {
              cli.info(`  - Read/Write: ${selector.ReadWriteType}`)
              cli.info(`    Management Events: ${selector.IncludeManagementEvents ? 'Yes' : 'No'}`)
              if (selector.DataResources && selector.DataResources.length > 0) {
                cli.info(`    Data Resources: ${selector.DataResources.length} configured`)
              }
            }
          }
        }
        catch {
          // Event selectors might not be available for all trails
        }
      }
      catch (error: any) {
        cli.error(`Failed to get trail: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('audit:events', 'Look up recent CloudTrail events')
    .option('--region <region>', 'AWS region')
    .option('--user <username>', 'Filter by IAM user')
    .option('--event <eventName>', 'Filter by event name')
    .option('--resource <resourceName>', 'Filter by resource name')
    .option('--hours <number>', 'Hours to look back', { default: '24' })
    .option('--limit <number>', 'Maximum events to return', { default: '50' })
    .action(async (options: {
      region?: string
      user?: string
      event?: string
      resource?: string
      hours: string
      limit: string
    }) => {
      cli.header('CloudTrail Events')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const cloudtrail = await getCloudTrailClient(region)

        const spinner = new cli.Spinner('Looking up events...')
        spinner.start()

        const endTime = new Date()
        const startTime = new Date(endTime.getTime() - Number.parseInt(options.hours) * 60 * 60 * 1000)

        const lookupParams: any = {
          StartTime: startTime,
          EndTime: endTime,
          MaxResults: Number.parseInt(options.limit),
        }

        if (options.user) {
          lookupParams.LookupAttributes = [{
            AttributeKey: 'Username',
            AttributeValue: options.user,
          }]
        }
        else if (options.event) {
          lookupParams.LookupAttributes = [{
            AttributeKey: 'EventName',
            AttributeValue: options.event,
          }]
        }
        else if (options.resource) {
          lookupParams.LookupAttributes = [{
            AttributeKey: 'ResourceName',
            AttributeValue: options.resource,
          }]
        }

        const result = await cloudtrail.lookupEvents(lookupParams)
        const events = result.Events || []

        spinner.succeed(`Found ${events.length} event(s)`)

        if (events.length === 0) {
          cli.info('No events found matching criteria')
          return
        }

        cli.table(
          ['Time', 'Event', 'User', 'Source IP', 'Resources'],
          events.map((event: any) => [
            event.EventTime ? new Date(event.EventTime).toLocaleString() : 'N/A',
            event.EventName || 'N/A',
            event.Username || 'N/A',
            event.SourceIPAddress || 'N/A',
            (event.Resources || []).map((r: any) => r.ResourceName).join(', ').substring(0, 30) || '-',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to lookup events: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('audit:event <eventId>', 'Show CloudTrail event details')
    .option('--region <region>', 'AWS region')
    .action(async (eventId: string, options: { region?: string }) => {
      cli.header(`Event: ${eventId}`)

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const cloudtrail = await getCloudTrailClient(region)

        const spinner = new cli.Spinner('Fetching event...')
        spinner.start()

        // Look up event by ID
        const result = await cloudtrail.lookupEvents({
          LookupAttributes: [{
            AttributeKey: 'EventId',
            AttributeValue: eventId,
          }],
          MaxResults: 1,
        })

        const event = result.Events?.[0]

        if (!event) {
          spinner.fail('Event not found')
          return
        }

        spinner.succeed('Event loaded')

        cli.info('\nEvent Information:')
        cli.info(`  Event ID: ${event.EventId}`)
        cli.info(`  Event Name: ${event.EventName}`)
        cli.info(`  Event Time: ${event.EventTime ? new Date(event.EventTime).toLocaleString() : 'N/A'}`)
        cli.info(`  Event Source: ${event.EventSource}`)
        cli.info(`  Username: ${event.Username}`)
        cli.info(`  Source IP: ${event.SourceIPAddress}`)
        cli.info(`  Access Key: ${event.AccessKeyId || 'N/A'}`)

        if (event.Resources && event.Resources.length > 0) {
          cli.info('\nResources:')
          for (const resource of event.Resources) {
            cli.info(`  - ${resource.ResourceType}: ${resource.ResourceName}`)
          }
        }

        if (event.CloudTrailEvent) {
          cli.info('\nFull Event Record:')
          const fullEvent = JSON.parse(event.CloudTrailEvent)
          console.log(JSON.stringify(fullEvent, null, 2))
        }
      }
      catch (error: any) {
        cli.error(`Failed to get event: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('audit:create <trailName>', 'Create a new CloudTrail trail')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--bucket <name>', 'S3 bucket for logs')
    .option('--prefix <prefix>', 'S3 key prefix')
    .option('--multi-region', 'Enable multi-region trail')
    .option('--validation', 'Enable log file validation')
    .option('--global-events', 'Include global service events')
    .action(async (trailName: string, options: {
      region: string
      bucket?: string
      prefix?: string
      multiRegion?: boolean
      validation?: boolean
      globalEvents?: boolean
    }) => {
      cli.header('Create CloudTrail Trail')

      try {
        if (!options.bucket) {
          cli.error('--bucket is required')
          return
        }

        const cloudtrail = await getCloudTrailClient(options.region)

        cli.info(`Trail Name: ${trailName}`)
        cli.info(`S3 Bucket: ${options.bucket}`)
        cli.info(`Multi-Region: ${options.multiRegion ? 'Yes' : 'No'}`)
        cli.info(`Log Validation: ${options.validation ? 'Yes' : 'No'}`)
        cli.info(`Global Events: ${options.globalEvents ? 'Yes' : 'No'}`)

        const confirmed = await cli.confirm('\nCreate this trail?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating trail...')
        spinner.start()

        const result = await cloudtrail.createTrail({
          Name: trailName,
          S3BucketName: options.bucket,
          S3KeyPrefix: options.prefix,
          IsMultiRegionTrail: options.multiRegion,
          EnableLogFileValidation: options.validation,
          IncludeGlobalServiceEvents: options.globalEvents ?? true,
        })

        spinner.text = 'Starting logging...'
        await cloudtrail.startLogging(trailName)

        spinner.succeed('Trail created and logging started')

        cli.success(`\nTrail ARN: ${result.TrailARN}`)
        cli.info(`S3 Bucket: ${result.S3BucketName}`)
      }
      catch (error: any) {
        cli.error(`Failed to create trail: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('audit:start <trailName>', 'Start CloudTrail logging')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (trailName: string, options: { region: string }) => {
      cli.header('Start CloudTrail Logging')

      try {
        const cloudtrail = await getCloudTrailClient(options.region)

        const spinner = new cli.Spinner('Starting logging...')
        spinner.start()

        await cloudtrail.startLogging(trailName)

        spinner.succeed('Logging started')
      }
      catch (error: any) {
        cli.error(`Failed to start logging: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('audit:stop <trailName>', 'Stop CloudTrail logging')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (trailName: string, options: { region: string }) => {
      cli.header('Stop CloudTrail Logging')

      try {
        const cloudtrail = await getCloudTrailClient(options.region)

        cli.warn(`This will stop logging for trail: ${trailName}`)

        const confirmed = await cli.confirm('\nStop logging?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Stopping logging...')
        spinner.start()

        await cloudtrail.stopLogging(trailName)

        spinner.succeed('Logging stopped')
      }
      catch (error: any) {
        cli.error(`Failed to stop logging: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('audit:delete <trailName>', 'Delete a CloudTrail trail')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .action(async (trailName: string, options: { region: string }) => {
      cli.header('Delete CloudTrail Trail')

      try {
        const cloudtrail = await getCloudTrailClient(options.region)

        cli.warn(`This will permanently delete trail: ${trailName}`)

        const confirmed = await cli.confirm('\nDelete this trail?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Deleting trail...')
        spinner.start()

        await cloudtrail.deleteTrail(trailName)

        spinner.succeed('Trail deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete trail: ${error.message}`)
        process.exit(1)
      }
    })
}
