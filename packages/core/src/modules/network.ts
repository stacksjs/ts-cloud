import type {
  EC2EIP,
  EC2FlowLog,
  EC2InternetGateway,
  EC2NatGateway,
  EC2Route,
  EC2RouteTable,
  EC2Subnet,
  EC2SubnetRouteTableAssociation,
  EC2VPC,
  EC2VPCGatewayAttachment,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface VpcOptions {
  slug: string
  environment: EnvironmentType
  cidr?: string
  enableDnsHostnames?: boolean
  enableDnsSupport?: boolean
  zones?: number
}

export interface SubnetOptions {
  slug: string
  environment: EnvironmentType
  vpcId: string
  type: 'public' | 'private' | 'isolated'
  cidr: string
  availabilityZone: string
  mapPublicIp?: boolean
}

export interface NatGatewayOptions {
  slug: string
  environment: EnvironmentType
  subnetId: string
}

export interface FlowLogOptions {
  slug: string
  environment: EnvironmentType
  resourceId: string
  resourceType: 'VPC' | 'Subnet'
  trafficType?: 'ACCEPT' | 'REJECT' | 'ALL'
  logGroupName?: string
}

/**
 * Network Module - VPC, Subnets, NAT, Internet Gateway
 * Provides clean API for creating and configuring networking resources
 */
export class Network {
  /**
   * Create a VPC with optional multi-AZ configuration
   */
  static createVpc(options: VpcOptions): {
    vpc: EC2VPC
    logicalId: string
  } {
    const {
      slug,
      environment,
      cidr = '10.0.0.0/16',
      enableDnsHostnames = true,
      enableDnsSupport = true,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'vpc',
    })

    const logicalId = generateLogicalId(resourceName)

    const vpc: EC2VPC = {
      Type: 'AWS::EC2::VPC',
      Properties: {
        CidrBlock: cidr,
        EnableDnsHostnames: enableDnsHostnames,
        EnableDnsSupport: enableDnsSupport,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { vpc, logicalId }
  }

  /**
   * Create a subnet in a VPC
   */
  static createSubnet(options: SubnetOptions): {
    subnet: EC2Subnet
    logicalId: string
  } {
    const {
      slug,
      environment,
      vpcId,
      type,
      cidr,
      availabilityZone,
      mapPublicIp = type === 'public',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: `subnet-${type}`,
    })

    const logicalId = generateLogicalId(`${resourceName}-${availabilityZone}`)

    const subnet: EC2Subnet = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: vpcId,
        CidrBlock: cidr,
        AvailabilityZone: availabilityZone,
        MapPublicIpOnLaunch: mapPublicIp,
        Tags: [
          { Key: 'Name', Value: `${resourceName}-${availabilityZone}` },
          { Key: 'Environment', Value: environment },
          { Key: 'Type', Value: type },
        ],
      },
    }

    return { subnet, logicalId }
  }

  /**
   * Create Internet Gateway
   */
  static createInternetGateway(
    slug: string,
    environment: EnvironmentType,
  ): {
      internetGateway: EC2InternetGateway
      logicalId: string
    } {
    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'igw',
    })

    const logicalId = generateLogicalId(resourceName)

    const internetGateway: EC2InternetGateway = {
      Type: 'AWS::EC2::InternetGateway',
      Properties: {
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { internetGateway, logicalId }
  }

  /**
   * Attach Internet Gateway to VPC
   */
  static attachInternetGateway(
    vpcLogicalId: string,
    igwLogicalId: string,
  ): {
      attachment: EC2VPCGatewayAttachment
      logicalId: string
    } {
    const logicalId = generateLogicalId(`${vpcLogicalId}-igw-attachment`)

    const attachment: EC2VPCGatewayAttachment = {
      Type: 'AWS::EC2::VPCGatewayAttachment',
      Properties: {
        VpcId: Fn.Ref(vpcLogicalId),
        InternetGatewayId: Fn.Ref(igwLogicalId),
      },
    }

    return { attachment, logicalId }
  }

  /**
   * Create Elastic IP for NAT Gateway
   */
  static createEip(
    slug: string,
    environment: EnvironmentType,
  ): {
      eip: EC2EIP
      logicalId: string
    } {
    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'eip',
    })

    const logicalId = generateLogicalId(resourceName)

    const eip: EC2EIP = {
      Type: 'AWS::EC2::EIP',
      Properties: {
        Domain: 'vpc',
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { eip, logicalId }
  }

  /**
   * Create NAT Gateway (with cost warning in comments)
   */
  static createNatGateway(
    options: NatGatewayOptions,
    eipLogicalId: string,
  ): {
      natGateway: EC2NatGateway
      logicalId: string
    } {
    const { slug, environment, subnetId } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'nat',
    })

    const logicalId = generateLogicalId(resourceName)

    const natGateway: EC2NatGateway = {
      Type: 'AWS::EC2::NatGateway',
      Properties: {
        AllocationId: Fn.GetAtt(eipLogicalId, 'AllocationId') as any,
        SubnetId: subnetId,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Warning', Value: 'NAT Gateway incurs hourly charges' },
        ],
      },
    }

    return { natGateway, logicalId }
  }

  /**
   * Create Route Table
   */
  static createRouteTable(
    slug: string,
    environment: EnvironmentType,
    vpcLogicalId: string,
    type: 'public' | 'private',
  ): {
      routeTable: EC2RouteTable
      logicalId: string
    } {
    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: `rt-${type}`,
    })

    const logicalId = generateLogicalId(resourceName)

    const routeTable: EC2RouteTable = {
      Type: 'AWS::EC2::RouteTable',
      Properties: {
        VpcId: Fn.Ref(vpcLogicalId),
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Type', Value: type },
        ],
      },
    }

    return { routeTable, logicalId }
  }

  /**
   * Create Route (e.g., for Internet Gateway or NAT Gateway)
   */
  static createRoute(
    routeTableLogicalId: string,
    destination: string,
    target: {
      type: 'igw' | 'nat' | 'instance'
      logicalId: string
    },
  ): {
      route: EC2Route
      logicalId: string
    } {
    const logicalId = generateLogicalId(`${routeTableLogicalId}-route-${target.type}`)

    const route: EC2Route = {
      Type: 'AWS::EC2::Route',
      Properties: {
        RouteTableId: Fn.Ref(routeTableLogicalId),
        DestinationCidrBlock: destination,
      },
    }

    // Set the appropriate gateway based on type
    if (target.type === 'igw') {
      route.Properties.GatewayId = Fn.Ref(target.logicalId)
    }
    else if (target.type === 'nat') {
      route.Properties.NatGatewayId = Fn.Ref(target.logicalId)
    }
    else if (target.type === 'instance') {
      route.Properties.InstanceId = Fn.Ref(target.logicalId)
    }

    return { route, logicalId }
  }

  /**
   * Associate Subnet with Route Table
   */
  static associateSubnetWithRouteTable(
    subnetLogicalId: string,
    routeTableLogicalId: string,
  ): {
      association: EC2SubnetRouteTableAssociation
      logicalId: string
    } {
    const logicalId = generateLogicalId(`${subnetLogicalId}-rt-assoc`)

    const association: EC2SubnetRouteTableAssociation = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: Fn.Ref(subnetLogicalId),
        RouteTableId: Fn.Ref(routeTableLogicalId),
      },
    }

    return { association, logicalId }
  }

  /**
   * Enable VPC Flow Logs
   */
  static enableFlowLogs(options: FlowLogOptions): {
    flowLog: EC2FlowLog
    logicalId: string
  } {
    const {
      slug,
      environment,
      resourceId,
      resourceType,
      trafficType = 'ALL',
      logGroupName,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'flowlog',
    })

    const logicalId = generateLogicalId(resourceName)

    const flowLog: EC2FlowLog = {
      Type: 'AWS::EC2::FlowLog',
      Properties: {
        ResourceType: resourceType,
        ResourceIds: [resourceId],
        TrafficType: trafficType,
        LogDestinationType: 'cloud-watch-logs',
        LogGroupName: logGroupName || `/aws/vpc/${slug}-${environment}`,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { flowLog, logicalId }
  }

  /**
   * Calculate subnet CIDRs for a VPC
   * Splits a VPC CIDR into smaller subnets
   */
  static calculateSubnetCidrs(
    vpcCidr: string,
    zones: number,
    subnetsPerZone = 3, // public, private, isolated
  ): string[] {
    const [baseIp, vpcMask] = vpcCidr.split('/')
    const vpcMaskNum = Number.parseInt(vpcMask, 10)

    // Calculate new subnet mask (add bits for zones and subnet types)
    const bitsNeeded = Math.ceil(Math.log2(zones * subnetsPerZone))
    const subnetMask = vpcMaskNum + bitsNeeded

    if (subnetMask > 28) {
      throw new Error('VPC CIDR is too small to accommodate requested subnets')
    }

    const [a, b, c, d] = baseIp.split('.').map(Number)
    const baseIpNum = (a << 24) + (b << 16) + (c << 8) + d

    const subnetSize = 2 ** (32 - subnetMask)
    const cidrs: string[] = []

    for (let i = 0; i < zones * subnetsPerZone; i++) {
      const subnetIpNum = baseIpNum + i * subnetSize
      const subnetIp = [
        (subnetIpNum >>> 24) & 0xFF,
        (subnetIpNum >>> 16) & 0xFF,
        (subnetIpNum >>> 8) & 0xFF,
        subnetIpNum & 0xFF,
      ].join('.')
      cidrs.push(`${subnetIp}/${subnetMask}`)
    }

    return cidrs
  }

  /**
   * Get available availability zones for a region
   * Returns zone suffixes (a, b, c, etc.)
   */
  static getAvailabilityZones(region: string, count: number): string[] {
    const zoneSuffixes = ['a', 'b', 'c', 'd', 'e', 'f']
    return zoneSuffixes.slice(0, count).map(suffix => `${region}${suffix}`)
  }
}
