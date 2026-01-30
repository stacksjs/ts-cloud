import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
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

        const result = await cloudfront.listDistributions()
        const distributions = result.DistributionList?.Items || []

        spinner.succeed(`Found ${distributions.length} distribution(s)`)

        if (distributions.length === 0) {
          cli.info('No CloudFront distributions found')
          cli.info('Use `cloud cdn:create` to create a new distribution')
          return
        }

        cli.table(
          ['ID', 'Domain', 'Status', 'Enabled', 'Origins'],
          distributions.map(dist => [
            dist.Id || 'N/A',
            dist.DomainName || 'N/A',
            dist.Status || 'N/A',
            dist.Enabled ? 'Yes' : 'No',
            (dist.Origins?.Items?.length || 0).toString(),
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

        const result = await cloudfront.getDistribution(distributionId)
        const dist = result.Distribution

        spinner.succeed('Distribution details loaded')

        if (!dist) {
          cli.error('Distribution not found')
          return
        }

        cli.info('\nDistribution Information:')
        cli.info(`  ID: ${dist.Id}`)
        cli.info(`  Domain: ${dist.DomainName}`)
        cli.info(`  Status: ${dist.Status}`)
        cli.info(`  ARN: ${dist.ARN}`)
        cli.info(`  Enabled: ${dist.DistributionConfig?.Enabled ? 'Yes' : 'No'}`)

        if (dist.DistributionConfig?.Aliases?.Items?.length) {
          cli.info(`  Aliases: ${dist.DistributionConfig.Aliases.Items.join(', ')}`)
        }

        cli.info('\nOrigins:')
        const origins = dist.DistributionConfig?.Origins?.Items || []
        for (const origin of origins) {
          cli.info(`  - ${origin.Id}: ${origin.DomainName}`)
        }

        if (dist.DistributionConfig?.DefaultCacheBehavior) {
          const behavior = dist.DistributionConfig.DefaultCacheBehavior
          cli.info('\nDefault Cache Behavior:')
          cli.info(`  Target Origin: ${behavior.TargetOriginId}`)
          cli.info(`  Viewer Protocol: ${behavior.ViewerProtocolPolicy}`)
          cli.info(`  Compress: ${behavior.Compress ? 'Yes' : 'No'}`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to get distribution: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('cdn:create', 'Create a new CloudFront distribution')
    .option('--origin <domain>', 'Origin domain (S3 bucket or custom origin)')
    .option('--alias <domain>', 'Custom domain alias (CNAME)')
    .option('--certificate <arn>', 'ACM certificate ARN for custom domain')
    .option('--comment <text>', 'Distribution comment/description')
    .action(async (options: { origin?: string; alias?: string; certificate?: string; comment?: string }) => {
      cli.header('Create CloudFront Distribution')

      try {
        if (!options.origin) {
          cli.error('--origin is required')
          cli.info('Example: cloud cdn:create --origin my-bucket.s3.amazonaws.com')
          process.exit(1)
        }

        const cloudfront = new CloudFrontClient()

        cli.info(`Origin: ${options.origin}`)
        if (options.alias) {
          cli.info(`Alias: ${options.alias}`)
        }

        const confirmed = await cli.confirm('\nCreate this distribution?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating distribution...')
        spinner.start()

        // Determine if this is an S3 origin
        const isS3Origin = options.origin.includes('.s3.') || options.origin.endsWith('.s3.amazonaws.com')

        const distributionConfig: any = {
          CallerReference: `cli-${Date.now()}`,
          Comment: options.comment || `Created by ts-cloud CLI`,
          Enabled: true,
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: 'primary-origin',
                DomainName: options.origin,
                ...(isS3Origin
                  ? {
                      S3OriginConfig: {
                        OriginAccessIdentity: '',
                      },
                    }
                  : {
                      CustomOriginConfig: {
                        HTTPPort: 80,
                        HTTPSPort: 443,
                        OriginProtocolPolicy: 'https-only',
                        OriginSslProtocols: {
                          Quantity: 1,
                          Items: ['TLSv1.2'],
                        },
                      },
                    }),
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: 'primary-origin',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: {
              Quantity: 2,
              Items: ['GET', 'HEAD'],
              CachedMethods: {
                Quantity: 2,
                Items: ['GET', 'HEAD'],
              },
            },
            Compress: true,
            CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // CachingOptimized
            OriginRequestPolicyId: '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf', // CORS-S3Origin
          },
          PriceClass: 'PriceClass_100', // US, Canada, Europe
        }

        if (options.alias && options.certificate) {
          distributionConfig.Aliases = {
            Quantity: 1,
            Items: [options.alias],
          }
          distributionConfig.ViewerCertificate = {
            ACMCertificateArn: options.certificate,
            SSLSupportMethod: 'sni-only',
            MinimumProtocolVersion: 'TLSv1.2_2021',
          }
        }
        else {
          distributionConfig.ViewerCertificate = {
            CloudFrontDefaultCertificate: true,
          }
        }

        const result = await cloudfront.createDistribution({ DistributionConfig: distributionConfig })

        spinner.succeed('Distribution created')

        cli.success(`\nDistribution ID: ${result.Distribution?.Id}`)
        cli.info(`Domain: ${result.Distribution?.DomainName}`)
        cli.info(`Status: ${result.Distribution?.Status}`)
        cli.info('\nNote: Distribution deployment may take 15-30 minutes.')
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
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: `cli-${Date.now()}`,
            Paths: {
              Quantity: paths.length,
              Items: paths,
            },
          },
        })

        spinner.succeed('Invalidation created')

        cli.success(`\nInvalidation ID: ${result.Invalidation?.Id}`)
        cli.info(`Status: ${result.Invalidation?.Status}`)
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

        // Get current config
        const current = await cloudfront.getDistributionConfig(distributionId)
        if (!current.DistributionConfig || !current.ETag) {
          spinner.fail('Could not get distribution config')
          return
        }

        // Update with Enabled = false
        current.DistributionConfig.Enabled = false

        await cloudfront.updateDistribution({
          Id: distributionId,
          DistributionConfig: current.DistributionConfig,
          IfMatch: current.ETag,
        })

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

        // Get current config to check status and get ETag
        const current = await cloudfront.getDistribution(distributionId)
        if (current.Distribution?.Status !== 'Deployed' || current.Distribution?.DistributionConfig?.Enabled) {
          spinner.fail('Distribution must be disabled and deployed before deletion')
          cli.info('\nRun `cloud cdn:disable` first and wait for status to be "Deployed"')
          return
        }

        spinner.text = 'Deleting distribution...'

        await cloudfront.deleteDistribution({
          Id: distributionId,
          IfMatch: current.ETag,
        })

        spinner.succeed('Distribution deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete distribution: ${error.message}`)
        process.exit(1)
      }
    })
}
