/**
 * Accessors for the in-repo PHP runtime asset sources (bootstrap, runtime loops,
 * FastCGI client) and the Laravel-on-Lambda environment defaults.
 *
 * The layer builder bundles these files plus the generated php-fpm.conf into the
 * ts-cloud PHP runtime layer (mounted at /opt on Lambda).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePhpFpmConfig } from './php-fpm-conf'

function assetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime-assets')
}

export interface RuntimeAsset {
  /** Path inside the layer, relative to /opt. */
  path: string
  /** File contents. */
  contents: string
  /** Unix mode (bootstrap must be executable). */
  mode: number
}

/**
 * The full set of files the PHP runtime layer ships, with their `/opt`-relative
 * paths and modes. `bootstrap` lives at the layer root; the rest under
 * `/opt/tscloud`.
 */
export function phpRuntimeLayerAssets(): RuntimeAsset[] {
  const dir = assetsDir()
  const read = (f: string): string => readFileSync(join(dir, f), 'utf-8')
  return [
    { path: 'bootstrap', contents: read('bootstrap'), mode: 0o755 },
    { path: 'tscloud/runtime.php', contents: read('runtime.php'), mode: 0o644 },
    { path: 'tscloud/octane-runtime.php', contents: read('octane-runtime.php'), mode: 0o644 },
    { path: 'tscloud/cli-runtime.php', contents: read('cli-runtime.php'), mode: 0o644 },
    { path: 'tscloud/fastcgi-client.php', contents: read('fastcgi-client.php'), mode: 0o644 },
    { path: 'tscloud/php-fpm.conf', contents: generatePhpFpmConfig(), mode: 0o644 },
  ]
}

/**
 * Environment variables a Laravel app needs to run serverless on Lambda:
 * read-only filesystem (only /tmp writable), no `file` drivers, S3 storage, SQS
 * queue, and logs to stderr → CloudWatch.
 */
export function laravelServerlessEnvDefaults(opts: { cacheDriver?: 'dynamodb' | 'redis' } = {}): Record<string, string> {
  const cache = opts.cacheDriver ?? 'dynamodb'
  return {
    APP_ENV: 'production',
    LOG_CHANNEL: 'stderr',
    CACHE_STORE: cache,
    CACHE_DRIVER: cache,
    SESSION_DRIVER: cache,
    QUEUE_CONNECTION: 'sqs',
    FILESYSTEM_DISK: 's3',
    VIEW_COMPILED_PATH: '/tmp/storage/framework/views',
    APP_SERVICES_CACHE: '/tmp/bootstrap/cache/services.php',
    APP_PACKAGES_CACHE: '/tmp/bootstrap/cache/packages.php',
    APP_CONFIG_CACHE: '/tmp/bootstrap/cache/config.php',
    APP_ROUTES_CACHE: '/tmp/bootstrap/cache/routes.php',
    APP_EVENTS_CACHE: '/tmp/bootstrap/cache/events.php',
  }
}

/**
 * The Laravel artisan caching steps that must run during the BUILD phase (the
 * runtime filesystem is read-only), mirroring the Forge/EC2 deploy semantics.
 */
export const LARAVEL_SERVERLESS_BUILD_STEPS: string[] = [
  'composer install --no-dev --optimize-autoloader --no-interaction',
  'php artisan config:cache',
  'php artisan route:cache',
  'php artisan event:cache',
  'php artisan view:cache',
]
