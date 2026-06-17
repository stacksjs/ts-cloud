import type { CloudConfig } from '../types'

/**
 * Serverless Laravel preset — a true Laravel-Vapor clone running on AWS Lambda.
 *
 * Produces an `environments.<env>.app` manifest (kind: 'php') that the serverless
 * deploy pipeline turns into three Lambda functions on the ts-cloud PHP runtime
 * layer: HTTP via php-fpm (API Gateway v2), an SQS queue worker (one job per
 * invocation), and a CLI function (EventBridge scheduler + artisan commands),
 * plus a DynamoDB cache table and CDN-backed `public/` assets.
 *
 * Build hooks default to the Laravel artisan caching steps (config/route/event/
 * view cache) since the Lambda filesystem is read-only at runtime; the deploy
 * hook runs migrations. Install the `tscloud/serverless` composer package in the
 * app for the SQS queue bridge (a `laravel/vapor-core` replacement).
 *
 * @example
 * export default createServerlessLaravelPreset({
 *   name: 'My App', slug: 'my-app', domain: 'my-app.com',
 *   layers: ['arn:aws:lambda:us-east-1:123:layer:tscloud-php-83:1'],
 * })
 */
export function createServerlessLaravelPreset(options: {
  name: string
  slug: string
  domain?: string
  /** PHP runtime layer ARN(s). If omitted, set TSCLOUD_PHP_LAYER_ARN at deploy. */
  layers?: string[]
  phpVersion?: '8.1' | '8.2' | '8.3' | '8.4'
  architecture?: 'x86_64' | 'arm64'
  memory?: number
  /** Override build hooks (defaults to Laravel artisan caching). */
  build?: string[]
  /** Override deploy hooks (defaults to `migrate --force`). */
  deploy?: string[]
  cache?: 'dynamodb' | 'elasticache'
  scheduler?: 'off' | 'on' | 'sub-minute'
  region?: string
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    layers,
    phpVersion = '8.3',
    architecture = 'x86_64',
    memory = 1024,
    build,
    deploy = ['migrate --force'],
    cache = 'dynamodb',
    scheduler = 'on',
    region = 'us-east-1',
  } = options

  return {
    project: { name, slug, region },
    mode: 'serverless',
    environments: {
      production: {
        type: 'production',
        domain,
        app: {
          kind: 'php',
          runtime: 'provided.al2023',
          phpVersion,
          architecture,
          layers,
          memory,
          // Default build hooks (artisan caches) are applied by the packager
          // when `build` is omitted; pass through any override here.
          build,
          deploy,
          assets: 'public',
          queues: true,
          scheduler,
          cache: { driver: cache },
          domain,
        },
      },
    },
  }
}
