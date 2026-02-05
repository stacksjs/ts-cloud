/**
 * Lambda VPC Configuration
 * VPC networking for Lambda functions
*/

export interface LambdaVPCConfig {
  id: string
  functionName: string
  vpcId: string
  subnetIds: string[]
  securityGroupIds: string[]
  ipv6Allowed?: boolean
}

export interface VPCEndpoint {
  id: string
  vpcId: string
  serviceName: string
  endpointType: 'Interface' | 'Gateway'
  subnetIds?: string[]
  securityGroupIds?: string[]
  privateDnsEnabled?: boolean
}

export interface NetworkInterface {
  id: string
  functionName: string
  networkInterfaceId: string
  subnetId: string
  privateIpAddress: string
  status: 'creating' | 'available' | 'in-use' | 'deleting'
  attachedAt?: Date
}

export interface VPCConnectivity {
  id: string
  functionName: string
  hasInternetAccess: boolean
  hasNATGateway: boolean
  hasVPCEndpoints: boolean
  endpoints: string[]
  recommendations: string[]
}

/**
 * Lambda VPC manager
*/
export class LambdaVPCManager {
  private vpcConfigs: Map<string, LambdaVPCConfig> = new Map()
  private endpoints: Map<string, VPCEndpoint> = new Map()
  private networkInterfaces: Map<string, NetworkInterface> = new Map()
  private connectivity: Map<string, VPCConnectivity> = new Map()
  private configCounter = 0
  private endpointCounter = 0
  private eniCounter = 0
  private connectivityCounter = 0

  /**
   * Configure VPC
  */
  configureVPC(config: Omit<LambdaVPCConfig, 'id'>): LambdaVPCConfig {
    const id = `vpc-config-${Date.now()}-${this.configCounter++}`

    const vpcConfig: LambdaVPCConfig = {
      id,
      ...config,
    }

    this.vpcConfigs.set(id, vpcConfig)

    // Simulate ENI creation
    for (const subnetId of config.subnetIds) {
      this.createNetworkInterface({
        functionName: config.functionName,
        subnetId,
      })
    }

    return vpcConfig
  }

  /**
   * Configure private VPC
  */
  configurePrivateVPC(options: {
    functionName: string
    vpcId: string
    privateSubnetIds: string[]
    securityGroupId: string
  }): LambdaVPCConfig {
    return this.configureVPC({
      functionName: options.functionName,
      vpcId: options.vpcId,
      subnetIds: options.privateSubnetIds,
      securityGroupIds: [options.securityGroupId],
      ipv6Allowed: false,
    })
  }

  /**
   * Configure multi-AZ VPC
  */
  configureMultiAZVPC(options: {
    functionName: string
    vpcId: string
    subnetIds: string[]
    securityGroupIds: string[]
  }): LambdaVPCConfig {
    if (options.subnetIds.length < 2) {
      throw new Error('Multi-AZ configuration requires at least 2 subnets')
    }

    return this.configureVPC({
      functionName: options.functionName,
      vpcId: options.vpcId,
      subnetIds: options.subnetIds,
      securityGroupIds: options.securityGroupIds,
    })
  }

  /**
   * Create VPC endpoint
  */
  createVPCEndpoint(endpoint: Omit<VPCEndpoint, 'id'>): VPCEndpoint {
    const id = `endpoint-${Date.now()}-${this.endpointCounter++}`

    const vpcEndpoint: VPCEndpoint = {
      id,
      ...endpoint,
    }

    this.endpoints.set(id, vpcEndpoint)

    return vpcEndpoint
  }

  /**
   * Create S3 VPC endpoint
  */
  createS3Endpoint(options: {
    vpcId: string
    routeTableIds: string[]
  }): VPCEndpoint {
    return this.createVPCEndpoint({
      vpcId: options.vpcId,
      serviceName: 'com.amazonaws.us-east-1.s3',
      endpointType: 'Gateway',
      privateDnsEnabled: false,
    })
  }

  /**
   * Create DynamoDB VPC endpoint
  */
  createDynamoDBEndpoint(options: {
    vpcId: string
    routeTableIds: string[]
  }): VPCEndpoint {
    return this.createVPCEndpoint({
      vpcId: options.vpcId,
      serviceName: 'com.amazonaws.us-east-1.dynamodb',
      endpointType: 'Gateway',
      privateDnsEnabled: false,
    })
  }

  /**
   * Create Secrets Manager VPC endpoint
  */
  createSecretsManagerEndpoint(options: {
    vpcId: string
    subnetIds: string[]
    securityGroupIds: string[]
  }): VPCEndpoint {
    return this.createVPCEndpoint({
      vpcId: options.vpcId,
      serviceName: 'com.amazonaws.us-east-1.secretsmanager',
      endpointType: 'Interface',
      subnetIds: options.subnetIds,
      securityGroupIds: options.securityGroupIds,
      privateDnsEnabled: true,
    })
  }

