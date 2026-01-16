import { describe, expect, it } from 'bun:test'
import { Network } from '../src/modules/network'
import { TemplateBuilder } from '../src/template-builder'

describe('Network Module', () => {
  describe('createVpc', () => {
    it('should create a VPC with default settings', () => {
      const { vpc, logicalId } = Network.createVpc({
        slug: 'my-app',
        environment: 'production',
      })

      expect(vpc.Type).toBe('AWS::EC2::VPC')
      expect(vpc.Properties.CidrBlock).toBe('10.0.0.0/16')
      expect(vpc.Properties.EnableDnsHostnames).toBe(true)
      expect(vpc.Properties.EnableDnsSupport).toBe(true)
      expect(logicalId).toBeDefined()
    })

    it('should create a VPC with custom CIDR', () => {
      const { vpc } = Network.createVpc({
        slug: 'my-app',
        environment: 'production',
        cidr: '172.16.0.0/16',
      })

      expect(vpc.Properties.CidrBlock).toBe('172.16.0.0/16')
    })

    it('should allow disabling DNS features', () => {
      const { vpc } = Network.createVpc({
        slug: 'my-app',
        environment: 'production',
        enableDnsHostnames: false,
        enableDnsSupport: false,
      })

      expect(vpc.Properties.EnableDnsHostnames).toBe(false)
      expect(vpc.Properties.EnableDnsSupport).toBe(false)
    })
  })

  describe('createSubnet', () => {
    it('should create a public subnet', () => {
      const { subnet, logicalId } = Network.createSubnet({
        slug: 'my-app',
        environment: 'production',
        vpcId: 'vpc-123',
        type: 'public',
        cidr: '10.0.1.0/24',
        availabilityZone: 'us-east-1a',
      })

      expect(subnet.Type).toBe('AWS::EC2::Subnet')
      expect(subnet.Properties.CidrBlock).toBe('10.0.1.0/24')
      expect(subnet.Properties.AvailabilityZone).toBe('us-east-1a')
      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(true)
      expect(logicalId).toBeDefined()
    })

    it('should create a private subnet without public IP', () => {
      const { subnet } = Network.createSubnet({
        slug: 'my-app',
        environment: 'production',
        vpcId: 'vpc-123',
        type: 'private',
        cidr: '10.0.2.0/24',
        availabilityZone: 'us-east-1a',
      })

      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false)
    })

    it('should create an isolated subnet', () => {
      const { subnet } = Network.createSubnet({
        slug: 'my-app',
        environment: 'production',
        vpcId: 'vpc-123',
        type: 'isolated',
        cidr: '10.0.3.0/24',
        availabilityZone: 'us-east-1a',
      })

      expect(subnet.Properties.MapPublicIpOnLaunch).toBe(false)
      const typeTag = subnet.Properties.Tags?.find(t => t.Key === 'Type')
      expect(typeTag?.Value).toBe('isolated')
    })
  })

  describe('createInternetGateway', () => {
    it('should create an Internet Gateway', () => {
      const { internetGateway, logicalId } = Network.createInternetGateway('my-app', 'production')

      expect(internetGateway.Type).toBe('AWS::EC2::InternetGateway')
      expect(logicalId).toBeDefined()
    })
  })

  describe('attachInternetGateway', () => {
    it('should create IGW attachment', () => {
      const { attachment, logicalId } = Network.attachInternetGateway('vpc-id', 'igw-id')

      expect(attachment.Type).toBe('AWS::EC2::VPCGatewayAttachment')
      expect(attachment.Properties.VpcId).toMatchObject({ Ref: 'vpc-id' })
      expect(attachment.Properties.InternetGatewayId).toMatchObject({ Ref: 'igw-id' })
      expect(logicalId).toBeDefined()
    })
  })

  describe('createEip', () => {
    it('should create an Elastic IP', () => {
      const { eip, logicalId } = Network.createEip('my-app', 'production')

      expect(eip.Type).toBe('AWS::EC2::EIP')
      expect(eip.Properties.Domain).toBe('vpc')
      expect(logicalId).toBeDefined()
    })
  })

  describe('createNatGateway', () => {
    it('should create a NAT Gateway', () => {
      const { natGateway, logicalId } = Network.createNatGateway(
        {
          slug: 'my-app',
          environment: 'production',
          subnetId: 'subnet-123',
        },
        'eip-id',
      )

      expect(natGateway.Type).toBe('AWS::EC2::NatGateway')
      expect(natGateway.Properties.SubnetId).toBe('subnet-123')
      expect(natGateway.Properties.AllocationId).toBeDefined()
      expect(logicalId).toBeDefined()

      // Check cost warning tag
      const warningTag = natGateway.Properties.Tags?.find(t => t.Key === 'Warning')
      expect(warningTag?.Value).toContain('charges')
    })
  })

  describe('createRouteTable', () => {
    it('should create a public route table', () => {
      const { routeTable, logicalId } = Network.createRouteTable(
        'my-app',
        'production',
        'vpc-id',
        'public',
      )

      expect(routeTable.Type).toBe('AWS::EC2::RouteTable')
      expect(routeTable.Properties.VpcId).toMatchObject({ Ref: 'vpc-id' })
      const typeTag = routeTable.Properties.Tags?.find(t => t.Key === 'Type')
      expect(typeTag?.Value).toBe('public')
      expect(logicalId).toBeDefined()
    })

    it('should create a private route table', () => {
      const { routeTable } = Network.createRouteTable(
        'my-app',
        'production',
        'vpc-id',
        'private',
      )

      const typeTag = routeTable.Properties.Tags?.find(t => t.Key === 'Type')
      expect(typeTag?.Value).toBe('private')
    })
  })

  describe('createRoute', () => {
    it('should create a route to Internet Gateway', () => {
      const { route, logicalId } = Network.createRoute(
        'rt-id',
        '0.0.0.0/0',
        { type: 'igw', logicalId: 'igw-id' },
      )

      expect(route.Type).toBe('AWS::EC2::Route')
      expect(route.Properties.RouteTableId).toMatchObject({ Ref: 'rt-id' })
      expect(route.Properties.DestinationCidrBlock).toBe('0.0.0.0/0')
      expect(route.Properties.GatewayId).toMatchObject({ Ref: 'igw-id' })
      expect(route.Properties.NatGatewayId).toBeUndefined()
      expect(logicalId).toBeDefined()
    })

    it('should create a route to NAT Gateway', () => {
      const { route } = Network.createRoute(
        'rt-id',
        '0.0.0.0/0',
        { type: 'nat', logicalId: 'nat-id' },
      )

      expect(route.Properties.NatGatewayId).toMatchObject({ Ref: 'nat-id' })
      expect(route.Properties.GatewayId).toBeUndefined()
    })

    it('should create a route to EC2 instance', () => {
      const { route } = Network.createRoute(
        'rt-id',
        '10.1.0.0/16',
        { type: 'instance', logicalId: 'instance-id' },
      )

      expect(route.Properties.InstanceId).toMatchObject({ Ref: 'instance-id' })
      expect(route.Properties.GatewayId).toBeUndefined()
      expect(route.Properties.NatGatewayId).toBeUndefined()
    })
  })

  describe('associateSubnetWithRouteTable', () => {
    it('should create subnet route table association', () => {
      const { association, logicalId } = Network.associateSubnetWithRouteTable(
        'subnet-id',
        'rt-id',
      )

      expect(association.Type).toBe('AWS::EC2::SubnetRouteTableAssociation')
      expect(association.Properties.SubnetId).toMatchObject({ Ref: 'subnet-id' })
      expect(association.Properties.RouteTableId).toMatchObject({ Ref: 'rt-id' })
      expect(logicalId).toBeDefined()
    })
  })

  describe('enableFlowLogs', () => {
    it('should create VPC flow logs', () => {
      const { flowLog, logicalId } = Network.enableFlowLogs({
        slug: 'my-app',
        environment: 'production',
        resourceId: 'vpc-123',
        resourceType: 'VPC',
      })

      expect(flowLog.Type).toBe('AWS::EC2::FlowLog')
      expect(flowLog.Properties.ResourceType).toBe('VPC')
      expect(flowLog.Properties.ResourceIds).toEqual(['vpc-123'])
      expect(flowLog.Properties.TrafficType).toBe('ALL')
      expect(flowLog.Properties.LogDestinationType).toBe('cloud-watch-logs')
      expect(logicalId).toBeDefined()
    })

    it('should allow custom traffic type', () => {
      const { flowLog } = Network.enableFlowLogs({
        slug: 'my-app',
        environment: 'production',
        resourceId: 'subnet-123',
        resourceType: 'Subnet',
        trafficType: 'REJECT',
      })

      expect(flowLog.Properties.TrafficType).toBe('REJECT')
    })

    it('should allow custom log group', () => {
      const { flowLog } = Network.enableFlowLogs({
        slug: 'my-app',
        environment: 'production',
        resourceId: 'vpc-123',
        resourceType: 'VPC',
        logGroupName: '/custom/log/group',
      })

      expect(flowLog.Properties.LogGroupName).toBe('/custom/log/group')
    })
  })

  describe('calculateSubnetCidrs', () => {
    it('should calculate subnet CIDRs for 2 zones', () => {
      const cidrs = Network.calculateSubnetCidrs('10.0.0.0/16', 2, 3)

      expect(cidrs).toHaveLength(6) // 2 zones × 3 subnets
      expect(cidrs[0]).toBe('10.0.0.0/19')
      expect(cidrs[1]).toBe('10.0.32.0/19')
      expect(cidrs[2]).toBe('10.0.64.0/19')
    })

    it('should calculate subnet CIDRs for 3 zones', () => {
      const cidrs = Network.calculateSubnetCidrs('10.0.0.0/16', 3, 3)

      expect(cidrs).toHaveLength(9) // 3 zones × 3 subnets
      expect(cidrs[0]).toBe('10.0.0.0/20')
    })

    it('should throw error for too small VPC CIDR', () => {
      expect(() => Network.calculateSubnetCidrs('10.0.0.0/28', 3, 3))
        .toThrow('too small')
    })
  })

  describe('getAvailabilityZones', () => {
    it('should return availability zone names', () => {
      const zones = Network.getAvailabilityZones('us-east-1', 2)

      expect(zones).toEqual(['us-east-1a', 'us-east-1b'])
    })

    it('should support 3 zones', () => {
      const zones = Network.getAvailabilityZones('eu-west-1', 3)

      expect(zones).toEqual(['eu-west-1a', 'eu-west-1b', 'eu-west-1c'])
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create complete VPC with public subnets across 2 AZs', () => {
      const template = new TemplateBuilder('VPC Infrastructure')

      // Create VPC
      const { vpc, logicalId: vpcId } = Network.createVpc({
        slug: 'my-app',
        environment: 'production',
        cidr: '10.0.0.0/16',
      })
      template.addResource(vpcId, vpc)

      // Create Internet Gateway
      const { internetGateway, logicalId: igwId } = Network.createInternetGateway('my-app', 'production')
      template.addResource(igwId, internetGateway)

      // Attach IGW to VPC
      const { attachment, logicalId: attachId } = Network.attachInternetGateway(vpcId, igwId)
      template.addResource(attachId, attachment)

      // Create public route table
      const { routeTable, logicalId: rtId } = Network.createRouteTable('my-app', 'production', vpcId, 'public')
      template.addResource(rtId, routeTable)

      // Add route to IGW
      const { route, logicalId: routeId } = Network.createRoute(rtId, '0.0.0.0/0', { type: 'igw', logicalId: igwId })
      template.addResource(routeId, route)

      // Create subnets in 2 AZs
      const zones = Network.getAvailabilityZones('us-east-1', 2)
      const cidrs = Network.calculateSubnetCidrs('10.0.0.0/16', 2, 1)

      for (let i = 0; i < zones.length; i++) {
        const { subnet, logicalId: subnetId } = Network.createSubnet({
          slug: 'my-app',
          environment: 'production',
          vpcId: vpcId,
          type: 'public',
          cidr: cidrs[i],
          availabilityZone: zones[i],
        })
        template.addResource(subnetId, subnet)

        // Associate subnet with route table
        const { association, logicalId: assocId } = Network.associateSubnetWithRouteTable(subnetId, rtId)
        template.addResource(assocId, association)
      }

      const result = template.build()

      // VPC + IGW + Attachment + RouteTable + Route + 2 Subnets + 2 Associations = 9 resources
      expect(Object.keys(result.Resources)).toHaveLength(9)
      expect(result.Resources[vpcId].Type).toBe('AWS::EC2::VPC')
      expect(result.Resources[igwId].Type).toBe('AWS::EC2::InternetGateway')
      expect(result.Resources[rtId].Type).toBe('AWS::EC2::RouteTable')
    })

    it('should create VPC with NAT Gateway for private subnets', () => {
      const template = new TemplateBuilder('VPC with NAT')

      const { vpc, logicalId: vpcId } = Network.createVpc({
        slug: 'my-app',
        environment: 'production',
      })
      template.addResource(vpcId, vpc)

      // Create public subnet for NAT
      const { subnet: publicSubnet, logicalId: publicSubnetId } = Network.createSubnet({
        slug: 'my-app',
        environment: 'production',
        vpcId: vpcId,
        type: 'public',
        cidr: '10.0.0.0/24',
        availabilityZone: 'us-east-1a',
      })
      template.addResource(publicSubnetId, publicSubnet)

      // Create EIP and NAT Gateway
      const { eip, logicalId: eipId } = Network.createEip('my-app', 'production')
      template.addResource(eipId, eip)

      const { natGateway, logicalId: natId } = Network.createNatGateway(
        {
          slug: 'my-app',
          environment: 'production',
          subnetId: publicSubnetId,
        },
        eipId,
      )
      template.addResource(natId, natGateway)

      // Create private route table with route to NAT
      const { routeTable, logicalId: rtId } = Network.createRouteTable('my-app', 'production', vpcId, 'private')
      template.addResource(rtId, routeTable)

      const { route, logicalId: routeId } = Network.createRoute(rtId, '0.0.0.0/0', { type: 'nat', logicalId: natId })
      template.addResource(routeId, route)

      const result = template.build()

      // VPC + PublicSubnet + EIP + NAT + RouteTable + Route = 6 resources
      expect(Object.keys(result.Resources)).toHaveLength(6)
      expect(result.Resources[natId].Type).toBe('AWS::EC2::NatGateway')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Network Test')

      const { vpc, logicalId } = Network.createVpc({
        slug: 'test',
        environment: 'development',
      })
      template.addResource(logicalId, vpc)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::EC2::VPC')
      expect(parsed.Resources[logicalId].Properties.CidrBlock).toBe('10.0.0.0/16')
    })
  })
})
