import type { CLI } from '@stacksjs/clapp'
import * as cli from '../../src/utils/cli'
import { EC2Client } from '../../src/aws/ec2'
import { loadValidatedConfig } from './shared'

export function registerNetworkCommands(app: CLI): void {
  app
    .command('network:list', 'List all VPCs')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('VPCs')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ec2 = new EC2Client(region)

        const spinner = new cli.Spinner('Fetching VPCs...')
        spinner.start()

        const result = await ec2.describeVpcs()
        const vpcs = result.Vpcs || []

        spinner.succeed(`Found ${vpcs.length} VPC(s)`)

        if (vpcs.length === 0) {
          cli.info('No VPCs found')
          return
        }

        cli.table(
          ['VPC ID', 'Name', 'CIDR', 'State', 'Default'],
          vpcs.map(vpc => [
            vpc.VpcId || 'N/A',
            vpc.Tags?.find(t => t.Key === 'Name')?.Value || '-',
            vpc.CidrBlock || 'N/A',
            vpc.State || 'N/A',
            vpc.IsDefault ? 'Yes' : 'No',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list VPCs: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:subnets', 'List all subnets')
    .option('--region <region>', 'AWS region')
    .option('--vpc <vpcId>', 'Filter by VPC ID')
    .action(async (options: { region?: string; vpc?: string }) => {
      cli.header('Subnets')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ec2 = new EC2Client(region)

        const spinner = new cli.Spinner('Fetching subnets...')
        spinner.start()

        const filters = options.vpc ? [{ Name: 'vpc-id', Values: [options.vpc] }] : undefined
        const result = await ec2.describeSubnets({ Filters: filters })
        const subnets = result.Subnets || []

        spinner.succeed(`Found ${subnets.length} subnet(s)`)

        if (subnets.length === 0) {
          cli.info('No subnets found')
          return
        }

        cli.table(
          ['Subnet ID', 'Name', 'VPC', 'CIDR', 'AZ', 'IPs Available', 'Public'],
          subnets.map(subnet => [
            subnet.SubnetId || 'N/A',
            subnet.Tags?.find(t => t.Key === 'Name')?.Value || '-',
            subnet.VpcId || 'N/A',
            subnet.CidrBlock || 'N/A',
            subnet.AvailabilityZone || 'N/A',
            (subnet.AvailableIpAddressCount || 0).toString(),
            subnet.MapPublicIpOnLaunch ? 'Yes' : 'No',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list subnets: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:security-groups', 'List all security groups')
    .option('--region <region>', 'AWS region')
    .option('--vpc <vpcId>', 'Filter by VPC ID')
    .action(async (options: { region?: string; vpc?: string }) => {
      cli.header('Security Groups')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ec2 = new EC2Client(region)

        const spinner = new cli.Spinner('Fetching security groups...')
        spinner.start()

        const filters = options.vpc ? [{ Name: 'vpc-id', Values: [options.vpc] }] : undefined
        const result = await ec2.describeSecurityGroups({ Filters: filters })
        const groups = result.SecurityGroups || []

        spinner.succeed(`Found ${groups.length} security group(s)`)

        if (groups.length === 0) {
          cli.info('No security groups found')
          return
        }

        cli.table(
          ['Group ID', 'Name', 'VPC', 'Description', 'Inbound Rules', 'Outbound Rules'],
          groups.map(sg => [
            sg.GroupId || 'N/A',
            sg.GroupName || 'N/A',
            sg.VpcId || 'N/A',
            (sg.Description || '').substring(0, 30),
            (sg.IpPermissions?.length || 0).toString(),
            (sg.IpPermissionsEgress?.length || 0).toString(),
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list security groups: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:security-group <groupId>', 'Show security group details')
    .option('--region <region>', 'AWS region')
    .action(async (groupId: string, options: { region?: string }) => {
      cli.header(`Security Group: ${groupId}`)

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ec2 = new EC2Client(region)

        const spinner = new cli.Spinner('Fetching security group...')
        spinner.start()

        const result = await ec2.describeSecurityGroups({
          GroupIds: [groupId],
        })

        const sg = result.SecurityGroups?.[0]

        if (!sg) {
          spinner.fail('Security group not found')
          return
        }

        spinner.succeed('Security group loaded')

        cli.info('\nGeneral Information:')
        cli.info(`  Group ID: ${sg.GroupId}`)
        cli.info(`  Name: ${sg.GroupName}`)
        cli.info(`  VPC: ${sg.VpcId}`)
        cli.info(`  Description: ${sg.Description}`)

        if (sg.IpPermissions && sg.IpPermissions.length > 0) {
          cli.info('\nInbound Rules:')
          for (const rule of sg.IpPermissions) {
            const protocol = rule.IpProtocol === '-1' ? 'All' : rule.IpProtocol?.toUpperCase()
            const ports = rule.FromPort === rule.ToPort
              ? rule.FromPort?.toString() || 'All'
              : `${rule.FromPort}-${rule.ToPort}`

            for (const range of rule.IpRanges || []) {
              cli.info(`  - ${protocol} ${ports} from ${range.CidrIp}${range.Description ? ` (${range.Description})` : ''}`)
            }

            for (const group of rule.UserIdGroupPairs || []) {
              cli.info(`  - ${protocol} ${ports} from ${group.GroupId}${group.Description ? ` (${group.Description})` : ''}`)
            }
          }
        }
        else {
          cli.info('\nNo inbound rules configured.')
        }

        if (sg.IpPermissionsEgress && sg.IpPermissionsEgress.length > 0) {
          cli.info('\nOutbound Rules:')
          for (const rule of sg.IpPermissionsEgress) {
            const protocol = rule.IpProtocol === '-1' ? 'All' : rule.IpProtocol?.toUpperCase()
            const ports = rule.FromPort === rule.ToPort
              ? rule.FromPort?.toString() || 'All'
              : `${rule.FromPort}-${rule.ToPort}`

            for (const range of rule.IpRanges || []) {
              cli.info(`  - ${protocol} ${ports} to ${range.CidrIp}${range.Description ? ` (${range.Description})` : ''}`)
            }

            for (const group of rule.UserIdGroupPairs || []) {
              cli.info(`  - ${protocol} ${ports} to ${group.GroupId}${group.Description ? ` (${group.Description})` : ''}`)
            }
          }
        }
        else {
          cli.info('\nNo outbound rules configured.')
        }

        if (sg.Tags && sg.Tags.length > 0) {
          cli.info('\nTags:')
          for (const tag of sg.Tags) {
            cli.info(`  ${tag.Key}: ${tag.Value}`)
          }
        }
      }
      catch (error: any) {
        cli.error(`Failed to get security group: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:create-vpc <cidr>', 'Create a new VPC')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--name <name>', 'VPC name tag')
    .option('--tenancy <tenancy>', 'Instance tenancy (default or dedicated)', { default: 'default' })
    .action(async (cidr: string, options: { region: string; name?: string; tenancy: string }) => {
      cli.header('Create VPC')

      try {
        const ec2 = new EC2Client(options.region)

        cli.info(`CIDR Block: ${cidr}`)
        cli.info(`Region: ${options.region}`)
        cli.info(`Tenancy: ${options.tenancy}`)
        if (options.name) {
          cli.info(`Name: ${options.name}`)
        }

        const confirmed = await cli.confirm('\nCreate this VPC?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating VPC...')
        spinner.start()

        const result = await ec2.createVpc({
          CidrBlock: cidr,
          InstanceTenancy: options.tenancy,
          TagSpecifications: options.name ? [{
            ResourceType: 'vpc',
            Tags: [{ Key: 'Name', Value: options.name }],
          }] : undefined,
        })

        spinner.succeed('VPC created')

        cli.success(`\nVPC ID: ${result.Vpc?.VpcId}`)
        cli.info(`CIDR: ${result.Vpc?.CidrBlock}`)
        cli.info(`State: ${result.Vpc?.State}`)
      }
      catch (error: any) {
        cli.error(`Failed to create VPC: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:create-subnet <vpcId> <cidr>', 'Create a new subnet')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--name <name>', 'Subnet name tag')
    .option('--az <zone>', 'Availability zone')
    .option('--public', 'Auto-assign public IPs')
    .action(async (vpcId: string, cidr: string, options: { region: string; name?: string; az?: string; public?: boolean }) => {
      cli.header('Create Subnet')

      try {
        const ec2 = new EC2Client(options.region)

        cli.info(`VPC: ${vpcId}`)
        cli.info(`CIDR Block: ${cidr}`)
        if (options.az) {
          cli.info(`Availability Zone: ${options.az}`)
        }
        if (options.name) {
          cli.info(`Name: ${options.name}`)
        }
        cli.info(`Auto-assign Public IP: ${options.public ? 'Yes' : 'No'}`)

        const confirmed = await cli.confirm('\nCreate this subnet?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating subnet...')
        spinner.start()

        const result = await ec2.createSubnet({
          VpcId: vpcId,
          CidrBlock: cidr,
          AvailabilityZone: options.az,
          TagSpecifications: options.name ? [{
            ResourceType: 'subnet',
            Tags: [{ Key: 'Name', Value: options.name }],
          }] : undefined,
        })

        if (options.public && result.Subnet?.SubnetId) {
          spinner.text = 'Enabling auto-assign public IP...'
          await ec2.modifySubnetAttribute({
            SubnetId: result.Subnet.SubnetId,
            MapPublicIpOnLaunch: { Value: true },
          })
        }

        spinner.succeed('Subnet created')

        cli.success(`\nSubnet ID: ${result.Subnet?.SubnetId}`)
        cli.info(`CIDR: ${result.Subnet?.CidrBlock}`)
        cli.info(`Availability Zone: ${result.Subnet?.AvailabilityZone}`)
      }
      catch (error: any) {
        cli.error(`Failed to create subnet: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:create-sg <vpcId> <name>', 'Create a new security group')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--description <desc>', 'Security group description')
    .action(async (vpcId: string, name: string, options: { region: string; description?: string }) => {
      cli.header('Create Security Group')

      try {
        const ec2 = new EC2Client(options.region)

        const description = options.description || `Security group for ${name}`

        cli.info(`VPC: ${vpcId}`)
        cli.info(`Name: ${name}`)
        cli.info(`Description: ${description}`)

        const confirmed = await cli.confirm('\nCreate this security group?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Creating security group...')
        spinner.start()

        const result = await ec2.createSecurityGroup({
          GroupName: name,
          Description: description,
          VpcId: vpcId,
          TagSpecifications: [{
            ResourceType: 'security-group',
            Tags: [{ Key: 'Name', Value: name }],
          }],
        })

        spinner.succeed('Security group created')

        cli.success(`\nGroup ID: ${result.GroupId}`)
        cli.info('\nTo add rules:')
        cli.info(`  cloud network:sg-rule ${result.GroupId} --inbound --port 443 --cidr 0.0.0.0/0`)
      }
      catch (error: any) {
        cli.error(`Failed to create security group: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:sg-rule <groupId>', 'Add a rule to a security group')
    .option('--region <region>', 'AWS region', { default: 'us-east-1' })
    .option('--inbound', 'Add inbound rule')
    .option('--outbound', 'Add outbound rule')
    .option('--protocol <protocol>', 'Protocol (tcp, udp, icmp, or -1 for all)', { default: 'tcp' })
    .option('--port <port>', 'Port number or range (e.g., 80 or 80-443)')
    .option('--cidr <cidr>', 'CIDR block (e.g., 0.0.0.0/0)')
    .option('--source-group <groupId>', 'Source security group')
    .option('--description <desc>', 'Rule description')
    .action(async (groupId: string, options: {
      region: string
      inbound?: boolean
      outbound?: boolean
      protocol: string
      port?: string
      cidr?: string
      sourceGroup?: string
      description?: string
    }) => {
      cli.header('Add Security Group Rule')

      try {
        const ec2 = new EC2Client(options.region)

        if (!options.inbound && !options.outbound) {
          cli.error('Specify --inbound or --outbound')
          return
        }

        if (!options.cidr && !options.sourceGroup) {
          cli.error('Specify --cidr or --source-group')
          return
        }

        // Parse port range
        let fromPort: number | undefined
        let toPort: number | undefined

        if (options.port) {
          if (options.port.includes('-')) {
            const [from, to] = options.port.split('-')
            fromPort = Number.parseInt(from)
            toPort = Number.parseInt(to)
          }
          else {
            fromPort = Number.parseInt(options.port)
            toPort = fromPort
          }
        }
        else if (options.protocol !== '-1') {
          cli.error('Port is required for TCP/UDP protocols')
          return
        }

        const direction = options.inbound ? 'Inbound' : 'Outbound'
        const portStr = options.protocol === '-1' ? 'All' : (fromPort === toPort ? fromPort : `${fromPort}-${toPort}`)

        cli.info(`Security Group: ${groupId}`)
        cli.info(`Direction: ${direction}`)
        cli.info(`Protocol: ${options.protocol}`)
        cli.info(`Port(s): ${portStr}`)
        cli.info(`Source: ${options.cidr || options.sourceGroup}`)

        const confirmed = await cli.confirm('\nAdd this rule?', true)
        if (!confirmed) {
          cli.info('Operation cancelled')
          return
        }

        const spinner = new cli.Spinner('Adding rule...')
        spinner.start()

        const ipPermission: any = {
          IpProtocol: options.protocol,
          FromPort: fromPort,
          ToPort: toPort,
        }

        if (options.cidr) {
          ipPermission.IpRanges = [{
            CidrIp: options.cidr,
            Description: options.description,
          }]
        }

        if (options.sourceGroup) {
          ipPermission.UserIdGroupPairs = [{
            GroupId: options.sourceGroup,
            Description: options.description,
          }]
        }

        if (options.inbound) {
          await ec2.authorizeSecurityGroupIngress({
            GroupId: groupId,
            IpPermissions: [ipPermission],
          })
        }
        else {
          await ec2.authorizeSecurityGroupEgress({
            GroupId: groupId,
            IpPermissions: [ipPermission],
          })
        }

        spinner.succeed('Rule added')
      }
      catch (error: any) {
        cli.error(`Failed to add rule: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:elastic-ips', 'List Elastic IP addresses')
    .option('--region <region>', 'AWS region')
    .action(async (options: { region?: string }) => {
      cli.header('Elastic IP Addresses')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ec2 = new EC2Client(region)

        const spinner = new cli.Spinner('Fetching Elastic IPs...')
        spinner.start()

        const result = await ec2.describeAddresses()
        const addresses = result.Addresses || []

        spinner.succeed(`Found ${addresses.length} Elastic IP(s)`)

        if (addresses.length === 0) {
          cli.info('No Elastic IPs found')
          return
        }

        cli.table(
          ['Public IP', 'Allocation ID', 'Association ID', 'Instance', 'Name'],
          addresses.map(addr => [
            addr.PublicIp || 'N/A',
            addr.AllocationId || 'N/A',
            addr.AssociationId || '-',
            addr.InstanceId || '-',
            addr.Tags?.find(t => t.Key === 'Name')?.Value || '-',
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list Elastic IPs: ${error.message}`)
        process.exit(1)
      }
    })

  app
    .command('network:route-tables', 'List route tables')
    .option('--region <region>', 'AWS region')
    .option('--vpc <vpcId>', 'Filter by VPC ID')
    .action(async (options: { region?: string; vpc?: string }) => {
      cli.header('Route Tables')

      try {
        const config = await loadValidatedConfig()
        const region = options.region || config.project.region || 'us-east-1'
        const ec2 = new EC2Client(region)

        const spinner = new cli.Spinner('Fetching route tables...')
        spinner.start()

        const filters = options.vpc ? [{ Name: 'vpc-id', Values: [options.vpc] }] : undefined
        const result = await ec2.describeRouteTables({ Filters: filters })
        const tables = result.RouteTables || []

        spinner.succeed(`Found ${tables.length} route table(s)`)

        if (tables.length === 0) {
          cli.info('No route tables found')
          return
        }

        cli.table(
          ['Route Table ID', 'VPC', 'Name', 'Main', 'Associations', 'Routes'],
          tables.map(rt => [
            rt.RouteTableId || 'N/A',
            rt.VpcId || 'N/A',
            rt.Tags?.find(t => t.Key === 'Name')?.Value || '-',
            rt.Associations?.some(a => a.Main) ? 'Yes' : 'No',
            (rt.Associations?.length || 0).toString(),
            (rt.Routes?.length || 0).toString(),
          ]),
        )
      }
      catch (error: any) {
        cli.error(`Failed to list route tables: ${error.message}`)
        process.exit(1)
      }
    })
}
