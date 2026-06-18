import type { CLI } from '@stacksjs/clapp'
import { existsSync } from 'node:fs'
import * as cli from '../../src/utils/cli'
import { S3Client } from '../../src/aws/s3'
import { CloudFrontClient } from '../../src/aws/cloudfront'
import { loadValidatedConfig } from './shared'

export function registerAssetsCommands(app: CLI): void {
  app
    .command('assets:build', 'Run the configured build hooks for an environment')
    .option('--env <environment>', 'Environment (production, staging, development)', { default: 'production' })
    .action(async (options?: { env?: string }) => {
      cli.header('Building Assets')
      try {
        const config = await loadValidatedConfig()
        const env = (options?.env || 'production') as 'production' | 'staging' | 'development'
        const appCfg = (config.environments as any)?.[env]?.app
        const steps: string[] = appCfg?.build ?? []
        if (!steps.length) {
          cli.error(`No build hooks defined for '${env}'. Set environments.${env}.app.build = ['bun run build', …] in cloud.config.`)
          process.exitCode = 1
          return
        }
        const { execSync } = await import('node:child_process')
        for (const step of steps) {
          cli.step(`$ ${step}`)
          execSync(step, { stdio: 'inherit' })
        }
        cli.success('Build hooks complete')
      }
      catch (error: any) {
        cli.error(`Build failed: ${error.message}`)
        process.exitCode = 1
      }
    })

  for (const cmd of ['assets:optimize:images', 'images:optimize'] as const) {
    app
      .command(cmd, 'Optimize images (not implemented)')
      .option('--dir <directory>', 'Directory to optimize')
      .action(async () => {
        cli.error(`'${cmd}' is not implemented — ts-cloud has no built-in image optimizer.`)
        cli.info('Optimize images in your own build step (e.g. sharp/squoosh), then `cloud assets:deploy`.')
        process.exitCode = 1
      })
  }

  app
    .command('assets:deploy', 'Deploy static assets to S3')
    .option('--source <path>', 'Source directory', { default: 'dist' })
    .option('--bucket <name>', 'S3 bucket name')
    .option('--prefix <prefix>', 'S3 prefix/folder')
    .option('--delete', 'Delete files not in source')
    .option('--cache-control <value>', 'Cache-Control header', { default: 'public, max-age=31536000' })
    .action(async (options?: { source?: string, bucket?: string, prefix?: string, delete?: boolean, cacheControl?: string }) => {
      cli.header('Deploying Assets to S3')

      try {
        const config = await loadValidatedConfig()
        const region = config.project.region || 'us-east-1'

        const source = options?.source || 'dist'
        const bucket = options?.bucket
        const prefix = options?.prefix
        const shouldDelete = options?.delete || false
        const cacheControl = options?.cacheControl || 'public, max-age=31536000'

        if (!bucket) {
          cli.error('--bucket is required')
          return
        }

        // Check if source directory exists
        if (!existsSync(source)) {
          cli.error(`Source directory not found: ${source}`)
          return
        }

        cli.info(`Source: ${source}`)
        cli.info(`Bucket: s3://${bucket}${prefix ? `/${prefix}` : ''}`)
        cli.info(`Cache-Control: ${cacheControl}`)
        if (shouldDelete) {
          cli.warn('Delete mode enabled - files not in source will be removed')
        }

        const confirmed = await cli.confirm('\nDeploy assets now?', true)
        if (!confirmed) {
          cli.info('Deployment cancelled')
          return
        }

        const s3 = new S3Client(region)

        const spinner = new cli.Spinner('Uploading assets to S3...')
        spinner.start()

        await s3.sync({
          source,
          bucket,
          prefix,
          delete: shouldDelete,
          cacheControl,
          acl: 'public-read',
        })

        spinner.succeed('Assets deployed successfully!')

        // Get bucket size
        const size = await s3.getBucketSize(bucket, prefix)
        const sizeInMB = (size / 1024 / 1024).toFixed(2)

        cli.success(`\nDeployment complete!`)
        cli.info(`Total size: ${sizeInMB} MB`)
        cli.info(`\nAssets URL: https://${bucket}.s3.${region}.amazonaws.com${prefix ? `/${prefix}` : ''}`)
      }
      catch (error: any) {
        cli.error(`Deployment failed: ${error.message}`)
      }
    })

  app
    .command('assets:invalidate', 'Invalidate CloudFront cache')
    .option('--distribution <id>', 'CloudFront distribution ID')
    .option('--paths <paths>', 'Paths to invalidate (comma-separated)', { default: '/*' })
    .option('--wait', 'Wait for invalidation to complete')
    .action(async (options?: { distribution?: string, paths?: string, wait?: boolean }) => {
      cli.header('Invalidating CloudFront Cache')

      try {
        const distributionId = options?.distribution

        if (!distributionId) {
          cli.error('--distribution is required')
          return
        }

        const pathsStr = options?.paths || '/*'
        const paths = pathsStr.split(',').map(p => p.trim())
        const shouldWait = options?.wait || false

        cli.info(`Distribution: ${distributionId}`)
        cli.info(`Paths: ${paths.join(', ')}`)

        const confirmed = await cli.confirm('\nInvalidate cache now?', true)
        if (!confirmed) {
          cli.info('Invalidation cancelled')
          return
        }

        const cloudfront = new CloudFrontClient()

        const spinner = new cli.Spinner('Creating invalidation...')
        spinner.start()

        const invalidation = await cloudfront.invalidatePaths(distributionId, paths)

        spinner.succeed('Invalidation created')

        cli.success(`\nInvalidation ID: ${invalidation.Id}`)
        cli.info(`Status: ${invalidation.Status}`)
        cli.info(`Created: ${new Date(invalidation.CreateTime).toLocaleString()}`)

        if (shouldWait) {
          const waitSpinner = new cli.Spinner('Waiting for invalidation to complete...')
          waitSpinner.start()

          await cloudfront.waitForInvalidation(distributionId, invalidation.Id)

          waitSpinner.succeed('Invalidation completed!')
        }
        else {
          cli.info('\nInvalidation is in progress. Use --wait to wait for completion.')
        }
      }
      catch (error: any) {
        cli.error(`Invalidation failed: ${error.message}`)
      }
    })
}
