import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { generatePhpLayerDockerfile, phpLayerPackages } from './dockerfile'
import { packagePhpApp, PHP_DEFAULT_EXCLUDES } from './package-php'
import { generatePhpFpmConfig } from './php-fpm-conf'
import { laravelServerlessEnvDefaults, LARAVEL_SERVERLESS_BUILD_STEPS, phpRuntimeLayerAssets } from './runtime-assets'

describe('generatePhpFpmConfig', () => {
  it('uses a single static worker on a /tmp socket', () => {
    const conf = generatePhpFpmConfig()
    expect(conf).toContain('listen = /tmp/.tscloud-fpm.sock')
    expect(conf).toContain('pm = static')
    expect(conf).toContain('pm.max_children = 1')
  })
})

describe('phpRuntimeLayerAssets', () => {
  it('ships the bootstrap (executable) + runtime loops + fpm config', () => {
    const assets = phpRuntimeLayerAssets()
    const byPath = Object.fromEntries(assets.map(a => [a.path, a]))
    expect(byPath.bootstrap.mode).toBe(0o755)
    expect(byPath.bootstrap.contents).toContain('TSCLOUD_LAMBDA_MODE')
    expect(byPath['tscloud/runtime.php'].contents).toContain('invocation/next')
    expect(byPath['tscloud/cli-runtime.php'].contents).toContain('batchItemFailures')
    expect(byPath['tscloud/fastcgi-client.php'].contents).toContain('FastCgiClient')
    expect(byPath['tscloud/php-fpm.conf']).toBeDefined()
  })

  it('includes the octane runtime, and the bootstrap selects it via TSCLOUD_OCTANE', () => {
    const byPath = Object.fromEntries(phpRuntimeLayerAssets().map(a => [a.path, a]))
    expect(byPath['tscloud/octane-runtime.php'].contents).toContain('Contracts\\Http\\Kernel')
    expect(byPath.bootstrap.contents).toContain('TSCLOUD_OCTANE')
    expect(byPath.bootstrap.contents).toContain('octane-runtime.php')
  })
})

describe('laravelServerlessEnvDefaults', () => {
  it('forces serverless-safe drivers and /tmp paths', () => {
    const env = laravelServerlessEnvDefaults()
    expect(env.LOG_CHANNEL).toBe('stderr')
    expect(env.QUEUE_CONNECTION).toBe('sqs')
    expect(env.FILESYSTEM_DISK).toBe('s3')
    expect(env.CACHE_STORE).toBe('dynamodb')
    expect(env.VIEW_COMPILED_PATH).toContain('/tmp/')
  })

  it('honors a redis cache driver', () => {
    expect(laravelServerlessEnvDefaults({ cacheDriver: 'redis' }).CACHE_STORE).toBe('redis')
  })

  it('exposes the build-time artisan caching steps', () => {
    expect(LARAVEL_SERVERLESS_BUILD_STEPS.some(s => s.includes('config:cache'))).toBe(true)
    expect(LARAVEL_SERVERLESS_BUILD_STEPS.some(s => s.includes('composer install'))).toBe(true)
  })
})

describe('generatePhpLayerDockerfile', () => {
  it('builds on AlmaLinux 9 + Remi and installs the Laravel extension set', () => {
    const df = generatePhpLayerDockerfile({ phpVersion: '8.3' })
    // Built on almalinux:9 (Remi-compatible; glibc 2.34 matches provided.al2023).
    expect(df).toContain('FROM almalinux:9')
    expect(df).toContain('remi-release-9')
    expect(df).toContain('php83-php-pecl-redis6')
    expect(phpLayerPackages('8.3')).toContain('php83-php-mysqlnd')
  })

  it('selects the requested PHP version across the matrix', () => {
    expect(generatePhpLayerDockerfile({ phpVersion: '8.1' })).toContain('php81-php-fpm')
    expect(generatePhpLayerDockerfile({ phpVersion: '8.4' })).toContain('php84-php-fpm')
    expect(phpLayerPackages('8.2')[0]).toBe('php82-php-cli')
  })
})

describe('packagePhpApp', () => {
  it('zips the app tree, excludes defaults, and points the handler at the front controller', () => {
    const root = mkdtempSync(join(tmpdir(), 'tscloud-laravel-'))
    try {
      mkdirSync(join(root, 'public'), { recursive: true })
      mkdirSync(join(root, 'vendor'), { recursive: true })
      mkdirSync(join(root, 'node_modules'), { recursive: true })
      writeFileSync(join(root, 'public', 'index.php'), '<?php echo "hi";')
      writeFileSync(join(root, 'artisan'), '#!/usr/bin/env php\n<?php')
      writeFileSync(join(root, 'vendor', 'autoload.php'), '<?php')
      writeFileSync(join(root, 'node_modules', 'junk.js'), 'junk')

      const artifact = packagePhpApp({ projectRoot: root, app: { kind: 'php' }, skipBuild: true })
      expect(artifact.zip.readUInt32LE(0)).toBe(0x04034B50)
      expect(artifact.handlers.http).toBe('public/index.php')
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
      // node_modules is excluded; index.php + artisan + vendor are included.
      expect(artifact.fileCount).toBe(3)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists sensible default excludes', () => {
    expect(PHP_DEFAULT_EXCLUDES).toContain('node_modules')
    expect(PHP_DEFAULT_EXCLUDES).toContain('.env')
  })
})
