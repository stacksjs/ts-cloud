/**
 * AWS Elastic Load Balancing V2 (ELBv2) Operations
 * Direct API calls without AWS CLI dependency
 *
 * Supports Application Load Balancers (ALB), Network Load Balancers (NLB),
 * and Gateway Load Balancers (GWLB)
*/

import { AWSClient } from './client'

export interface LoadBalancer {
  LoadBalancerArn?: string
  DNSName?: string
  CanonicalHostedZoneId?: string
  CreatedTime?: string
  LoadBalancerName?: string
  Scheme?: 'internet-facing' | 'internal'
  VpcId?: string
  State?: {
    Code?: 'active' | 'provisioning' | 'active_impaired' | 'failed'
    Reason?: string
  }
  Type?: 'application' | 'network' | 'gateway'
  AvailabilityZones?: AvailabilityZone[]
  SecurityGroups?: string[]
  IpAddressType?: 'ipv4' | 'dualstack'
}

export interface AvailabilityZone {
  ZoneName?: string
  SubnetId?: string
  OutpostId?: string
  LoadBalancerAddresses?: LoadBalancerAddress[]
}

export interface LoadBalancerAddress {
  IpAddress?: string
  AllocationId?: string
  PrivateIPv4Address?: string
  IPv6Address?: string
}

export interface TargetGroup {
  TargetGroupArn?: string
  TargetGroupName?: string
  Protocol?: string
  Port?: number
  VpcId?: string
  HealthCheckProtocol?: string
  HealthCheckPort?: string
  HealthCheckEnabled?: boolean
  HealthCheckIntervalSeconds?: number
  HealthCheckTimeoutSeconds?: number
  HealthyThresholdCount?: number
  UnhealthyThresholdCount?: number
  HealthCheckPath?: string
  Matcher?: {
    HttpCode?: string
    GrpcCode?: string
  }
  LoadBalancerArns?: string[]
  TargetType?: 'instance' | 'ip' | 'lambda' | 'alb'
  ProtocolVersion?: string
  IpAddressType?: 'ipv4' | 'ipv6'
}

export interface Listener {
  ListenerArn?: string
  LoadBalancerArn?: string
  Port?: number
  Protocol?: string
  Certificates?: Certificate[]
  SslPolicy?: string
  DefaultActions?: Action[]
  AlpnPolicy?: string[]
}

export interface Certificate {
  CertificateArn?: string
  IsDefault?: boolean
}

export interface Action {
  Type?: 'forward' | 'redirect' | 'fixed-response' | 'authenticate-oidc' | 'authenticate-cognito'
  TargetGroupArn?: string
  Order?: number
  RedirectConfig?: {
    Protocol?: string
    Port?: string
    Host?: string
    Path?: string
    Query?: string
    StatusCode?: 'HTTP_301' | 'HTTP_302'
  }
  FixedResponseConfig?: {
    MessageBody?: string
    StatusCode?: string
    ContentType?: string
  }
  ForwardConfig?: {
    TargetGroups?: Array<{
      TargetGroupArn?: string
      Weight?: number
    }>
    TargetGroupStickinessConfig?: {
      Enabled?: boolean
      DurationSeconds?: number
    }
  }
}

export interface Rule {
  RuleArn?: string
  Priority?: string
  Conditions?: Condition[]
  Actions?: Action[]
  IsDefault?: boolean
}

export interface Condition {
  Field?: string
  Values?: string[]
  HostHeaderConfig?: { Values?: string[] }
  PathPatternConfig?: { Values?: string[] }
  HttpHeaderConfig?: { HttpHeaderName?: string, Values?: string[] }
  QueryStringConfig?: { Values?: Array<{ Key?: string, Value?: string }> }
  HttpRequestMethodConfig?: { Values?: string[] }
  SourceIpConfig?: { Values?: string[] }
}

export interface TargetHealthDescription {
  Target?: {
    Id?: string
    Port?: number
    AvailabilityZone?: string
  }
  HealthCheckPort?: string
  TargetHealth?: {
    State?: 'initial' | 'healthy' | 'unhealthy' | 'unused' | 'draining' | 'unavailable'
    Reason?: string
    Description?: string
  }
}

