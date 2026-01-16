import { describe, expect, it } from 'bun:test'
import { CDN, DNS, Security, Storage, TemplateBuilder } from '../src'

describe('Integration Tests - Full Stack Deployment', () => {
  it('should create complete static website infrastructure', () => {
    const template = new TemplateBuilder('Static Website Infrastructure')

    // 1. Create S3 bucket for website
    const { bucket, bucketPolicy, logicalId: bucketId } = Storage.createBucket({
      name: 'website',
      slug: 'my-app',
      environment: 'production',
      public: true,
      website: true,
      versioning: true,
      encryption: true,
    })

    template.addResource(bucketId, bucket)

    if (bucketPolicy) {
      template.addResource(`${bucketId}Policy`, bucketPolicy)
    }

    // 2. Create CloudFront distribution
    const { distribution, originAccessControl, logicalId: cdnId } = CDN.createSpaDistribution({
      slug: 'my-app',
      environment: 'production',
      origin: {
        type: 's3',
        domainName: 'my-app-production-s3-website.s3.amazonaws.com',
      },
      customDomain: 'www.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:123456789:certificate/abc',
      http3: true,
    })

    template.addResource(cdnId, distribution)

    if (originAccessControl) {
      template.addResource(`${cdnId}OAC`, originAccessControl)
    }

    // 3. Create DNS records
    const { zone, logicalId: zoneId } = DNS.createHostedZone({
      domain: 'example.com',
      slug: 'my-app',
      environment: 'production',
    })

    template.addResource(zoneId, zone)

    const { record: apexRecord, logicalId: apexId } = DNS.createCloudFrontAlias(
      'example.com',
      'd123.cloudfront.net',
      'Z1234567890ABC',
    )

    template.addResource(apexId, apexRecord)

    const { record: wwwRecord, logicalId: wwwId } = DNS.createCloudFrontAlias(
      'www.example.com',
      'd123.cloudfront.net',
      'Z1234567890ABC',
    )

    template.addResource(wwwId, wwwRecord)

    // Verify the template
    const result = template.build()

    // Resources: Bucket, BucketPolicy, CDN, OAC, HostedZone, ApexRecord, WwwRecord = 7 total
    expect(Object.keys(result.Resources)).toHaveLength(7)
    expect(result.Resources[bucketId].Type).toBe('AWS::S3::Bucket')
    expect(result.Resources[cdnId].Type).toBe('AWS::CloudFront::Distribution')
    expect(result.Resources[zoneId].Type).toBe('AWS::Route53::HostedZone')

    // Verify CloudFormation is valid JSON
    const json = template.toJSON()
    const parsed = JSON.parse(json)
    expect(parsed.AWSTemplateFormatVersion).toBe('2010-09-09')
  })

  it('should create multi-environment setup', () => {
    const environments: Array<'production' | 'staging' | 'development'> = ['production', 'staging', 'development']

    for (const env of environments) {
      const template = new TemplateBuilder(`${env.charAt(0).toUpperCase() + env.slice(1)} Environment`)

      const { bucket, logicalId } = Storage.createBucket({
        name: 'app',
        slug: 'my-app',
        environment: env,
        encryption: true,
        versioning: env === 'production', // Only production gets versioning
      })

      template.addResource(logicalId, bucket)

      const result = template.build()

      expect(result.Resources[logicalId]!.Properties!.BucketName).toContain(env)

      if (env === 'production') {
        expect(result.Resources[logicalId]!.Properties!.VersioningConfiguration).toBeDefined()
      }
    }
  })

  it('should create complete email infrastructure', () => {
    const template = new TemplateBuilder('Email Infrastructure')

    // Create hosted zone
    const { zone, logicalId: zoneId } = DNS.createHostedZone({
      domain: 'example.com',
      slug: 'my-app',
      environment: 'production',
    })

    template.addResource(zoneId, zone)

    // Create MX records
    const { record: mxRecord, logicalId: mxId } = DNS.createMxRecords(
      'example.com',
      [
        { priority: 10, server: 'mail1.example.com' },
        { priority: 20, server: 'mail2.example.com' },
      ],
      'Z1234567890ABC',
    )

    template.addResource(mxId, mxRecord)

    // Create SPF record
    const { record: spfRecord, logicalId: spfId } = DNS.createSpfRecord(
      'example.com',
      'v=spf1 include:_spf.google.com ~all',
      'Z1234567890ABC',
    )

    template.addResource(spfId, spfRecord)

    // Create DMARC record
    const { record: dmarcRecord, logicalId: dmarcId } = DNS.createDmarcRecord(
      'example.com',
      'quarantine',
      'dmarc@example.com',
      'Z1234567890ABC',
    )

    template.addResource(dmarcId, dmarcRecord)

    // Create email storage bucket
    const { bucket, logicalId: bucketId } = Storage.createBucket({
      name: 'emails',
      slug: 'my-app',
      environment: 'production',
      encryption: true,
      lifecycleRules: [
        {
          id: 'DeleteOldEmails',
          enabled: true,
          expirationDays: 90,
        },
      ],
    })

    template.addResource(bucketId, bucket)

    const result = template.build()

    expect(Object.keys(result.Resources)).toHaveLength(5)
    expect(result.Resources[mxId]!.Properties!.Type).toBe('MX')
    expect(result.Resources[spfId]!.Properties!.Type).toBe('TXT')
    expect(result.Resources[dmarcId]!.Properties!.Name).toBe('_dmarc.example.com')
  })

  it('should handle resource naming across environments', () => {
    const slug = 'my-app'
    const name = 'data'

    const prod = Storage.createBucket({
      name,
      slug,
      environment: 'production',
    })

    const staging = Storage.createBucket({
      name,
      slug,
      environment: 'staging',
    })

    expect(prod.bucket.Properties?.BucketName).toBe('my-app-production-s3-data')
    expect(staging.bucket.Properties?.BucketName).toBe('my-app-staging-s3-data')
    expect(prod.logicalId).not.toBe(staging.logicalId)
  })

  it('should create CDN with multiple origins', () => {
    const template = new TemplateBuilder('Multi-Origin CDN')

    // S3 origin for static assets
    const { distribution: dist1, logicalId: id1 } = CDN.createDistribution({
      slug: 'my-app',
      environment: 'production',
      origin: {
        type: 's3',
        domainName: 'assets.s3.amazonaws.com',
        originPath: '/static',
      },
    })

    // ALB origin for API
    const { distribution: dist2, logicalId: id2 } = CDN.createDistribution({
      slug: 'my-app',
      environment: 'production',
      origin: {
        type: 'alb',
        domainName: 'api-alb.us-east-1.elb.amazonaws.com',
      },
    })

    template.addResource(id1, dist1)
    template.addResource(id2, dist2)

    const result = template.build()

    expect((result.Resources[id1]!.Properties as any).DistributionConfig.Origins[0].S3OriginConfig).toBeUndefined()
    expect((result.Resources[id2]!.Properties as any).DistributionConfig.Origins[0].CustomOriginConfig).toBeDefined()
  })

  it('should create complete secure website with SSL and WAF', () => {
    const template = new TemplateBuilder('Secure Website Infrastructure')

    // 1. Create SSL certificate
    const { certificate, logicalId: certId } = Security.createCertificate({
      domain: 'secure.example.com',
      subdomains: ['*'],
      slug: 'secure-app',
      environment: 'production',
      hostedZoneId: 'Z1234567890ABC',
    })
    template.addResource(certId, certificate)

    // 2. Create encryption key
    const { key, alias, logicalId: keyId, aliasId } = Security.createKmsKey({
      description: 'Application data encryption',
      slug: 'secure-app',
      environment: 'production',
    })
    template.addResource(keyId, key)
    if (alias && aliasId) {
      template.addResource(aliasId, alias)
    }

    // 3. Create WAF with comprehensive protection
    const { webAcl, logicalId: wafId } = Security.createFirewall({
      slug: 'secure-app',
      environment: 'production',
      scope: 'CLOUDFRONT',
    })

    // Add rate limiting (DDoS protection)
    Security.setRateLimit(webAcl, {
      name: 'RateLimit',
      priority: 1,
      requestsPerWindow: 2000,
    })

    // Add AWS managed rules
    Security.addManagedRules(webAcl, {
      name: 'CoreRuleSet',
      priority: 2,
      ...Security.ManagedRuleGroups.CoreRuleSet,
    })

    Security.addManagedRules(webAcl, {
      name: 'KnownBadInputs',
      priority: 3,
      ...Security.ManagedRuleGroups.KnownBadInputs,
    })

    // Add geo-blocking
    Security.blockCountries(webAcl, {
      name: 'BlockHighRiskCountries',
      priority: 4,
      countryCodes: ['CN', 'RU', 'KP'],
    })

    // Add IP blocking
    const { webAcl: finalWebAcl, ipSet, ipSetLogicalId } = Security.blockIpAddresses(
      webAcl,
      {
        name: 'BlockMaliciousIPs',
        priority: 5,
        ipAddresses: ['192.0.2.0/24', '198.51.100.0/24'],
      },
      'secure-app',
      'production',
    )

    template.addResource(wafId, finalWebAcl)
    template.addResource(ipSetLogicalId, ipSet)

    // 4. Create S3 bucket with encryption
    const { bucket, logicalId: bucketId } = Storage.createBucket({
      name: 'secure-website',
      slug: 'secure-app',
      environment: 'production',
      encryption: true,
      versioning: true,
      public: true,
      website: true,
    })
    template.addResource(bucketId, bucket)

    // 5. Create CloudFront distribution with WAF
    const { distribution, originAccessControl, logicalId: cdnId } = CDN.createSpaDistribution({
      slug: 'secure-app',
      environment: 'production',
      origin: {
        type: 's3',
        domainName: 'secure-app-production-s3-secure-website.s3.amazonaws.com',
      },
      customDomain: 'secure.example.com',
      certificateArn: 'arn:aws:acm:us-east-1:123456789:certificate/abc',
      http3: true,
    })
    template.addResource(cdnId, distribution)
    if (originAccessControl) {
      template.addResource(`${cdnId}OAC`, originAccessControl)
    }

    const result = template.build()

    // Certificate + Key + Alias + WAF + IPSet + Bucket + CDN + OAC = 8 resources
    expect(Object.keys(result.Resources)).toHaveLength(8)
    expect(result.Resources[certId].Type).toBe('AWS::CertificateManager::Certificate')
    expect(result.Resources[keyId].Type).toBe('AWS::KMS::Key')
    expect(result.Resources[wafId].Type).toBe('AWS::WAFv2::WebACL')
    expect(result.Resources[wafId]!.Properties!.Rules).toHaveLength(5)
    expect(result.Resources[bucketId].Type).toBe('AWS::S3::Bucket')
    expect(result.Resources[cdnId].Type).toBe('AWS::CloudFront::Distribution')

    // Verify CloudFormation is valid JSON
    const json = template.toJSON()
    const parsed = JSON.parse(json)
    expect(parsed.AWSTemplateFormatVersion).toBe('2010-09-09')
  })
})
