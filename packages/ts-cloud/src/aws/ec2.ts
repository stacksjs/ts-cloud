/**
 * AWS EC2 Client
 * Manages EC2 instances, VPCs, security groups, and related resources using direct API calls
 */

import { AWSClient } from './client'

export interface Instance {
  InstanceId?: string
  ImageId?: string
  InstanceType?: string
  State?: {
    Code?: number
    Name?: 'pending' | 'running' | 'shutting-down' | 'terminated' | 'stopping' | 'stopped'
  }
  PrivateIpAddress?: string
  PublicIpAddress?: string
  SubnetId?: string
  VpcId?: string
  SecurityGroups?: { GroupId?: string, GroupName?: string }[]
  Tags?: { Key?: string, Value?: string }[]
  LaunchTime?: string
  Placement?: {
    AvailabilityZone?: string
    Tenancy?: string
  }
  Architecture?: string
  RootDeviceType?: string
  RootDeviceName?: string
  BlockDeviceMappings?: {
    DeviceName?: string
    Ebs?: {
      VolumeId?: string
      Status?: string
      AttachTime?: string
      DeleteOnTermination?: boolean
    }
  }[]
  IamInstanceProfile?: {
    Arn?: string
    Id?: string
  }
}

export interface Vpc {
  VpcId?: string
  CidrBlock?: string
  State?: 'pending' | 'available'
  DhcpOptionsId?: string
  InstanceTenancy?: string
  IsDefault?: boolean
  Tags?: { Key?: string, Value?: string }[]
}

export interface Subnet {
  SubnetId?: string
  VpcId?: string
  CidrBlock?: string
  AvailabilityZone?: string
  AvailableIpAddressCount?: number
  State?: 'pending' | 'available'
  MapPublicIpOnLaunch?: boolean
  Tags?: { Key?: string, Value?: string }[]
}

export interface SecurityGroup {
  GroupId?: string
  GroupName?: string
  Description?: string
  VpcId?: string
  IpPermissions?: IpPermission[]
  IpPermissionsEgress?: IpPermission[]
  Tags?: { Key?: string, Value?: string }[]
}

export interface IpPermission {
  IpProtocol?: string
  FromPort?: number
  ToPort?: number
  IpRanges?: { CidrIp?: string, Description?: string }[]
  Ipv6Ranges?: { CidrIpv6?: string, Description?: string }[]
  UserIdGroupPairs?: { GroupId?: string, UserId?: string }[]
}

export interface InternetGateway {
  InternetGatewayId?: string
  Attachments?: { VpcId?: string, State?: string }[]
  Tags?: { Key?: string, Value?: string }[]
}

export interface RouteTable {
  RouteTableId?: string
  VpcId?: string
  Routes?: {
    DestinationCidrBlock?: string
    GatewayId?: string
    NatGatewayId?: string
    State?: string
  }[]
  Associations?: {
    RouteTableAssociationId?: string
    SubnetId?: string
    Main?: boolean
  }[]
  Tags?: { Key?: string, Value?: string }[]
}

export interface Address {
  PublicIp?: string
  AllocationId?: string
  AssociationId?: string
  InstanceId?: string
  NetworkInterfaceId?: string
  PrivateIpAddress?: string
  Domain?: 'vpc' | 'standard'
  Tags?: { Key?: string, Value?: string }[]
}

export interface ConsoleOutput {
  InstanceId?: string
  Output?: string
  Timestamp?: string
}

export interface InstanceStatus {
  InstanceId?: string
  InstanceState?: {
    Code?: number
    Name?: string
  }
  InstanceStatus?: {
    Status?: string
    Details?: { Name?: string, Status?: string }[]
  }
  SystemStatus?: {
    Status?: string
    Details?: { Name?: string, Status?: string }[]
  }
}

/**
 * EC2 client using direct API calls
 */
