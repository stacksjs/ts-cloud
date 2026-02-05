/**
 * Static Site Deployment with External DNS Provider Support
 * Deploys static sites to AWS (S3 + CloudFront + ACM) with DNS managed by external providers (Porkbun, GoDaddy, etc.)
 */

import { CloudFormationClient } from '../aws/cloudformation'
import { S3Client } from '../aws/s3'
import { CloudFrontClient } from '../aws/cloudfront'
import { ACMClient } from '../aws/acm'
import type { DnsProvider, DnsProviderConfig } from '../dns/types'
import { createDnsProvider } from '../dns'
import { UnifiedDnsValidator } from '../dns/validator'

export interface ExternalDnsStaticSiteConfig {
  /** Site name used for resource naming */
  siteName: string
  /** AWS region for S3 bucket */
  region?: string
  /** Custom domain (e.g., bunpress.org) */
  domain: string
  /** S3 bucket name (auto-generated if not provided) */
  bucket?: string
  /** ACM certificate ARN (auto-created if not provided) */
  certificateArn?: string
  /** CloudFormation stack name */
  stackName?: string
  /** Default root object */
  defaultRootObject?: string
  /** Error document */
  errorDocument?: string
  /** Cache control for assets */
  cacheControl?: string
  /** Tags to apply to resources */
  tags?: Record<string, string>
  /** DNS provider configuration */
  dnsProvider: DnsProviderConfig
}

export interface ExternalDnsDeployResult {
  success: boolean
  stackId?: string
  stackName: string
  bucket: string
  distributionId?: string
  distributionDomain?: string
  domain?: string
  certificateArn?: string
  message: string
  filesUploaded?: number
  filesSkipped?: number
}

/**
 * Generate CloudFormation template for static site infrastructure (without Route53)
 */
