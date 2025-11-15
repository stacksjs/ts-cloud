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
    }>
    SecurityGroupEgress?: Array<{
      IpProtocol: string
      FromPort?: number
      ToPort?: number
      CidrIp?: string
      DestinationSecurityGroupId?: string
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
