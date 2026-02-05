import type { ACMCertificate, KMSAlias, KMSKey, WAFv2IPSet, WAFv2WebACL } from '@stacksjs/ts-cloud-aws-types'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'
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
    /**
     * Bot Control - protects against bots and scrapers
    */
    BotControl: {
      vendorName: 'AWS',
      ruleName: 'AWSManagedRulesBotControlRuleSet',
    },
  } as const

  /**
   * Add path-based rate limiting
   * Rate limit specific URL paths (e.g., login, API endpoints)
  */
  static setPathRateLimit(
    webAcl: WAFv2WebACL,
    rule: RateLimitRule & { paths: string[] },
  ): WAFv2WebACL {
    if (!webAcl.Properties.Rules) {
      webAcl.Properties.Rules = []
    }

    // Build path patterns for the rule
    const pathConditions = rule.paths.map(path => ({
      SearchString: path,
      FieldToMatch: {
        UriPath: {},
      },
      TextTransformation: [{
        Priority: 0,
        Type: 'LOWERCASE',
      }],
      PositionalConstraint: 'STARTS_WITH',
    }))

    webAcl.Properties.Rules.push({
      Name: rule.name,
      Priority: rule.priority,
      Statement: {
        RateBasedStatement: {
          Limit: rule.requestsPerWindow,
          AggregateKeyType: rule.aggregateKeyType || 'IP',
          ScopeDownStatement: {
            OrStatement: {
              Statements: pathConditions.map(condition => ({
                ByteMatchStatement: condition,
              })),
            },
          },
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
   * Add header-based rate limiting
   * Useful for API key or user-based rate limiting
  */
  static setHeaderRateLimit(
    webAcl: WAFv2WebACL,
    rule: RateLimitRule & { headerName: string, headerValue?: string },
  ): WAFv2WebACL {
    if (!webAcl.Properties.Rules) {
      webAcl.Properties.Rules = []
    }

    const statement: any = {
      RateBasedStatement: {
        Limit: rule.requestsPerWindow,
        AggregateKeyType: 'CUSTOM_KEYS',
        CustomKeys: [
          {
            Header: {
              Name: rule.headerName,
              TextTransformations: [{ Priority: 0, Type: 'NONE' }],
            },
          },
        ],
      },
    }

    // Optionally scope down to specific header value
    if (rule.headerValue) {
      statement.RateBasedStatement.ScopeDownStatement = {
        ByteMatchStatement: {
          SearchString: rule.headerValue,
          FieldToMatch: {
            SingleHeader: { Name: rule.headerName },
          },
          TextTransformation: [{ Priority: 0, Type: 'NONE' }],
          PositionalConstraint: 'EXACTLY',
        },
      }
    }

    webAcl.Properties.Rules.push({
      Name: rule.name,
      Priority: rule.priority,
      Statement: statement,
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
   * Add login endpoint protection
   * Combines rate limiting with common attack patterns
  */
  static protectLoginEndpoint(
    webAcl: WAFv2WebACL,
    options: {
      loginPaths: string[]
      priority: number
      requestsPerMinute?: number
    },
  ): WAFv2WebACL {
    const { loginPaths, priority, requestsPerMinute = 10 } = options

    // Add rate limiting for login paths
    Security.setPathRateLimit(webAcl, {
      name: 'LoginRateLimit',
      priority,
      requestsPerWindow: requestsPerMinute * 5, // AWS rate is per 5 minutes
      paths: loginPaths,
    })

    return webAcl
  }

  /**
   * Add API rate limiting
   * Apply stricter limits on API endpoints
  */
  static protectApiEndpoints(
    webAcl: WAFv2WebACL,
    options: {
      apiPaths: string[]
      priority: number
      requestsPerMinute?: number
    },
  ): WAFv2WebACL {
    const { apiPaths, priority, requestsPerMinute = 100 } = options

    Security.setPathRateLimit(webAcl, {
      name: 'ApiRateLimit',
      priority,
      requestsPerWindow: requestsPerMinute * 5, // AWS rate is per 5 minutes
      paths: apiPaths,
    })

    return webAcl
  }

  /**
   * Create a comprehensive WAF with common protections
  */
  static createProtectedFirewall(options: {
    slug: string
    environment: EnvironmentType
    scope?: 'CLOUDFRONT' | 'REGIONAL'
    enableBotControl?: boolean
    enableRateLimiting?: boolean
    rateLimitPerMinute?: number
  }): {
    webAcl: WAFv2WebACL
    logicalId: string
  } {
    const {
      slug,
      environment,
      scope = 'CLOUDFRONT',
      enableBotControl = false,
      enableRateLimiting = true,
      rateLimitPerMinute = 2000,
    } = options

    // Create base firewall
    let { webAcl, logicalId } = Security.createFirewall({
      slug,
      environment,
      scope,
      defaultAction: 'allow',
    })

    let priority = 0

    // Add AWS IP Reputation list
    webAcl = Security.addManagedRules(webAcl, {
      name: 'AWSIPReputationList',
      priority: priority++,
      ...Security.ManagedRuleGroups.AmazonIpReputation,
    })

    // Add Anonymous IP protection
    webAcl = Security.addManagedRules(webAcl, {
      name: 'AWSAnonymousIPList',
      priority: priority++,
      ...Security.ManagedRuleGroups.AnonymousIpList,
    })

    // Add Core Rule Set
    webAcl = Security.addManagedRules(webAcl, {
      name: 'AWSCoreRuleSet',
      priority: priority++,
      ...Security.ManagedRuleGroups.CoreRuleSet,
    })

    // Add Known Bad Inputs
    webAcl = Security.addManagedRules(webAcl, {
      name: 'AWSKnownBadInputs',
      priority: priority++,
      ...Security.ManagedRuleGroups.KnownBadInputs,
    })

    // Add SQL Injection protection
    webAcl = Security.addManagedRules(webAcl, {
      name: 'AWSSQLi',
      priority: priority++,
      ...Security.ManagedRuleGroups.SqlDatabase,
    })

    // Optionally add Bot Control (additional cost)
    if (enableBotControl) {
      webAcl = Security.addManagedRules(webAcl, {
        name: 'AWSBotControl',
        priority: priority++,
        ...Security.ManagedRuleGroups.BotControl,
      })
    }

    // Add global rate limiting
    if (enableRateLimiting) {
      webAcl = Security.setRateLimit(webAcl, {
        name: 'GlobalRateLimit',
        priority: priority++,
        requestsPerWindow: rateLimitPerMinute * 5, // AWS uses 5-minute windows
      })
    }

    return { webAcl, logicalId }
  }

  /**
   * Common rate limit presets
  */
  static readonly RateLimitPresets = {
    /** Standard website: 2000 requests per minute per IP */
    STANDARD: 2000,
    /** High-traffic API: 10000 requests per minute per IP */
    HIGH_TRAFFIC: 10000,
    /** Aggressive protection: 100 requests per minute per IP */
    STRICT: 100,
    /** Login protection: 10 requests per minute per IP */
    LOGIN: 10,
    /** API endpoint: 100 requests per minute per IP */
    API: 100,
  } as const
}
