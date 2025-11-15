import type { CloudFormationResource } from './index'

export interface WAFv2WebACL extends CloudFormationResource {
  Type: 'AWS::WAFv2::WebACL'
  Properties: {
    Name: string
    Scope: 'CLOUDFRONT' | 'REGIONAL'
    DefaultAction: {
      Allow?: Record<string, unknown>
      Block?: Record<string, unknown>
    }
    Description?: string
    Rules?: Array<{
      Name: string
      Priority: number
      Statement: {
        ByteMatchStatement?: {
          SearchString: string
          FieldToMatch: unknown
          TextTransformations: Array<{
            Priority: number
            Type: string
          }>
          PositionalConstraint: 'EXACTLY' | 'STARTS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'CONTAINS_WORD'
        }
        GeoMatchStatement?: {
          CountryCodes: string[]
        }
        IPSetReferenceStatement?: {
          Arn: string
        }
        RateBasedStatement?: {
          Limit: number
          AggregateKeyType: 'IP' | 'FORWARDED_IP'
        }
        ManagedRuleGroupStatement?: {
          VendorName: string
          Name: string
          ExcludedRules?: Array<{
            Name: string
          }>
        }
      }
      Action?: {
        Allow?: Record<string, unknown>
        Block?: Record<string, unknown>
        Count?: Record<string, unknown>
      }
      VisibilityConfig: {
        SampledRequestsEnabled: boolean
        CloudWatchMetricsEnabled: boolean
        MetricName: string
      }
    }>
    VisibilityConfig: {
      SampledRequestsEnabled: boolean
      CloudWatchMetricsEnabled: boolean
      MetricName: string
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface WAFv2IPSet extends CloudFormationResource {
  Type: 'AWS::WAFv2::IPSet'
  Properties: {
    Name: string
    Scope: 'CLOUDFRONT' | 'REGIONAL'
    IPAddressVersion: 'IPV4' | 'IPV6'
    Addresses: string[]
    Description?: string
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}
