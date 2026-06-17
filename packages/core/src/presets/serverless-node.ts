import type { CloudConfig } from '../types'

/**
 * Serverless Node/Bun application preset (Laravel-Vapor-equivalent for JS/TS).
 *
 * Produces an `environments.<env>.app` manifest that the serverless deploy
 * pipeline (`cloud deploy:serverless`) turns into three Lambda functions sharing
 * one bundled artifact: HTTP (API Gateway v2), queue worker (SQS), and CLI
 * (EventBridge scheduler + on-demand commands), plus a DynamoDB cache table and
 * optional CDN-backed assets.
 *
 * @example
 * export default createServerlessNodePreset({
 *   name: 'My API', slug: 'my-api',
 *   entry: 'src/server.ts', domain: 'api.example.com',
 *   build: ['bun install', 'bun run build'],
 *   deploy: ['migrate'],
 * })
 */
export function createServerlessNodePreset(options: {
  name: string
  slug: string
  entry: string
  domain?: string
  runtime?: 'nodejs20.x' | 'nodejs22.x'
  memory?: number
  /** Build commands run locally before packaging. */
  build?: string[]
  /** Deploy commands run remotely after activation (e.g. migrations). */
  deploy?: string[]
  /** Static asset directory served via CloudFront (e.g. `public` or `dist`). */
  assets?: string
  /** Queue names; defaults to a single `default` queue. */
  queues?: boolean | Array<string | Record<string, number>>
  scheduler?: 'off' | 'on' | 'sub-minute'
  region?: string
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    entry,
    domain,
    runtime = 'nodejs20.x',
    memory = 1024,
    build,
    deploy,
    assets,
    queues = true,
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
          kind: 'node',
          runtime,
          entry,
          memory,
          build,
          deploy,
          assets,
          queues,
          scheduler,
          domain,
        },
      },
    },
  }
}
