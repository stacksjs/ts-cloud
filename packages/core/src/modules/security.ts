import type { ACMCertificate, KMSAlias, KMSKey, WAFv2IPSet, WAFv2WebACL } from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface CertificateOptions {
  domain: string
  subdomains?: string[]
  slug: string
  environment: EnvironmentType
  validationMethod?: 'DNS' | 'EMAIL'
  hostedZoneId?: string
}

export interface KmsKeyOptions {
  description: string
  slug: string
  environment: EnvironmentType
  enableRotation?: boolean
  multiRegion?: boolean
}

export interface FirewallOptions {
  slug: string
  environment: EnvironmentType
  scope?: 'CLOUDFRONT' | 'REGIONAL'
  defaultAction?: 'allow' | 'block'
}

export interface RateLimitRule {
  name: string
  priority: number
  requestsPerWindow: number
  aggregateKeyType?: 'IP' | 'FORWARDED_IP'
}

export interface GeoBlockRule {
  name: string
  priority: number
  countryCodes: string[]
}

export interface IpBlockRule {
  name: string
  priority: number
  ipAddresses: string[]
  ipVersion?: 'IPV4' | 'IPV6'
}

export interface ManagedRuleGroup {
  name: string
  priority: number
  vendorName: string
  ruleName: string
  excludedRules?: string[]
}

/**
 * Security Module - ACM, KMS, WAF Management
 * Provides clean API for creating and configuring security resources
 */
export class Security {
  /**
   * Create an SSL/TLS certificate with ACM
   */
  static createCertificate(options: CertificateOptions): {
    certificate: ACMCertificate
    logicalId: string
  } {
    const {
      domain,
      subdomains = [],
      slug,
      environment,
      validationMethod = 'DNS',
      hostedZoneId,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'acm',
    })

    const logicalId = generateLogicalId(`${resourceName}-${domain.replace(/\./g, '')}`)

    // Build SubjectAlternativeNames (SANs) - includes the main domain plus subdomains
    const sans: string[] = [domain]
    for (const subdomain of subdomains) {
      // Support wildcard notation
      if (subdomain === '*') {
        sans.push(`*.${domain}`)
      }
      else {
        sans.push(`${subdomain}.${domain}`)
      }
    }

    const certificate: ACMCertificate = {
      Type: 'AWS::CertificateManager::Certificate',
      Properties: {
        DomainName: domain,
        SubjectAlternativeNames: sans,
        ValidationMethod: validationMethod,
      },
    }

    // Add DNS validation with Route53 if hostedZoneId is provided
    if (validationMethod === 'DNS' && hostedZoneId) {
      certificate.Properties.DomainValidationOptions = sans.map(domainName => ({
        DomainName: domainName,
        HostedZoneId: hostedZoneId,
      }))
    }

