import type { Route53HostedZone, Route53RecordSet } from '@ts-cloud/aws-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@ts-cloud/types'

export interface HostedZoneOptions {
  domain: string
  slug: string
  environment: EnvironmentType
  comment?: string
}

export interface RecordOptions {
  hostedZoneId?: string
  hostedZoneName?: string
  name: string
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'PTR' | 'SOA' | 'SPF' | 'SRV' | 'TXT'
  ttl?: number
  values?: string[]
  aliasTarget?: AliasTarget
}

export interface AliasTarget {
  dnsName: string
  hostedZoneId: string
  evaluateTargetHealth?: boolean
}

/**
 * DNS Module - Route53 Management
 * Provides clean API for creating and configuring Route53 resources
 */
export class DNS {
  /**
   * Create a Route53 hosted zone
   */
  static createHostedZone(options: HostedZoneOptions): { zone: Route53HostedZone, logicalId: string } {
    const { domain, slug, environment, comment } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'hostedzone',
    })

    const logicalId = generateLogicalId(`${resourceName}-${domain.replace(/\./g, '')}`)

    const zone: Route53HostedZone = {
      Type: 'AWS::Route53::HostedZone',
      Properties: {
        Name: domain,
        HostedZoneConfig: {
          Comment: comment || `Hosted zone for ${domain}`,
        },
      },
    }

    return { zone, logicalId }
  }

  /**
   * Create a DNS record
   */
  static createRecord(options: RecordOptions): { record: Route53RecordSet, logicalId: string } {
    const { hostedZoneId, hostedZoneName, name, type, ttl, values, aliasTarget } = options

    const logicalId = generateLogicalId(`record-${name.replace(/\./g, '')}-${type}`)

    const record: Route53RecordSet = {
      Type: 'AWS::Route53::RecordSet',
      Properties: {
        Name: name,
        Type: type,
      },
    }

    // Set hosted zone reference
    if (hostedZoneId) {
      record.Properties.HostedZoneId = hostedZoneId
    }
    else if (hostedZoneName) {
      record.Properties.HostedZoneName = hostedZoneName
    }

    // Configure record based on type
    if (aliasTarget) {
      // Alias record (no TTL, points to AWS resource)
      record.Properties.AliasTarget = {
        DNSName: aliasTarget.dnsName,
        HostedZoneId: aliasTarget.hostedZoneId,
        EvaluateTargetHealth: aliasTarget.evaluateTargetHealth ?? false,
      }
    }
    else {
      // Standard record (requires TTL and values)
      record.Properties.TTL = ttl || 300
      record.Properties.ResourceRecords = values || []
    }

    return { record, logicalId }
  }

  /**
   * Create an A record that points to a CloudFront distribution
   */
  static createCloudFrontAlias(
    domain: string,
    distributionDomainName: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createRecord({
      hostedZoneId,
      name: domain,
      type: 'A',
      aliasTarget: {
        dnsName: distributionDomainName,
        hostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront hosted zone ID (constant)
        evaluateTargetHealth: false,
      },
    })
  }

  /**
   * Create an A record that points to an Application Load Balancer
   */
  static createAlbAlias(
    domain: string,
    albDomainName: string,
    albHostedZoneId: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createRecord({
      hostedZoneId,
      name: domain,
      type: 'A',
      aliasTarget: {
        dnsName: albDomainName,
        hostedZoneId: albHostedZoneId,
        evaluateTargetHealth: true,
      },
    })
  }

  /**
   * Create a CNAME record
   */
  static createCname(
    name: string,
    target: string,
    hostedZoneId: string,
    ttl = 300,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createRecord({
      hostedZoneId,
      name,
      type: 'CNAME',
      ttl,
      values: [target],
    })
  }

  /**
   * Create www → non-www redirect using S3 and Route53
   */
  static createWwwRedirect(
    domain: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createRecord({
      hostedZoneId,
      name: `www.${domain}`,
      type: 'CNAME',
      ttl: 300,
      values: [domain],
    })
  }

  /**
   * Create MX records for email
   */
  static createMxRecords(
    domain: string,
    mailServers: Array<{ priority: number, server: string }>,
    hostedZoneId: string,
    ttl = 300,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createRecord({
      hostedZoneId,
      name: domain,
      type: 'MX',
      ttl,
      values: mailServers.map(mx => `${mx.priority} ${mx.server}`),
    })
  }

  /**
   * Create TXT record (useful for domain verification, SPF, DKIM, etc.)
   */
  static createTxtRecord(
    name: string,
    value: string,
    hostedZoneId: string,
    ttl = 300,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createRecord({
      hostedZoneId,
      name,
      type: 'TXT',
      ttl,
      values: [`"${value}"`], // TXT values must be quoted
    })
  }

  /**
   * Create SPF record for email sending
   */
  static createSpfRecord(
    domain: string,
    spfValue: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createTxtRecord(domain, spfValue, hostedZoneId)
  }

  /**
   * Create DMARC record for email authentication
   */
  static createDmarcRecord(
    domain: string,
    policy: 'none' | 'quarantine' | 'reject',
    email: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    const dmarcValue = `v=DMARC1; p=${policy}; rua=mailto:${email}`
    return DNS.createTxtRecord(`_dmarc.${domain}`, dmarcValue, hostedZoneId)
  }
}
