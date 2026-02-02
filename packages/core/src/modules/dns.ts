import type { Route53HostedZone, Route53RecordSet } from '@stacksjs/ts-cloud-aws-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'

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

  /**
   * Create an A record pointing to an S3 website redirect bucket
   * Used for www to non-www redirect (or vice versa)
   */
  static createS3WebsiteAlias(
    domain: string,
    s3WebsiteEndpoint: string,
    s3HostedZoneId: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createRecord({
      hostedZoneId,
      name: domain,
      type: 'A',
      aliasTarget: {
        dnsName: s3WebsiteEndpoint,
        hostedZoneId: s3HostedZoneId,
        evaluateTargetHealth: false,
      },
    })
  }

  /**
   * S3 Website Hosted Zone IDs by region
   * These are required for alias records pointing to S3 website endpoints
   */
  static readonly S3WebsiteHostedZoneIds: Record<string, string> = {
    'us-east-1': 'Z3AQBSTGFYJSTF',
    'us-east-2': 'Z2O1EMRO9K5GLX',
    'us-west-1': 'Z2F56UZL2M1ACD',
    'us-west-2': 'Z3BJ6K6RIION7M',
    'af-south-1': 'Z83WF9RJE8B12',
    'ap-east-1': 'ZNB98KWMFR0R6',
    'ap-south-1': 'Z11RGJOFQNVJUP',
    'ap-south-2': 'Z02976202B4EZMXIPMXF7',
    'ap-northeast-1': 'Z2M4EHUR26P7ZW',
    'ap-northeast-2': 'Z3W03O7B5YMIYP',
    'ap-northeast-3': 'Z2YQB5RD63NC85',
    'ap-southeast-1': 'Z3O0J2DXBE1FTB',
    'ap-southeast-2': 'Z1WCIBER6CPFUU',
    'ap-southeast-3': 'Z01613992JD795ZI93075',
    'ca-central-1': 'Z1QDHH18159H29',
    'eu-central-1': 'Z21DNDUVLTQW6Q',
    'eu-central-2': 'Z030506016YDQGETNASS',
    'eu-west-1': 'Z1BKCTXD74EZPE',
    'eu-west-2': 'Z3GKZC51ZF0DB4',
    'eu-west-3': 'Z3R1K369G5AVDG',
    'eu-north-1': 'Z3BAZG2TWCNX0D',
    'eu-south-1': 'Z30OZKI7KPW7MI',
    'eu-south-2': 'Z0081959F7139GRJC19J',
    'me-south-1': 'Z1MPMWCPA7YB62',
    'me-central-1': 'Z06143092I8HRBER9VXCO',
    'sa-east-1': 'Z7KQH4QJS55SO',
  }

  /**
   * Get S3 website endpoint for a bucket in a specific region
   */
  static getS3WebsiteEndpoint(bucketName: string, region: string): string {
    return `${bucketName}.s3-website-${region}.amazonaws.com`
  }

  /**
   * Create a store subdomain record (e.g., for Lemon Squeezy integration)
   */
  static createStoreRecord(
    domain: string,
    storeUrl: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createCname(`store.${domain}`, storeUrl, hostedZoneId)
  }

  /**
   * Create API subdomain record
   */
  static createApiRecord(
    domain: string,
    apiUrl: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createCname(`api.${domain}`, apiUrl, hostedZoneId)
  }

  /**
   * Create docs subdomain record
   */
  static createDocsRecord(
    domain: string,
    docsUrl: string,
    hostedZoneId: string,
  ): { record: Route53RecordSet, logicalId: string } {
    return DNS.createCname(`docs.${domain}`, docsUrl, hostedZoneId)
  }

  /**
   * CloudFront Hosted Zone ID (constant for all CloudFront distributions)
   */
  static readonly CloudFrontHostedZoneId = 'Z2FDTNDATAQYW2'
}
