/**
 * Redirects Module - URL Redirect Management
 * Provides clean API for creating domain and path-based redirects
 */

import type { CloudFrontFunction, S3Bucket, S3BucketPolicy } from 'ts-cloud-aws-types'
import type { EnvironmentType } from 'ts-cloud-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface RedirectRule {
  source: string
  target: string
  statusCode?: 301 | 302 | 307 | 308
  preserveQueryString?: boolean
}

export interface DomainRedirectOptions {
  slug: string
  environment: EnvironmentType
  sourceDomain: string
  targetDomain: string
  protocol?: 'http' | 'https'
  preservePath?: boolean
}

export interface PathRedirectOptions {
  slug: string
  environment: EnvironmentType
  rules: RedirectRule[]
}

/**
 * Redirects Module - Domain and Path-based Redirects
 * Provides clean API for URL redirects using S3 and CloudFront Functions
 */
export class Redirects {
  /**
   * Create an S3 bucket configured for domain redirect
   * Redirects all requests from one domain to another
   */
  static createDomainRedirectBucket(options: DomainRedirectOptions): {
    bucket: S3Bucket
    bucketPolicy: S3BucketPolicy
    logicalId: string
    policyLogicalId: string
  } {
    const {
      slug,
      environment,
      sourceDomain,
      targetDomain,
      protocol = 'https',
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 's3',
      suffix: 'redirect',
    })

    const logicalId = generateLogicalId(resourceName)
    const policyLogicalId = generateLogicalId(`${resourceName}-policy`)