/**
 * ELBv2 client for managing Application, Network, and Gateway Load Balancers
*/
export class ELBv2Client {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  /**
   * Describe load balancers
  */
  async describeLoadBalancers(options?: {
    LoadBalancerArns?: string[]
    Names?: string[]
    Marker?: string
    PageSize?: number
  }): Promise<{ LoadBalancers?: LoadBalancer[], NextMarker?: string }> {
    const params: Record<string, any> = {}

    if (options?.LoadBalancerArns) {
      options.LoadBalancerArns.forEach((arn, index) => {
        params[`LoadBalancerArns.member.${index + 1}`] = arn
      })
    }

    if (options?.Names) {
      options.Names.forEach((name, index) => {
        params[`Names.member.${index + 1}`] = name
      })
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    if (options?.PageSize) {
      params.PageSize = options.PageSize
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DescribeLoadBalancers', params),
    })

    return this.normalizeResult(result, 'DescribeLoadBalancersResult')
  }

  /**
   * Describe target groups
  */
  async describeTargetGroups(options?: {
    LoadBalancerArn?: string
    TargetGroupArns?: string[]
    Names?: string[]
    Marker?: string
    PageSize?: number
  }): Promise<{ TargetGroups?: TargetGroup[], NextMarker?: string }> {
    const params: Record<string, any> = {}

    if (options?.LoadBalancerArn) {
      params.LoadBalancerArn = options.LoadBalancerArn
    }

    if (options?.TargetGroupArns) {
      options.TargetGroupArns.forEach((arn, index) => {
        params[`TargetGroupArns.member.${index + 1}`] = arn
      })
    }

    if (options?.Names) {
      options.Names.forEach((name, index) => {
        params[`Names.member.${index + 1}`] = name
      })
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    if (options?.PageSize) {
      params.PageSize = options.PageSize
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DescribeTargetGroups', params),
    })

    return this.normalizeResult(result, 'DescribeTargetGroupsResult')
  }

  /**
   * Describe target health
  */
  async describeTargetHealth(options: {
    TargetGroupArn: string
    Targets?: Array<{ Id: string, Port?: number, AvailabilityZone?: string }>
  }): Promise<{ TargetHealthDescriptions?: TargetHealthDescription[] }> {
    const params: Record<string, any> = {
      TargetGroupArn: options.TargetGroupArn,
    }

    if (options.Targets) {
      options.Targets.forEach((target, index) => {
        params[`Targets.member.${index + 1}.Id`] = target.Id
        if (target.Port) {
          params[`Targets.member.${index + 1}.Port`] = target.Port
        }
        if (target.AvailabilityZone) {
          params[`Targets.member.${index + 1}.AvailabilityZone`] = target.AvailabilityZone
        }
      })
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DescribeTargetHealth', params),
    })

