import type { CLI } from '@stacksjs/clapp'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as cli from '../../src/utils/cli'
import { S3Client } from '../../src/aws/s3'
import { loadValidatedConfig } from './shared'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { DockerNamedVolumeDriver, ServerPathVolumeDriver, VolumeService, VolumeStore, type VolumeInventoryItem } from '../../src/storage'

async function volumeContext(environment?:string){const config=await loadValidatedConfig(),controlPlane=initializeDashboardControlPlane(process.cwd(),config),env=environment??Object.keys(config.environments??{})[0]??'production',environmentRecord=controlPlane.environments.get(env as any);if(!environmentRecord){controlPlane.store.close();throw new Error(`Environment ${env} was not found.`)}const actor=controlPlane.store.getActorByExternalId('system','cli')??controlPlane.store.createActor({kind:'system',externalId:'cli',displayName:'ts-cloud CLI'}),store=new VolumeStore(controlPlane.store),service=new VolumeService(store,[new DockerNamedVolumeDriver(),new ServerPathVolumeDriver(join(process.cwd(),'.ts-cloud','volumes'))]);return{controlPlane,environmentRecord,actor,store,service}}
export function volumeRows(items:VolumeInventoryItem[]):string[][]{return items.map(item=>[item.name,`${item.provider}/${item.type}`,item.status,item.capacityBytes==null?'—':formatBytes(item.capacityBytes),item.usedBytes==null?'—':formatBytes(item.usedBytes),String(item.attachments.filter(value=>value.observedState==='attached').length),item.backupState,item.orphaned?'orphan':'managed'])}

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

        await s3.createBucket(name)

        // Block public access by default
        if (!options.public) {
          spinner.text = 'Configuring public access block...'
          await s3.putPublicAccessBlock(name, {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          })
        }

        // Enable versioning if requested
        if (options.versioning) {
          spinner.text = 'Enabling versioning...'
          await s3.putBucketVersioning(name, 'Enabled')
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

        await s3.deleteBucket(name)

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
            bucket: bucket,
            key: file.key,
            body: Buffer.from(buffer),
            contentType: getContentType(file.key),
          })

          uploaded++
        }

        uploadSpinner.succeed(`Uploaded ${uploaded} file(s)`)

        // Delete remote files not in source if requested
        if (options.delete) {
          const deleteSpinner = new cli.Spinner('Checking for files to delete...')
          deleteSpinner.start()

          const remoteResult = await s3.listObjects({
            bucket,
            prefix: options.prefix,
          })

          const localKeys = new Set(localFiles.map(f => f.key))
          const toDelete = remoteResult.objects
            .filter((obj: any) => obj.Key && !localKeys.has(obj.Key))
            .map((obj: any) => obj.Key!)

          if (toDelete.length > 0) {
            deleteSpinner.text = `Deleting ${toDelete.length} remote file(s)...`

            for (const key of toDelete) {
              await s3.deleteObject(bucket, key)
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

          await s3.deleteBucketPolicy(bucket)

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

          await s3.putBucketPolicy(bucket, policy)

          spinner.succeed('Public read policy set')
          return
        }

        if (options.set) {
          const spinner = new cli.Spinner('Setting policy...')
          spinner.start()

          const policyFile = Bun.file(options.set)
          const policy = await policyFile.text()

          await s3.putBucketPolicy(bucket, policy)

          spinner.succeed('Policy set')
          return
        }

        // Show current policy
        const spinner = new cli.Spinner('Fetching policy...')
        spinner.start()

        try {
          const result = await s3.getBucketPolicy(bucket)
          spinner.succeed('Policy loaded')

          cli.info('\nBucket Policy:')
          console.log(JSON.stringify(result || {}, null, 2))
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

        const result = await s3.listObjects({
          bucket,
          prefix: options.prefix,
          maxKeys: Number.parseInt(options.limit || '100'),
        })

        const objects = result.objects

        spinner.succeed(`Found ${objects.length} object(s)${result.nextContinuationToken ? ' (truncated)' : ''}`)

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

        if (result.nextContinuationToken) {
          cli.info(`\nMore objects available. Use --limit to see more.`)
        }
      }
      catch (error: any) {
        cli.error(`Failed to list objects: ${error.message}`)
        process.exit(1)
      }
    })

  const volumeCommand=(name:string,description:string)=>app.command(name,description).option('--env <environment>','Dashboard environment')
  volumeCommand('volume:list','List persistent volumes, consumers, usage, and protection').option('--json','Print structured JSON').action(async(options:{env?:string,json?:boolean})=>{const value=await volumeContext(options.env);try{const items=value.store.inventory(value.controlPlane.project.id,value.environmentRecord.id);if(options.json)console.log(JSON.stringify(items,null,2));else cli.table(['Name','Driver','Status','Capacity','Used','Consumers','Backup','Ownership'],volumeRows(items))}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:show <name>','Inspect a persistent volume and its dependency graph').option('--json','Print structured JSON').action(async(name:string,options:{env?:string,json?:boolean})=>{const value=await volumeContext(options.env);try{const item=value.store.inventory(value.controlPlane.project.id,value.environmentRecord.id).find(volume=>volume.id===name||volume.name===name);if(!item)throw new Error(`Volume ${name} was not found.`);if(options.json)console.log(JSON.stringify(item,null,2));else{cli.table(['Property','Value'],[['ID',item.id],['Driver',`${item.provider}/${item.type}`],['Provider ID',item.providerId??'—'],['Status',item.status],['Capacity',item.capacityBytes==null?'—':formatBytes(item.capacityBytes)],['Used',item.usedBytes==null?'—':formatBytes(item.usedBytes)],['Backup',item.backupState]]);cli.table(['Resource','Target','Mode','State'],item.attachments.map(mount=>[mount.resourceId,mount.targetPath,mount.readOnly?'read only':'read/write',mount.observedState]))}}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:create <name>','Create a stable named or managed-path volume').option('--driver <driver>','docker or server',{default:'docker'}).option('--capacity-bytes <bytes>','Advisory capacity in bytes').option('--encrypted','Request provider encryption').action(async(name:string,options:{env?:string,driver?:string,capacityBytes?:string,encrypted?:boolean})=>{const value=await volumeContext(options.env);try{const server=options.driver==='server';if(!server&&options.driver!=='docker')throw new Error('--driver must be docker or server.');const result=value.service.create({organizationId:value.controlPlane.organization.id,projectId:value.controlPlane.project.id,environmentId:value.environmentRecord.id,name,provider:server?'server':'docker',type:server?'server_path':'docker',capacityBytes:options.capacityBytes?Number(options.capacityBytes):undefined,encrypted:!!options.encrypted,actorId:value.actor.id});cli.success(`Volume create queued: ${result.operation.id}`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:attach <volume> <resource> <target>','Validate and attach a volume to a workload').option('--read-only','Mount read only').option('--uid <uid>','Filesystem UID').option('--gid <gid>','Filesystem GID').option('--mode <mode>','Octal mode').action(async(volumeName:string,resourceName:string,target:string,options:{env?:string,readOnly?:boolean,uid?:string,gid?:string,mode?:string})=>{const value=await volumeContext(options.env);try{const volume=value.store.list({projectId:value.controlPlane.project.id,environmentId:value.environmentRecord.id}).find(item=>item.id===volumeName||item.name===volumeName),resource=value.controlPlane.store.listResources(value.controlPlane.project.id,value.environmentRecord.id).find(item=>item.id===resourceName||item.slug===resourceName);if(!volume||!resource)throw new Error('Volume or resource was not found in the selected environment.');const result=value.service.attach(volume.id,{resourceId:resource.id,targetPath:target,readOnly:!!options.readOnly,uid:options.uid?Number(options.uid):undefined,gid:options.gid?Number(options.gid):undefined,mode:options.mode,actorId:value.actor.id});cli.success(`Volume attachment queued: ${result.operation.id}`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:detach <volume> <attachment>','Drain, unmount, and detach a volume consumer').option('--force','Force after exact confirmation').option('--confirm <text>','Exact force-detach confirmation').action(async(volumeName:string,attachmentId:string,options:{env?:string,force?:boolean,confirm?:string})=>{const value=await volumeContext(options.env);try{const volume=value.store.list({projectId:value.controlPlane.project.id,environmentId:value.environmentRecord.id}).find(item=>item.id===volumeName||item.name===volumeName);if(!volume)throw new Error('Volume was not found.');const result=value.service.detach(volume.id,attachmentId,{drained:true,unmounted:true,force:!!options.force,confirmation:options.confirm,actorId:value.actor.id});cli.success(`Volume detach queued: ${result.operation.id}`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:resize <volume> <bytes>','Grow a capable persistent volume').option('--drained','Confirm offline workload drain').action(async(volumeName:string,bytes:string,options:{env?:string,drained?:boolean})=>{const value=await volumeContext(options.env);try{const volume=value.store.list({projectId:value.controlPlane.project.id,environmentId:value.environmentRecord.id}).find(item=>item.id===volumeName||item.name===volumeName);if(!volume)throw new Error('Volume was not found.');const result=value.service.resize(volume.id,Number(bytes),{drained:!!options.drained,actorId:value.actor.id});cli.success(`Volume resize queued: ${result.operation.id}`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:snapshot <volume>','Create a provider snapshot when supported').action(async(volumeName:string,options:{env?:string})=>{const value=await volumeContext(options.env);try{const volume=value.store.list({projectId:value.controlPlane.project.id,environmentId:value.environmentRecord.id}).find(item=>item.id===volumeName||item.name===volumeName);if(!volume)throw new Error('Volume was not found.');const result=value.service.snapshot(volume.id,{actorId:value.actor.id});cli.success(`Volume snapshot queued: ${result.operation.id}`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:restore <snapshot> <name>','Restore a snapshot into a replacement volume').action(async(snapshotId:string,name:string,options:{env?:string})=>{const value=await volumeContext(options.env);try{const result=value.service.restore(snapshotId,{name,actorId:value.actor.id});cli.success(`Volume restore queued: ${result.operation.id}`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:discover','Discover provider volumes without adopting or deleting them').action(async(options:{env?:string})=>{const value=await volumeContext(options.env);try{const items=await value.service.discover({organizationId:value.controlPlane.organization.id,projectId:value.controlPlane.project.id,environmentId:value.environmentRecord.id,actorId:value.actor.id});cli.success(`Discovered ${items.filter(item=>item.status==='orphaned').length} orphan volume(s).`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:adopt <volume> <name>','Adopt a discovered orphan under a managed name').action(async(volumeId:string,name:string,options:{env?:string})=>{const value=await volumeContext(options.env);try{value.service.adopt(volumeId,{name,actorId:value.actor.id});cli.success(`Adopted ${name}.`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
  volumeCommand('volume:delete <volume>','Permanently delete a detached volume').option('--confirm <name>','Exact volume name').option('--without-backup','Explicitly override the recent-backup gate').option('--backup-confirm <text>','Exact backup override confirmation').action(async(volumeName:string,options:{env?:string,confirm?:string,withoutBackup?:boolean,backupConfirm?:string})=>{const value=await volumeContext(options.env);try{const volume=value.store.list({projectId:value.controlPlane.project.id,environmentId:value.environmentRecord.id}).find(item=>item.id===volumeName||item.name===volumeName);if(!volume)throw new Error('Volume was not found.');const result=value.service.delete(volume.id,{recentAuthAt:new Date().toISOString(),confirmation:options.confirm,backupOverride:!!options.withoutBackup,backupOverrideConfirmation:options.backupConfirm,actorId:value.actor.id});cli.success(`Volume deletion queued: ${result.operation.id}`)}catch(error){cli.error(error instanceof Error?error.message:String(error))}finally{value.controlPlane.store.close()}})
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