    const bucket: S3Bucket = {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: sourceDomain,
        WebsiteConfiguration: {
          RedirectAllRequestsTo: {
            HostName: targetDomain,
            Protocol: protocol,
          },
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: false,
          BlockPublicPolicy: false,
          IgnorePublicAcls: false,
          RestrictPublicBuckets: false,
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Purpose', Value: 'Domain Redirect' },
        ],
      },
    }

    const bucketPolicy: S3BucketPolicy = {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: Fn.Ref(logicalId),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Sid: 'PublicReadForRedirect',
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject'],
            Resource: [Fn.Join('', [Fn.GetAtt(logicalId, 'Arn'), '/*']) as any],
          }],
        },
      },
    }

    return {
      bucket,
      bucketPolicy,
      logicalId,
      policyLogicalId,
    }
  }

  /**
   * Create a CloudFront Function for path-based redirects
   */
  static createPathRedirectFunction(options: PathRedirectOptions): {
    function: CloudFrontFunction
    logicalId: string
    functionCode: string
  } {
    const { slug, environment, rules } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'cf-redirect',
    })

    const logicalId = generateLogicalId(resourceName)

    // Generate the CloudFront Function code
    const functionCode = Redirects.generateRedirectFunctionCode(rules)

    const cloudFrontFunction: CloudFrontFunction = {
      Type: 'AWS::CloudFront::Function',
      Properties: {
        Name: resourceName,
        AutoPublish: true,
        FunctionConfig: {
          Comment: `Path redirect function for ${slug} (${environment})`,
          Runtime: 'cloudfront-js-2.0',
        },
        FunctionCode: functionCode,
      },
    }

    return {
      function: cloudFrontFunction,
      logicalId,
      functionCode,
    }
  }

  /**
   * Generate CloudFront Function code for path redirects
   */
  static generateRedirectFunctionCode(rules: RedirectRule[]): string {
    const redirectMap = rules.map((rule) => {
      const preserveQs = rule.preserveQueryString !== false
      const statusCode = rule.statusCode || 301
      return `  '${rule.source}': { target: '${rule.target}', statusCode: ${statusCode}, preserveQs: ${preserveQs} }`
    }).join(',\n')

    return `function handler(event) {
  const request = event.request;
  const uri = request.uri;
  const querystring = request.querystring;

  const redirects = {
${redirectMap}
  };

  // Check for exact match
  var redirect = redirects[uri];

  // Check for pattern matches (trailing slash variations)
  if (!redirect) {
    // Try without trailing slash
    if (uri.endsWith('/') && uri !== '/') {
      redirect = redirects[uri.slice(0, -1)];
    }
    // Try with trailing slash
    else {
      redirect = redirects[uri + '/'];
    }
  }

  if (redirect) {
    var targetUrl = redirect.target;

    // Preserve query string if configured
    if (redirect.preserveQs && Object.keys(querystring).length > 0) {
      const qs = Object.keys(querystring).map(function(key) {
        const val = querystring[key];
        if (val.value) {
          return key + '=' + val.value;
        }
        return key;
      }).join('&');

      if (qs) {
        targetUrl += (targetUrl.indexOf('?') >= 0 ? '&' : '?') + qs;
      }
    }

    return {
      statusCode: redirect.statusCode,
      statusDescription: redirect.statusCode === 301 ? 'Moved Permanently' : 'Found',
      headers: {
        'location': { value: targetUrl },
        'cache-control': { value: 'max-age=3600' }
      }
    };
  }

  return request;
}`
  }

  /**
   * Create common redirect patterns
   */
  static readonly CommonRedirects = {
    /**
     * www to non-www redirect
     */
    wwwToApex: (domain: string, protocol: 'http' | 'https' = 'https'): DomainRedirectOptions => ({
      slug: domain.replace(/\./g, '-'),
      environment: 'production',
      sourceDomain: `www.${domain}`,
      targetDomain: domain,
      protocol,
      preservePath: true,
    }),

    /**
     * non-www to www redirect
     */
    apexToWww: (domain: string, protocol: 'http' | 'https' = 'https'): DomainRedirectOptions => ({
      slug: domain.replace(/\./g, '-'),
      environment: 'production',
      sourceDomain: domain,
      targetDomain: `www.${domain}`,
      protocol,
      preservePath: true,
    }),

    /**
     * HTTP to HTTPS redirect (handled at CloudFront/ALB level typically)
     */
    httpToHttps: (path: string = '/'): RedirectRule => ({
      source: path,
      target: path,
      statusCode: 301,
    }),

    /**
     * Trailing slash normalization (add trailing slash)
     */
    addTrailingSlash: (paths: string[]): RedirectRule[] =>
      paths.map(path => ({
        source: path.endsWith('/') ? path.slice(0, -1) : path,
        target: path.endsWith('/') ? path : `${path}/`,
        statusCode: 301,
      })),

    /**
     * Trailing slash normalization (remove trailing slash)
     */
    removeTrailingSlash: (paths: string[]): RedirectRule[] =>
      paths.map(path => ({
        source: path.endsWith('/') && path !== '/' ? path : `${path}/`,
        target: path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path,
        statusCode: 301,
      })),
  }

  /**
   * Create redirect rules for common URL patterns
   */
  static readonly Patterns = {
    /**
     * Old blog URL pattern to new pattern
     * /blog/2023/01/my-post -> /blog/my-post
     */
    flattenBlogUrls: (posts: Array<{ oldPath: string, newPath: string }>): RedirectRule[] =>
      posts.map(({ oldPath, newPath }) => ({
        source: oldPath,
        target: newPath,
        statusCode: 301,
        preserveQueryString: true,
      })),

    /**
     * Category URL changes
     */
    categoryRename: (oldCategory: string, newCategory: string): RedirectRule[] => [
      {
        source: `/${oldCategory}`,
        target: `/${newCategory}`,
        statusCode: 301,
      },
      {
        source: `/${oldCategory}/`,
        target: `/${newCategory}/`,
        statusCode: 301,
      },
    ],

    /**
     * Product page URL pattern
     */
    productSlugChange: (products: Array<{ oldSlug: string, newSlug: string }>): RedirectRule[] =>
      products.map(({ oldSlug, newSlug }) => ({
        source: `/products/${oldSlug}`,
        target: `/products/${newSlug}`,
        statusCode: 301,
      })),

    /**
     * Deprecated API version redirects
     */
    apiVersionRedirect: (oldVersion: string, newVersion: string, endpoints: string[]): RedirectRule[] =>
      endpoints.map(endpoint => ({
        source: `/api/${oldVersion}/${endpoint}`,
        target: `/api/${newVersion}/${endpoint}`,
        statusCode: 307, // Temporary, preserves method
        preserveQueryString: true,
      })),

    /**
     * Gone (410) redirects for deleted content
     */
    gonePages: (paths: string[]): RedirectRule[] =>
      paths.map(path => ({
        source: path,
        target: '/410',
        statusCode: 301, // CloudFront Functions don't support 410, redirect to a 410 page
      })),
  }

  /**
   * Create a complete redirect setup with multiple rules
   */
  static createRedirectSetup(options: {
    slug: string
    environment: EnvironmentType
    domainRedirects?: DomainRedirectOptions[]
    pathRedirects?: RedirectRule[]
  }): {
    resources: Record<string, any>
    outputs: {
      domainRedirectBuckets: string[]
      pathRedirectFunctionLogicalId: string | null
    }
  } {
    const { slug, environment, domainRedirects = [], pathRedirects = [] } = options
    const resources: Record<string, any> = {}
    const domainRedirectBuckets: string[] = []

    // Create domain redirect buckets
    for (const domainRedirect of domainRedirects) {
      const { bucket, bucketPolicy, logicalId, policyLogicalId } = Redirects.createDomainRedirectBucket({
        ...domainRedirect,
        slug,
        environment,
      })
      resources[logicalId] = bucket
      resources[policyLogicalId] = bucketPolicy
      domainRedirectBuckets.push(logicalId)
    }

    // Create path redirect function if there are path redirects
    let pathRedirectFunctionLogicalId: string | null = null
    if (pathRedirects.length > 0) {
      const { function: redirectFunction, logicalId } = Redirects.createPathRedirectFunction({
        slug,
        environment,
        rules: pathRedirects,
      })
      resources[logicalId] = redirectFunction
      pathRedirectFunctionLogicalId = logicalId
    }

    return {
      resources,
      outputs: {
        domainRedirectBuckets,
        pathRedirectFunctionLogicalId,
      },
    }
  }

  /**
   * Generate redirect rules from a simple mapping object
   */
  static fromMapping(
    mapping: Record<string, string>,
    options?: { statusCode?: 301 | 302 | 307 | 308, preserveQueryString?: boolean },
  ): RedirectRule[] {
    return Object.entries(mapping).map(([source, target]) => ({
      source,
      target,
      statusCode: options?.statusCode || 301,
      preserveQueryString: options?.preserveQueryString ?? true,
    }))
  }

  /**
   * Validate redirect rules for common issues
   */
  static validateRules(rules: RedirectRule[]): {
    valid: boolean
    errors: string[]
    warnings: string[]
  } {
    const errors: string[] = []
    const warnings: string[] = []
    const sources = new Set<string>()

    for (const rule of rules) {
      // Check for duplicate sources
      if (sources.has(rule.source)) {
        errors.push(`Duplicate source path: ${rule.source}`)
      }
      sources.add(rule.source)

      // Check for redirect loops
      if (rule.source === rule.target) {
        errors.push(`Redirect loop detected: ${rule.source} -> ${rule.target}`)
      }

      // Check for relative URLs in target
      if (!rule.target.startsWith('/') && !rule.target.startsWith('http')) {
        warnings.push(`Target URL should start with / or http: ${rule.target}`)
      }

      // Check for empty paths
      if (!rule.source || rule.source.trim() === '') {
        errors.push('Source path cannot be empty')
      }

      if (!rule.target || rule.target.trim() === '') {
        errors.push('Target path cannot be empty')
      }
    }

    // Check for potential redirect chains
    for (const rule of rules) {
      const chainTarget = rules.find(r => r.source === rule.target)
      if (chainTarget) {
        warnings.push(`Potential redirect chain: ${rule.source} -> ${rule.target} -> ${chainTarget.target}`)
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }
}