    return this.normalizeResult(result, 'DescribeTargetHealthResult')
  }

  /**
   * Describe listeners
  */
  async describeListeners(options?: {
    LoadBalancerArn?: string
    ListenerArns?: string[]
    Marker?: string
    PageSize?: number
  }): Promise<{ Listeners?: Listener[], NextMarker?: string }> {
    const params: Record<string, any> = {}

    if (options?.LoadBalancerArn) {
      params.LoadBalancerArn = options.LoadBalancerArn
    }

    if (options?.ListenerArns) {
      options.ListenerArns.forEach((arn, index) => {
        params[`ListenerArns.member.${index + 1}`] = arn
      })
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    if (options?.PageSize) {
      params.PageSize = options.PageSize
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DescribeListeners', params),
    })

    return this.normalizeResult(result, 'DescribeListenersResult')
  }

  /**
   * Describe rules for a listener
  */
  async describeRules(options?: {
    ListenerArn?: string
    RuleArns?: string[]
    Marker?: string
    PageSize?: number
  }): Promise<{ Rules?: Rule[], NextMarker?: string }> {
    const params: Record<string, any> = {}

    if (options?.ListenerArn) {
      params.ListenerArn = options.ListenerArn
    }

    if (options?.RuleArns) {
      options.RuleArns.forEach((arn, index) => {
        params[`RuleArns.member.${index + 1}`] = arn
      })
    }

    if (options?.Marker) {
      params.Marker = options.Marker
    }

    if (options?.PageSize) {
      params.PageSize = options.PageSize
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DescribeRules', params),
    })

    return this.normalizeResult(result, 'DescribeRulesResult')
  }

  /**
   * Describe load balancer attributes
  */
  async describeLoadBalancerAttributes(loadBalancerArn: string): Promise<{ Attributes?: Array<{ Key: string, Value: string }> }> {
    const params = {
      LoadBalancerArn: loadBalancerArn,
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DescribeLoadBalancerAttributes', params),
    })

    return this.normalizeResult(result, 'DescribeLoadBalancerAttributesResult')
  }

  /**
   * Describe target group attributes
  */
  async describeTargetGroupAttributes(targetGroupArn: string): Promise<{ Attributes?: Array<{ Key: string, Value: string }> }> {
    const params = {
      TargetGroupArn: targetGroupArn,
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DescribeTargetGroupAttributes', params),
    })

    return this.normalizeResult(result, 'DescribeTargetGroupAttributesResult')
  }

  /**
   * Create a load balancer
  */
  async createLoadBalancer(options: {
    Name: string
    Subnets?: string[]
    SubnetMappings?: Array<{
      SubnetId: string
      AllocationId?: string
      PrivateIPv4Address?: string
      IPv6Address?: string
    }>
    SecurityGroups?: string[]
    Scheme?: 'internet-facing' | 'internal'
    Type?: 'application' | 'network' | 'gateway'
    IpAddressType?: 'ipv4' | 'dualstack'
    Tags?: Array<{ Key: string, Value: string }>
  }): Promise<{ LoadBalancers?: LoadBalancer[] }> {
    const params: Record<string, any> = {
      Name: options.Name,
    }

    if (options.Subnets) {
      options.Subnets.forEach((subnet, index) => {
        params[`Subnets.member.${index + 1}`] = subnet
      })
    }

    if (options.SubnetMappings) {
      options.SubnetMappings.forEach((mapping, index) => {
        params[`SubnetMappings.member.${index + 1}.SubnetId`] = mapping.SubnetId
        if (mapping.AllocationId) {
          params[`SubnetMappings.member.${index + 1}.AllocationId`] = mapping.AllocationId
        }
        if (mapping.PrivateIPv4Address) {
          params[`SubnetMappings.member.${index + 1}.PrivateIPv4Address`] = mapping.PrivateIPv4Address
        }
        if (mapping.IPv6Address) {
          params[`SubnetMappings.member.${index + 1}.IPv6Address`] = mapping.IPv6Address
        }
      })
    }

    if (options.SecurityGroups) {
      options.SecurityGroups.forEach((sg, index) => {
        params[`SecurityGroups.member.${index + 1}`] = sg
      })
    }

    if (options.Scheme) {
      params.Scheme = options.Scheme
    }

    if (options.Type) {
      params.Type = options.Type
    }

    if (options.IpAddressType) {
      params.IpAddressType = options.IpAddressType
    }

    if (options.Tags) {
      options.Tags.forEach((tag, index) => {
        params[`Tags.member.${index + 1}.Key`] = tag.Key
        params[`Tags.member.${index + 1}.Value`] = tag.Value
      })
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('CreateLoadBalancer', params),
    })

    return this.normalizeResult(result, 'CreateLoadBalancerResult')
  }

  /**
   * Delete a load balancer
  */
  async deleteLoadBalancer(loadBalancerArn: string): Promise<void> {
    const params = {
      LoadBalancerArn: loadBalancerArn,
    }

    await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DeleteLoadBalancer', params),
    })
  }

  /**
   * Create a target group
  */
  async createTargetGroup(options: {
    Name: string
    Protocol?: string
    ProtocolVersion?: string
    Port?: number
    VpcId?: string
    HealthCheckProtocol?: string
    HealthCheckPort?: string
    HealthCheckEnabled?: boolean
    HealthCheckPath?: string
    HealthCheckIntervalSeconds?: number
    HealthCheckTimeoutSeconds?: number
    HealthyThresholdCount?: number
    UnhealthyThresholdCount?: number
    Matcher?: { HttpCode?: string, GrpcCode?: string }
    TargetType?: 'instance' | 'ip' | 'lambda' | 'alb'
    Tags?: Array<{ Key: string, Value: string }>
    IpAddressType?: 'ipv4' | 'ipv6'
  }): Promise<{ TargetGroups?: TargetGroup[] }> {
    const params: Record<string, any> = {
      Name: options.Name,
    }

    if (options.Protocol) params.Protocol = options.Protocol
    if (options.ProtocolVersion) params.ProtocolVersion = options.ProtocolVersion
    if (options.Port) params.Port = options.Port
    if (options.VpcId) params.VpcId = options.VpcId
    if (options.HealthCheckProtocol) params.HealthCheckProtocol = options.HealthCheckProtocol
    if (options.HealthCheckPort) params.HealthCheckPort = options.HealthCheckPort
    if (options.HealthCheckEnabled !== undefined) params.HealthCheckEnabled = options.HealthCheckEnabled
    if (options.HealthCheckPath) params.HealthCheckPath = options.HealthCheckPath
    if (options.HealthCheckIntervalSeconds) params.HealthCheckIntervalSeconds = options.HealthCheckIntervalSeconds
    if (options.HealthCheckTimeoutSeconds) params.HealthCheckTimeoutSeconds = options.HealthCheckTimeoutSeconds
    if (options.HealthyThresholdCount) params.HealthyThresholdCount = options.HealthyThresholdCount
    if (options.UnhealthyThresholdCount) params.UnhealthyThresholdCount = options.UnhealthyThresholdCount
    if (options.TargetType) params.TargetType = options.TargetType
    if (options.IpAddressType) params.IpAddressType = options.IpAddressType

    if (options.Matcher) {
      if (options.Matcher.HttpCode) params['Matcher.HttpCode'] = options.Matcher.HttpCode
      if (options.Matcher.GrpcCode) params['Matcher.GrpcCode'] = options.Matcher.GrpcCode
    }

    if (options.Tags) {
      options.Tags.forEach((tag, index) => {
        params[`Tags.member.${index + 1}.Key`] = tag.Key
        params[`Tags.member.${index + 1}.Value`] = tag.Value
      })
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('CreateTargetGroup', params),
    })

    return this.normalizeResult(result, 'CreateTargetGroupResult')
  }

  /**
   * Delete a target group
  */
  async deleteTargetGroup(targetGroupArn: string): Promise<void> {
    const params = {
      TargetGroupArn: targetGroupArn,
    }

    await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DeleteTargetGroup', params),
    })
  }

  /**
   * Register targets with a target group
  */
  async registerTargets(options: {
    TargetGroupArn: string
    Targets: Array<{ Id: string, Port?: number, AvailabilityZone?: string }>
  }): Promise<void> {
    const params: Record<string, any> = {
      TargetGroupArn: options.TargetGroupArn,
    }

    options.Targets.forEach((target, index) => {
      params[`Targets.member.${index + 1}.Id`] = target.Id
      if (target.Port) {
        params[`Targets.member.${index + 1}.Port`] = target.Port
      }
      if (target.AvailabilityZone) {
        params[`Targets.member.${index + 1}.AvailabilityZone`] = target.AvailabilityZone
      }
    })

    await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('RegisterTargets', params),
    })
  }

  /**
   * Deregister targets from a target group
  */
  async deregisterTargets(options: {
    TargetGroupArn: string
    Targets: Array<{ Id: string, Port?: number, AvailabilityZone?: string }>
  }): Promise<void> {
    const params: Record<string, any> = {
      TargetGroupArn: options.TargetGroupArn,
    }

    options.Targets.forEach((target, index) => {
      params[`Targets.member.${index + 1}.Id`] = target.Id
      if (target.Port) {
        params[`Targets.member.${index + 1}.Port`] = target.Port
      }
      if (target.AvailabilityZone) {
        params[`Targets.member.${index + 1}.AvailabilityZone`] = target.AvailabilityZone
      }
    })

    await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DeregisterTargets', params),
    })
  }

  /**
   * Create a listener
  */
  async createListener(options: {
    LoadBalancerArn: string
    Protocol?: string
    Port: number
    SslPolicy?: string
    Certificates?: Array<{ CertificateArn: string }>
    DefaultActions: Array<{
      Type: 'forward' | 'redirect' | 'fixed-response'
      TargetGroupArn?: string
      Order?: number
      RedirectConfig?: {
        Protocol?: string
        Port?: string
        Host?: string
        Path?: string
        Query?: string
        StatusCode: 'HTTP_301' | 'HTTP_302'
      }
      FixedResponseConfig?: {
        MessageBody?: string
        StatusCode: string
        ContentType?: string
      }
    }>
    AlpnPolicy?: string[]
    Tags?: Array<{ Key: string, Value: string }>
  }): Promise<{ Listeners?: Listener[] }> {
    const params: Record<string, any> = {
      LoadBalancerArn: options.LoadBalancerArn,
      Port: options.Port,
    }

    if (options.Protocol) params.Protocol = options.Protocol
    if (options.SslPolicy) params.SslPolicy = options.SslPolicy

    if (options.Certificates) {
      options.Certificates.forEach((cert, index) => {
        params[`Certificates.member.${index + 1}.CertificateArn`] = cert.CertificateArn
      })
    }

    options.DefaultActions.forEach((action, index) => {
      params[`DefaultActions.member.${index + 1}.Type`] = action.Type
      if (action.TargetGroupArn) {
        params[`DefaultActions.member.${index + 1}.TargetGroupArn`] = action.TargetGroupArn
      }
      if (action.Order !== undefined) {
        params[`DefaultActions.member.${index + 1}.Order`] = action.Order
      }
      if (action.RedirectConfig) {
        const rc = action.RedirectConfig
        if (rc.Protocol) params[`DefaultActions.member.${index + 1}.RedirectConfig.Protocol`] = rc.Protocol
        if (rc.Port) params[`DefaultActions.member.${index + 1}.RedirectConfig.Port`] = rc.Port
        if (rc.Host) params[`DefaultActions.member.${index + 1}.RedirectConfig.Host`] = rc.Host
        if (rc.Path) params[`DefaultActions.member.${index + 1}.RedirectConfig.Path`] = rc.Path
        if (rc.Query) params[`DefaultActions.member.${index + 1}.RedirectConfig.Query`] = rc.Query
        params[`DefaultActions.member.${index + 1}.RedirectConfig.StatusCode`] = rc.StatusCode
      }
      if (action.FixedResponseConfig) {
        const fr = action.FixedResponseConfig
        if (fr.MessageBody) params[`DefaultActions.member.${index + 1}.FixedResponseConfig.MessageBody`] = fr.MessageBody
        params[`DefaultActions.member.${index + 1}.FixedResponseConfig.StatusCode`] = fr.StatusCode
        if (fr.ContentType) params[`DefaultActions.member.${index + 1}.FixedResponseConfig.ContentType`] = fr.ContentType
      }
    })

    if (options.AlpnPolicy) {
      options.AlpnPolicy.forEach((policy, index) => {
        params[`AlpnPolicy.member.${index + 1}`] = policy
      })
    }

    if (options.Tags) {
      options.Tags.forEach((tag, index) => {
        params[`Tags.member.${index + 1}.Key`] = tag.Key
        params[`Tags.member.${index + 1}.Value`] = tag.Value
      })
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('CreateListener', params),
    })

    return this.normalizeResult(result, 'CreateListenerResult')
  }

  /**
   * Delete a listener
  */
  async deleteListener(listenerArn: string): Promise<void> {
    const params = {
      ListenerArn: listenerArn,
    }

    await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('DeleteListener', params),
    })
  }

  /**
   * Modify listener
  */
  async modifyListener(options: {
    ListenerArn: string
    Port?: number
    Protocol?: string
    SslPolicy?: string
    Certificates?: Array<{ CertificateArn: string }>
    DefaultActions?: Action[]
    AlpnPolicy?: string[]
  }): Promise<{ Listeners?: Listener[] }> {
    const params: Record<string, any> = {
      ListenerArn: options.ListenerArn,
    }

    if (options.Port) params.Port = options.Port
    if (options.Protocol) params.Protocol = options.Protocol
    if (options.SslPolicy) params.SslPolicy = options.SslPolicy

    if (options.Certificates) {
      options.Certificates.forEach((cert, index) => {
        params[`Certificates.member.${index + 1}.CertificateArn`] = cert.CertificateArn
      })
    }

    if (options.DefaultActions) {
      options.DefaultActions.forEach((action, index) => {
        if (action.Type) params[`DefaultActions.member.${index + 1}.Type`] = action.Type
        if (action.TargetGroupArn) params[`DefaultActions.member.${index + 1}.TargetGroupArn`] = action.TargetGroupArn
        if (action.Order !== undefined) params[`DefaultActions.member.${index + 1}.Order`] = action.Order
      })
    }

    if (options.AlpnPolicy) {
      options.AlpnPolicy.forEach((policy, index) => {
        params[`AlpnPolicy.member.${index + 1}`] = policy
      })
    }

    const result = await this.client.request({
      service: 'elasticloadbalancing',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: this.buildFormBody('ModifyListener', params),
    })

    return this.normalizeResult(result, 'ModifyListenerResult')
  }

  /**
   * Build form URL encoded body for ELBv2 API
  */
  private buildFormBody(action: string, params: Record<string, any>): string {
    const formParams: Record<string, string> = {
      Action: action,
      Version: '2015-12-01',
    }

    // Flatten params
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        formParams[key] = String(value)
      }
    }

    return Object.entries(formParams)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')
  }

  /**
   * Normalize the parsed XML result from AWS API
   * The client parses XML to JSON, so we need to extract the result
  */
  private normalizeResult(parsed: any, resultKey: string): any {
    // The AWS response is wrapped like: { DescribeLoadBalancersResponse: { DescribeLoadBalancersResult: {...} } }
    // fast-xml-parser returns: { DescribeLoadBalancersResult: {...}, ResponseMetadata: {...} }

    // Try direct access first
    if (parsed && parsed[resultKey]) {
      return this.normalizeArrays(parsed[resultKey])
    }

    // Try accessing through response wrapper
    const responseKey = resultKey.replace('Result', 'Response')
    if (parsed && parsed[responseKey] && parsed[responseKey][resultKey]) {
      return this.normalizeArrays(parsed[responseKey][resultKey])
    }

    // Return parsed as-is if no wrapper found
    return this.normalizeArrays(parsed)
  }

  /**
   * Normalize arrays in the response
   * AWS XML parsing sometimes returns single items as objects instead of arrays
  */
  private normalizeArrays(obj: any): any {
    if (!obj || typeof obj !== 'object') {
      return obj
    }

    // Handle arrays
    if (Array.isArray(obj)) {
      return obj.map(item => this.normalizeArrays(item))
    }

    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      // Known array fields that should always be arrays
      const arrayFields = [
        'LoadBalancers', 'TargetGroups', 'Listeners', 'Rules',
        'TargetHealthDescriptions', 'Attributes', 'SecurityGroups',
        'AvailabilityZones', 'Certificates', 'DefaultActions',
        'Conditions', 'Actions', 'member'
      ]

      if (key === 'member') {
        // AWS returns arrays as { member: [...] } or { member: {...} }
        if (Array.isArray(value)) {
          return value.map(item => this.normalizeArrays(item))
        }
        return [this.normalizeArrays(value)]
      }

      if (arrayFields.includes(key)) {
        if (value && typeof value === 'object' && 'member' in (value as any)) {
          const memberValue = (value as any).member
          result[key] = Array.isArray(memberValue)
            ? memberValue.map((item: any) => this.normalizeArrays(item))
            : [this.normalizeArrays(memberValue)]
        } else if (Array.isArray(value)) {
          result[key] = value.map(item => this.normalizeArrays(item))
        } else if (value) {
          result[key] = [this.normalizeArrays(value)]
        } else {
          result[key] = []
        }
      } else if (typeof value === 'object') {
        result[key] = this.normalizeArrays(value)
      } else {
        result[key] = value
      }
    }

    return result
  }
}