  /**
   * Create network interface
  */
  private createNetworkInterface(options: {
    functionName: string
    subnetId: string
  }): NetworkInterface {
    const id = `eni-${Date.now()}-${this.eniCounter++}`

    const networkInterface: NetworkInterface = {
      id,
      functionName: options.functionName,
      networkInterfaceId: `eni-${Math.random().toString(36).substring(2, 15)}`,
      subnetId: options.subnetId,
      privateIpAddress: `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
      status: 'creating',
      attachedAt: new Date(),
    }

    this.networkInterfaces.set(id, networkInterface)

    // Simulate ENI becoming available
    setTimeout(() => {
      networkInterface.status = 'available'
    }, 100)

    return networkInterface
  }

  /**
   * Analyze VPC connectivity
  */
  analyzeConnectivity(options: {
    functionName: string
    hasNATGateway?: boolean
    hasInternetGateway?: boolean
  }): VPCConnectivity {
    const id = `connectivity-${Date.now()}-${this.connectivityCounter++}`

    const config = Array.from(this.vpcConfigs.values()).find(
      c => c.functionName === options.functionName
    )

    const vpcEndpoints = Array.from(this.endpoints.values())
      .filter(e => e.vpcId === config?.vpcId)
      .map(e => e.serviceName)

    const recommendations: string[] = []

    const hasNAT = options.hasNATGateway ?? false
    const hasInternet = options.hasInternetGateway ?? false

    if (!hasNAT && !hasInternet) {
      recommendations.push('Add NAT Gateway for internet access')
    }

    if (!vpcEndpoints.includes('com.amazonaws.us-east-1.s3')) {
      recommendations.push('Add S3 VPC endpoint to reduce NAT costs')
    }

    if (!vpcEndpoints.includes('com.amazonaws.us-east-1.dynamodb')) {
      recommendations.push('Add DynamoDB VPC endpoint for private access')
    }

    const connectivity: VPCConnectivity = {
      id,
      functionName: options.functionName,
      hasInternetAccess: hasNAT || hasInternet,
      hasNATGateway: hasNAT,
      hasVPCEndpoints: vpcEndpoints.length > 0,
      endpoints: vpcEndpoints,
      recommendations,
    }

    this.connectivity.set(id, connectivity)

    return connectivity
  }

  /**
   * Get VPC config
  */
  getVPCConfig(id: string): LambdaVPCConfig | undefined {
    return this.vpcConfigs.get(id)
  }

  /**
   * List VPC configs
  */
  listVPCConfigs(functionName?: string): LambdaVPCConfig[] {
    const configs = Array.from(this.vpcConfigs.values())
    return functionName
      ? configs.filter(c => c.functionName === functionName)
      : configs
  }

  /**
   * Get network interfaces
  */
  getNetworkInterfaces(functionName: string): NetworkInterface[] {
    return Array.from(this.networkInterfaces.values()).filter(
      eni => eni.functionName === functionName
    )
  }

  /**
   * List VPC endpoints
  */
  listVPCEndpoints(vpcId?: string): VPCEndpoint[] {
    const endpoints = Array.from(this.endpoints.values())
    return vpcId ? endpoints.filter(e => e.vpcId === vpcId) : endpoints
  }

  /**
   * Generate CloudFormation for VPC config
  */
  generateVPCConfigCF(config: LambdaVPCConfig): any {
    return {
      VpcConfig: {
        SubnetIds: config.subnetIds,
        SecurityGroupIds: config.securityGroupIds,
        ...(config.ipv6Allowed && { Ipv6AllowedForDualStack: true }),
      },
    }
  }

  /**
   * Generate CloudFormation for VPC endpoint
  */
  generateVPCEndpointCF(endpoint: VPCEndpoint): any {
    return {
      Type: 'AWS::EC2::VPCEndpoint',
      Properties: {
        VpcId: endpoint.vpcId,
        ServiceName: endpoint.serviceName,
        VpcEndpointType: endpoint.endpointType,
        ...(endpoint.subnetIds && { SubnetIds: endpoint.subnetIds }),
        ...(endpoint.securityGroupIds && {
          SecurityGroupIds: endpoint.securityGroupIds,
        }),
        ...(endpoint.privateDnsEnabled !== undefined && {
          PrivateDnsEnabled: endpoint.privateDnsEnabled,
        }),
      },
    }
  }

  /**
   * Generate security group CloudFormation
  */
  generateSecurityGroupCF(options: {
    groupName: string
    vpcId: string
    ingressRules?: Array<{
      protocol: string
      fromPort: number
      toPort: number
      cidrIp?: string
      sourceSecurityGroupId?: string
    }>
    egressRules?: Array<{
      protocol: string
      fromPort: number
      toPort: number
      cidrIp?: string
    }>
  }): any {
    return {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupName: options.groupName,
        GroupDescription: `Security group for Lambda ${options.groupName}`,
        VpcId: options.vpcId,
        ...(options.ingressRules && {
          SecurityGroupIngress: options.ingressRules.map(rule => ({
            IpProtocol: rule.protocol,
            FromPort: rule.fromPort,
            ToPort: rule.toPort,
            ...(rule.cidrIp && { CidrIp: rule.cidrIp }),
            ...(rule.sourceSecurityGroupId && {
              SourceSecurityGroupId: rule.sourceSecurityGroupId,
            }),
          })),
        }),
        ...(options.egressRules && {
          SecurityGroupEgress: options.egressRules.map(rule => ({
            IpProtocol: rule.protocol,
            FromPort: rule.fromPort,
            ToPort: rule.toPort,
            CidrIp: rule.cidrIp || '0.0.0.0/0',
          })),
        }),
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.vpcConfigs.clear()
    this.endpoints.clear()
    this.networkInterfaces.clear()
    this.connectivity.clear()
    this.configCounter = 0
    this.endpointCounter = 0
    this.eniCounter = 0
    this.connectivityCounter = 0
  }
}

/**
 * Global Lambda VPC manager instance
*/
export const lambdaVPCManager: LambdaVPCManager = new LambdaVPCManager()
