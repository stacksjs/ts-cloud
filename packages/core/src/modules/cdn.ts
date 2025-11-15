import type { CloudFrontDistribution, CloudFrontOriginAccessControl } from '@ts-cloud/aws-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@ts-cloud/types'

export interface DistributionOptions {
  slug: string
  environment: EnvironmentType
  origin: OriginConfig
  customDomain?: string
  certificateArn?: string
  errorPages?: ErrorPageMapping[]
  cachePolicy?: CachePolicyConfig
  edgeFunctions?: EdgeFunctionConfig[]
  http3?: boolean
  comment?: string
}

export interface OriginConfig {
  type: 's3' | 'alb' | 'custom'
  domainName: string
  originPath?: string
  customHeaders?: Record<string, string>
  s3OriginAccessControl?: string
}

export interface ErrorPageMapping {
  errorCode: number
  responseCode?: number
  responsePagePath?: string
}

export interface CachePolicyConfig {
  minTTL?: number
  maxTTL?: number
  defaultTTL?: number
}

export interface EdgeFunctionConfig {
  event: 'origin-request' | 'origin-response' | 'viewer-request' | 'viewer-response'
  functionArn: string
}

/**
 * CDN Module - CloudFront Distribution Management
 * Provides clean API for creating and configuring CloudFront distributions
 */
export class CDN {
  /**
   * Create a CloudFront distribution
   */
  static createDistribution(options: DistributionOptions): {
    distribution: CloudFrontDistribution
    originAccessControl?: CloudFrontOriginAccessControl
    logicalId: string
  } {
    const {
      slug,
      environment,
      origin,
      customDomain,
      certificateArn,
      errorPages,
      cachePolicy,
      edgeFunctions,
      http3 = false,
      comment,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'cdn',
    })

    const logicalId = generateLogicalId(resourceName)

    // Create origin configuration
    const originConfig: any = {
      Id: 'DefaultOrigin',
      DomainName: origin.domainName,
      OriginPath: origin.originPath || '',
    }

    // Configure S3 origin with OAC
    let originAccessControl: CloudFrontOriginAccessControl | undefined

    if (origin.type === 's3') {
      const oacLogicalId = `${logicalId}OAC`

      originAccessControl = {
        Type: 'AWS::CloudFront::OriginAccessControl',
        Properties: {
          OriginAccessControlConfig: {
            Name: `${resourceName}-oac`,
            Description: `Origin Access Control for ${resourceName}`,
            OriginAccessControlOriginType: 's3',
            SigningBehavior: 'always',
            SigningProtocol: 'sigv4',
          },
        },
      }

      originConfig.OriginAccessControlId = Fn.Ref(oacLogicalId)
    }
    else if (origin.type === 'alb' || origin.type === 'custom') {
      originConfig.CustomOriginConfig = {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: 'https-only',
      }
    }

    // Build distribution
    const distribution: CloudFrontDistribution = {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: comment || `CDN for ${resourceName}`,
          DefaultRootObject: 'index.html',
          Origins: [originConfig],
          DefaultCacheBehavior: {
            TargetOriginId: 'DefaultOrigin',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            CachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            Compress: true,
          },
          PriceClass: 'PriceClass_100', // Use only North America and Europe
          HttpVersion: http3 ? 'http2and3' : 'http2',
        },
      },
    }

    // Configure custom domain and certificate
    if (customDomain && certificateArn) {
      distribution.Properties.DistributionConfig.Aliases = [customDomain]
      distribution.Properties.DistributionConfig.ViewerCertificate = {
        AcmCertificateArn: certificateArn,
        SslSupportMethod: 'sni-only',
        MinimumProtocolVersion: 'TLSv1.2_2021',
      }
    }

    // Configure error pages (for SPA routing)
    if (errorPages && errorPages.length > 0) {
      distribution.Properties.DistributionConfig.CustomErrorResponses = errorPages.map(page => ({
        ErrorCode: page.errorCode,
        ResponseCode: page.responseCode,
        ResponsePagePath: page.responsePagePath,
      }))
    }

    // Configure Lambda@Edge functions
    if (edgeFunctions && edgeFunctions.length > 0) {
      distribution.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations =
        edgeFunctions.map(fn => ({
          EventType: fn.event,
          LambdaFunctionARN: fn.functionArn,
        }))
    }

    return {
      distribution,
      originAccessControl,
      logicalId,
    }
  }

  /**
   * Set custom domain on a distribution
   */
  static setCustomDomain(
    distribution: CloudFrontDistribution,
    domain: string,
    certificateArn: string,
  ): CloudFrontDistribution {
    distribution.Properties.DistributionConfig.Aliases = [domain]
    distribution.Properties.DistributionConfig.ViewerCertificate = {
      AcmCertificateArn: certificateArn,
      SslSupportMethod: 'sni-only',
      MinimumProtocolVersion: 'TLSv1.2_2021',
    }

    return distribution
  }

  /**
   * Set error pages for SPA routing (404 → index.html)
   */
  static setErrorPages(
    distribution: CloudFrontDistribution,
    mappings: ErrorPageMapping[],
  ): CloudFrontDistribution {
    distribution.Properties.DistributionConfig.CustomErrorResponses = mappings.map(page => ({
      ErrorCode: page.errorCode,
      ResponseCode: page.responseCode,
      ResponsePagePath: page.responsePagePath,
    }))

    return distribution
  }

  /**
   * Enable HTTP/3 support
   */
  static enableHttp3(distribution: CloudFrontDistribution): CloudFrontDistribution {
    distribution.Properties.DistributionConfig.HttpVersion = 'http2and3'
    return distribution
  }

  /**
   * Add Lambda@Edge function
   */
  static addEdgeFunction(
    distribution: CloudFrontDistribution,
    event: EdgeFunctionConfig['event'],
    functionArn: string,
  ): CloudFrontDistribution {
    if (!distribution.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations) {
      distribution.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations = []
    }

    distribution.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations.push({
      EventType: event,
      LambdaFunctionARN: functionArn,
    })

    return distribution
  }

  /**
   * Set cache policy with custom TTL
   */
  static setCachePolicy(
    distribution: CloudFrontDistribution,
    ttl: { min?: number, max?: number, default?: number },
  ): CloudFrontDistribution {
    // Note: For full cache policy support, we'd need to create a CachePolicy resource
    // For now, we'll just set the comment to indicate the desired TTL
    distribution.Properties.DistributionConfig.Comment =
      `${distribution.Properties.DistributionConfig.Comment || ''} (TTL: ${ttl.default || 86400}s)`

    return distribution
  }

  /**
   * Create standard SPA (Single Page Application) configuration
   * Routes all 404/403 errors to index.html
   */
  static createSpaDistribution(options: Omit<DistributionOptions, 'errorPages'>): ReturnType<typeof CDN.createDistribution> {
    return CDN.createDistribution({
      ...options,
      errorPages: [
        { errorCode: 404, responseCode: 200, responsePagePath: '/index.html' },
        { errorCode: 403, responseCode: 200, responsePagePath: '/index.html' },
      ],
    })
  }
}
