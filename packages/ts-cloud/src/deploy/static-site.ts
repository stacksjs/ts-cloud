/**
 * Static Site Deployment Module
 * Deploys static sites to AWS using CloudFormation (S3 + CloudFront + Route53/External DNS + ACM)
 */

import { CloudFormationClient } from '../aws/cloudformation'
import { S3Client } from '../aws/s3'
import { CloudFrontClient } from '../aws/cloudfront'
import { Route53Client } from '../aws/route53'
import { ACMClient, ACMDnsValidator } from '../aws/acm'
import type { DnsProviderConfig } from '../dns/types'
import { deployStaticSiteWithExternalDns, deployStaticSiteWithExternalDnsFull } from './static-site-external-dns'

export interface StaticSiteConfig {
  /** Site name used for resource naming */
  siteName: string
  /** AWS region for S3 bucket */
  region?: string
  /** Custom domain (e.g., docs.example.com) */
  domain?: string
  /** Subdomain part (e.g., 'docs') - used with baseDomain */
  subdomain?: string
  /** Base domain (e.g., 'example.com') - must have Route53 hosted zone */
  baseDomain?: string
  /** S3 bucket name (auto-generated if not provided) */
  bucket?: string
  /** Route53 hosted zone ID (auto-detected if not provided) */
  hostedZoneId?: string
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
  /**
   * External DNS provider configuration (optional)
   * When provided, DNS records will be managed via the specified provider (Porkbun, GoDaddy, etc.)
   * instead of Route53. Useful when your domain is registered outside AWS.
   */
  dnsProvider?: DnsProviderConfig
}

export interface DeployResult {
  success: boolean
  stackId?: string
  stackName: string
  bucket: string
  distributionId?: string
  distributionDomain?: string
  domain?: string
  certificateArn?: string
  message: string
}

export interface UploadOptions {
  /** Local directory containing built files */
  sourceDir: string
  /** S3 bucket name */
  bucket: string
  /** AWS region */
  region: string
  /** Cache control header */
  cacheControl?: string
  /** Callback for progress updates */
  onProgress?: (uploaded: number, total: number, file: string) => void
}

/**
 * Generate CloudFormation template for static site infrastructure
 */
