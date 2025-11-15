import type { CloudFormationResource } from './index'

export interface ApplicationLoadBalancer extends CloudFormationResource {
  Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer'
  Properties: {
    Name?: string
    Scheme?: 'internet-facing' | 'internal'
    Type?: 'application' | 'network' | 'gateway'
    IpAddressType?: 'ipv4' | 'dualstack'
    Subnets?: string[]
    SecurityGroups?: string[]
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface TargetGroup extends CloudFormationResource {
  Type: 'AWS::ElasticLoadBalancingV2::TargetGroup'
  Properties: {
    Name?: string
    Port: number
    Protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'TLS' | 'UDP' | 'TCP_UDP'
    VpcId: string | { Ref: string }
    TargetType?: 'instance' | 'ip' | 'lambda' | 'alb'
    HealthCheckEnabled?: boolean
    HealthCheckProtocol?: 'HTTP' | 'HTTPS' | 'TCP' | 'TLS' | 'UDP' | 'TCP_UDP'
    HealthCheckPath?: string
    HealthCheckIntervalSeconds?: number
    HealthCheckTimeoutSeconds?: number
    HealthyThresholdCount?: number
    UnhealthyThresholdCount?: number
    Matcher?: {
      HttpCode?: string
      GrpcCode?: string
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface Listener extends CloudFormationResource {
  Type: 'AWS::ElasticLoadBalancingV2::Listener'
  Properties: {
    LoadBalancerArn: string | { Ref: string }
    Port: number
    Protocol: 'HTTP' | 'HTTPS' | 'TCP' | 'TLS' | 'UDP' | 'TCP_UDP'
    Certificates?: Array<{
      CertificateArn: string
    }>
    SslPolicy?: string
    DefaultActions: Array<{
      Type: 'forward' | 'redirect' | 'fixed-response' | 'authenticate-cognito' | 'authenticate-oidc'
      TargetGroupArn?: string | { Ref: string }
      RedirectConfig?: {
        Protocol?: string
        Port?: string
        Host?: string
        Path?: string
        Query?: string
        StatusCode: 'HTTP_301' | 'HTTP_302'
      }
      FixedResponseConfig?: {
        StatusCode: string
        ContentType?: string
        MessageBody?: string
      }
    }>
  }
}
