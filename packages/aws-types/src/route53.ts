import type { CloudFormationResource } from './index'

export interface Route53HostedZone extends CloudFormationResource {
  Type: 'AWS::Route53::HostedZone'
  Properties: {
    Name: string
    HostedZoneConfig?: {
      Comment?: string
    }
    HostedZoneTags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface Route53RecordSet extends CloudFormationResource {
  Type: 'AWS::Route53::RecordSet'
  Properties: {
    HostedZoneId?: string
    HostedZoneName?: string
    Name: string
    Type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'PTR' | 'SOA' | 'SPF' | 'SRV' | 'TXT'
    TTL?: number
    ResourceRecords?: string[]
    AliasTarget?: {
      DNSName: string
      EvaluateTargetHealth?: boolean
      HostedZoneId: string
    }
  }
}
