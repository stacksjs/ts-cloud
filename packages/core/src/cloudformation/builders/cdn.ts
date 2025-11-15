import type { CloudFormationBuilder } from '../builder'
import { Fn } from '../types'

export interface CDNConfig {
  enabled: boolean
  origins?: Array<{
    id: string
    domainName: string
    pathPattern?: string
    originPath?: string
  }>
  customDomain?: {
    domain: string
    certificateArn: string
  }
  cachePolicy?: {
    minTTL?: number
    defaultTTL?: number
    maxTTL?: number
  }
  compress?: boolean
  http3?: boolean
  errorPages?: {
    [code: string]: string
  }
  edgeFunctions?: Array<{
    eventType: 'viewer-request' | 'viewer-response' | 'origin-request' | 'origin-response'
    functionArn: string
    name: string
  }>
  priceClass?: 'PriceClass_All' | 'PriceClass_200' | 'PriceClass_100'
}

/**
 * Add CloudFront distribution to CloudFormation template
 */
export function addCDNResources(
  builder: CloudFormationBuilder,
  config: CDNConfig,
): void {
  if (!config.enabled) {
    return
  }

  // Origin Access Identity for S3 origins
  builder.addResource('CloudFrontOriginAccessIdentity', 'AWS::CloudFront::CloudFrontOriginAccessIdentity', {
    CloudFrontOriginAccessIdentityConfig: {
      Comment: Fn.sub('${AWS::StackName} CloudFront OAI'),
    },
  })

  // Build origins list
  const origins: any[] = []
  const cacheBehaviors: any[] = []

  // Default origin from S3 if no custom origins specified
  if (!config.origins || config.origins.length === 0) {
    // Assume there's a static bucket
    origins.push({
      Id: 'S3Origin',
      DomainName: Fn.getAtt('StaticBucket', 'DomainName'),
      S3OriginConfig: {
        OriginAccessIdentity: Fn.sub('origin-access-identity/cloudfront/${CloudFrontOriginAccessIdentity}'),
      },
    })
  }
  else {
    // Use custom origins
    config.origins.forEach((origin, index) => {
      const originConfig: any = {
        Id: origin.id,
        DomainName: origin.domainName,
      }

      if (origin.originPath) {
        originConfig.OriginPath = origin.originPath
      }

      // Determine origin type
      if (origin.domainName.includes('s3')) {
        originConfig.S3OriginConfig = {
          OriginAccessIdentity: Fn.sub('origin-access-identity/cloudfront/${CloudFrontOriginAccessIdentity}'),
        }
      }
      else {
        // Custom origin (ALB, API Gateway, etc.)
        originConfig.CustomOriginConfig = {
          HTTPPort: 80,
          HTTPSPort: 443,
          OriginProtocolPolicy: 'https-only',
          OriginSSLProtocols: ['TLSv1.2'],
        }
      }

      origins.push(originConfig)

      // Add cache behavior for non-default origins
      if (index > 0 || origin.pathPattern) {
        cacheBehaviors.push({
          PathPattern: origin.pathPattern || `/${origin.id}/*`,
          TargetOriginId: origin.id,
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
          CachedMethods: ['GET', 'HEAD'],
          Compress: config.compress !== false,
          ForwardedValues: {
            QueryString: true,
            Cookies: {
              Forward: 'none',
            },
          },
          MinTTL: config.cachePolicy?.minTTL || 0,
          DefaultTTL: config.cachePolicy?.defaultTTL || 86400,
          MaxTTL: config.cachePolicy?.maxTTL || 31536000,
        })
      }
    })
  }

  // Default cache behavior
  const defaultCacheBehavior: any = {
    TargetOriginId: origins[0].Id,
    ViewerProtocolPolicy: 'redirect-to-https',
    AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
    CachedMethods: ['GET', 'HEAD'],
    Compress: config.compress !== false,
    ForwardedValues: {
      QueryString: true,
      Cookies: {
        Forward: 'none',
      },
    },
    MinTTL: config.cachePolicy?.minTTL || 0,
    DefaultTTL: config.cachePolicy?.defaultTTL || 86400,
    MaxTTL: config.cachePolicy?.maxTTL || 31536000,
  }

  // Lambda@Edge functions
  if (config.edgeFunctions && config.edgeFunctions.length > 0) {
    defaultCacheBehavior.LambdaFunctionAssociations = config.edgeFunctions.map(fn => ({
      EventType: fn.eventType,
      LambdaFunctionARN: fn.functionArn,
    }))
  }

  // CloudFront distribution
  const distributionConfig: any = {
    Enabled: true,
    HttpVersion: config.http3 ? 'http3' : 'http2',
    IPV6Enabled: true,
    Origins: origins,
    DefaultCacheBehavior: defaultCacheBehavior,
    PriceClass: config.priceClass || 'PriceClass_100',
    ViewerCertificate: {},
  }

  // Cache behaviors for additional origins
  if (cacheBehaviors.length > 0) {
    distributionConfig.CacheBehaviors = cacheBehaviors
  }

  // Custom domain
  if (config.customDomain) {
    distributionConfig.Aliases = [config.customDomain.domain]
    distributionConfig.ViewerCertificate = {
      AcmCertificateArn: config.customDomain.certificateArn,
      SslSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
    }
  }
  else {
    distributionConfig.ViewerCertificate = {
      CloudFrontDefaultCertificate: true,
    }
  }

  // Custom error responses
  if (config.errorPages) {
    distributionConfig.CustomErrorResponses = Object.entries(config.errorPages).map(([code, path]) => ({
      ErrorCode: Number.parseInt(code),
      ResponseCode: 200,
      ResponsePagePath: path,
      ErrorCachingMinTTL: 300,
    }))
  }

  // Default root object
  distributionConfig.DefaultRootObject = 'index.html'

  // Comment
  distributionConfig.Comment = Fn.sub('${AWS::StackName} CloudFront Distribution')

  builder.addResource('CloudFrontDistribution', 'AWS::CloudFront::Distribution', {
    DistributionConfig: distributionConfig,
  }, {
    dependsOn: 'CloudFrontOriginAccessIdentity',
  })

  // Update S3 bucket policy to allow CloudFront access
  if (!config.origins || config.origins.length === 0) {
    builder.addResource('StaticBucketPolicyForCloudFront', 'AWS::S3::BucketPolicy', {
      Bucket: Fn.ref('StaticBucket'),
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'AllowCloudFrontAccess',
          Effect: 'Allow',
          Principal: {
            CanonicalUser: Fn.getAtt('CloudFrontOriginAccessIdentity', 'S3CanonicalUserId'),
          },
          Action: 's3:GetObject',
          Resource: Fn.join('', [
            Fn.getAtt('StaticBucket', 'Arn'),
            '/*',
          ]),
        }],
      },
    }, {
      dependsOn: ['StaticBucket', 'CloudFrontOriginAccessIdentity'],
    })
  }

  // Route53 DNS record for custom domain
  if (config.customDomain) {
    // Note: This assumes a hosted zone exists
    // In a real implementation, you'd need to either create or import the hosted zone
    builder.addResource('CloudFrontDNSRecord', 'AWS::Route53::RecordSet', {
      HostedZoneName: Fn.sub(`${extractRootDomain(config.customDomain.domain)}.`),
      Name: config.customDomain.domain,
      Type: 'A',
      AliasTarget: {
        HostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront hosted zone ID (constant)
        DNSName: Fn.getAtt('CloudFrontDistribution', 'DomainName'),
        EvaluateTargetHealth: false,
      },
    }, {
      dependsOn: 'CloudFrontDistribution',
    })
  }

  // Outputs
  builder.template.Outputs = {
    ...builder.template.Outputs,
    CloudFrontDistributionId: {
      Description: 'CloudFront distribution ID',
      Value: Fn.ref('CloudFrontDistribution'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-cloudfront-id'),
      },
    },
    CloudFrontDomainName: {
      Description: 'CloudFront distribution domain name',
      Value: Fn.getAtt('CloudFrontDistribution', 'DomainName'),
      Export: {
        Name: Fn.sub('${AWS::StackName}-cloudfront-domain'),
      },
    },
  }

  if (config.customDomain) {
    builder.template.Outputs.CloudFrontURL = {
      Description: 'CloudFront custom domain URL',
      Value: Fn.sub(`https://${config.customDomain.domain}`),
    }
  }
}

/**
 * Extract root domain from subdomain
 */
function extractRootDomain(domain: string): string {
  const parts = domain.split('.')
  if (parts.length >= 2) {
    return parts.slice(-2).join('.')
  }
  return domain
}