export function generateStaticSiteTemplate(config: {
  bucketName: string
  domain?: string
  certificateArn?: string
  hostedZoneId?: string
  defaultRootObject?: string
  errorDocument?: string
}): object {
  const {
    bucketName,
    domain,
    certificateArn,
    hostedZoneId,
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

  // CloudFront Function for URL rewriting (append .html to URLs without extensions)
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
    distributionConfig.Aliases = [domain]
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

  // Route53 DNS Record if domain and hosted zone provided
  if (domain && hostedZoneId) {
    resources.DNSRecord = {
      Type: 'AWS::Route53::RecordSet',
      DependsOn: 'CloudFrontDistribution',
      Properties: {
        HostedZoneId: hostedZoneId,
        Name: domain,
        Type: 'A',
        AliasTarget: {
          DNSName: { 'Fn::GetAtt': ['CloudFrontDistribution', 'DomainName'] },
          HostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront hosted zone ID (global)
          EvaluateTargetHealth: false,
        },
      },
    }

    // Also create AAAA record for IPv6
    resources.DNSRecordIPv6 = {
      Type: 'AWS::Route53::RecordSet',
      DependsOn: 'CloudFrontDistribution',
      Properties: {
        HostedZoneId: hostedZoneId,
        Name: domain,
        Type: 'AAAA',
        AliasTarget: {
          DNSName: { 'Fn::GetAtt': ['CloudFrontDistribution', 'DomainName'] },
          HostedZoneId: 'Z2FDTNDATAQYW2',
          EvaluateTargetHealth: false,
        },
      },
    }

    outputs.SiteUrl = {
      Description: 'Site URL',
      Value: { 'Fn::Sub': 'https://${DNSRecord}' },
    }
  }

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Static site infrastructure for ${domain || bucketName}`,
    Resources: resources,
    Outputs: outputs,
  }
}

/**
 * Deploy a static site to AWS
 * Automatically routes to external DNS deployment when a non-Route53 dnsProvider is configured
 */
export async function deployStaticSite(config: StaticSiteConfig): Promise<DeployResult> {
  // If using external DNS provider (not Route53), delegate to the external DNS deployment
  if (config.dnsProvider && config.dnsProvider.provider !== 'route53') {
    const domain = config.domain || (config.subdomain && config.baseDomain ? `${config.subdomain}.${config.baseDomain}` : undefined)
    if (!domain) {
      return {
        success: false,
        stackName: config.stackName || `${config.siteName}-static-site`,
        bucket: config.bucket || `${config.siteName}-${Date.now()}`,
        message: 'Domain is required when using external DNS provider',
      }
    }

    return deployStaticSiteWithExternalDns({
      siteName: config.siteName,
      region: config.region,
      domain,
      bucket: config.bucket,
      certificateArn: config.certificateArn,
      stackName: config.stackName,
      defaultRootObject: config.defaultRootObject,
      errorDocument: config.errorDocument,
      cacheControl: config.cacheControl,
      tags: config.tags,
      dnsProvider: config.dnsProvider,
    })
  }

  const region = config.region || 'us-east-1'
  const cfRegion = 'us-east-1' // CloudFormation for global resources must be in us-east-1

  // Determine full domain
  let domain: string | undefined
  if (config.domain) {
    domain = config.domain
  }
  else if (config.subdomain && config.baseDomain) {
    domain = `${config.subdomain}.${config.baseDomain}`
  }

  // Generate bucket name if not provided
  const bucket = config.bucket || (domain ? domain.replace(/\./g, '-') : `${config.siteName}-${Date.now()}`)

  // Generate stack name
  const stackName = config.stackName || `${config.siteName}-static-site`

  // Initialize clients
  const cf = new CloudFormationClient(cfRegion)
  const route53 = new Route53Client()
  const acm = new ACMClient('us-east-1') // ACM certs for CloudFront must be in us-east-1
  const acmValidator = new ACMDnsValidator('us-east-1')

  let hostedZoneId = config.hostedZoneId
  let certificateArn = config.certificateArn

  // Auto-detect hosted zone if domain is specified
  if (domain && !hostedZoneId) {
    const zone = await route53.findHostedZoneForDomain(domain)
    if (zone) {
      hostedZoneId = zone.Id.replace('/hostedzone/', '')
    }
    else {
      return {
        success: false,
        stackName,
        bucket,
        message: `No Route53 hosted zone found for ${config.baseDomain || domain}. Please create one first.`,
      }
    }
  }

  // Auto-create SSL certificate if domain is specified
  if (domain && !certificateArn && hostedZoneId) {
    // Check for existing certificate
    const existingCert = await acm.findCertificateByDomain(domain)
    if (existingCert && existingCert.Status === 'ISSUED') {
      certificateArn = existingCert.CertificateArn
    }
    else {
      // Request and validate new certificate
      const certResult = await acmValidator.requestAndValidate({
        domainName: domain,
        hostedZoneId,
        waitForValidation: true,
        maxWaitMinutes: 10,
      })
      certificateArn = certResult.certificateArn
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

      // If stack is being deleted, wait for it to complete
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
        // Get existing bucket name from stack outputs to ensure consistency during updates
        const outputs = stack.Outputs || []
        existingBucketName = outputs.find(o => o.OutputKey === 'BucketName')?.OutputValue
      }
    }
  }
  catch (err: any) {
    // Stack doesn't exist - this is expected for new deployments
    if (err.message?.includes('does not exist') || err.code === 'ValidationError') {
      stackExists = false
    }
    else {
      throw err
    }
  }

  // If stack doesn't exist, check for orphaned resources and clean them up
  // Use a unique bucket name suffix if cleanup fails
  // If stack exists, use the existing bucket name to avoid CloudFormation trying to recreate resources
  let finalBucket = existingBucketName || bucket
  if (!stackExists) {
    const s3 = new S3Client(region)
    const cloudfront = new CloudFrontClient()

    // Check if S3 bucket exists (orphaned from previous non-CloudFormation deployment)
    let bucketCleanedUp = false
    try {
      const headResult = await s3.headBucket(bucket)
      if (headResult.exists) {
        // Bucket exists without a stack - try to clean it up with timeout
        console.log(`Found orphaned S3 bucket ${bucket}, cleaning up...`)
        try {
          // Timeout for bucket cleanup (30 seconds)
          const cleanupPromise = s3.emptyBucket(bucket).then(() => s3.deleteBucket(bucket))
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Bucket cleanup timeout')), 30000),
          )
          await Promise.race([cleanupPromise, timeoutPromise])
          console.log(`Deleted orphaned S3 bucket ${bucket}`)
          bucketCleanedUp = true
        }
        catch (cleanupErr: any) {
          console.log(`Note: Could not clean up S3 bucket: ${cleanupErr.message}`)
          // If we can't clean up the bucket, use a unique suffix
          const suffix = Date.now().toString(36)
          finalBucket = `${bucket}-${suffix}`
          console.log(`Using alternative bucket name: ${finalBucket}`)
        }
      }
    }
    catch {
      // Bucket doesn't exist, good
    }

    // Check for existing CloudFront distribution that WE created for this domain
    // Only reuse distributions that have our domain as an alias - NEVER use other projects' resources
    if (domain) {
      try {
        console.log(`Checking for existing CloudFront distribution for ${domain}...`)
        const distributions = await cloudfront.listDistributions()

        for (const dist of distributions) {
          // Handle various alias structures: Items can be an array, or Items.CNAME can be a string or array
          let aliases: string[] = []
          if (dist.Aliases?.Items) {
            if (Array.isArray(dist.Aliases.Items)) {
              aliases = dist.Aliases.Items
            }
            else if (typeof dist.Aliases.Items === 'object') {
              // Items.CNAME can be a string or array
              const cname = (dist.Aliases.Items as any).CNAME
              if (typeof cname === 'string') {
                aliases = [cname]
              }
              else if (Array.isArray(cname)) {
                aliases = cname
              }
            }
          }

          // Only use distribution if it has OUR domain as an alias
          if (aliases.includes(domain)) {
            console.log(`Found existing CloudFront distribution ${dist.Id} for ${domain}`)

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
                // Extract bucket name from S3 domain
                const s3Match = domainName.match(/^([^.]+)\.s3[\.-]/)
                if (s3Match) {
                  originBucket = s3Match[1]
                  break
                }
              }
            }

            if (originBucket) {
              // Verify this bucket name matches our expected naming convention
              const expectedBucketPrefix = domain.replace(/\./g, '-')
              if (!originBucket.startsWith(expectedBucketPrefix) && !originBucket.includes(config.siteName)) {
                console.log(`Warning: Found distribution with mismatched bucket ${originBucket}, skipping...`)
                continue
              }

              console.log(`Using existing S3 bucket: ${originBucket}`)

              // Ensure Route53 records exist for this distribution
              if (hostedZoneId && dist.DomainName) {
                try {
                  console.log(`Ensuring Route53 records exist for ${domain}...`)
                  await route53.createAliasRecord({
                    HostedZoneId: hostedZoneId,
                    Name: domain,
                    Type: 'A',
                    TargetHostedZoneId: Route53Client.CloudFrontHostedZoneId,
                    TargetDNSName: dist.DomainName,
                    EvaluateTargetHealth: false,
                  })
                  await route53.createAliasRecord({
                    HostedZoneId: hostedZoneId,
                    Name: domain,
                    Type: 'AAAA',
                    TargetHostedZoneId: Route53Client.CloudFrontHostedZoneId,
                    TargetDNSName: dist.DomainName,
                    EvaluateTargetHealth: false,
                  })
                  console.log(`Route53 records ensured for ${domain}`)
                }
                catch (dnsErr: any) {
                  console.log(`Note: Could not update Route53 records: ${dnsErr.message}`)
                }
              }

              return {
                success: true,
                stackName: `existing-${dist.Id}`,
                bucket: originBucket,
                distributionId: dist.Id,
                distributionDomain: dist.DomainName,
                domain,
                certificateArn,
                message: 'Using existing CloudFront distribution',
              }
            }
          }
        }
      }
      catch {
        // No distributions or error listing them
      }

      // Check for orphaned Route53 records
      if (hostedZoneId) {
        try {
          const recordsResult = await route53.listResourceRecordSets({ HostedZoneId: hostedZoneId })
          const records = recordsResult.ResourceRecordSets || []
          for (const record of records) {
            if (record.Name === `${domain}.` && (record.Type === 'A' || record.Type === 'AAAA')) {
              // This is an alias record, check if it points to a CloudFront distribution
              if (record.AliasTarget) {
                console.log(`Found orphaned Route53 ${record.Type} record for ${domain}, cleaning up...`)
                try {
                  await route53.deleteRecord({
                    HostedZoneId: hostedZoneId,
                    RecordSet: record,
                  })
                  console.log(`Deleted orphaned Route53 ${record.Type} record for ${domain}`)
                }
                catch (recordErr: any) {
                  console.log(`Note: Could not delete Route53 record: ${recordErr.message}`)
                }
              }
            }
          }
        }
        catch {
          // Error listing/deleting records
        }
      }
    }
  }

  // Generate CloudFormation template with final bucket name
  const template = generateStaticSiteTemplate({
    bucketName: finalBucket,
    domain,
    certificateArn,
    hostedZoneId,
    defaultRootObject: config.defaultRootObject,
    errorDocument: config.errorDocument,
  })

  // Build tags
  const tags = Object.entries(config.tags || {}).map(([Key, Value]) => ({ Key, Value }))
  tags.push({ Key: 'ManagedBy', Value: 'ts-cloud' })
  tags.push({ Key: 'Application', Value: config.siteName })

  // Create or update stack
  let stackId: string
  let isUpdate = false

  if (stackExists) {
    isUpdate = true
    console.log(`Updating CloudFormation stack: ${stackName}`)
    console.log(`Using existing bucket: ${finalBucket}`)
    console.log(`Domain: ${domain || 'not specified'}`)
    console.log(`Certificate ARN: ${certificateArn || 'not specified'}`)
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
      // No updates needed is not an error
      if (err.message?.includes('No updates are to be performed')) {
        const stacks = await cf.describeStacks({ stackName })
        stackId = stacks.Stacks[0].StackId
        // No actual update needed, return success with existing stack info
        const outputs = stacks.Stacks[0]?.Outputs || []
        const getOutput = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue

        return {
          success: true,
          stackId,
          stackName,
          bucket: getOutput('BucketName') || finalBucket,
          distributionId: getOutput('DistributionId'),
          distributionDomain: getOutput('DistributionDomain'),
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
    console.log(`Domain: ${domain || 'not specified'}`)
    console.log(`Certificate ARN: ${certificateArn || 'not specified'}`)
    console.log('Stack does not exist, creating...')
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

  // Wait for stack to complete using the appropriate wait type
  console.log(`Waiting for stack to reach ${isUpdate ? 'stack-update-complete' : 'stack-create-complete'}...`)
  try {
    await cf.waitForStack(stackName, isUpdate ? 'stack-update-complete' : 'stack-create-complete')
    console.log('Stack operation completed successfully!')
  }
  catch (err: any) {
    // CloudFormation failed - try direct API creation instead
    // This handles cases where CloudFormation has stricter validation than direct API calls
    if (err.message?.includes('must be verified') || err.message?.includes('Access denied for operation') || err.message?.includes('failed')) {
      console.log('CloudFormation deployment failed, trying direct API creation...')

      const cloudfront = new CloudFrontClient()

      // First check if we already have a distribution for this domain
      if (domain) {
        try {
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
      }

      // No existing infrastructure found - try to create directly via API calls
      // This often bypasses CloudFormation's stricter validation
      console.log('No existing infrastructure found, creating via direct API calls...')

      try {
        const s3Direct = new S3Client(region)

        // Step 1: Create or reuse S3 bucket
        const bucketExists = await s3Direct.headBucket(finalBucket)
        if (bucketExists.exists) {
          console.log(`Using existing S3 bucket: ${finalBucket}`)
        }
        else {
          console.log(`Creating S3 bucket: ${finalBucket}...`)
          await s3Direct.createBucket(finalBucket)
        }

        // Configure bucket for static website hosting
        await s3Direct.putBucketWebsite(finalBucket, {
          IndexDocument: config.defaultRootObject || 'index.html',
          ErrorDocument: config.errorDocument || '404.html',
        })

        // Block public access (we'll use CloudFront OAC)
        await s3Direct.putPublicAccessBlock(finalBucket, {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: false,
          RestrictPublicBuckets: false,
        })
        console.log(`S3 bucket ${finalBucket} configured`)

        // Step 2: Create Origin Access Control
        const oacName = `OAC-${finalBucket}`
        console.log(`Creating Origin Access Control: ${oacName}...`)
        const oac = await cloudfront.findOrCreateOriginAccessControl(oacName)
        console.log(`Origin Access Control ${oac.Id} ready`)

        // Step 3: Create CloudFront distribution
        console.log(`Creating CloudFront distribution...`)
        const distResult = await cloudfront.createDistributionForS3({
          bucketName: finalBucket,
          bucketRegion: region,
          originAccessControlId: oac.Id,
          aliases: domain ? [domain] : [],
          certificateArn: certificateArn,
          defaultRootObject: config.defaultRootObject || 'index.html',
          comment: `Distribution for ${domain || finalBucket}`,
        })
        console.log(`CloudFront distribution ${distResult.Id} created`)

        // Step 4: Update S3 bucket policy for CloudFront access
        console.log(`Updating S3 bucket policy...`)
        const bucketPolicy = CloudFrontClient.getS3BucketPolicyForCloudFront(finalBucket, distResult.ARN)
        await s3Direct.putBucketPolicy(finalBucket, bucketPolicy)
        console.log(`S3 bucket policy updated`)

        // Step 5: Create Route53 records
        if (domain && hostedZoneId) {
          console.log(`Creating Route53 records for ${domain}...`)
          try {
            await route53.createAliasRecord({
              HostedZoneId: hostedZoneId,
              Name: domain,
              Type: 'A',
              TargetHostedZoneId: Route53Client.CloudFrontHostedZoneId,
              TargetDNSName: distResult.DomainName,
              EvaluateTargetHealth: false,
            })
            await route53.createAliasRecord({
              HostedZoneId: hostedZoneId,
              Name: domain,
              Type: 'AAAA',
              TargetHostedZoneId: Route53Client.CloudFrontHostedZoneId,
              TargetDNSName: distResult.DomainName,
              EvaluateTargetHealth: false,
            })
            console.log(`Route53 records created for ${domain}`)
          }
          catch (dnsErr: any) {
            console.log(`Note: Could not create Route53 records: ${dnsErr.message}`)
          }
        }

        return {
          success: true,
          stackName: `direct-${distResult.Id}`,
          bucket: finalBucket,
          distributionId: distResult.Id,
          distributionDomain: distResult.DomainName,
          domain,
          certificateArn,
          message: 'Static site infrastructure created via direct API calls',
        }
      }
      catch (directErr: any) {
        console.log(`Direct API creation failed: ${directErr.message}`)
        return {
          success: false,
          stackId,
          stackName,
          bucket: finalBucket,
          message: `Deployment failed: ${directErr.message}`,
        }
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

  return {
    success: true,
    stackId,
    stackName,
    bucket: getOutput('BucketName') || finalBucket,
    distributionId: getOutput('DistributionId'),
    distributionDomain: getOutput('DistributionDomain'),
    domain,
    certificateArn,
    message: 'Static site infrastructure deployed successfully',
  }
}

/**
 * Upload files to S3 bucket
 */
export async function uploadStaticFiles(options: UploadOptions): Promise<{ uploaded: number; errors: string[] }> {
  const { sourceDir, bucket, region, cacheControl = 'max-age=31536000, public', onProgress } = options
  const s3 = new S3Client(region)

  const { readdir, stat } = await import('node:fs/promises')
  const { join, relative } = await import('node:path')

  // Recursively list files
  async function listFiles(dir: string): Promise<string[]> {
    const files: string[] = []
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...await listFiles(fullPath))
      }
      else {
        files.push(fullPath)
      }
    }

    return files
  }

  // Get content type
  function getContentType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase()
    const types: Record<string, string> = {
      'html': 'text/html; charset=utf-8',
      'css': 'text/css; charset=utf-8',
      'js': 'application/javascript; charset=utf-8',
      'json': 'application/json; charset=utf-8',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'ico': 'image/x-icon',
      'webp': 'image/webp',
      'woff': 'font/woff',
      'woff2': 'font/woff2',
      'ttf': 'font/ttf',
      'xml': 'application/xml',
      'txt': 'text/plain; charset=utf-8',
    }
    return types[ext || ''] || 'application/octet-stream'
  }

  const files = await listFiles(sourceDir)
  const errors: string[] = []
  let uploaded = 0

  for (const file of files) {
    const key = relative(sourceDir, file)
    const contentType = getContentType(file)
    const fileCacheControl = file.endsWith('.html') ? 'max-age=3600, public' : cacheControl

    try {
      const content = await Bun.file(file).arrayBuffer()

      await s3.putObject({
        bucket,
        key,
        body: Buffer.from(content),
        contentType,
        cacheControl: fileCacheControl,
      })

      uploaded++
      onProgress?.(uploaded, files.length, key)
    }
    catch (err: any) {
      errors.push(`Failed to upload ${key}: ${err.message}`)
    }
  }

  return { uploaded, errors }
}

/**
 * Invalidate CloudFront cache
 */
export async function invalidateCache(distributionId: string): Promise<{ invalidationId: string }> {
  const cloudfront = new CloudFrontClient()
  const result = await cloudfront.invalidateAll(distributionId)
  return { invalidationId: result.Id }
}

/**
 * Delete static site infrastructure
 */
export async function deleteStaticSite(stackName: string, region: string = 'us-east-1'): Promise<{ success: boolean; message: string }> {
  const cf = new CloudFormationClient(region)

  // First, empty the S3 bucket (CloudFormation can't delete non-empty buckets)
  try {
    const stacks = await cf.describeStacks({ stackName })
    const outputs = stacks.Stacks[0]?.Outputs || []
    const bucketName = outputs.find(o => o.OutputKey === 'BucketName')?.OutputValue

    if (bucketName) {
      const s3 = new S3Client(region)
      await s3.emptyBucket(bucketName)
    }
  }
  catch {
    // Bucket might not exist or already be empty
  }

  // Delete the stack
  await cf.deleteStack(stackName)

  // Wait for deletion
  const result = await cf.waitForStackComplete(stackName, 60, 10000)

  return {
    success: result.success || result.status === 'DELETE_COMPLETE',
    message: result.success ? 'Static site deleted successfully' : `Deletion failed: ${result.status}`,
  }
}

/**
 * Full deployment: infrastructure + files + cache invalidation
 */
export async function deployStaticSiteFull(config: StaticSiteConfig & {
  sourceDir: string
  cleanBucket?: boolean
  onProgress?: (stage: string, detail?: string) => void
}): Promise<DeployResult & { filesUploaded?: number }> {
  const { sourceDir, cleanBucket = true, onProgress, ...siteConfig } = config

  // Step 1: Deploy infrastructure
  onProgress?.('infrastructure', 'Deploying CloudFormation stack...')
  const infraResult = await deployStaticSite(siteConfig)

  if (!infraResult.success) {
    return infraResult
  }

  // Step 2: Clean bucket before upload (ensures no stale files)
  if (cleanBucket) {
    onProgress?.('clean', 'Cleaning old files from S3...')
    try {
      const s3 = new S3Client(siteConfig.region || 'us-east-1')
      await s3.emptyBucket(infraResult.bucket)
    }
    catch (err: any) {
      // Log but don't fail - bucket might be empty
      console.log(`Note: Could not clean bucket: ${err.message}`)
    }
  }

  // Step 3: Upload files
  onProgress?.('upload', 'Uploading files to S3...')
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

  // Step 3: Invalidate cache
  if (infraResult.distributionId) {
    onProgress?.('invalidate', 'Invalidating CloudFront cache...')
    await invalidateCache(infraResult.distributionId)
  }

  onProgress?.('complete', 'Deployment complete!')

  return {
    ...infraResult,
    filesUploaded: uploadResult.uploaded,
    message: `Deployed ${uploadResult.uploaded} files successfully`,
  }
}
