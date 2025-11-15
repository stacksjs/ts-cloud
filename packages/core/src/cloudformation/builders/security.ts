import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface SecurityConfig {
  certificate?: {
    domain: string
    subdomains?: string[]
    validationMethod?: 'DNS' | 'EMAIL'
  }
  waf?: {
    enabled: boolean
    rules?: string[]
    rateLimit?: number
    scope?: 'REGIONAL' | 'CLOUDFRONT'
  }
  securityGroups?: Record<string, {
    ingress?: Array<{
      port: number
      protocol: string
      cidr?: string
      source?: string
    }>
    egress?: Array<{
      port: number
      protocol: string
      cidr?: string
    }>
  }>
}

/**
 * Add security resources (ACM certificates, WAF, security groups) to CloudFormation template
 */
export function addSecurityResources(
  builder: CloudFormationBuilder,
  config: SecurityConfig,
): void {
  // ACM Certificate
  if (config.certificate) {
    addCertificate(builder, config.certificate)
  }

  // WAF Web ACL
  if (config.waf?.enabled) {
    addWAF(builder, config.waf)
  }

  // Additional Security Groups
  if (config.securityGroups) {
    for (const [name, sgConfig] of Object.entries(config.securityGroups)) {
      addSecurityGroup(builder, name, sgConfig)
    }
  }
}

/**
 * Add ACM SSL/TLS Certificate
 */
