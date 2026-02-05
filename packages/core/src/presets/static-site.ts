import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * Static Site Preset
 * Perfect for: Static websites, SPAs, documentation sites
 * Includes: S3 bucket + CloudFront CDN
*/
export function createStaticSitePreset(options: {
  name: string
  slug: string
  domain?: string
  subdomain?: string
}): Partial<CloudConfig> {
  const { name, slug, domain, subdomain } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1', // CloudFront requires ACM certs in us-east-1
    },
    mode: 'serverless',
    environments: {
      production: {
        type: 'production',
        domain: subdomain && domain ? `${subdomain}.${domain}` : domain,
      },
    },
    infrastructure: {
      storage: {
        assets: {
          public: true,
          versioning: false,
          website: true,
          encryption: false, // Public bucket doesn't need encryption
          cors: [{
            allowedOrigins: ['*'],
            allowedMethods: ['GET', 'HEAD'],
            allowedHeaders: ['*'],
            maxAge: 3600,
          }],
        },
      },
      cdn: {
        enabled: true,
        customDomain: domain ? {
          domain: subdomain && domain ? `${subdomain}.${domain}` : domain,
          certificateArn: 'TO_BE_GENERATED', // Will be created automatically
        } : undefined,
        cachePolicy: {
          minTTL: 0,
          defaultTTL: 86400, // 1 day
          maxTTL: 31536000, // 1 year
        },
        compress: true,
        http3: true,
        errorPages: {
          404: '/index.html', // For SPA routing
          403: '/index.html',
        },
      },
    },
  }
}
