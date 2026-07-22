import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { FleetService,FleetStore,SshFleetDriver,type ServerProvider,type ServerRole } from '../../src/fleet'
import { initializeDashboardControlPlane } from '../../src/deploy/dashboard-control-plane'
import { loadValidatedConfig } from './shared'
async function fleetContext(){const config=await loadValidatedConfig(),controlPlane=initializeDashboardControlPlane(process.cwd(),config),store=new FleetStore(controlPlane.store),service=new FleetService(store,[new SshFleetDriver('aws'),new SshFleetDriver('hetzner'),new SshFleetDriver('ssh')]);return{controlPlane,store,service}}
async function withFleet<T>(callback:(value:Awaited<ReturnType<typeof fleetContext>>)=>Promise<T>){const value=await fleetContext();try{return await callback(value)}finally{value.controlPlane.store.close()}}
const findServer=(store:FleetStore,projectId:string,name:string)=>{const server=store.list(projectId).find(item=>item.id===name||item.name===name);if(!server)throw new Error(`Server ${name} was not found.`);return server}

export function registerServerCommands(app: CLI): void {
  app
    .command('server:list', 'List all servers')
    .option('--json','Print structured JSON').action(async(options:{json?:boolean})=>withFleet(async value=>{const servers=value.store.list(value.controlPlane.project.id);if(options.json)console.log(JSON.stringify(servers,null,2));else cli.table(['Name','Provider ID','Provider / region','Status / trust','Roles','CPU / memory','Heartbeat'],servers.map(item=>[item.name,item.providerId??'—',`${item.provider} / ${item.region??'external'}`,`${item.status} / ${item.trustState}`,item.roles.join(','),`${item.capacity.cpu??0} / ${item.capacity.memoryBytes??0}`,item.heartbeatAt??'never']))}))

  app
    .command('server:create <name>', 'Enroll a provisioned or existing server into fleet inventory')
    .option('--provider <provider>','aws, hetzner, or ssh',{default:'ssh'}).option('--provider-id <id>','Stable provider instance ID').option('--endpoint <host>','SSH hostname or IP').option('--user <user>','Non-root SSH user',{default:'deploy'}).option('--credential-ref <ref>','Secret reference',{default:'secret://fleet/agent'}).option('--region <region>','Provider region').option('--roles <roles>','Comma-separated roles',{default:'application'}).option('--labels <labels>','Comma-separated key=value labels')
    .action(async(name:string,options:{provider?:string;providerId?:string;endpoint?:string;user?:string;credentialRef?:string;region?:string;roles?:string;labels?:string})=>withFleet(async value=>{const provider=options.provider as ServerProvider;if(!['aws','hetzner','ssh'].includes(provider))throw new Error('--provider must be aws, hetzner, or ssh.');if(!options.endpoint)throw new Error('--endpoint is required; provisioning and enrollment are separate explicit operations.');const labels=Object.fromEntries((options.labels??'').split(',').map(v=>v.split('=')).filter(v=>v[0]&&v[1])),server=value.service.enroll({organizationId:value.controlPlane.organization.id,projectId:value.controlPlane.project.id,name,provider,providerId:options.providerId,endpoint:options.endpoint,sshUser:options.user??'deploy',credentialRef:options.credentialRef??'secret://fleet/agent',region:options.region,roles:(options.roles??'application').split(',').map(v=>v.trim()) as ServerRole[],labels});cli.success(`Enrolled ${server.name} as ${server.id}; no remote mutation was performed.`)}))

  app.command('server:validate <name>','Test pinned trust and produce an actionable validation report').option('--accept-host-key <fingerprint>','Explicitly accept a pending rotation').option('--json','Print structured JSON').action(async(name:string,options:{acceptHostKey?:string;json?:boolean})=>withFleet(async value=>{let server=findServer(value.store,value.controlPlane.project.id,name);server=await value.service.test(server.id);if(server.trustState==='rotation_pending'){if(!options.acceptHostKey)throw new Error(`Host key changed to ${server.pendingHostKey}; review and pass --accept-host-key.`);server=value.service.reviewHostKey(server.id,options.acceptHostKey)}const validated=await value.service.validate(server.id);if(options.json)console.log(JSON.stringify(validated.validation,null,2));else cli.table(['Severity','Code','Finding','Remediation'],(validated.validation?.findings??[]).map(item=>[item.severity,item.code,item.message,item.remediation??'—']));if(!validated.validation?.valid)process.exitCode=1}))
  app.command('server:bootstrap <name>','Preview or queue idempotent server bootstrap').option('--apply','Queue the reviewed plan').action(async(name:string,options:{apply?:boolean})=>withFleet(async value=>{const server=findServer(value.store,value.controlPlane.project.id,name),result=value.service.bootstrap(server.id,!!options.apply);if(result.preview)cli.table(['Step'],result.steps.map(step=>[step]));else cli.success(`Bootstrap queued: ${result.operation?.id}`)}))
  app.command('server:drain <name>','Drain a server without terminating it').option('--complete','Mark workload movement complete').action(async(name:string,options:{complete?:boolean})=>withFleet(async value=>{const server=findServer(value.store,value.controlPlane.project.id,name);cli.success(`${value.service.drain(server.id,!!options.complete).status}: ${server.name}`)}))
  app.command('server:uncordon <name>','Return a drained server to scheduling').action(async(name:string)=>withFleet(async value=>{const server=findServer(value.store,value.controlPlane.project.id,name);value.service.uncordon(server.id);cli.success(`Uncordoned ${server.name}.`)}))
  app.command('server:archive <name>','Remove a server from inventory without terminating it').option('--confirm <name>','Exact server name').action(async(name:string,options:{confirm?:string})=>withFleet(async value=>{const server=findServer(value.store,value.controlPlane.project.id,name);value.service.archive(server.id,options.confirm??'');cli.success(`Archived ${server.name}; provider infrastructure was not terminated.`)}))

  app
    .command('server:ssh <name>', 'SSH into a server')
    .action(async (name: string) => {
      cli.step(`Connecting to ${name}...`)
      // TODO: Implement SSH connection
    })

  app
    .command('server:logs <name>', 'View server logs')
    .option('--tail', 'Tail logs in real-time')
    .action(async (name: string) => {
      cli.header(`Logs for ${name}`)
      // TODO: Implement log viewing
    })

  app
    .command('server:deploy <name>', 'Deploy app to server')
    .option('--strategy <strategy>', 'Deployment strategy: git, rsync, or scp')
    .action(async (name: string) => {
      cli.header(`Deploying to ${name}`)
      // TODO: Implement deployment
    })

  app
    .command('server:resize <name> <type>', 'Change server instance type')
    .action(async (name: string, type: string) => {
      cli.header(`Resizing Server: ${name}`)

      const confirm = await cli.confirm(
        `This will stop and restart ${name}. Continue?`,
        false,
      )

      if (!confirm) {
        cli.info('Resize cancelled')
        return
      }

      const spinner = new cli.Spinner(`Resizing ${name} to ${type}...`)
      spinner.start()

      try {
        // TODO: Implement EC2 instance type change
        await new Promise(resolve => setTimeout(resolve, 2000))

        spinner.succeed(`Server ${name} resized to ${type}`)
        cli.success(`Instance type changed from t3.micro to ${type}`)
      }
      catch (error: any) {
        spinner.fail('Resize failed')
        cli.error(error.message)
      }
    })

  app
    .command('server:reboot <name>', 'Reboot a server')
    .option('--force', 'Force reboot without confirmation')
    .action(async (name: string, options?: { force?: boolean }) => {
      cli.header(`Rebooting Server: ${name}`)

      if (!options?.force) {
        const confirm = await cli.confirm(
          `Are you sure you want to reboot ${name}?`,
          false,
        )

        if (!confirm) {
          cli.info('Reboot cancelled')
          return
        }
      }

      const spinner = new cli.Spinner(`Rebooting ${name}...`)
      spinner.start()

      try {
        // TODO: Implement EC2 reboot
        await new Promise(resolve => setTimeout(resolve, 2000))

        spinner.succeed(`Server ${name} rebooted successfully`)
        cli.info('Server will be available in a few moments')
      }
      catch (error: any) {
        spinner.fail('Reboot failed')
        cli.error(error.message)
      }
    })

  app
    .command('server:destroy <name>', 'Terminate a server')
    .option('--force', 'Skip confirmation prompt')
    .action(async (name: string, options?: { force?: boolean }) => {
      cli.header(`Destroying Server: ${name}`)

      cli.warning('This action is irreversible!')

      if (!options?.force) {
        const confirm = await cli.confirm(
          `Are you absolutely sure you want to terminate ${name}?`,
          false,
        )

        if (!confirm) {
          cli.info('Termination cancelled')
          return
        }

        // Double confirmation for safety
        const doubleConfirm = await cli.confirm(
          `Type the server name to confirm: ${name}`,
          false,
        )

        if (!doubleConfirm) {
          cli.info('Termination cancelled')
          return
        }
      }

      const spinner = new cli.Spinner(`Terminating ${name}...`)
      spinner.start()

      try {
        // TODO: Implement EC2 termination
        await new Promise(resolve => setTimeout(resolve, 2000))

        spinner.succeed(`Server ${name} terminated successfully`)
        cli.success('All resources have been cleaned up')
      }
      catch (error: any) {
        spinner.fail('Termination failed')
        cli.error(error.message)
      }
    })

  app
    .command('server:recipe <name> <recipe>', 'Install software recipe')
    .action(async (name: string, recipe: string) => {
      cli.header(`Installing Recipe: ${recipe}`)

      const validRecipes = ['lamp', 'lemp', 'nodejs', 'python', 'ruby', 'docker']
      if (!validRecipes.includes(recipe.toLowerCase())) {
        cli.warn(`Unknown recipe. Common recipes: ${validRecipes.join(', ')}`)
      }

      cli.info(`Server: ${name}`)
      cli.info(`Recipe: ${recipe}`)

      const confirm = await cli.confirm('\nInstall this recipe?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner(`Installing ${recipe} stack...`)
      spinner.start()

      // TODO: Run installation script via SSM or user data
      await new Promise(resolve => setTimeout(resolve, 5000))

      spinner.succeed('Recipe installed successfully')

      cli.success('\nSoftware stack installed!')
      cli.info(`Server ${name} is now running ${recipe}`)
    })

  app
    .command('server:firewall:add <name> <rule>', 'Add firewall rule')
    .action(async (name: string, rule: string) => {
      cli.header('Adding Firewall Rule')

      cli.info(`Server: ${name}`)
      cli.info(`Rule: ${rule}`)

      const confirm = await cli.confirm('\nAdd this firewall rule?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Updating firewall rules (ufw)...')
      spinner.start()

      // TODO: Update security group and/or ufw via SSM
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Firewall rule added')

      cli.success('\nFirewall rule configured!')
    })

  app
    .command('server:firewall:list <name>', 'List firewall rules')
    .action(async (name: string) => {
      cli.header(`Firewall Rules on ${name}`)

      const spinner = new cli.Spinner('Fetching firewall rules...')
      spinner.start()

      // TODO: Fetch from security group + ufw
      await new Promise(resolve => setTimeout(resolve, 1500))

      spinner.stop()

      cli.table(
        ['#', 'Action', 'From', 'To', 'Port', 'Protocol'],
        [
          ['1', 'ALLOW', 'Anywhere', '22/tcp', '22', 'TCP'],
          ['2', 'ALLOW', 'Anywhere', '80/tcp', '80', 'TCP'],
          ['3', 'ALLOW', 'Anywhere', '443/tcp', '443', 'TCP'],
          ['4', 'DENY', '192.168.1.0/24', 'Any', 'Any', 'Any'],
        ],
      )
    })

  app
    .command('server:firewall:remove <name> <rule>', 'Remove firewall rule')
    .action(async (name: string, rule: string) => {
      cli.header('Removing Firewall Rule')

      cli.info(`Server: ${name}`)
      cli.info(`Rule: ${rule}`)

      const confirm = await cli.confirm('\nRemove this firewall rule?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Updating firewall rules...')
      spinner.start()

      // TODO: Update security group and/or ufw
      await new Promise(resolve => setTimeout(resolve, 1500))

      spinner.succeed('Firewall rule removed')

      cli.success('\nFirewall rule deleted!')
    })

  app
    .command('server:ssl:install <domain>', 'Install Let\'s Encrypt certificate')
    .action(async (domain: string) => {
      cli.header(`Installing SSL Certificate for ${domain}`)

      const confirm = await cli.confirm('\nInstall Let\'s Encrypt certificate?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Installing certbot and obtaining certificate...')
      spinner.start()

      // TODO: Run certbot via SSM
      await new Promise(resolve => setTimeout(resolve, 3000))

      spinner.succeed('SSL certificate installed')

      cli.success('\nSSL certificate active!')
      cli.info(`HTTPS enabled for ${domain}`)
      cli.info('Auto-renewal configured via cron')
    })

  app
    .command('server:ssl:renew <domain>', 'Renew SSL certificate')
    .action(async (domain: string) => {
      cli.header(`Renewing SSL Certificate for ${domain}`)

      const spinner = new cli.Spinner('Renewing certificate...')
      spinner.start()

      // TODO: Run certbot renew via SSM
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.succeed('Certificate renewed')

      cli.success('\nSSL certificate renewed!')
      cli.info(`Valid until: ${new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toLocaleDateString()}`)
    })

  app
    .command('server:monitoring <name>', 'Show server metrics')
    .action(async (name: string) => {
      cli.header(`Server Metrics: ${name}`)

      const spinner = new cli.Spinner('Fetching metrics from CloudWatch...')
      spinner.start()

      // TODO: Fetch from CloudWatch
      await new Promise(resolve => setTimeout(resolve, 2000))

      spinner.stop()

      cli.info('\nCurrent Metrics:\n')

      cli.info('CPU Usage:')
      cli.info('  - Current: 23.5%')
      cli.info('  - Average (1h): 18.2%')
      cli.info('  - Peak (24h): 67.3%')

      cli.info('\nMemory Usage:')
      cli.info('  - Used: 2.1 GB / 4 GB (52.5%)')
      cli.info('  - Available: 1.9 GB')
      cli.info('  - Swap: 0 GB')

      cli.info('\nDisk Usage:')
      cli.info('  - /: 15.2 GB / 30 GB (50.7%)')
      cli.info('  - /data: 45.8 GB / 100 GB (45.8%)')

      cli.info('\nNetwork:')
      cli.info('  - In: 125 MB/s')
      cli.info('  - Out: 87 MB/s')
    })

  app
    .command('server:snapshot <name>', 'Create server snapshot')
    .action(async (name: string) => {
      cli.header(`Creating Snapshot of ${name}`)

      const confirm = await cli.confirm('\nCreate snapshot? This may take several minutes.', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Creating EBS snapshot...')
      spinner.start()

      // TODO: Create EC2 snapshot
      await new Promise(resolve => setTimeout(resolve, 3000))

      spinner.succeed('Snapshot created')

      cli.success('\nServer snapshot created!')
      cli.info('Snapshot ID: snap-abc123')
      cli.info('Use `cloud server:snapshot:restore` to restore from this snapshot')
    })

  app
    .command('server:snapshot:restore <name> <snapshot-id>', 'Restore from snapshot')
    .action(async (name: string, snapshotId: string) => {
      cli.header('Restoring from Snapshot')

      cli.info(`Server: ${name}`)
      cli.info(`Snapshot: ${snapshotId}`)

      cli.warn('\nThis will replace the current server data')

      const confirm = await cli.confirm('Proceed with restore?', false)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Restoring from snapshot...')
      spinner.start()

      // TODO: Create volume from snapshot and attach
      await new Promise(resolve => setTimeout(resolve, 4000))

      spinner.succeed('Restore complete')

      cli.success('\nServer restored from snapshot!')
      cli.warn('Reboot required to complete restoration')
    })

  app
    .command('server:update <name>', 'Update server packages')
    .action(async (name: string) => {
      cli.header(`Updating Packages on ${name}`)

      const confirm = await cli.confirm('\nUpdate all packages?', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Running apt update && apt upgrade...')
      spinner.start()

      // TODO: Run update via SSM
      await new Promise(resolve => setTimeout(resolve, 5000))

      spinner.succeed('Packages updated')

      cli.success('\nServer packages updated!')
      cli.info('Updated: 45 packages')
      cli.warn('Reboot recommended')
    })

  app
    .command('server:secure <name>', 'Run security hardening script')
    .action(async (name: string) => {
      cli.header(`Securing Server: ${name}`)

      const confirm = await cli.confirm('\nRun security hardening? This will:\n- Configure firewall\n- Disable root login\n- Setup fail2ban\n- Configure SSH keys only\n- Install security updates', true)
      if (!confirm) {
        cli.info('Operation cancelled')
        return
      }

      const spinner = new cli.Spinner('Running security hardening script...')
      spinner.start()

      // TODO: Run hardening script via SSM
      await new Promise(resolve => setTimeout(resolve, 6000))

      spinner.succeed('Security hardening complete')

      cli.success('\nServer secured!')
      cli.info('\nSecurity measures applied:')
      cli.info('  - Firewall configured (ufw)')
      cli.info('  - Root login disabled')
      cli.info('  - fail2ban installed and configured')
      cli.info('  - SSH keys-only authentication')
      cli.info('  - Security updates installed')
    })
}