export class EC2Client {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Describe EC2 instances
   */
  async describeInstances(options?: {
    InstanceIds?: string[]
    Filters?: { Name: string, Values: string[] }[]
    MaxResults?: number
    NextToken?: string
  }): Promise<{
    Reservations?: {
      ReservationId?: string
      Instances?: Instance[]
    }[]
    NextToken?: string
  }> {
    const params: Record<string, string> = {
      Action: 'DescribeInstances',
      Version: '2016-11-15',
    }

    if (options?.InstanceIds) {
      options.InstanceIds.forEach((id, i) => {
        params[`InstanceId.${i + 1}`] = id
      })
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((val, j) => {
          params[`Filter.${i + 1}.Value.${j + 1}`] = val
        })
      })
    }

    if (options?.MaxResults) {
      params.MaxResults = String(options.MaxResults)
    }

    if (options?.NextToken) {
      params.NextToken = options.NextToken
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    // Handle EC2 XML response wrapper
    const response = result.DescribeInstancesResponse || result

    return {
      Reservations: this.parseReservations(response.reservationSet?.item),
      NextToken: response.nextToken,
    }
  }

  /**
   * Get a single instance by ID
   */
  async getInstance(instanceId: string): Promise<Instance | undefined> {
    const result = await this.describeInstances({ InstanceIds: [instanceId] })
    return result.Reservations?.[0]?.Instances?.[0]
  }

  /**
   * Get console output from an EC2 instance
   */
  async getConsoleOutput(instanceId: string, latest?: boolean): Promise<ConsoleOutput> {
    const params: Record<string, string> = {
      Action: 'GetConsoleOutput',
      Version: '2016-11-15',
      InstanceId: instanceId,
    }

    if (latest) {
      params.Latest = 'true'
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    // Handle EC2 XML response wrapper
    const response = result.GetConsoleOutputResponse || result

    return {
      InstanceId: response.instanceId,
      Output: response.output,
      Timestamp: response.timestamp,
    }
  }

  /**
   * Get console output decoded (convenience method)
   */
  async getConsoleOutputDecoded(instanceId: string, options?: {
    latest?: boolean
    tailLines?: number
  }): Promise<string> {
    const result = await this.getConsoleOutput(instanceId, options?.latest)

    if (!result.Output) {
      return 'No console output available yet'
    }

    // Decode base64
    const decoded = Buffer.from(result.Output, 'base64').toString('utf-8')

    if (options?.tailLines) {
      const lines = decoded.split('\n')
      return lines.slice(-options.tailLines).join('\n')
    }

    return decoded
  }

  /**
   * Describe instance status
   */
  async describeInstanceStatus(options?: {
    InstanceIds?: string[]
    IncludeAllInstances?: boolean
    Filters?: { Name: string, Values: string[] }[]
  }): Promise<{
    InstanceStatuses?: InstanceStatus[]
  }> {
    const params: Record<string, string> = {
      Action: 'DescribeInstanceStatus',
      Version: '2016-11-15',
    }

    if (options?.InstanceIds) {
      options.InstanceIds.forEach((id, i) => {
        params[`InstanceId.${i + 1}`] = id
      })
    }

    if (options?.IncludeAllInstances) {
      params.IncludeAllInstances = 'true'
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((val, j) => {
          params[`Filter.${i + 1}.Value.${j + 1}`] = val
        })
      })
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      InstanceStatuses: this.parseArray(result.instanceStatusSet?.item).map((item: any) => ({
        InstanceId: item.instanceId,
        InstanceState: item.instanceState ? {
          Code: Number.parseInt(item.instanceState.code),
          Name: item.instanceState.name,
        } : undefined,
        InstanceStatus: item.instanceStatus ? {
          Status: item.instanceStatus.status,
          Details: this.parseArray(item.instanceStatus.details?.item).map((d: any) => ({
            Name: d.name,
            Status: d.status,
          })),
        } : undefined,
        SystemStatus: item.systemStatus ? {
          Status: item.systemStatus.status,
          Details: this.parseArray(item.systemStatus.details?.item).map((d: any) => ({
            Name: d.name,
            Status: d.status,
          })),
        } : undefined,
      })),
    }
  }

  /**
   * Start instances
   */
  async startInstances(instanceIds: string[]): Promise<{
    StartingInstances?: { InstanceId?: string, CurrentState?: { Name?: string }, PreviousState?: { Name?: string } }[]
  }> {
    const params: Record<string, string> = {
      Action: 'StartInstances',
      Version: '2016-11-15',
    }

    instanceIds.forEach((id, i) => {
      params[`InstanceId.${i + 1}`] = id
    })

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      StartingInstances: this.parseArray(result.instancesSet?.item).map((item: any) => ({
        InstanceId: item.instanceId,
        CurrentState: item.currentState ? { Name: item.currentState.name } : undefined,
        PreviousState: item.previousState ? { Name: item.previousState.name } : undefined,
      })),
    }
  }

  /**
   * Stop instances
   */
  async stopInstances(instanceIds: string[], force?: boolean): Promise<{
    StoppingInstances?: { InstanceId?: string, CurrentState?: { Name?: string }, PreviousState?: { Name?: string } }[]
  }> {
    const params: Record<string, string> = {
      Action: 'StopInstances',
      Version: '2016-11-15',
    }

    instanceIds.forEach((id, i) => {
      params[`InstanceId.${i + 1}`] = id
    })

    if (force) {
      params.Force = 'true'
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      StoppingInstances: this.parseArray(result.instancesSet?.item).map((item: any) => ({
        InstanceId: item.instanceId,
        CurrentState: item.currentState ? { Name: item.currentState.name } : undefined,
        PreviousState: item.previousState ? { Name: item.previousState.name } : undefined,
      })),
    }
  }

  /**
   * Reboot instances
   */
  async rebootInstances(instanceIds: string[]): Promise<void> {
    const params: Record<string, string> = {
      Action: 'RebootInstances',
      Version: '2016-11-15',
    }

    instanceIds.forEach((id, i) => {
      params[`InstanceId.${i + 1}`] = id
    })

    await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * Terminate instances
   */
  async terminateInstances(instanceIds: string[]): Promise<{
    TerminatingInstances?: { InstanceId?: string, CurrentState?: { Name?: string }, PreviousState?: { Name?: string } }[]
  }> {
    const params: Record<string, string> = {
      Action: 'TerminateInstances',
      Version: '2016-11-15',
    }

    instanceIds.forEach((id, i) => {
      params[`InstanceId.${i + 1}`] = id
    })

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      TerminatingInstances: this.parseArray(result.instancesSet?.item).map((item: any) => ({
        InstanceId: item.instanceId,
        CurrentState: item.currentState ? { Name: item.currentState.name } : undefined,
        PreviousState: item.previousState ? { Name: item.previousState.name } : undefined,
      })),
    }
  }

  /**
   * Describe VPCs
   */
  async describeVpcs(options?: {
    VpcIds?: string[]
    Filters?: { Name: string, Values: string[] }[]
  }): Promise<{
    Vpcs?: Vpc[]
  }> {
    const params: Record<string, string> = {
      Action: 'DescribeVpcs',
      Version: '2016-11-15',
    }

    if (options?.VpcIds) {
      options.VpcIds.forEach((id, i) => {
        params[`VpcId.${i + 1}`] = id
      })
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((val, j) => {
          params[`Filter.${i + 1}.Value.${j + 1}`] = val
        })
      })
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      Vpcs: this.parseArray(result.vpcSet?.item).map((item: any) => ({
        VpcId: item.vpcId,
        CidrBlock: item.cidrBlock,
        State: item.state,
        DhcpOptionsId: item.dhcpOptionsId,
        InstanceTenancy: item.instanceTenancy,
        IsDefault: item.isDefault === 'true',
        Tags: this.parseTags(item.tagSet?.item),
      })),
    }
  }

  /**
   * Describe Subnets
   */
  async describeSubnets(options?: {
    SubnetIds?: string[]
    Filters?: { Name: string, Values: string[] }[]
  }): Promise<{
    Subnets?: Subnet[]
  }> {
    const params: Record<string, string> = {
      Action: 'DescribeSubnets',
      Version: '2016-11-15',
    }

    if (options?.SubnetIds) {
      options.SubnetIds.forEach((id, i) => {
        params[`SubnetId.${i + 1}`] = id
      })
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((val, j) => {
          params[`Filter.${i + 1}.Value.${j + 1}`] = val
        })
      })
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      Subnets: this.parseArray(result.subnetSet?.item).map((item: any) => ({
        SubnetId: item.subnetId,
        VpcId: item.vpcId,
        CidrBlock: item.cidrBlock,
        AvailabilityZone: item.availabilityZone,
        AvailableIpAddressCount: Number.parseInt(item.availableIpAddressCount),
        State: item.state,
        MapPublicIpOnLaunch: item.mapPublicIpOnLaunch === 'true',
        Tags: this.parseTags(item.tagSet?.item),
      })),
    }
  }

  /**
   * Describe Security Groups
   */
  async describeSecurityGroups(options?: {
    GroupIds?: string[]
    GroupNames?: string[]
    Filters?: { Name: string, Values: string[] }[]
  }): Promise<{
    SecurityGroups?: SecurityGroup[]
  }> {
    const params: Record<string, string> = {
      Action: 'DescribeSecurityGroups',
      Version: '2016-11-15',
    }

    if (options?.GroupIds) {
      options.GroupIds.forEach((id, i) => {
        params[`GroupId.${i + 1}`] = id
      })
    }

    if (options?.GroupNames) {
      options.GroupNames.forEach((name, i) => {
        params[`GroupName.${i + 1}`] = name
      })
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((val, j) => {
          params[`Filter.${i + 1}.Value.${j + 1}`] = val
        })
      })
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      SecurityGroups: this.parseArray(result.securityGroupInfo?.item).map((item: any) => ({
        GroupId: item.groupId,
        GroupName: item.groupName,
        Description: item.groupDescription,
        VpcId: item.vpcId,
        IpPermissions: this.parseIpPermissions(item.ipPermissions?.item),
        IpPermissionsEgress: this.parseIpPermissions(item.ipPermissionsEgress?.item),
        Tags: this.parseTags(item.tagSet?.item),
      })),
    }
  }

  /**
   * Describe Internet Gateways
   */
  async describeInternetGateways(options?: {
    InternetGatewayIds?: string[]
    Filters?: { Name: string, Values: string[] }[]
  }): Promise<{
    InternetGateways?: InternetGateway[]
  }> {
    const params: Record<string, string> = {
      Action: 'DescribeInternetGateways',
      Version: '2016-11-15',
    }

    if (options?.InternetGatewayIds) {
      options.InternetGatewayIds.forEach((id, i) => {
        params[`InternetGatewayId.${i + 1}`] = id
      })
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((val, j) => {
          params[`Filter.${i + 1}.Value.${j + 1}`] = val
        })
      })
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      InternetGateways: this.parseArray(result.internetGatewaySet?.item).map((item: any) => ({
        InternetGatewayId: item.internetGatewayId,
        Attachments: this.parseArray(item.attachmentSet?.item).map((a: any) => ({
          VpcId: a.vpcId,
          State: a.state,
        })),
        Tags: this.parseTags(item.tagSet?.item),
      })),
    }
  }

  /**
   * Describe Elastic IPs (Addresses)
   */
  async describeAddresses(options?: {
    AllocationIds?: string[]
    PublicIps?: string[]
    Filters?: { Name: string, Values: string[] }[]
  }): Promise<{
    Addresses?: Address[]
  }> {
    const params: Record<string, string> = {
      Action: 'DescribeAddresses',
      Version: '2016-11-15',
    }

    if (options?.AllocationIds) {
      options.AllocationIds.forEach((id, i) => {
        params[`AllocationId.${i + 1}`] = id
      })
    }

    if (options?.PublicIps) {
      options.PublicIps.forEach((ip, i) => {
        params[`PublicIp.${i + 1}`] = ip
      })
    }

    if (options?.Filters) {
      options.Filters.forEach((filter, i) => {
        params[`Filter.${i + 1}.Name`] = filter.Name
        filter.Values.forEach((val, j) => {
          params[`Filter.${i + 1}.Value.${j + 1}`] = val
        })
      })
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      Addresses: this.parseArray(result.addressesSet?.item).map((item: any) => ({
        PublicIp: item.publicIp,
        AllocationId: item.allocationId,
        AssociationId: item.associationId,
        InstanceId: item.instanceId,
        NetworkInterfaceId: item.networkInterfaceId,
        PrivateIpAddress: item.privateIpAddress,
        Domain: item.domain,
        Tags: this.parseTags(item.tagSet?.item),
      })),
    }
  }

  /**
   * Allocate Elastic IP
   */
  async allocateAddress(options?: {
    Domain?: 'vpc' | 'standard'
    TagSpecifications?: { ResourceType: string, Tags: { Key: string, Value: string }[] }[]
  }): Promise<{
    AllocationId?: string
    PublicIp?: string
    Domain?: string
  }> {
    const params: Record<string, string> = {
      Action: 'AllocateAddress',
      Version: '2016-11-15',
    }

    if (options?.Domain) {
      params.Domain = options.Domain
    }

    if (options?.TagSpecifications) {
      options.TagSpecifications.forEach((spec, i) => {
        params[`TagSpecification.${i + 1}.ResourceType`] = spec.ResourceType
        spec.Tags.forEach((tag, j) => {
          params[`TagSpecification.${i + 1}.Tag.${j + 1}.Key`] = tag.Key
          params[`TagSpecification.${i + 1}.Tag.${j + 1}.Value`] = tag.Value
        })
      })
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      AllocationId: result.allocationId,
      PublicIp: result.publicIp,
      Domain: result.domain,
    }
  }

  /**
   * Associate Elastic IP with instance
   */
  async associateAddress(options: {
    AllocationId?: string
    PublicIp?: string
    InstanceId?: string
    NetworkInterfaceId?: string
    PrivateIpAddress?: string
    AllowReassociation?: boolean
  }): Promise<{
    AssociationId?: string
  }> {
    const params: Record<string, string> = {
      Action: 'AssociateAddress',
      Version: '2016-11-15',
    }

    if (options.AllocationId) {
      params.AllocationId = options.AllocationId
    }

    if (options.PublicIp) {
      params.PublicIp = options.PublicIp
    }

    if (options.InstanceId) {
      params.InstanceId = options.InstanceId
    }

    if (options.NetworkInterfaceId) {
      params.NetworkInterfaceId = options.NetworkInterfaceId
    }

    if (options.PrivateIpAddress) {
      params.PrivateIpAddress = options.PrivateIpAddress
    }

    if (options.AllowReassociation) {
      params.AllowReassociation = 'true'
    }

    const result = await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })

    return {
      AssociationId: result.associationId,
    }
  }

  /**
   * Create tags for resources
   */
  async createTags(options: {
    Resources: string[]
    Tags: { Key: string, Value: string }[]
  }): Promise<void> {
    const params: Record<string, string> = {
      Action: 'CreateTags',
      Version: '2016-11-15',
    }

    options.Resources.forEach((id, i) => {
      params[`ResourceId.${i + 1}`] = id
    })

    options.Tags.forEach((tag, i) => {
      params[`Tag.${i + 1}.Key`] = tag.Key
      params[`Tag.${i + 1}.Value`] = tag.Value
    })

    await this.client.request({
      service: 'ec2',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })
  }

  /**
   * Wait for instance to reach a specific state
   */
  async waitForInstanceState(
    instanceId: string,
    targetState: 'running' | 'stopped' | 'terminated',
    options?: {
      maxWaitMs?: number
      pollIntervalMs?: number
    },
  ): Promise<Instance | undefined> {
    const maxWait = options?.maxWaitMs || 300000 // 5 minutes
    const pollInterval = options?.pollIntervalMs || 5000 // 5 seconds
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait) {
      const instance = await this.getInstance(instanceId)

      if (instance?.State?.Name === targetState) {
        return instance
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    return undefined
  }

  // Helper methods for parsing EC2 XML responses

  private parseArray(item: any): any[] {
    if (!item)
      return []
    return Array.isArray(item) ? item : [item]
  }

  private parseTags(item: any): { Key?: string, Value?: string }[] {
    return this.parseArray(item).map((t: any) => ({
      Key: t.key,
      Value: t.value,
    }))
  }

  private parseReservations(item: any): { ReservationId?: string, Instances?: Instance[] }[] {
    return this.parseArray(item).map((r: any) => ({
      ReservationId: r.reservationId,
      Instances: this.parseInstances(r.instancesSet?.item || r.instancesSet),
    }))
  }

  private parseInstances(item: any): Instance[] {
    return this.parseArray(item).map((i: any) => ({
      InstanceId: i.instanceId,
      ImageId: i.imageId,
      InstanceType: i.instanceType,
      State: i.instanceState ? {
        Code: Number.parseInt(i.instanceState.code),
        Name: i.instanceState.name,
      } : undefined,
      PrivateIpAddress: i.privateIpAddress,
      PublicIpAddress: i.ipAddress,
      SubnetId: i.subnetId,
      VpcId: i.vpcId,
      SecurityGroups: this.parseArray(i.groupSet?.item).map((g: any) => ({
        GroupId: g.groupId,
        GroupName: g.groupName,
      })),
      Tags: this.parseTags(i.tagSet?.item),
      LaunchTime: i.launchTime,
      Placement: i.placement ? {
        AvailabilityZone: i.placement.availabilityZone,
        Tenancy: i.placement.tenancy,
      } : undefined,
      Architecture: i.architecture,
      RootDeviceType: i.rootDeviceType,
      RootDeviceName: i.rootDeviceName,
      BlockDeviceMappings: this.parseArray(i.blockDeviceMapping?.item).map((b: any) => ({
        DeviceName: b.deviceName,
        Ebs: b.ebs ? {
          VolumeId: b.ebs.volumeId,
          Status: b.ebs.status,
          AttachTime: b.ebs.attachTime,
          DeleteOnTermination: b.ebs.deleteOnTermination === 'true',
        } : undefined,
      })),
      IamInstanceProfile: i.iamInstanceProfile ? {
        Arn: i.iamInstanceProfile.arn,
        Id: i.iamInstanceProfile.id,
      } : undefined,
    }))
  }

  private parseIpPermissions(item: any): IpPermission[] {
    return this.parseArray(item).map((p: any) => ({
      IpProtocol: p.ipProtocol,
      FromPort: p.fromPort ? Number.parseInt(p.fromPort) : undefined,
      ToPort: p.toPort ? Number.parseInt(p.toPort) : undefined,
      IpRanges: this.parseArray(p.ipRanges?.item).map((r: any) => ({
        CidrIp: r.cidrIp,
        Description: r.description,
      })),
      Ipv6Ranges: this.parseArray(p.ipv6Ranges?.item).map((r: any) => ({
        CidrIpv6: r.cidrIpv6,
        Description: r.description,
      })),
      UserIdGroupPairs: this.parseArray(p.groups?.item).map((g: any) => ({
        GroupId: g.groupId,
        UserId: g.userId,
      })),
    }))
  }
}
