import type { CloudFrontDistribution, CloudFrontOriginAccessControl, LambdaFunction, IAMRole } from '@stacksjs/ts-cloud-aws-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'

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
  type?: 's3' | 'alb' | 'custom'
  id?: string
  originId?: string // Alias for id
  domainName?: string
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

  /**
   * Create Lambda@Edge origin request function for docs routing
   * Handles:
   * - Pretty URLs (e.g., /guide → /guide.html or /guide/index.html)
   * - Trailing slashes normalization
   * - Default document serving (index.html)
   */
  static createDocsOriginRequestFunction(options: {
    slug: string
    environment: EnvironmentType
  }): {
    lambdaFunction: LambdaFunction
    role: IAMRole
    functionLogicalId: string
    roleLogicalId: string
    versionLogicalId: string
  } {
    const { slug, environment } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'edge-docs',
    })

    const functionLogicalId = generateLogicalId(resourceName)
    const roleLogicalId = generateLogicalId(`${resourceName}-role`)
    const versionLogicalId = generateLogicalId(`${resourceName}-version`)

    // Lambda@Edge execution role
    const role: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: `${resourceName}-role`,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'],
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
        ],
      },
    }

    // Lambda@Edge function code for docs routing
    // This handles VitePress/docs URL patterns
    const lambdaCode = `
'use strict';

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  let uri = request.uri;

  // If URI ends with a slash, append index.html
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  // If URI has a file extension, serve as-is
  if (uri.includes('.')) {
    return request;
  }

  // Try to determine if this is a directory or a file
  // First, try appending .html (for VitePress clean URLs)
  // If the file doesn't exist, CloudFront will try the directory with index.html

  // Check if the URI looks like a file path without extension
  const parts = uri.split('/');
  const lastPart = parts[parts.length - 1];

  // If the last part has no extension, append .html
  if (lastPart && !lastPart.includes('.')) {
    request.uri = uri + '.html';
  }

  return request;
};
`.trim()

    const lambdaFunction: LambdaFunction = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        FunctionName: resourceName,
        Description: 'Lambda@Edge origin request handler for docs routing',
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Role: Fn.GetAtt(roleLogicalId, 'Arn') as any,
        Code: {
          ZipFile: lambdaCode,
        },
        MemorySize: 128,
        Timeout: 5,
      },
    }

    return {
      lambdaFunction,
      role,
      functionLogicalId,
      roleLogicalId,
      versionLogicalId,
    }
  }

  /**
   * Create a docs-specific CloudFront distribution
   * Includes Lambda@Edge for URL rewriting and proper cache settings
   */
  static createDocsDistribution(options: {
    slug: string
    environment: EnvironmentType
    origin: OriginConfig
    customDomain?: string
    certificateArn?: string
    lambdaEdgeFunctionArn?: string
  }): {
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
      lambdaEdgeFunctionArn,
    } = options

    // Create base distribution
    const result = CDN.createDistribution({
      slug,
      environment,
      origin,
      customDomain,
      certificateArn,
      comment: `Docs CDN for ${slug}`,
      errorPages: [
        { errorCode: 404, responseCode: 404, responsePagePath: '/404.html' },
        { errorCode: 403, responseCode: 403, responsePagePath: '/404.html' },
      ],
    })

    // Add Lambda@Edge function if provided
    if (lambdaEdgeFunctionArn) {
      CDN.addEdgeFunction(result.distribution, 'origin-request', lambdaEdgeFunctionArn)
    }

    // Optimize cache settings for static docs
    result.distribution.Properties.DistributionConfig.DefaultCacheBehavior.DefaultTTL = 86400 // 1 day
    result.distribution.Properties.DistributionConfig.DefaultCacheBehavior.MaxTTL = 604800 // 1 week
    result.distribution.Properties.DistributionConfig.DefaultCacheBehavior.MinTTL = 0

    return result
  }

  /**
   * Create an API distribution with ALB origin
   * Optimized for API traffic (no caching by default, all methods allowed)
   */
  static createApiDistribution(options: {
    slug: string
    environment: EnvironmentType
    albDomainName: string
    customDomain?: string
    certificateArn?: string
    pathPattern?: string
    forwardHeaders?: string[]
    forwardCookies?: 'none' | 'all' | 'whitelist'
    whitelistedCookies?: string[]
    customOriginHeaders?: Record<string, string>
  }): {
    distribution: CloudFrontDistribution
    logicalId: string
  } {
    const {
      slug,
      environment,
      albDomainName,
      customDomain,
      certificateArn,
      pathPattern = '/api/*',
      forwardHeaders = ['Host', 'Origin', 'Authorization', 'Content-Type', 'Accept'],
      forwardCookies = 'all',
      whitelistedCookies,
      customOriginHeaders = {},
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'cdn-api',
    })

    const logicalId = generateLogicalId(resourceName)

    // Build custom headers for origin
    const originCustomHeaders: any[] = Object.entries(customOriginHeaders).map(([key, value]) => ({
      HeaderName: key,
      HeaderValue: value,
    }))

    // ALB origin configuration
    const albOrigin: any = {
      Id: 'ALBOrigin',
      DomainName: albDomainName,
      CustomOriginConfig: {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: 'https-only',
        OriginSSLProtocols: ['TLSv1.2'],
        OriginReadTimeout: 60,
        OriginKeepaliveTimeout: 60,
      },
    }

    if (originCustomHeaders.length > 0) {
      albOrigin.OriginCustomHeaders = originCustomHeaders
    }

    // Build cookie forwarding config
    let cookieConfig: any = { Forward: forwardCookies }
    if (forwardCookies === 'whitelist' && whitelistedCookies) {
      cookieConfig.WhitelistedNames = whitelistedCookies
    }

    // Build distribution
    const distribution: CloudFrontDistribution = {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: `API CDN for ${resourceName}`,
          Origins: [albOrigin],
          DefaultCacheBehavior: {
            TargetOriginId: 'ALBOrigin',
            ViewerProtocolPolicy: 'https-only',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
            CachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            Compress: true,
            // No caching for API by default
            DefaultTTL: 0,
            MaxTTL: 0,
            MinTTL: 0,
            ForwardedValues: {
              QueryString: true,
              Headers: forwardHeaders,
              Cookies: cookieConfig,
            },
          },
          PriceClass: 'PriceClass_100',
          HttpVersion: 'http2',
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

    return { distribution, logicalId }
  }

  /**
   * Create a multi-origin distribution (S3 for static, ALB for API)
   */
  static createMultiOriginDistribution(options: {
    slug: string
    environment: EnvironmentType
    s3BucketDomainName: string
    albDomainName: string
    apiPathPattern?: string
    customDomain?: string
    certificateArn?: string
    customOriginHeaders?: Record<string, string>
  }): {
    distribution: CloudFrontDistribution
    originAccessControl: CloudFrontOriginAccessControl
    logicalId: string
    oacLogicalId: string
  } {
    const {
      slug,
      environment,
      s3BucketDomainName,
      albDomainName,
      apiPathPattern = '/api/*',
      customDomain,
      certificateArn,
      customOriginHeaders = {},
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'cdn',
    })

    const logicalId = generateLogicalId(resourceName)
    const oacLogicalId = `${logicalId}OAC`

    // S3 Origin Access Control
    const originAccessControl: CloudFrontOriginAccessControl = {
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

    // Build custom headers for ALB origin
    const originCustomHeaders: any[] = Object.entries(customOriginHeaders).map(([key, value]) => ({
      HeaderName: key,
      HeaderValue: value,
    }))

    // S3 origin configuration
    const s3Origin: any = {
      Id: 'S3Origin',
      DomainName: s3BucketDomainName,
      OriginAccessControlId: Fn.Ref(oacLogicalId),
    }

    // ALB origin configuration
    const albOrigin: any = {
      Id: 'ALBOrigin',
      DomainName: albDomainName,
      CustomOriginConfig: {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: 'https-only',
        OriginSSLProtocols: ['TLSv1.2'],
        OriginReadTimeout: 60,
        OriginKeepaliveTimeout: 60,
      },
    }

    if (originCustomHeaders.length > 0) {
      albOrigin.OriginCustomHeaders = originCustomHeaders
    }

    // Build distribution
    const distribution: CloudFrontDistribution = {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: `Multi-origin CDN for ${resourceName}`,
          DefaultRootObject: 'index.html',
          Origins: [s3Origin, albOrigin],
          DefaultCacheBehavior: {
            TargetOriginId: 'S3Origin',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            CachedMethods: ['GET', 'HEAD', 'OPTIONS'],
            Compress: true,
          },
          CacheBehaviors: [
            {
              PathPattern: apiPathPattern,
              TargetOriginId: 'ALBOrigin',
              ViewerProtocolPolicy: 'https-only',
              AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
              CachedMethods: ['GET', 'HEAD', 'OPTIONS'],
              Compress: true,
              DefaultTTL: 0,
              MaxTTL: 0,
              MinTTL: 0,
              ForwardedValues: {
                QueryString: true,
                Headers: ['Host', 'Origin', 'Authorization', 'Content-Type', 'Accept'],
                Cookies: { Forward: 'all' },
              },
            },
          ],
          PriceClass: 'PriceClass_100',
          HttpVersion: 'http2',
          CustomErrorResponses: [
            { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' },
            { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' },
          ],
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

    return { distribution, originAccessControl, logicalId, oacLogicalId }
  }

  /**
   * Add ALB origin to an existing distribution
   */
  static addAlbOrigin(
    distribution: CloudFrontDistribution,
    options: {
      originId: string
      domainName: string
      pathPattern: string
      customHeaders?: Record<string, string>
      forwardHeaders?: string[]
      cacheTtl?: { default: number, max: number, min: number }
    },
  ): CloudFrontDistribution {
    const {
      originId,
      domainName,
      pathPattern,
      customHeaders = {},
      forwardHeaders = ['Host', 'Origin', 'Authorization', 'Content-Type', 'Accept'],
      cacheTtl = { default: 0, max: 0, min: 0 },
    } = options

    // Build custom headers
    const originCustomHeaders: any[] = Object.entries(customHeaders).map(([key, value]) => ({
      HeaderName: key,
      HeaderValue: value,
    }))

    // ALB origin
    const albOrigin: any = {
      Id: originId,
      DomainName: domainName,
      CustomOriginConfig: {
        HTTPPort: 80,
        HTTPSPort: 443,
        OriginProtocolPolicy: 'https-only',
        OriginSSLProtocols: ['TLSv1.2'],
        OriginReadTimeout: 60,
        OriginKeepaliveTimeout: 60,
      },
    }

    if (originCustomHeaders.length > 0) {
      albOrigin.OriginCustomHeaders = originCustomHeaders
    }

    // Add origin
    if (!distribution.Properties.DistributionConfig.Origins) {
      distribution.Properties.DistributionConfig.Origins = []
    }
    distribution.Properties.DistributionConfig.Origins.push(albOrigin)

    // Add cache behavior for the path pattern
    if (!distribution.Properties.DistributionConfig.CacheBehaviors) {
      distribution.Properties.DistributionConfig.CacheBehaviors = []
    }

    distribution.Properties.DistributionConfig.CacheBehaviors.push({
      PathPattern: pathPattern,
      TargetOriginId: originId,
      ViewerProtocolPolicy: 'https-only',
      AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
      CachedMethods: ['GET', 'HEAD', 'OPTIONS'],
      Compress: true,
      DefaultTTL: cacheTtl.default,
      MaxTTL: cacheTtl.max,
      MinTTL: cacheTtl.min,
      ForwardedValues: {
        QueryString: true,
        Headers: forwardHeaders,
        Cookies: { Forward: 'all' },
      },
    })

    return distribution
  }

  /**
   * Add a custom origin header (for origin authentication)
   */
  static addOriginHeader(
    distribution: CloudFrontDistribution,
    originId: string,
    headerName: string,
    headerValue: string,
  ): CloudFrontDistribution {
    const origin = distribution.Properties.DistributionConfig.Origins?.find(
      (o: any) => o.Id === originId,
    )

    if (origin) {
      if (!origin.OriginCustomHeaders) {
        origin.OriginCustomHeaders = []
      }
      origin.OriginCustomHeaders.push({
        HeaderName: headerName,
        HeaderValue: headerValue,
      })
    }

    return distribution
  }

  /**
   * Lambda@Edge code templates for common use cases
   */
  static readonly EdgeFunctionTemplates = {
    /**
     * Origin request handler for docs/VitePress routing
     */
    docsOriginRequest: (`
'use strict';
exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  let uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.includes('.')) {
    request.uri = uri + '.html';
  }

  return request;
};
`).trim() as string,

    /**
     * Viewer response handler for security headers
     */
    securityHeaders: (`
'use strict';
exports.handler = async (event) => {
  const response = event.Records[0].cf.response;
  const headers = response.headers;

  headers['strict-transport-security'] = [{ value: 'max-age=31536000; includeSubdomains; preload' }];
  headers['x-content-type-options'] = [{ value: 'nosniff' }];
  headers['x-frame-options'] = [{ value: 'DENY' }];
  headers['x-xss-protection'] = [{ value: '1; mode=block' }];
  headers['referrer-policy'] = [{ value: 'strict-origin-when-cross-origin' }];

  return response;
};
`).trim() as string,

    /**
     * Viewer request handler for basic auth (staging/preview environments)
     */
    basicAuth: (username: string, password: string): string => `
'use strict';
exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;

  const authString = 'Basic ' + Buffer.from('${username}:${password}').toString('base64');

  if (!headers.authorization || headers.authorization[0].value !== authString) {
    return {
      status: '401',
      statusDescription: 'Unauthorized',
      body: 'Unauthorized',
      headers: {
        'www-authenticate': [{ value: 'Basic realm="Protected"' }],
      },
    };
  }

  return request;
};
`.trim(),

    /**
     * Origin request handler for path-based routing (e.g., /api to different origin)
     */
    pathBasedRouting: (pathPrefix: string, targetOriginId: string): string => `
'use strict';
exports.handler = async (event) => {
  const request = event.Records[0].cf.request;

  if (request.uri.startsWith('${pathPrefix}')) {
    request.origin = {
      custom: {
        domainName: request.headers.host[0].value,
        port: 443,
        protocol: 'https',
        sslProtocols: ['TLSv1.2'],
      },
    };
    // Remove the path prefix for the origin request
    request.uri = request.uri.substring(${pathPrefix.length});
    if (!request.uri.startsWith('/')) {
      request.uri = '/' + request.uri;
    }
  }

  return request;
};
`.trim(),
  }

  /**
   * CDN Configuration helpers
   * Provides Stacks configuration parity for CDN options
   */
  static readonly Config = {
    /**
     * Create TTL configuration
     */
    ttl: (options: {
      min?: number
      max?: number
      default?: number
    }): {
      MinTTL: number
      MaxTTL: number
      DefaultTTL: number
    } => {
      const {
        min = 0,
        max = 86400,
        default: defaultTtl = 86400,
      } = options

      return {
        MinTTL: min,
        MaxTTL: max,
        DefaultTTL: defaultTtl,
      }
    },

    /**
     * Cookie behavior configuration
     */
    cookies: (behavior: 'none' | 'all' | 'allowList', allowedCookies?: string[]): {
      Forward: string
      WhitelistedNames?: string[]
    } => {
      const config: any = { Forward: behavior === 'allowList' ? 'whitelist' : behavior }
      if (behavior === 'allowList' && allowedCookies) {
        config.WhitelistedNames = allowedCookies
      }
      return config
    },

    /**
     * Allowed HTTP methods configuration
     */
    allowedMethods: (methods: 'ALL' | 'GET_HEAD' | 'GET_HEAD_OPTIONS'): string[] => {
      const mapping: Record<string, string[]> = {
        ALL: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
        GET_HEAD: ['GET', 'HEAD'],
        GET_HEAD_OPTIONS: ['GET', 'HEAD', 'OPTIONS'],
      }
      return mapping[methods] || mapping.GET_HEAD
    },

    /**
     * Cached methods configuration
     */
    cachedMethods: (methods: 'GET_HEAD' | 'GET_HEAD_OPTIONS'): string[] => {
      const mapping: Record<string, string[]> = {
        GET_HEAD: ['GET', 'HEAD'],
        GET_HEAD_OPTIONS: ['GET', 'HEAD', 'OPTIONS'],
      }
      return mapping[methods] || mapping.GET_HEAD
    },

    /**
     * Common TTL presets
     */
    ttlPresets: {
      /** Static assets (1 year) */
      static: { min: 0, max: 31536000, default: 31536000 },
      /** Dynamic content (no cache) */
      dynamic: { min: 0, max: 0, default: 0 },
      /** API responses (1 hour) */
      api: { min: 0, max: 3600, default: 60 },
      /** SPA/HTML (1 day) */
      html: { min: 0, max: 86400, default: 86400 },
      /** Images (1 week) */
      images: { min: 0, max: 604800, default: 604800 },
    } as const,

    /**
     * Create cache behavior configuration
     */
    cacheBehavior: (options: {
      ttl?: { min: number, max: number, default: number }
      cookies?: 'none' | 'all' | 'allowList'
      allowedCookies?: string[]
      allowedMethods?: 'ALL' | 'GET_HEAD' | 'GET_HEAD_OPTIONS'
      cachedMethods?: 'GET_HEAD' | 'GET_HEAD_OPTIONS'
      compress?: boolean
      forwardQueryString?: boolean
      forwardHeaders?: string[]
    }): {
      MinTTL: number
      MaxTTL: number
      DefaultTTL: number
      Compress: boolean
      AllowedMethods: string[]
      CachedMethods: string[]
      ForwardedValues: {
        QueryString: boolean
        Headers: string[]
        Cookies: { Forward: string, WhitelistedNames?: string[] }
      }
    } => {
      const {
        ttl = { min: 0, max: 86400, default: 86400 },
        cookies = 'none',
        allowedCookies,
        allowedMethods = 'GET_HEAD',
        cachedMethods = 'GET_HEAD',
        compress = true,
        forwardQueryString = true,
        forwardHeaders = [],
      } = options

      return {
        MinTTL: ttl.min,
        MaxTTL: ttl.max,
        DefaultTTL: ttl.default,
        Compress: compress,
        AllowedMethods: CDN.Config.allowedMethods(allowedMethods),
        CachedMethods: CDN.Config.cachedMethods(cachedMethods),
        ForwardedValues: {
          QueryString: forwardQueryString,
          Headers: forwardHeaders,
          Cookies: CDN.Config.cookies(cookies, allowedCookies),
        },
      }
    },
  }

  /**
   * Apply configuration to an existing distribution
   */
  static applyConfig(
    distribution: CloudFrontDistribution,
    config: {
      ttl?: { min: number, max: number, default: number }
      cookies?: 'none' | 'all' | 'allowList'
      allowedCookies?: string[]
      allowedMethods?: 'ALL' | 'GET_HEAD' | 'GET_HEAD_OPTIONS'
      cachedMethods?: 'GET_HEAD' | 'GET_HEAD_OPTIONS'
      compress?: boolean
    },
  ): CloudFrontDistribution {
    const behavior = distribution.Properties.DistributionConfig.DefaultCacheBehavior

    if (config.ttl) {
      behavior.MinTTL = config.ttl.min
      behavior.MaxTTL = config.ttl.max
      behavior.DefaultTTL = config.ttl.default
    }

    if (config.compress !== undefined) {
      behavior.Compress = config.compress
    }

    if (config.allowedMethods) {
      behavior.AllowedMethods = CDN.Config.allowedMethods(config.allowedMethods)
    }

    if (config.cachedMethods) {
      behavior.CachedMethods = CDN.Config.cachedMethods(config.cachedMethods)
    }

    if (config.cookies) {
      if (!behavior.ForwardedValues) {
        behavior.ForwardedValues = { QueryString: true }
      }
      behavior.ForwardedValues.Cookies = CDN.Config.cookies(config.cookies, config.allowedCookies)
    }

    return distribution
  }
}
