import type { CloudFormationResource } from './index'

export interface EC2Instance extends CloudFormationResource {
  Type: 'AWS::EC2::Instance'
  Properties: {
    ImageId: string
    InstanceType: string
    KeyName?: string
    SecurityGroupIds?: string[]
    SubnetId?: string
    IamInstanceProfile?: string
    UserData?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
    BlockDeviceMappings?: Array<{
      DeviceName: string
      Ebs?: {
        VolumeSize?: number
        VolumeType?: 'gp2' | 'gp3' | 'io1' | 'io2' | 'sc1' | 'st1'
        Encrypted?: boolean
        DeleteOnTermination?: boolean
      }
    }>
  }
}

export interface EC2SecurityGroup extends CloudFormationResource {
  Type: 'AWS::EC2::SecurityGroup'
  Properties: {
    GroupName?: string
    GroupDescription: string
    VpcId?: string
    SecurityGroupIngress?: Array<{
      IpProtocol: string
      FromPort?: number
      ToPort?: number
      CidrIp?: string
      SourceSecurityGroupId?: string
      Description?: string
    }>
    SecurityGroupEgress?: Array<{
      IpProtocol: string
      FromPort?: number
      ToPort?: number
      CidrIp?: string
      DestinationSecurityGroupId?: string
      Description?: string
    }>
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EC2VPC extends CloudFormationResource {
  Type: 'AWS::EC2::VPC'
  Properties: {
    CidrBlock: string
    EnableDnsHostnames?: boolean
    EnableDnsSupport?: boolean
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EC2Subnet extends CloudFormationResource {
  Type: 'AWS::EC2::Subnet'
  Properties: {
    VpcId: string | { Ref: string }
    CidrBlock: string
    AvailabilityZone?: string
    MapPublicIpOnLaunch?: boolean
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EC2InternetGateway extends CloudFormationResource {
  Type: 'AWS::EC2::InternetGateway'
  Properties?: {
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EC2NatGateway extends CloudFormationResource {
  Type: 'AWS::EC2::NatGateway'
  Properties: {
    AllocationId: string | { 'Fn::GetAtt': [string, string] }
    SubnetId: string | { Ref: string }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EC2RouteTable extends CloudFormationResource {
  Type: 'AWS::EC2::RouteTable'
  Properties: {
    VpcId: string | { Ref: string }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EC2Route extends CloudFormationResource {
  Type: 'AWS::EC2::Route'
  Properties: {
    RouteTableId: string | { Ref: string }
    DestinationCidrBlock: string
    GatewayId?: string | { Ref: string }
    NatGatewayId?: string | { Ref: string }
    InstanceId?: string | { Ref: string }
  }
}

export interface EC2SubnetRouteTableAssociation extends CloudFormationResource {
  Type: 'AWS::EC2::SubnetRouteTableAssociation'
  Properties: {
    SubnetId: string | { Ref: string }
    RouteTableId: string | { Ref: string }
  }
}

export interface EC2VPCGatewayAttachment extends CloudFormationResource {
  Type: 'AWS::EC2::VPCGatewayAttachment'
  Properties: {
    VpcId: string | { Ref: string }
    InternetGatewayId: string | { Ref: string }
  }
}

export interface EC2EIP extends CloudFormationResource {
  Type: 'AWS::EC2::EIP'
  Properties: {
    Domain?: 'vpc' | 'standard'
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface EC2FlowLog extends CloudFormationResource {
  Type: 'AWS::EC2::FlowLog'
  Properties: {
    ResourceType: 'VPC' | 'Subnet' | 'NetworkInterface'
    ResourceIds: string[] | Array<{ Ref: string }>
    TrafficType: 'ACCEPT' | 'REJECT' | 'ALL'
    LogDestinationType?: 'cloud-watch-logs' | 's3'
    LogDestination?: string
    LogGroupName?: string
    DeliverLogsPermissionArn?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
