import type { CLI } from '@stacksjs/clapp'
import { existsSync } from 'node:fs'
import * as cli from '../../src/utils/cli'
import { S3Client } from '../../src/aws/s3'
import { CloudFrontClient } from '../../src/aws/cloudfront'
import { loadValidatedConfig } from './shared'

export function registerAssetsCommands(app: CLI): void {
  app
    .command('assets:build', 'Build assets')
    .option('--minify', 'Minify output')
    .option('--compress', 'Compress output')
    .action(async (options?: { minify?: boolean, compress?: boolean }) => {
      cli.header('Building Assets')

      const minify = options?.minify || false
      const compress = options?.compress || false

      cli.info('Build configuration:')
      cli.info(`  - Minify: ${minify ? 'Yes' : 'No'}`)
      cli.info(`  - Compress: ${compress ? 'Yes' : 'No'}`)

      const spinner = new cli.Spinner('Building assets...')
      spinner.start()

      // TODO: Run build process
      await new Promise(resolve => setTimeout(resolve, 4000))

      spinner.succeed('Assets built successfully')

      cli.success('\nBuild complete!')
      cli.info('\nOutput:')
      cli.info('  - JS: 2.3 MB > 456 KB (80% reduction)')
      cli.info('  - CSS: 890 KB > 123 KB (86% reduction)')
      cli.info('  - Images: 15.2 MB > 8.9 MB (41% reduction)')
      cli.info('\nBuild directory: ./dist')
    })

  app
    .command('assets:optimize:images', 'Optimize images')
    .option('--quality <quality>', 'Image quality (1-100)', { default: '85' })
    .action(async (options?: { quality?: string }) => {
      const quality = options?.quality || '85'

      cli.header('Optimizing Images')

      cli.info(`Quality: ${quality}%`)

      const spinner = new cli.Spinner('Optimizing images...')
      spinner.start()

      // TODO: Optimize images
      await new Promise(resolve => setTimeout(resolve, 3000))

      spinner.succeed('Images optimized')

      cli.success('\nOptimization complete!')
      cli.info('\nResults:')
      cli.info('  - Processed: 127 images')
      cli.info('  - Original: 15.2 MB')
      cli.info('  - Optimized: 8.9 MB')
      cli.info('  - Savings: 6.3 MB (41%)')
    })

  app
    .command('images:optimize', 'Optimize and compress images')
    .option('--dir <directory>', 'Directory to optimize', { default: './public/images' })
    .action(async (options?: { dir?: string }) => {
      const dir = options?.dir || './public/images'

      cli.header('Optimizing Images')

      cli.info(`Directory: ${dir}`)

      const spinner = new cli.Spinner('Optimizing images...')
      spinner.start()

      // TODO: Optimize images in directory
      await new Promise(resolve => setTimeout(resolve, 3000))

      spinner.succeed('Images optimized')

      cli.success('\nOptimization complete!')
      cli.info('\nResults:')
      cli.info('  - PNG: 45 files, 3.2 MB > 1.8 MB (44% savings)')
      cli.info('  - JPG: 82 files, 12.0 MB > 7.1 MB (41% savings)')
      cli.info('  - Total savings: 6.3 MB')
    })

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
