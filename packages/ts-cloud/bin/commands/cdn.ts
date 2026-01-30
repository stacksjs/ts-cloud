import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import type { Distribution } from '../../src/aws/cloudfront'
import { CloudFrontClient } from '../../src/aws/cloudfront'
import { loadValidatedConfig } from './shared'

export function registerCdnCommands(app: CLI): void {
  app
    .command('cdn:list', 'List all CloudFront distributions')
    .action(async () => {
      cli.header('CloudFront Distributions')

      try {
        const config = await loadValidatedConfig()
        const cloudfront = new CloudFrontClient()

        const spinner = new cli.Spinner('Fetching distributions...')
        spinner.start()

        const distributions = await cloudfront.listDistributions()

        spinner.succeed(`Found ${distributions.length} distribution(s)`)

        if (distributions.length === 0) {
          cli.info('No CloudFront distributions found')
          cli.info('Use `cloud cdn:create` to create a new distribution')
          return
        }

        cli.table(
          ['ID', 'Domain', 'Status', 'Enabled', 'Aliases'],
          distributions.map((dist: Distribution) => [
            dist.Id || 'N/A',
            dist.DomainName || 'N/A',
            dist.Status || 'N/A',
            dist.Enabled ? 'Yes' : 'No',
            (dist.Aliases?.Items?.length || 0).toString(),
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list distributions: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cdn:status <distributionId>', 'Get CloudFront distribution status')
    .action(async (distributionId: string) => {
      cli.header(`CloudFront Distribution: ${distributionId}`)

      try {
        const cloudfront = new CloudFrontClient()

        const spinner = new cli.Spinner('Fetching distribution details...')
        spinner.start()

        const dist = await cloudfront.getDistribution(distributionId)

        spinner.succeed('Distribution details loaded')

        cli.info('\nDistribution Information:')
        cli.info(`  ID: ${dist.Id}`)
        cli.info(`  Domain: ${dist.DomainName}`)
        cli.info(`  Status: ${dist.Status}`)
        cli.info(`  ARN: ${dist.ARN}`)
        cli.info(`  Enabled: ${dist.Enabled ? 'Yes' : 'No'}`)

        if (dist.Aliases?.Items?.length) {
          cli.info(`  Aliases: ${dist.Aliases.Items.join(', ')}`)
        }

        // Fetch full config for origin and cache behavior details
        const config = await cloudfront.getDistributionConfig(distributionId)

        cli.info('\nOrigins:')
        const origins = config.DistributionConfig?.Origins?.Items || []
        if (Array.isArray(origins)) {
          for (const origin of origins) {
            cli.info(`  - ${origin.Id}: ${origin.DomainName}`)
          }
        }

        if (config.DistributionConfig?.DefaultCacheBehavior) {
          const behavior = config.DistributionConfig.DefaultCacheBehavior
          cli.info('\nDefault Cache Behavior:')
          cli.info(`  Target Origin: ${behavior.TargetOriginId}`)
          cli.info(`  Viewer Protocol: ${behavior.ViewerProtocolPolicy}`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to get distribution: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cdn:create', 'Create a new CloudFront distribution for an S3 bucket')
    .option('--bucket <name>', 'S3 bucket name')
    .option('--region <region>', 'S3 bucket region', { default: 'us-east-1' })
    .option('--alias <domain>', 'Custom domain alias (CNAME)')
    .option('--certificate <arn>', 'ACM certificate ARN for custom domain')
    .option('--comment <text>', 'Distribution comment/description')
    .action(async (options: { bucket?: string; region: string; alias?: string; certificate?: string; comment?: string }) => {
      cli.header('Create CloudFront Distribution')

      try {
        if (!options.bucket) {
          cli.error('--bucket is required')
          cli.info('Example: cloud cdn:create --bucket my-bucket --region us-east-1')
          process.exit(1)
        }

        const cloudfront = new CloudFrontClient()

        cli.info(`Bucket: ${options.bucket}`)
        cli.info(`Region: ${options.region}`)
        if (options.alias) {
          cli.info(`Alias: ${options.alias}`)
        }

        const confirmed = await cli.confirm('\nCreate this distribution?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Setting up Origin Access Control...')
        spinner.start()

        // Find or create an OAC for S3
        const oac = await cloudfront.findOrCreateOriginAccessControl(`OAC-${options.bucket}`)
        if (oac.isNew) {
          spinner.text = 'Created new Origin Access Control'
        }

        spinner.text = 'Creating distribution...'

        const aliases = options.alias ? [options.alias] : []

        const result = await cloudfront.createDistributionForS3({
          bucketName: options.bucket,
          bucketRegion: options.region,
          originAccessControlId: oac.Id,
          aliases,
          certificateArn: options.certificate,
          comment: options.comment || `Created by ts-cloud CLI`,
        })

        spinner.succeed('Distribution created')

        cli.success(`\nDistribution ID: ${result.Id}`)
        cli.info(`Domain: ${result.DomainName}`)
        cli.info(`Status: ${result.Status}`)
        cli.info('\nNote: Distribution deployment may take 15-30 minutes.')

        // Show the S3 bucket policy that needs to be applied
        cli.info('\nIMPORTANT: Update your S3 bucket policy to allow CloudFront access:')
        const policy = CloudFrontClient.getS3BucketPolicyForCloudFront(options.bucket, result.ARN)
        cli.info(JSON.stringify(policy, null, 2))
      }
      catch (error: any) {
        cli.error(`Failed to create distribution: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cdn:invalidate <distributionId>', 'Invalidate CloudFront cache')
    .option('--paths <paths>', 'Paths to invalidate (comma-separated)', { default: '/*' })
    .action(async (distributionId: string, options: { paths: string }) => {
      cli.header('Invalidate CloudFront Cache')

      try {
        const cloudfront = new CloudFrontClient()

        const paths = options.paths.split(',').map(p => p.trim())

        cli.info(`Distribution: ${distributionId}`)
        cli.info(`Paths: ${paths.join(', ')}`)

        const confirmed = await cli.confirm('\nCreate invalidation?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating invalidation...')
        spinner.start()

        const result = await cloudfront.createInvalidation({
          distributionId,
          paths,
          callerReference: `cli-${Date.now()}`,
        })

        spinner.succeed('Invalidation created')

        cli.success(`\nInvalidation ID: ${result.Id}`)
        cli.info(`Status: ${result.Status}`)
        cli.info('\nNote: Invalidation typically completes in 5-10 minutes.')
      }
      catch (error: any) {
        cli.error(`Failed to create invalidation: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cdn:disable <distributionId>', 'Disable a CloudFront distribution')
    .action(async (distributionId: string) => {
      cli.header('Disable CloudFront Distribution')

      try {
        const cloudfront = new CloudFrontClient()

        cli.warn(`This will disable distribution: ${distributionId}`)
        cli.info('The distribution will stop serving content.')

        const confirmed = await cli.confirm('\nDisable this distribution?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Disabling distribution...')
        spinner.start()

        await cloudfront.disableDistribution(distributionId)

        spinner.succeed('Distribution disabled')

        cli.info('\nNote: Changes may take 15-30 minutes to propagate.')
        cli.info('To delete the distribution, wait for it to be fully disabled first.')
      }
      catch (error: any) {
        cli.error(`Failed to disable distribution: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cdn:delete <distributionId>', 'Delete a CloudFront distribution')
    .action(async (distributionId: string) => {
      cli.header('Delete CloudFront Distribution')

      try {
        const cloudfront = new CloudFrontClient()

        cli.warn(`This will permanently delete distribution: ${distributionId}`)
        cli.warn('The distribution must be disabled first.')

        const confirmed = await cli.confirm('\nDelete this distribution?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Checking distribution status...')
        spinner.start()

        // Get distribution to check status
        const dist = await cloudfront.getDistribution(distributionId)
        if (dist.Status !== 'Deployed' || dist.Enabled) {
          spinner.fail('Distribution must be disabled and deployed before deletion')
          cli.info('\nRun `cloud cdn:disable` first and wait for status to be "Deployed"')
          return
        }

        spinner.text = 'Deleting distribution...'

        await cloudfront.deleteDistribution(distributionId)

        spinner.succeed('Distribution deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete distribution: ${error.message}`)
        process.exit(1)
      }
    })
}
