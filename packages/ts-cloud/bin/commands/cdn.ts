import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import type { Distribution } from '../../src/aws/cloudfront'
import { CloudFrontClient } from '../../src/aws/cloudfront'
import { CloudWatchLogsClient } from '../../src/aws/cloudwatch-logs'
import { deployStaticApiOrigin, estimateStaticApiOriginMonthlyCost, verifyStaticApiOrigin } from '../../src/deploy/static-api-origin'
import { loadValidatedConfig } from './shared'

export function registerCdnCommands(app: CLI): void {
  app.command('cdn:api:deploy <distributionId> <alias>', 'Plan or deploy a private Lambda API behind an existing static distribution')
    .option('--function <name>', 'Lambda function name', { default: 'ts-cloud-static-api' })
    .option('--path <pattern>', 'CloudFront API path', { default: '/api/*' })
    .option('--origin-id <id>', 'Stable CloudFront origin ID')
    .option('--role <name>', 'Lambda execution role name')
    .option('--region <region>', 'Lambda region', { default: 'us-east-1' })
    .option('--profile <name>', 'AWS credential profile')
    .option('--memory <mb>', 'Lambda memory in MB', { default: '256' })
    .option('--timeout <seconds>', 'Lambda timeout', { default: '10' })
    .option('--retention <days>', 'CloudWatch log retention', { default: '14' })
    .option('--apply', 'Create resources and patch the live distribution')
    .option('--confirm <text>', 'Exact distribution:path confirmation')
    .action(async (distributionId: string, alias: string, options: { function?: string, path?: string, originId?: string, role?: string, region?: string, profile?: string, memory?: string, timeout?: string, retention?: string, apply?: boolean, confirm?: string }) => {
      try {
        const plan = await deployStaticApiOrigin({
          distributionId,
          expectedAlias: alias,
          functionName: options.function || 'ts-cloud-static-api',
          pathPattern: options.path,
          originId: options.originId,
          roleName: options.role,
          region: options.region,
          profile: options.profile,
          memorySize: Number(options.memory),
          timeout: Number(options.timeout),
          logRetentionDays: Number(options.retention),
          apply: !!options.apply,
          confirm: options.confirm,
        })
        cli.info(JSON.stringify(plan, null, 2))
        if (plan.applied) cli.success('Private API origin submitted to CloudFront. Run cdn:api:verify after propagation.')
        else cli.info(`Plan only. Re-run with --apply --confirm '${distributionId}:${plan.origin.pathPattern}'.`)
      }
      catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })

  app.command('cdn:api:verify <alias>', 'Verify static frontend integrity, API health, latency, and Lambda initialization')
    .option('--function <name>', 'Lambda function name', { default: 'ts-cloud-static-api' })
    .option('--frontend-sha256 <digest>', 'Expected SHA-256 of the frontend response')
    .option('--region <region>', 'Lambda region', { default: 'us-east-1' })
    .option('--profile <name>', 'AWS credential profile')
    .action(async (alias: string, options: { function?: string, frontendSha256?: string, region?: string, profile?: string }) => {
      try {
        const logs = new CloudWatchLogsClient(options.region || 'us-east-1', options.profile)
        const result = await verifyStaticApiOrigin({ alias, expectedFrontendSha256: options.frontendSha256, logs, functionName: options.function || 'ts-cloud-static-api' })
        cli.info(JSON.stringify(result, null, 2))
        if (!result.api.healthy || result.frontend.unchanged === false) throw new Error('Static API verification failed')
        cli.success('Static frontend and Lambda API verification passed.')
      }
      catch (error) {
        cli.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      }
    })

  app.command('cdn:api:cost <requests>', 'Compare a low-volume Lambda API with one always-on Fargate task and ALB')
    .option('--duration <milliseconds>', 'Average Lambda duration', { default: '100' })
    .option('--memory <mb>', 'Lambda memory in MB', { default: '256' })
    .option('--no-free-tier', 'Exclude the Lambda free tier')
    .action((requests: string, options: { duration?: string, memory?: string, freeTier?: boolean }) => {
      const estimate = estimateStaticApiOriginMonthlyCost({ requests: Number(requests), averageDurationMs: Number(options.duration), memoryMb: Number(options.memory), includeFreeTier: options.freeTier !== false })
      cli.info(JSON.stringify(estimate, null, 2))
    })

  app.command('cdn:origin:add <distributionId> <domain>', 'Safely add a backend origin and path to an existing distribution').option('--id <origin>','Stable origin ID',{default:'api-backend'}).option('--path <pattern>','Path behavior',{default:'/api/*'}).option('--profile <name>','AWS credential profile').option('--replace','Replace a reviewed path/origin collision').option('--apply','Apply the ETag-protected patch').option('--confirm <text>','Exact distribution:path confirmation').action(async(distributionId:string,domain:string,options:{id?:string,path?:string,profile?:string,replace?:boolean,apply?:boolean,confirm?:string})=>{try{const cloudfront=new CloudFrontClient(options.profile);const request={id:options.id??'api-backend',domainName:domain,pathPattern:options.path??'/api/*',replaceExisting:!!options.replace};const preview=await cloudfront.upsertExistingDistributionOrigin(distributionId,{...request,dryRun:true});cli.info(JSON.stringify(preview,null,2));if(!options.apply){cli.info('Dry run only. Re-run with --apply and the exact --confirm token.');return}const token=`${distributionId}:${preview.pathPattern}`;if(options.confirm!==token)throw new Error(`Pass --confirm "${token}" to apply this live distribution change`);const result=await cloudfront.upsertExistingDistributionOrigin(distributionId,request);cli.success(result.changed?'Backend origin patch submitted.':'Backend origin already matches.');cli.info(JSON.stringify(result,null,2))}catch(error){cli.error(error instanceof Error?error.message:String(error));process.exitCode=1}})
  app.command('cdn:origin:remove <distributionId> <domain>', 'Remove one exact backend behavior and its unreferenced origin').option('--id <origin>','Origin ID',{default:'api-backend'}).option('--path <pattern>','Path behavior',{default:'/api/*'}).option('--profile <name>','AWS credential profile').option('--apply','Apply the ETag-protected rollback').option('--confirm <text>','Exact remove:distribution:path confirmation').action(async(distributionId:string,domain:string,options:{id?:string,path?:string,profile?:string,apply?:boolean,confirm?:string})=>{try{const cloudfront=new CloudFrontClient(options.profile);const request={id:options.id??'api-backend',domainName:domain,pathPattern:options.path??'/api/*'};const preview=await cloudfront.removeExistingDistributionOrigin(distributionId,{...request,dryRun:true});cli.info(JSON.stringify(preview,null,2));if(!options.apply){cli.info('Dry run only. Re-run with --apply and the exact --confirm token.');return}const token=`remove:${distributionId}:${preview.pathPattern}`;if(options.confirm!==token)throw new Error(`Pass --confirm "${token}" to apply this live distribution rollback`);const result=await cloudfront.removeExistingDistributionOrigin(distributionId,request);cli.success(result.changed?'Backend behavior rollback submitted.':'Backend behavior was already absent.');cli.info(JSON.stringify(result,null,2))}catch(error){cli.error(error instanceof Error?error.message:String(error));process.exitCode=1}})
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
