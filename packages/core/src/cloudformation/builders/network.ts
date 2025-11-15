import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface NetworkConfig {
  vpc?: {
    cidr?: string
    availabilityZones?: number
    natGateways?: number
    enableDnsHostnames?: boolean
    enableDnsSupport?: boolean
  }
}

/**
 * Add VPC and networking resources to CloudFormation template
 */
export function addNetworkResources(
  builder: CloudFormationBuilder,
  config: NetworkConfig,
): void {
  if (!config.vpc) {
    return
  }

  const {
    cidr = '10.0.0.0/16',
    availabilityZones = 2,
    natGateways = 1,
    enableDnsHostnames = true,
    enableDnsSupport = true,
  } = config.vpc

  // VPC
  builder.addResource('VPC', 'AWS::EC2::VPC', {
    CidrBlock: cidr,
    EnableDnsHostnames: enableDnsHostnames,
    EnableDnsSupport: enableDnsSupport,
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-vpc') },
    ],
  })

  // Internet Gateway
  builder.addResource('InternetGateway', 'AWS::EC2::InternetGateway', {
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-igw') },
    ],
  })

  builder.addResource('VPCGatewayAttachment', 'AWS::EC2::VPCGatewayAttachment', {
    VpcId: Fn.ref('VPC'),
    InternetGatewayId: Fn.ref('InternetGateway'),
  }, {
    dependsOn: ['VPC', 'InternetGateway'],
  })

  // Public subnets (one per AZ)
  const publicSubnets: string[] = []
  for (let i = 0; i < availabilityZones; i++) {
    const subnetId = `PublicSubnet${i + 1}`
    publicSubnets.push(subnetId)

    builder.addResource(subnetId, 'AWS::EC2::Subnet', {
      VpcId: Fn.ref('VPC'),
      CidrBlock: Fn.select(i, Fn.cidr(Fn.getAtt('VPC', 'CidrBlock'), availabilityZones * 2, 8)),
      AvailabilityZone: Fn.select(i, Fn.getAZs()),
      MapPublicIpOnLaunch: true,
      Tags: [
        { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-public-${i + 1}`) },
        { Key: 'Type', Value: 'public' },
      ],
    }, {
      dependsOn: 'VPC',
    })
  }

  // Private subnets (one per AZ)
  const privateSubnets: string[] = []
  for (let i = 0; i < availabilityZones; i++) {
    const subnetId = `PrivateSubnet${i + 1}`
    privateSubnets.push(subnetId)

    builder.addResource(subnetId, 'AWS::EC2::Subnet', {
      VpcId: Fn.ref('VPC'),
      CidrBlock: Fn.select(
        i + availabilityZones,
        Fn.cidr(Fn.getAtt('VPC', 'CidrBlock'), availabilityZones * 2, 8),
      ),
      AvailabilityZone: Fn.select(i, Fn.getAZs()),
      MapPublicIpOnLaunch: false,
      Tags: [
        { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-private-${i + 1}`) },
        { Key: 'Type', Value: 'private' },
      ],
    }, {
      dependsOn: 'VPC',
    })
  }

  // Elastic IPs for NAT Gateways
  const eips: string[] = []
  for (let i = 0; i < natGateways; i++) {
    const eipId = `NatEIP${i + 1}`
    eips.push(eipId)

    builder.addResource(eipId, 'AWS::EC2::EIP', {
      Domain: 'vpc',
      Tags: [
        { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-nat-eip-${i + 1}`) },
      ],
    }, {
      dependsOn: 'VPCGatewayAttachment',
    })
  }

  // NAT Gateways
  const natGatewayIds: string[] = []
  for (let i = 0; i < natGateways; i++) {
    const natId = `NatGateway${i + 1}`
    natGatewayIds.push(natId)

    // Use round-robin to distribute NAT gateways across AZs
    const subnetIndex = i % availabilityZones

    builder.addResource(natId, 'AWS::EC2::NatGateway', {
      AllocationId: Fn.getAtt(eips[i], 'AllocationId'),
      SubnetId: Fn.ref(publicSubnets[subnetIndex]),
      Tags: [
        { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-nat-${i + 1}`) },
      ],
    }, {
      dependsOn: [eips[i], publicSubnets[subnetIndex]],
    })
  }

  // Public route table
  builder.addResource('PublicRouteTable', 'AWS::EC2::RouteTable', {
    VpcId: Fn.ref('VPC'),
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-public-rt') },
    ],
  }, {
    dependsOn: 'VPC',
  })

  builder.addResource('PublicRoute', 'AWS::EC2::Route', {
    RouteTableId: Fn.ref('PublicRouteTable'),
    DestinationCidrBlock: '0.0.0.0/0',
    GatewayId: Fn.ref('InternetGateway'),
  }, {
    dependsOn: ['PublicRouteTable', 'VPCGatewayAttachment'],
  })

  // Associate public subnets with public route table
  publicSubnets.forEach((subnetId, i) => {
    builder.addResource(`PublicSubnetRouteTableAssociation${i + 1}`, 'AWS::EC2::SubnetRouteTableAssociation', {
      SubnetId: Fn.ref(subnetId),
      RouteTableId: Fn.ref('PublicRouteTable'),
    }, {
      dependsOn: [subnetId, 'PublicRouteTable'],
    })
  })

  // Private route tables (one per NAT gateway for HA)
  privateSubnets.forEach((subnetId, i) => {
    const routeTableId = `PrivateRouteTable${i + 1}`
    const natIndex = i % natGateways

    builder.addResource(routeTableId, 'AWS::EC2::RouteTable', {
      VpcId: Fn.ref('VPC'),
      Tags: [
        { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-private-rt-${i + 1}`) },
      ],
    }, {
      dependsOn: 'VPC',
    })

    builder.addResource(`PrivateRoute${i + 1}`, 'AWS::EC2::Route', {
      RouteTableId: Fn.ref(routeTableId),
      DestinationCidrBlock: '0.0.0.0/0',
      NatGatewayId: Fn.ref(natGatewayIds[natIndex]),
    }, {
      dependsOn: [routeTableId, natGatewayIds[natIndex]],
    })

    builder.addResource(`PrivateSubnetRouteTableAssociation${i + 1}`, 'AWS::EC2::SubnetRouteTableAssociation', {
      SubnetId: Fn.ref(subnetId),
      RouteTableId: Fn.ref(routeTableId),
    }, {
      dependsOn: [subnetId, routeTableId],
    })
  })

  // VPC Endpoints for AWS services (cost optimization)
  builder.addResource('S3VPCEndpoint', 'AWS::EC2::VPCEndpoint', {
    VpcId: Fn.ref('VPC'),
    ServiceName: Fn.sub('com.amazonaws.${AWS::Region}.s3'),
    VpcEndpointType: 'Gateway',
    RouteTableIds: [
      Fn.ref('PublicRouteTable'),
      ...Array.from({ length: availabilityZones }, (_, i) => Fn.ref(`PrivateRouteTable${i + 1}`)),
    ],
  }, {
    dependsOn: 'VPC',
  })

  // Network ACL for additional security
  builder.addResource('NetworkAcl', 'AWS::EC2::NetworkAcl', {
    VpcId: Fn.ref('VPC'),
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-nacl') },
    ],
  }, {
    dependsOn: 'VPC',
  })

  // Allow all inbound traffic (can be customized)
  builder.addResource('NetworkAclEntryInbound', 'AWS::EC2::NetworkAclEntry', {
    NetworkAclId: Fn.ref('NetworkAcl'),
    RuleNumber: 100,
    Protocol: -1,
    RuleAction: 'allow',
    CidrBlock: '0.0.0.0/0',
  }, {
    dependsOn: 'NetworkAcl',
  })

  // Allow all outbound traffic
  builder.addResource('NetworkAclEntryOutbound', 'AWS::EC2::NetworkAclEntry', {
    NetworkAclId: Fn.ref('NetworkAcl'),
    RuleNumber: 100,
    Protocol: -1,
    Egress: true,
    RuleAction: 'allow',
    CidrBlock: '0.0.0.0/0',
  }, {
    dependsOn: 'NetworkAcl',
  })

  // Outputs
  builder.template.Outputs = {
    ...builder.template.Outputs,
    VPCId: {
      Description: 'VPC ID',
      Value: Fn.ref('VPC'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-VPC'),
      },
    },
    PublicSubnets: {
      Description: 'Public subnet IDs',
      Value: Fn.join(',', publicSubnets.map(id => Fn.ref(id))),
      Export: {
        Name: Fn.sub('${AWS::StackName}-PublicSubnets'),
      },
    },
    PrivateSubnets: {
      Description: 'Private subnet IDs',
      Value: Fn.join(',', privateSubnets.map(id => Fn.ref(id))),
      Export: {
        Name: Fn.sub('${AWS::StackName}-PrivateSubnets'),
      },
    },
  }
}