    return { certificate, logicalId }
  }

  /**
   * Create a KMS encryption key
   */
  static createKmsKey(options: KmsKeyOptions): {
    key: KMSKey
    alias?: KMSAlias
    logicalId: string
    aliasId?: string
  } {
    const {
      description,
      slug,
      environment,
      enableRotation = true,
      multiRegion = false,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'kms',
    })

    const logicalId = generateLogicalId(resourceName)

    // Default key policy - allows root account full access
    const keyPolicy = {
      Version: '2012-10-17' as const,
      Statement: [
        {
          Sid: 'Enable IAM User Permissions',
          Effect: 'Allow' as const,
          Principal: {
            AWS: Fn.Sub('arn:aws:iam::${AWS::AccountId}:root'),
          },
          Action: 'kms:*',
          Resource: '*',
        },
        {
          Sid: 'Allow services to use the key',
          Effect: 'Allow' as const,
          Principal: {
            Service: [
              's3.amazonaws.com',
              'cloudfront.amazonaws.com',
              'logs.amazonaws.com',
              'secretsmanager.amazonaws.com',
            ],
          },
          Action: [
            'kms:Decrypt',
            'kms:GenerateDataKey',
          ],
          Resource: '*',
        },
      ],
    }

    const key: KMSKey = {
      Type: 'AWS::KMS::Key',
      Properties: {
        Description: description,
        Enabled: true,
        EnableKeyRotation: enableRotation,
        KeyPolicy: keyPolicy,
        KeySpec: 'SYMMETRIC_DEFAULT',
        KeyUsage: 'ENCRYPT_DECRYPT',
        MultiRegion: multiRegion,
      },
    }

    // Create alias for easier reference
    const aliasId = generateLogicalId(`${resourceName}-alias`)
    const alias: KMSAlias = {
      Type: 'AWS::KMS::Alias',
      Properties: {
        AliasName: `alias/${slug}-${environment}`,
        TargetKeyId: Fn.Ref(logicalId),
      },
    }

    return { key, alias, logicalId, aliasId }
  }

  /**
   * Create a WAF Web ACL
   */
  static createFirewall(options: FirewallOptions): {
    webAcl: WAFv2WebACL
    logicalId: string
  } {
    const {
      slug,
      environment,
      scope = 'CLOUDFRONT',
      defaultAction = 'allow',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'waf',
    })

    const logicalId = generateLogicalId(resourceName)

    const webAcl: WAFv2WebACL = {
      Type: 'AWS::WAFv2::WebACL',
      Properties: {
        Name: resourceName,
        Scope: scope,
        DefaultAction: defaultAction === 'allow' ? { Allow: {} } : { Block: {} },
        Description: `WAF for ${slug} ${environment}`,
        Rules: [],
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: `${resourceName}-metric`,
        },
      },
    }

    return { webAcl, logicalId }
  }

  /**
   * Add rate limiting to a Web ACL
   */
  static setRateLimit(
    webAcl: WAFv2WebACL,
    rule: RateLimitRule,
  ): WAFv2WebACL {
    if (!webAcl.Properties.Rules) {
      webAcl.Properties.Rules = []
    }

    webAcl.Properties.Rules.push({
      Name: rule.name,
      Priority: rule.priority,
      Statement: {
        RateBasedStatement: {
          Limit: rule.requestsPerWindow,
          AggregateKeyType: rule.aggregateKeyType || 'IP',
        },
      },
      Action: {
        Block: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: `${rule.name}-metric`,
      },
    })

    return webAcl
  }

  /**
   * Block specific countries
   */
  static blockCountries(
    webAcl: WAFv2WebACL,
    rule: GeoBlockRule,
  ): WAFv2WebACL {
    if (!webAcl.Properties.Rules) {
      webAcl.Properties.Rules = []
    }

    webAcl.Properties.Rules.push({
      Name: rule.name,
      Priority: rule.priority,
      Statement: {
        GeoMatchStatement: {
          CountryCodes: rule.countryCodes,
        },
      },
      Action: {
        Block: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: `${rule.name}-metric`,
      },
    })

    return webAcl
  }

  /**
   * Block specific IP addresses
   */
  static blockIpAddresses(
    webAcl: WAFv2WebACL,
    rule: IpBlockRule,
    slug: string,
    environment: EnvironmentType,
  ): {
      webAcl: WAFv2WebACL
      ipSet: WAFv2IPSet
      ipSetLogicalId: string
    } {
    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'ipset',
    })

    const ipSetLogicalId = generateLogicalId(`${resourceName}-${rule.name}`)

    // Create IP Set
    const ipSet: WAFv2IPSet = {
      Type: 'AWS::WAFv2::IPSet',
      Properties: {
        Name: `${resourceName}-${rule.name}`,
        Scope: webAcl.Properties.Scope,
        IPAddressVersion: rule.ipVersion || 'IPV4',
        Addresses: rule.ipAddresses,
        Description: `Blocked IPs for ${rule.name}`,
      },
    }

    // Add rule to Web ACL
    if (!webAcl.Properties.Rules) {
      webAcl.Properties.Rules = []
    }

    webAcl.Properties.Rules.push({
      Name: rule.name,
      Priority: rule.priority,
      Statement: {
        IPSetReferenceStatement: {
          Arn: Fn.GetAtt(ipSetLogicalId, 'Arn') as any,
        },
      },
      Action: {
        Block: {},
      },
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: `${rule.name}-metric`,
      },
    })

    return { webAcl, ipSet, ipSetLogicalId }
  }

  /**
   * Add AWS Managed Rules
   */
  static addManagedRules(
    webAcl: WAFv2WebACL,
    rule: ManagedRuleGroup,
  ): WAFv2WebACL {
    if (!webAcl.Properties.Rules) {
      webAcl.Properties.Rules = []
    }

    const managedRuleStatement: NonNullable<WAFv2WebACL['Properties']['Rules']>[0]['Statement'] = {
      ManagedRuleGroupStatement: {
        VendorName: rule.vendorName,
        Name: rule.ruleName,
      },
    }

    if (rule.excludedRules && rule.excludedRules.length > 0) {
      managedRuleStatement.ManagedRuleGroupStatement!.ExcludedRules = rule.excludedRules.map(name => ({ Name: name }))
    }

    webAcl.Properties.Rules.push({
      Name: rule.name,
      Priority: rule.priority,
      Statement: managedRuleStatement,
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: `${rule.name}-metric`,
      },
    })

    return webAcl
  }

  /**
   * Common managed rule groups from AWS
   */
  static readonly ManagedRuleGroups = {
    /**
     * AWS Core Rule Set - protects against common threats
     */
    CoreRuleSet: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesCommonRuleSet',
    },
    /**
     * Known Bad Inputs - blocks patterns known to be invalid
     */
    KnownBadInputs: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesKnownBadInputsRuleSet',
    },
    /**
     * SQL Database - protects against SQL injection
     */
    SqlDatabase: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesSQLiRuleSet',
    },
    /**
     * Linux Operating System - protects against Linux-specific exploits
     */
    LinuxOS: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesLinuxRuleSet',
    },
    /**
     * POSIX Operating System - protects against POSIX-specific exploits
     */
    PosixOS: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesUnixRuleSet',
    },
    /**
     * Amazon IP Reputation List - blocks IPs with poor reputation
     */
    AmazonIpReputation: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesAmazonIpReputationList',
    },
    /**
     * Anonymous IP List - blocks requests from anonymizing services
     */
    AnonymousIpList: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesAnonymousIpList',
    },
  } as const
}
