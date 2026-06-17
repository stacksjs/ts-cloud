/**
 * Example: deploy a real Laravel app to AWS Lambda (a Laravel Vapor clone).
 *
 *   # once, requires Docker:
 *   cloud serverless:build-php-layer --php 8.3 --arch x86_64
 *   # then set the printed ARN below (or export TSCLOUD_PHP_LAYER_ARN) and:
 *   cloud deploy:serverless --env production
 */
import type { CloudConfig } from '@stacksjs/ts-cloud'
import { createServerlessLaravelPreset } from '@stacksjs/ts-cloud'

const config: Partial<CloudConfig> = createServerlessLaravelPreset({
  name: 'Serverless Laravel Example',
  slug: 'sls-laravel-example',
  // domain: 'my-app.com',
  layers: [
    // arn printed by `cloud serverless:build-php-layer`
    // 'arn:aws:lambda:us-east-1:123456789012:layer:tscloud-php-83-x86_64:1',
  ],
  phpVersion: '8.3',
  cache: 'dynamodb',
  scheduler: 'on',
  // build hooks default to the Laravel artisan caching steps;
  // deploy defaults to ['migrate --force'].
})

export default config
