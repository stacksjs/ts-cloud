/**
 * AWS Global Accelerator Types
 * CloudFormation resource types for AWS Global Accelerator
 */

import type { Tag } from './common'

export interface Accelerator {
  Type: 'AWS::GlobalAccelerator::Accelerator'
  Properties: {
    Name: string
    Enabled?: boolean
    IpAddressType?: 'IPV4' | 'DUAL_STACK'
    IpAddresses?: string[]
    Tags?: Tag[]
  }
  DeletionPolicy?: 'Delete' | 'Retain'
  UpdateReplacePolicy?: 'Delete' | 'Retain'
}

export interface Listener {
  Type: 'AWS::GlobalAccelerator::Listener'
  Properties: {
    AcceleratorArn: string | { Ref: string }
    Protocol: 'TCP' | 'UDP'
    PortRanges: Array<{
      FromPort: number
      ToPort: number
    }>
    ClientAffinity?: 'NONE' | 'SOURCE_IP'
  }
  DependsOn?: string | string[]
}

export interface EndpointGroup {
  Type: 'AWS::GlobalAccelerator::EndpointGroup'
  Properties: {
    ListenerArn: string | { Ref: string }
    EndpointGroupRegion: string
    EndpointConfigurations?: Array<{
      EndpointId: string | { Ref: string }
      Weight?: number
      ClientIPPreservationEnabled?: boolean
    }>
    TrafficDialPercentage?: number
    HealthCheckIntervalSeconds?: number
    HealthCheckPath?: string
    HealthCheckPort?: number
    HealthCheckProtocol?: 'TCP' | 'HTTP' | 'HTTPS'
    ThresholdCount?: number
    PortOverrides?: Array<{
      ListenerPort: number
      EndpointPort: number
    }>
  }
  DependsOn?: string | string[]
}