export function generateExternalDnsStaticSiteTemplate(config: {
  bucketName: string
  domain?: string
  aliases?: string[]
  certificateArn?: string
  defaultRootObject?: string
  errorDocument?: string
}): object {
  const {
    bucketName,
    domain,
    aliases,
    certificateArn,
    defaultRootObject = 'index.html',
    errorDocument = '404.html',
  } = config

  const resources: Record<string, any> = {}
  const outputs: Record<string, any> = {}

  // S3 Bucket
  resources.S3Bucket = {
    Type: 'AWS::S3::Bucket',
    Properties: {
      BucketName: bucketName,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: false,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: false,
      },
      WebsiteConfiguration: {
        IndexDocument: defaultRootObject,
        ErrorDocument: errorDocument,
      },
    },
  }

  outputs.BucketName = {
    Description: 'S3 Bucket Name',
    Value: { Ref: 'S3Bucket' },
  }

  outputs.BucketArn = {
    Description: 'S3 Bucket ARN',
    Value: { 'Fn::GetAtt': ['S3Bucket', 'Arn'] },
  }

  // Origin Access Control
  resources.CloudFrontOAC = {
    Type: 'AWS::CloudFront::OriginAccessControl',
    Properties: {
      OriginAccessControlConfig: {
        Name: `OAC-${bucketName}`,
        Description: `OAC for ${bucketName}`,
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    },
  }

  // CloudFront Function for URL rewriting
  resources.UrlRewriteFunction = {
    Type: 'AWS::CloudFront::Function',
    Properties: {
      Name: { 'Fn::Sub': '${AWS::StackName}-url-rewrite' },
      AutoPublish: true,
      FunctionConfig: {
        Comment: 'Append .html extension to URLs without extensions',
        Runtime: 'cloudfront-js-2.0',
      },
      FunctionCode: `function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // If URI ends with /, serve index.html
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  }
  // If URI doesn't have an extension, append .html
  else if (!uri.includes('.')) {
    request.uri = uri + '.html';
  }

  return request;
}`,
    },
  }

  // CloudFront Distribution
  const distributionConfig: any = {
    Enabled: true,
    DefaultRootObject: defaultRootObject,
    HttpVersion: 'http2and3',
    IPV6Enabled: true,
    PriceClass: 'PriceClass_100',
    Origins: [
      {
        Id: `S3-${bucketName}`,
        DomainName: { 'Fn::GetAtt': ['S3Bucket', 'RegionalDomainName'] },
        S3OriginConfig: {
          OriginAccessIdentity: '',
        },
        OriginAccessControlId: { 'Fn::GetAtt': ['CloudFrontOAC', 'Id'] },
      },
    ],
    DefaultCacheBehavior: {
      TargetOriginId: `S3-${bucketName}`,
      ViewerProtocolPolicy: 'redirect-to-https',
      AllowedMethods: ['GET', 'HEAD'],
      CachedMethods: ['GET', 'HEAD'],
      Compress: true,
      CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // Managed-CachingOptimized
      FunctionAssociations: [
        {
          EventType: 'viewer-request',
          FunctionARN: { 'Fn::GetAtt': ['UrlRewriteFunction', 'FunctionARN'] },
        },
      ],
    },
    CustomErrorResponses: [
      {
        ErrorCode: 403,
        ResponseCode: 200,
        ResponsePagePath: `/${defaultRootObject}`,
        ErrorCachingMinTTL: 300,
      },
      {
        ErrorCode: 404,
        ResponseCode: 404,
        ResponsePagePath: `/${errorDocument}`,
        ErrorCachingMinTTL: 300,
      },
    ],
  }

  // Add custom domain configuration if provided
  if (domain && certificateArn) {
    // Use provided aliases or default to just the domain
    distributionConfig.Aliases = aliases && aliases.length > 0 ? aliases : [domain]
    distributionConfig.ViewerCertificate = {
      AcmCertificateArn: certificateArn,
      SslSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
    }
  }
  else {
    distributionConfig.ViewerCertificate = {
      CloudFrontDefaultCertificate: true,
    }
  }

  resources.CloudFrontDistribution = {
    Type: 'AWS::CloudFront::Distribution',
    DependsOn: ['S3Bucket', 'CloudFrontOAC', 'UrlRewriteFunction'],
    Properties: {
      DistributionConfig: distributionConfig,
    },
  }

  outputs.DistributionId = {
    Description: 'CloudFront Distribution ID',
    Value: { Ref: 'CloudFrontDistribution' },
  }

  outputs.DistributionDomain = {
    Description: 'CloudFront Distribution Domain',
    Value: { 'Fn::GetAtt': ['CloudFrontDistribution', 'DomainName'] },
  }

  // S3 Bucket Policy for CloudFront OAC
  resources.S3BucketPolicy = {
    Type: 'AWS::S3::BucketPolicy',
    DependsOn: ['S3Bucket', 'CloudFrontDistribution'],
    Properties: {
      Bucket: { Ref: 'S3Bucket' },
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontServicePrincipal',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudfront.amazonaws.com',
            },
            Action: 's3:GetObject',
            Resource: { 'Fn::Sub': 'arn:aws:s3:::${S3Bucket}/*' },
            Condition: {
              StringEquals: {
                'AWS:SourceArn': {
                  'Fn::Sub': 'arn:aws:cloudfront::${AWS::AccountId}:distribution/${CloudFrontDistribution}',
                },
              },
            },
          },
        ],
      },
    },
  }

  // NOTE: No Route53 records - DNS will be managed by external provider

  outputs.SiteUrl = {
    Description: 'Site URL',
    Value: domain ? `https://${domain}` : { 'Fn::Sub': 'https://${CloudFrontDistribution.DomainName}' },
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Static site infrastructure for ${domain || bucketName} (External DNS)`,
    Resources: resources,
    Outputs: outputs,
  }
}

/**
 * Deploy a static site to AWS with external DNS provider
 */
export async function deployStaticSiteWithExternalDns(
  config: ExternalDnsStaticSiteConfig,
): Promise<ExternalDnsDeployResult> {
  const region = config.region || 'us-east-1'
  const cfRegion = 'us-east-1' // CloudFormation for global resources must be in us-east-1
  const domain = config.domain

  // Generate bucket name if not provided
  const bucket = config.bucket || domain.replace(/\./g, '-')

  // Generate stack name
  const stackName = config.stackName || `${config.siteName}-static-site`

  // Initialize clients
  const cf = new CloudFormationClient(cfRegion)
  const acm = new ACMClient('us-east-1') // ACM certs for CloudFront must be in us-east-1

  // Create DNS provider
  const dnsProvider: DnsProvider = createDnsProvider(config.dnsProvider)

  // Verify DNS provider can manage this domain
  console.log(`Verifying DNS provider can manage ${domain}...`)
  const canManage = await dnsProvider.canManageDomain(domain)
  if (!canManage) {
    return {
      success: false,
      stackName,
      bucket,
      message: `DNS provider '${dnsProvider.name}' cannot manage domain ${domain}. Please check your API credentials and domain ownership.`,
    }
  }
  console.log(`DNS provider '${dnsProvider.name}' verified for ${domain}`)

  let certificateArn = config.certificateArn

  // Determine if we're dealing with an apex domain (need www SAN)
  const domainParts = domain.split('.')
  const isApexDomain = domainParts.length === 2
  const wwwDomain = isApexDomain ? `www.${domain}` : undefined

  // Auto-create SSL certificate if not provided
  if (!certificateArn) {
    console.log(`Checking for existing SSL certificate for ${domain}...`)

    // Check for existing certificate that covers both apex and www
    const existingCert = await acm.findCertificateByDomain(domain)
    let existingCertCoversWww = false

    if (existingCert && existingCert.Status === 'ISSUED') {
      // Check if the existing cert also covers www
      if (wwwDomain && existingCert.SubjectAlternativeNames) {
        existingCertCoversWww = existingCert.SubjectAlternativeNames.includes(wwwDomain)
          || existingCert.SubjectAlternativeNames.some(san => san === `*.${domain}`)
      }
      else {
        existingCertCoversWww = true // Not apex domain, no www needed
      }

      if (existingCertCoversWww) {
        certificateArn = existingCert.CertificateArn
        console.log(`Found existing certificate with www coverage: ${certificateArn}`)
      }
      else {
        console.log(`Existing certificate doesn't cover ${wwwDomain}, requesting new one...`)
      }
    }

    if (!certificateArn) {
      // Request and validate new certificate using external DNS provider
      // Always include www for apex domains
      console.log(`Requesting new SSL certificate for ${domain}${wwwDomain ? ` (including ${wwwDomain})` : ''}...`)
      const validator = new UnifiedDnsValidator(dnsProvider, 'us-east-1')

      const certResult = await validator.findOrCreateCertificate({
        domainName: domain,
        subjectAlternativeNames: wwwDomain ? [wwwDomain] : undefined,
        waitForValidation: true,
        maxWaitMinutes: 10,
      })

      if (certResult.status !== 'issued') {
        return {
          success: false,
          stackName,
          bucket,
          message: `SSL certificate validation failed. Status: ${certResult.status}`,
        }
      }

      certificateArn = certResult.certificateArn
      console.log(`Certificate issued: ${certificateArn}`)
    }
  }

  // Check if stack already exists
  let stackExists = false
  let existingBucketName: string | undefined
  try {
    const existingStacks = await cf.describeStacks({ stackName })
    if (existingStacks.Stacks.length > 0) {
      const stack = existingStacks.Stacks[0]
      const stackStatus = stack.StackStatus

      if (stackStatus === 'DELETE_IN_PROGRESS') {
        console.log('Previous stack is still being deleted, waiting...')
        await cf.waitForStack(stackName, 'stack-delete-complete')
        stackExists = false
      }
      else if (stackStatus === 'DELETE_COMPLETE') {
        stackExists = false
      }
      else {
        stackExists = true
        const outputs = stack.Outputs || []
        existingBucketName = outputs.find(o => o.OutputKey === 'BucketName')?.OutputValue
      }
    }
  }
  catch (err: any) {
    if (err.message?.includes('does not exist') || err.code === 'ValidationError') {
      stackExists = false
    }
    else {
      throw err
    }
  }

  // Determine final bucket name
  let finalBucket = existingBucketName || bucket
  if (!stackExists) {
    const s3 = new S3Client(region)
    const cloudfront = new CloudFrontClient()

    // Check if S3 bucket exists (orphaned from previous deployment)
    try {
      const headResult = await s3.headBucket(bucket)
      if (headResult.exists) {
        console.log(`Found orphaned S3 bucket ${bucket}, cleaning up...`)
        try {
          const cleanupPromise = s3.emptyBucket(bucket).then(() => s3.deleteBucket(bucket))
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Bucket cleanup timeout')), 30000),
          )
          await Promise.race([cleanupPromise, timeoutPromise])
          console.log(`Deleted orphaned S3 bucket ${bucket}`)
        }
        catch (cleanupErr: any) {
          console.log(`Note: Could not clean up S3 bucket: ${cleanupErr.message}`)
          const suffix = Date.now().toString(36)
          finalBucket = `${bucket}-${suffix}`
          console.log(`Using alternative bucket name: ${finalBucket}`)
        }
      }
    }
    catch {
      // Bucket doesn't exist, good
    }

    // Check for existing CloudFront distributions with our domain
    if (domain) {
      try {
        console.log(`Checking for existing CloudFront distributions with alias ${domain}...`)
        const distributions = await cloudfront.listDistributions()
        for (const dist of distributions) {
          let aliases: string[] = []
          if (dist.Aliases?.Items) {
            if (Array.isArray(dist.Aliases.Items)) {
              aliases = dist.Aliases.Items
            }
            else if (typeof dist.Aliases.Items === 'object') {
              const cname = (dist.Aliases.Items as any).CNAME
              if (typeof cname === 'string') {
                aliases = [cname]
              }
              else if (Array.isArray(cname)) {
                aliases = cname
              }
            }
          }
          if (aliases.includes(domain)) {
            console.log(`Found existing CloudFront distribution ${dist.Id} with alias ${domain}`)
            console.log(`Reusing existing infrastructure for updates...`)

            // Get the origin bucket from the distribution
            const distConfig = await cloudfront.getDistributionConfig(dist.Id!)
            const originsData = distConfig.DistributionConfig?.Origins?.Items
            let originBucket: string | undefined

            if (originsData) {
              // Handle AWS XML-to-JSON format: single item is { Origin: {...} }, multiple is { Origin: [...] } or [...]
              let originList: any[] = []
              if (Array.isArray(originsData)) {
                originList = originsData
              }
              else if (originsData.Origin) {
                originList = Array.isArray(originsData.Origin) ? originsData.Origin : [originsData.Origin]
              }
              else {
                originList = [originsData]
              }

              for (const origin of originList) {
                const domainName = origin.DomainName || ''
                // Extract bucket name from S3 domain (e.g., "bucket-name.s3.us-east-1.amazonaws.com")
                const s3Match = domainName.match(/^([^.]+)\.s3[\.-]/)
                if (s3Match) {
                  originBucket = s3Match[1]
                  break
                }
              }
            }

            if (originBucket) {
              console.log(`Using existing S3 bucket: ${originBucket}`)
              // Return success with existing infrastructure info - skip CloudFormation
              return {
                success: true,
                stackName: `existing-${dist.Id}`,
                bucket: originBucket,
                distributionId: dist.Id,
                distributionDomain: dist.DomainName,
                domain,
                certificateArn,
                message: 'Using existing CloudFront distribution',
                _existingInfrastructure: true, // Flag to indicate we're reusing infrastructure
              } as ExternalDnsDeployResult & { _existingInfrastructure: boolean }
            }
          }
        }
      }
      catch {
        // No distributions or error listing them
      }
    }
  }

  // Generate CloudFormation template (without Route53)
  // Build aliases list (include www for apex domains)
  const aliases = wwwDomain ? [domain, wwwDomain] : [domain]

  const template = generateExternalDnsStaticSiteTemplate({
    bucketName: finalBucket,
    domain,
    aliases,
    certificateArn,
    defaultRootObject: config.defaultRootObject,
    errorDocument: config.errorDocument,
  })

  // Build tags
  const tags = Object.entries(config.tags || {}).map(([Key, Value]) => ({ Key, Value }))
  tags.push({ Key: 'ManagedBy', Value: 'ts-cloud' })
  tags.push({ Key: 'Application', Value: config.siteName })
  tags.push({ Key: 'DnsProvider', Value: dnsProvider.name })

  // Create or update stack
  let stackId: string
  let isUpdate = false

  if (stackExists) {
    isUpdate = true
    console.log(`Updating CloudFormation stack: ${stackName}`)
    try {
      const result = await cf.updateStack({
        stackName,
        templateBody: JSON.stringify(template),
        capabilities: ['CAPABILITY_IAM'],
        tags,
      })
      stackId = result.StackId
      console.log(`Update initiated, stack ID: ${stackId}`)
    }
    catch (err: any) {
      if (err.message?.includes('No updates are to be performed')) {
        const stacks = await cf.describeStacks({ stackName })
        stackId = stacks.Stacks[0].StackId
        const outputs = stacks.Stacks[0]?.Outputs || []
        const getOutput = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue

        // Still need to ensure DNS records exist
        const distributionDomain = getOutput('DistributionDomain')
        if (distributionDomain) {
          await ensureDnsRecords(dnsProvider, domain, distributionDomain)
        }

        return {
          success: true,
          stackId,
          stackName,
          bucket: getOutput('BucketName') || finalBucket,
          distributionId: getOutput('DistributionId'),
          distributionDomain,
          domain,
          certificateArn,
          message: 'Static site infrastructure is already up to date',
        }
      }
      else {
        throw err
      }
    }
  }
  else {
    console.log(`Creating CloudFormation stack: ${stackName}`)
    console.log(`Bucket name: ${finalBucket}`)
    console.log(`Domain: ${domain}`)
    console.log(`Certificate ARN: ${certificateArn}`)
    const result = await cf.createStack({
      stackName,
      templateBody: JSON.stringify(template),
      capabilities: ['CAPABILITY_IAM'],
      tags,
      onFailure: 'DELETE',
    })
    stackId = result.StackId
    console.log(`Create initiated, stack ID: ${stackId}`)
  }

  // Wait for stack to complete
  console.log(`Waiting for stack to reach ${isUpdate ? 'stack-update-complete' : 'stack-create-complete'}...`)
  try {
    await cf.waitForStack(stackName, isUpdate ? 'stack-update-complete' : 'stack-create-complete')
    console.log('Stack operation completed successfully!')
  }
  catch (err: any) {
    // Check for CloudFront account verification error
    if (err.message?.includes('must be verified') || err.message?.includes('Access denied for operation')) {
      console.log('CloudFront account verification required - checking for existing infrastructure...')

      // Try to find an existing CloudFront distribution we can use
      try {
        const cloudfront = new CloudFrontClient()
        const distributions = await cloudfront.listDistributions()

        for (const dist of distributions) {
          let aliases: string[] = []
          if (dist.Aliases?.Items) {
            if (Array.isArray(dist.Aliases.Items)) {
              aliases = dist.Aliases.Items
            }
            else if (typeof dist.Aliases.Items === 'object') {
              const cname = (dist.Aliases.Items as any).CNAME
              if (typeof cname === 'string') {
                aliases = [cname]
              }
              else if (Array.isArray(cname)) {
                aliases = cname
              }
            }
          }

          if (aliases.includes(domain)) {
            console.log(`Found existing CloudFront distribution ${dist.Id} with alias ${domain}`)
            console.log(`Using existing infrastructure despite account verification requirement...`)

            // Get the origin bucket from the distribution
            const distConfig = await cloudfront.getDistributionConfig(dist.Id!)
            const originsData = distConfig.DistributionConfig?.Origins?.Items
            let originBucket: string | undefined

            if (originsData) {
              let originList: any[] = []
              if (Array.isArray(originsData)) {
                originList = originsData
              }
              else if (originsData.Origin) {
                originList = Array.isArray(originsData.Origin) ? originsData.Origin : [originsData.Origin]
              }
              else {
                originList = [originsData]
              }

              for (const origin of originList) {
                const domainName = origin.DomainName || ''
                const s3Match = domainName.match(/^([^.]+)\.s3[\.-]/)
                if (s3Match) {
                  originBucket = s3Match[1]
                  break
                }
              }
            }

            if (originBucket) {
              console.log(`Using existing S3 bucket: ${originBucket}`)

              // Also ensure DNS records exist
              const distributionDomain = dist.DomainName
              if (distributionDomain) {
                await ensureDnsRecords(dnsProvider, domain, distributionDomain)
              }

              return {
                success: true,
                stackName: `existing-${dist.Id}`,
                bucket: originBucket,
                distributionId: dist.Id,
                distributionDomain: dist.DomainName,
                domain,
                certificateArn,
                message: 'Using existing CloudFront distribution (account verification pending for new distributions)',
              }
            }
          }
        }
      }
      catch {
        // Couldn't find existing infrastructure
      }

      // No existing infrastructure found, show verification message
      const verificationMessage = `
┌─────────────────────────────────────────────────────────────────────────────┐
│  AWS ACCOUNT VERIFICATION REQUIRED                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  Your AWS account must be verified before you can create CloudFront         │
│  distributions. This is a one-time requirement for new AWS accounts.        │
│                                                                             │
│  To verify your account:                                                    │
│                                                                             │
│  1. Go to: https://console.aws.amazon.com/support/home#/                   │
│  2. Click "Create case"                                                     │
│  3. Select "Service limit increase"                                         │
│  4. For Service: Select "CloudFront"                                        │
│  5. For Request: "Please verify my account for CloudFront access"           │
│  6. Submit the case                                                         │
│                                                                             │
│  Verification typically takes 1-2 business days.                            │
│  After verification, re-run: bunx bunpress deploy                           │
└─────────────────────────────────────────────────────────────────────────────┘`
      console.log(verificationMessage)
      return {
        success: false,
        stackId,
        stackName,
        bucket: finalBucket,
        message: 'CloudFront account verification required. Please contact AWS Support.',
      }
    }

    return {
      success: false,
      stackId,
      stackName,
      bucket: finalBucket,
      message: `Stack deployment failed: ${err.message}`,
    }
  }

  // Get stack outputs
  const stacks = await cf.describeStacks({ stackName })
  const outputs = stacks.Stacks[0]?.Outputs || []
  const getOutput = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue

  const distributionDomain = getOutput('DistributionDomain')

  // Create DNS records using external DNS provider
  if (distributionDomain) {
    console.log(`Creating DNS records via ${dnsProvider.name}...`)
    await ensureDnsRecords(dnsProvider, domain, distributionDomain)
  }

  return {
    success: true,
    stackId,
    stackName,
    bucket: getOutput('BucketName') || finalBucket,
    distributionId: getOutput('DistributionId'),
    distributionDomain,
    domain,
    certificateArn,
    message: 'Static site infrastructure deployed successfully with external DNS',
  }
}

