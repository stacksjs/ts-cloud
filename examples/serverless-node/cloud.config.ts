/**
 * Example: deploy a Node/Bun app to AWS Lambda (Vapor-style) with ts-cloud.
 *
 *   cloud deploy:serverless --env production
 */
import type { CloudConfig } from '@stacksjs/ts-cloud'
import { createServerlessNodePreset } from '@stacksjs/ts-cloud'

const config: Partial<CloudConfig> = createServerlessNodePreset({
  name: 'Serverless Node Example',
  slug: 'sls-node-example',
  entry: 'src/server.ts',
  // domain: 'api.example.com',          // optional custom domain (needs an ACM cert)
  build: ['bun install'],
  deploy: [], // e.g. ['migrate'] — runs on the CLI function
  assets: 'public', // uploaded to S3 + CloudFront, exposed as ASSET_URL
  queues: true, // a single default SQS queue + DLQ
  scheduler: 'on', // EventBridge invokes cli `schedule:run` each minute
})

export default config
