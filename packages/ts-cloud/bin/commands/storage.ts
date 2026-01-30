import type { CLI } from '@stacksjs/clapp'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as cli from '../../src/utils/cli'
import { S3Client } from '../../src/aws/s3'
import { loadValidatedConfig } from './shared'

export function registerStorageCommands(app: CLI): void {
  app
    .command('storage:list', 'List all S3 buckets')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('S3 Buckets')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const s3 = new S3Client(region)

        const spinner = new cli.Spinner('Fetching buckets...')
        spinner.start()

        const result = await s3.listBuckets()
        const buckets = result.Buckets || []

        spinner.succeed(`Found ${buckets.length} bucket(s)`)

        if (buckets.length === 0) {
          cli.info('No S3 buckets found')
          cli.info('Use `cloud storage:create` to create a new bucket')
          return
        }

        cli.table(
          ['Name', 'Created'],
          buckets.map(bucket => [
            bucket.Name || 'N/A',
            bucket.CreationDate ? new Date(bucket.CreationDate).toLocaleDateString() : 'N/A',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list buckets: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('storage:create <name>', 'Create a new S3 bucket')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--public', 'Enable public access')
    .option('--versioning', 'Enable versioning')
    .action(async (name: string, options: { region: string; public?: boolean; versioning?: boolean }) => {
      cli.header('Create S3 Bucket')

      try {
        const s3 = new S3Client(options.region)

        cli.info(`Bucket name: ${name}`)
        cli.info(`Region: ${options.region}`)
        cli.info(`Public access: ${options.public ? 'Yes' : 'No'}`)
        cli.info(`Versioning: ${options.versioning ? 'Yes' : 'No'}`)

        const confirmed = await cli.confirm('\nCreate this bucket?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating bucket...')
        spinner.start()

        await s3.createBucket({
          Bucket: name,
          CreateBucketConfiguration: options.region !== 'us-east-1' ? {
            LocationConstraint: options.region,
          } : undefined,
        })

        // Block public access by default
        if (!options.public) {
          spinner.text = 'Configuring public access block...'
          await s3.putPublicAccessBlock({
            Bucket: name,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true,
            },
          })
        }

        // Enable versioning if requested
        if (options.versioning) {
          spinner.text = 'Enabling versioning...'
          await s3.putBucketVersioning({
            Bucket: name,
            VersioningConfiguration: {
              Status: 'Enabled',
            },
          })
        }

        spinner.succeed('Bucket created')

        cli.success(`\nBucket: ${name}`)
        cli.info(`Region: ${options.region}`)
        cli.info(`URL: s3://${name}`)
      }
      catch (error: any) {
        cli.error(`Failed to create bucket: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('storage:delete <name>', 'Delete an S3 bucket')
    .option('--force', 'Delete all objects first')
    .action(async (name: string, options: { force?: boolean }) => {
      cli.header('Delete S3 Bucket')

      try {
        const s3 = new S3Client('us-east-1')

        cli.warn(`This will permanently delete bucket: ${name}`)
        if (options.force) {
          cli.warn('All objects in the bucket will be deleted!')
        }

        const confirmed = await cli.confirm('\nDelete this bucket?', false)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Deleting bucket...')
        spinner.start()

        if (options.force) {
          spinner.text = 'Emptying bucket...'
          await s3.emptyBucket(name)
        }

        await s3.deleteBucket({ Bucket: name })

        spinner.succeed('Bucket deleted')
      }
      catch (error: any) {
        cli.error(`Failed to delete bucket: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('storage:sync <source> <bucket>', 'Sync local directory to S3 bucket')
    .option('--prefix <prefix>', 'S3 key prefix')
    .option('--delete', 'Delete files in S3 that are not in source')
    .option('--dry-run', 'Show what would be synced without making changes')
    .action(async (source: string, bucket: string, options: { prefix?: string; delete?: boolean; dryRun?: boolean }) => {
      cli.header('Sync to S3')

      try {
        const s3 = new S3Client('us-east-1')

        cli.info(`Source: ${source}`)
        cli.info(`Destination: s3://${bucket}/${options.prefix || ''}`)

        if (options.dryRun) {
          cli.info('Dry run mode - no changes will be made')
        }

        const spinner = new cli.Spinner('Scanning files...')
        spinner.start()

        // Get all local files
        const localFiles: { path: string; key: string; size: number }[] = []

        function scanDirectory(dir: string, baseDir: string) {
          const entries = readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = join(dir, entry.name)
            if (entry.isDirectory()) {
              scanDirectory(fullPath, baseDir)
            }
            else {
              const relativePath = relative(baseDir, fullPath)
              const key = options.prefix ? `${options.prefix}/${relativePath}` : relativePath
              const stats = statSync(fullPath)
              localFiles.push({ path: fullPath, key, size: stats.size })
            }
          }
        }

        scanDirectory(source, source)

        spinner.succeed(`Found ${localFiles.length} local file(s)`)

        if (localFiles.length === 0) {
          cli.info('No files to sync')
          return
        }

        // Show preview
        cli.info('\nFiles to sync:')
        for (const file of localFiles.slice(0, 10)) {
          cli.info(`  ${file.key} (${(file.size / 1024).toFixed(2)} KB)`)
        }
        if (localFiles.length > 10) {
          cli.info(`  ... and ${localFiles.length - 10} more`)
        }

        if (options.dryRun) {
          cli.info('\nDry run complete - no changes made')
          return
        }

        const confirmed = await cli.confirm('\nSync these files?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const uploadSpinner = new cli.Spinner('Uploading files...')
        uploadSpinner.start()

        let uploaded = 0
        for (const file of localFiles) {
          uploadSpinner.text = `Uploading ${file.key}... (${uploaded + 1}/${localFiles.length})`

          const fileContent = Bun.file(file.path)
          const buffer = await fileContent.arrayBuffer()

          await s3.putObject({
            Bucket: bucket,
            Key: file.key,
            Body: buffer,
            ContentType: getContentType(file.key),
          })

          uploaded++
        }

        uploadSpinner.succeed(`Uploaded ${uploaded} file(s)`)

        // Delete remote files not in source if requested
        if (options.delete) {
          const deleteSpinner = new cli.Spinner('Checking for files to delete...')
          deleteSpinner.start()

          const remoteObjects = await s3.listObjectsV2({
            Bucket: bucket,
            Prefix: options.prefix,
          })

          const localKeys = new Set(localFiles.map(f => f.key))
          const toDelete = (remoteObjects.Contents || [])
            .filter(obj => obj.Key && !localKeys.has(obj.Key))
            .map(obj => obj.Key!)

          if (toDelete.length > 0) {
            deleteSpinner.text = `Deleting ${toDelete.length} remote file(s)...`

            for (const key of toDelete) {
              await s3.deleteObject({ Bucket: bucket, Key: key })
            }

            deleteSpinner.succeed(`Deleted ${toDelete.length} remote file(s)`)
          }
          else {
            deleteSpinner.succeed('No files to delete')
          }
        }

        cli.success('\nSync complete!')
      }
      catch (error: any) {
        cli.error(`Failed to sync: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('storage:policy <bucket>', 'Show or set bucket policy')
    .option('--set <file>', 'Set policy from JSON file')
    .option('--public-read', 'Set a public read policy')
    .option('--delete', 'Delete the bucket policy')
    .action(async (bucket: string, options: { set?: string; publicRead?: boolean; delete?: boolean }) => {
      cli.header('S3 Bucket Policy')

      try {
        const s3 = new S3Client('us-east-1')

        if (options.delete) {
          cli.warn(`This will delete the policy for bucket: ${bucket}`)

          const confirmed = await cli.confirm('\nDelete bucket policy?', false)
          if (!confirmed) {
            cli.info('Operation cancelled')
            return
          }

          const spinner = new cli.Spinner('Deleting policy...')
          spinner.start()

          await s3.deleteBucketPolicy({ Bucket: bucket })

          spinner.succeed('Policy deleted')
          return
        }

        if (options.publicRead) {
          cli.warn(`This will make bucket ${bucket} publicly readable!`)

          const confirmed = await cli.confirm('\nSet public read policy?', false)
          if (!confirmed) {
            cli.info('Operation cancelled')
            return
          }

          const spinner = new cli.Spinner('Setting policy...')
          spinner.start()

          const policy = {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'PublicReadGetObject',
                Effect: 'Allow',
                Principal: '*',
                Action: 's3:GetObject',
                Resource: `arn:aws:s3:::${bucket}/*`,
              },
            ],
          }

          await s3.putBucketPolicy({
            Bucket: bucket,
            Policy: JSON.stringify(policy),
          })

          spinner.succeed('Public read policy set')
          return
        }

        if (options.set) {
          const spinner = new cli.Spinner('Setting policy...')
          spinner.start()

          const policyFile = Bun.file(options.set)
          const policy = await policyFile.text()

          await s3.putBucketPolicy({
            Bucket: bucket,
            Policy: policy,
          })

          spinner.succeed('Policy set')
          return
        }

        // Show current policy
        const spinner = new cli.Spinner('Fetching policy...')
        spinner.start()

        try {
          const result = await s3.getBucketPolicy({ Bucket: bucket })
          spinner.succeed('Policy loaded')

          cli.info('\nBucket Policy:')
          console.log(JSON.stringify(JSON.parse(result.Policy || '{}'), null, 2))
        }
        catch (err: any) {
          if (err.message?.includes('NoSuchBucketPolicy')) {
            spinner.succeed('No policy set')
            cli.info('This bucket has no policy configured.')
          }
          else {
            throw err
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to manage policy: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('storage:ls <bucket>', 'List objects in a bucket')
    .option('--prefix <prefix>', 'Filter by prefix')
    .option('--limit <number>', 'Limit number of results', { default: '100' })
    .action(async (bucket: string, options: { prefix?: string; limit?: string }) => {
      cli.header(`Objects in ${bucket}`)

      try {
        const s3 = new S3Client('us-east-1')

        const spinner = new cli.Spinner('Listing objects...')
        spinner.start()

        const result = await s3.listObjectsV2({
          Bucket: bucket,
          Prefix: options.prefix,
          MaxKeys: Number.parseInt(options.limit || '100'),
        })

        const objects = result.Contents || []

        spinner.succeed(`Found ${objects.length} object(s)${result.IsTruncated ? ' (truncated)' : ''}`)

        if (objects.length === 0) {
          cli.info('No objects found')
          return
        }

        cli.table(
          ['Key', 'Size', 'Last Modified'],
          objects.map(obj => [
            obj.Key || 'N/A',
            formatBytes(obj.Size || 0),
            obj.LastModified ? new Date(obj.LastModified).toLocaleString() : 'N/A',
          ]),
        )

        if (result.IsTruncated) {
          cli.info(`\nMore objects available. Use --limit to see more.`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to list objects: ${error.message}`)
        process.exit(1)
      }
    })
}

function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
    pdf: 'application/pdf',
    zip: 'application/zip',
    xml: 'application/xml',
    txt: 'text/plain',
    md: 'text/markdown',
  }
  return types[ext || ''] || 'application/octet-stream'
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`
}