/**
 * Create or update DNS records pointing to CloudFront
 */
async function ensureDnsRecords(
  dnsProvider: DnsProvider,
  domain: string,
  cloudfrontDomain: string,
): Promise<void> {
  // Create CNAME record pointing to CloudFront
  // Note: For apex domains (e.g., bunpress.org), some DNS providers support ALIAS/ANAME records
  // Porkbun supports ALIAS records for apex domains

  // Check if this is an apex domain (no subdomain)
  const parts = domain.split('.')
  const isApexDomain = parts.length === 2

  if (isApexDomain) {
    // For apex domains, create an ALIAS record (Porkbun supports this)
    // Porkbun uses 'ALIAS' type for apex domain CNAME-like behavior
    console.log(`Creating ALIAS record for apex domain ${domain} -> ${cloudfrontDomain}`)

    const result = await dnsProvider.upsertRecord(domain, {
      name: domain,
      type: 'ALIAS' as any, // Porkbun-specific type for apex domains
      content: cloudfrontDomain,
      ttl: 600,
    })

    if (!result.success) {
      // Fallback to A record using CloudFront IPs (not recommended but works)
      console.log(`ALIAS record failed, trying CNAME with @ subdomain...`)
      const cnameResult = await dnsProvider.upsertRecord(domain, {
        name: domain,
        type: 'CNAME',
        content: cloudfrontDomain,
        ttl: 600,
      })

      if (!cnameResult.success) {
        console.warn(`Warning: Could not create DNS record: ${cnameResult.message}`)
        console.warn(`Please manually create a CNAME or ALIAS record:`)
        console.warn(`  ${domain} -> ${cloudfrontDomain}`)
      }
      else {
        console.log(`Created CNAME record: ${domain} -> ${cloudfrontDomain}`)
      }
    }
    else {
      console.log(`Created ALIAS record: ${domain} -> ${cloudfrontDomain}`)
    }

    // Also create CNAME for www subdomain
    const wwwDomain = `www.${domain}`
    console.log(`Creating CNAME record for ${wwwDomain} -> ${cloudfrontDomain}`)
    const wwwResult = await dnsProvider.upsertRecord(domain, {
      name: wwwDomain,
      type: 'CNAME',
      content: cloudfrontDomain,
      ttl: 600,
    })

    if (!wwwResult.success) {
      console.warn(`Warning: Could not create www DNS record: ${wwwResult.message}`)
      console.warn(`Please manually create a CNAME record:`)
      console.warn(`  ${wwwDomain} -> ${cloudfrontDomain}`)
    }
    else {
      console.log(`Created CNAME record: ${wwwDomain} -> ${cloudfrontDomain}`)
    }
  }
  else {
    // For subdomains, use standard CNAME
    console.log(`Creating CNAME record for ${domain} -> ${cloudfrontDomain}`)

    const result = await dnsProvider.upsertRecord(domain, {
      name: domain,
      type: 'CNAME',
      content: cloudfrontDomain,
      ttl: 600,
    })

    if (!result.success) {
      console.warn(`Warning: Could not create DNS record: ${result.message}`)
      console.warn(`Please manually create a CNAME record:`)
      console.warn(`  ${domain} -> ${cloudfrontDomain}`)
    }
    else {
      console.log(`Created CNAME record: ${domain} -> ${cloudfrontDomain}`)
    }
  }
}