function addCertificate(
  builder: CloudFormationBuilder,
  config: SecurityConfig['certificate'],
): void {
  if (!config) return

  const domains = [config.domain]
  if (config.subdomains) {
    domains.push(...config.subdomains)
  }

  builder.addResource('Certificate', 'AWS::CertificateManager::Certificate', {
    DomainName: config.domain,
    SubjectAlternativeNames: config.subdomains,
    ValidationMethod: config.validationMethod || 'DNS',
    DomainValidationOptions: domains.map(domain => ({
      DomainName: domain,
      HostedZoneId: Fn.ref('HostedZone'),
    })),
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-certificate`) },
    ],
  })

  // Output
  builder.template.Outputs = {
    ...builder.template.Outputs,
    CertificateArn: {
      Description: 'ACM Certificate ARN',
      Value: Fn.ref('Certificate'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-certificate-arn'),
      },
    },
  }
}

/**
 * Add AWS WAF Web ACL
 */
function addWAF(
  builder: CloudFormationBuilder,
  config: SecurityConfig['waf'],
): void {
  if (!config) return

  const rules: any[] = []
  const ruleNames = config.rules || ['rateLimit', 'sqlInjection', 'xss']

  // Rate limiting rule
  if (ruleNames.includes('rateLimit')) {
    rules.push({
      Name: 'RateLimitRule',
      Priority: 1,
      Statement: {
        RateBasedStatement: {
          Limit: config.rateLimit || 2000,
          AggregateKeyType: 'IP',
        },
      },
      Action: {
        Block: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'RateLimitRule',
      },
    })
  }

  // AWS Managed Rules
  let priority = rules.length + 1

  if (ruleNames.includes('sqlInjection')) {
    rules.push({
      Name: 'AWSManagedRulesSQLi',
      Priority: priority++,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: 'AWSManagedRulesSQLiRuleSet',
        },
      },
      OverrideAction: {
        None: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'AWSManagedRulesSQLi',
      },
    })
  }

  if (ruleNames.includes('xss')) {
    rules.push({
      Name: 'AWSManagedRulesXSS',
      Priority: priority++,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: 'AWSManagedRulesKnownBadInputsRuleSet',
        },
      },
      OverrideAction: {
        None: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'AWSManagedRulesXSS',
      },
    })
  }

  if (ruleNames.includes('knownBadInputs')) {
    rules.push({
      Name: 'AWSManagedRulesKnownBadInputs',
      Priority: priority++,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: 'AWSManagedRulesKnownBadInputsRuleSet',
        },
      },
      OverrideAction: {
        None: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'AWSManagedRulesKnownBadInputs',
      },
    })
  }

  if (ruleNames.includes('coreRuleSet')) {
    rules.push({
      Name: 'AWSManagedRulesCoreRuleSet',
      Priority: priority++,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: 'AWSManagedRulesCommonRuleSet',
        },
      },
      OverrideAction: {
        None: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'AWSManagedRulesCoreRuleSet',
      },
    })
  }

  if (ruleNames.includes('linuxRuleSet')) {
    rules.push({
      Name: 'AWSManagedRulesLinuxRuleSet',
      Priority: priority++,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: 'AWSManagedRulesLinuxRuleSet',
        },
      },
      OverrideAction: {
        None: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'AWSManagedRulesLinuxRuleSet',
      },
    })
  }

  if (ruleNames.includes('apiProtection')) {
    rules.push({
      Name: 'AWSManagedRulesAPIProtection',
      Priority: priority++,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: 'AWS',
          Name: 'AWSManagedRulesAmazonIpReputationList',
        },
      },
      OverrideAction: {
        None: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'AWSManagedRulesAPIProtection',
      },
    })
  }

  if (ruleNames.includes('geoBlock')) {
    // Example: Block traffic from certain countries
    rules.push({
      Name: 'GeoBlockRule',
      Priority: priority++,
      Statement: {
        GeoMatchStatement: {
          CountryCodes: ['CN', 'RU'], // Example countries to block
        },
      },
      Action: {
        Block: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'GeoBlockRule',
      },
    })
  }

  if (ruleNames.includes('connectionLimit')) {
    rules.push({
      Name: 'ConnectionLimitRule',
      Priority: priority++,
      Statement: {
        RateBasedStatement: {
          Limit: 100,
          AggregateKeyType: 'IP',
        },
      },
      Action: {
        Block: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'ConnectionLimitRule',
      },
    })
  }

  // Web ACL
  builder.addResource('WebACL', 'AWS::WAFv2::WebACL', {
    Name: Fn.sub('${AWS::StackName}-waf'),
    Scope: config.scope || 'REGIONAL',
    DefaultAction: {
      Allow: {},
    },
    Rules: rules,
    VisibilityConfig: {
      SampledRequestsEnabled: true,
      CloudWatchMetricsEnabled: true,
      MetricName: Fn.sub('${AWS::StackName}-waf'),
    },
    Tags: [
      { Key: 'Name', Value: Fn.sub('${AWS::StackName}-waf') },
    ],
  })

  // Associate WAF with ALB (if exists)
  if (builder.template.Resources.LoadBalancer) {
    builder.addResource('WebACLAssociation', 'AWS::WAFv2::WebACLAssociation', {
      ResourceArn: Fn.ref('LoadBalancer'),
      WebACLArn: Fn.getAtt('WebACL', 'Arn'),
    }, {
      dependsOn: ['WebACL', 'LoadBalancer'],
    })
  }

  // Output
  builder.template.Outputs = {
    ...builder.template.Outputs,
    WebACLId: {
      Description: 'WAF Web ACL ID',
      Value: Fn.ref('WebACL'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-waf-id'),
      },
    },
    WebACLArn: {
      Description: 'WAF Web ACL ARN',
      Value: Fn.getAtt('WebACL', 'Arn'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-waf-arn'),
      },
    },
  }
}

/**
 * Add Security Group
 */
function addSecurityGroup(
  builder: CloudFormationBuilder,
  name: string,
  config: SecurityConfig['securityGroups'][string],
): void {
  const logicalId = builder.toLogicalId(`${name}-security-group`)

  const ingressRules = config.ingress?.map(rule => ({
    IpProtocol: rule.protocol,
    FromPort: rule.port,
    ToPort: rule.port,
    CidrIp: rule.cidr,
    SourceSecurityGroupId: rule.source ? Fn.ref(rule.source) : undefined,
  })) || []

  const egressRules = config.egress?.map(rule => ({
    IpProtocol: rule.protocol,
    FromPort: rule.port,
    ToPort: rule.port,
    CidrIp: rule.cidr || '0.0.0.0/0',
  })) || [{
    IpProtocol: '-1',
    CidrIp: '0.0.0.0/0',
  }]

  builder.addResource(logicalId, 'AWS::EC2::SecurityGroup', {
    GroupDescription: `Security group for ${name}`,
    VpcId: Fn.ref('VPC'),
    SecurityGroupIngress: ingressRules,
    SecurityGroupEgress: egressRules,
    Tags: [
      { Key: 'Name', Value: Fn.sub(`\${AWS::StackName}-${name}-sg`) },
    ],
  }, {
    dependsOn: 'VPC',
  })

  // Output
  builder.template.Outputs = {
    ...builder.template.Outputs,
    [`${logicalId}Id`]: {
      Description: `${name} security group ID`,
      Value: Fn.ref(logicalId),
      Export: {
        Name: Fn.sub(`\${AWS::StackName}-${name}-sg-id`),
      },
    },
  }
}