/**
 * Full deployment with external DNS: infrastructure + files + cache invalidation
 */
export async function deployStaticSiteWithExternalDnsFull(config: ExternalDnsStaticSiteConfig & {
  sourceDir: string
  cleanBucket?: boolean
  onProgress?: (stage: string, detail?: string) => void
}): Promise<ExternalDnsDeployResult> {
  const { sourceDir, cleanBucket = true, onProgress, ...siteConfig } = config

  // Step 1: Deploy infrastructure
  onProgress?.('infrastructure', 'Deploying CloudFormation stack...')
  const infraResult = await deployStaticSiteWithExternalDns(siteConfig)

  if (!infraResult.success) {
    return infraResult
  }

  // Step 2: Clean bucket before upload
  if (cleanBucket) {
    onProgress?.('clean', 'Cleaning old files from S3...')
    try {
      const s3 = new S3Client(siteConfig.region || 'us-east-1')
      await s3.emptyBucket(infraResult.bucket)
    }
    catch (err: any) {
      console.log(`Note: Could not clean bucket: ${err.message}`)
    }
  }

  // Step 3: Upload files
  onProgress?.('upload', 'Uploading files to S3...')
  const { uploadStaticFiles } = await import('./static-site')
  const uploadResult = await uploadStaticFiles({
    sourceDir,
    bucket: infraResult.bucket,
    region: siteConfig.region || 'us-east-1',
    cacheControl: siteConfig.cacheControl,
    onProgress: (uploaded, total, file) => {
      onProgress?.('upload', `${uploaded}/${total}: ${file}`)
    },
  })

  if (uploadResult.errors.length > 0) {
    return {
      ...infraResult,
      success: false,
      message: `Upload errors: ${uploadResult.errors.join(', ')}`,
      filesUploaded: uploadResult.uploaded,
    }
  }

  // Step 4: Invalidate cache (only if files were uploaded)
  if (infraResult.distributionId && uploadResult.uploaded > 0) {
    onProgress?.('invalidate', 'Invalidating CloudFront cache...')
    const { invalidateCache } = await import('./static-site')
    await invalidateCache(infraResult.distributionId)
  }

  onProgress?.('complete', 'Deployment complete!')

  const message = uploadResult.skipped > 0
    ? `Deployed ${uploadResult.uploaded} files (${uploadResult.skipped} unchanged) with external DNS`
    : `Deployed ${uploadResult.uploaded} files successfully with external DNS`

  return {
    ...infraResult,
    filesUploaded: uploadResult.uploaded,
    filesSkipped: uploadResult.skipped,
    message,
  }
}
