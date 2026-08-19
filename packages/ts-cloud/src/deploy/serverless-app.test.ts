import type { ResolvedContext } from './serverless-app'
import { describe, expect, it } from 'bun:test'
import { assertEnvWithinLimit, buildFunctionEnv, infraEnvFromOutputs, resolveSecrets } from './serverless-app'

const ctx: ResolvedContext = {
  app: { kind: 'node', entry: 'a.ts', env: { APP_NAME: 'demo' } },
  slug: 'demo',
  region: 'us-east-1',
  stackName: 'demo-production-app',
  artifactBucket: 'demo-production-deployments',
  assetsBucket: 'demo-production-assets',
}

describe('buildFunctionEnv', () => {
  it('sets the per-function mode and shared vars', () => {
    const env = buildFunctionEnv(ctx.app, ctx, 'production', 'queue', {}, undefined, 'demo-production-default')
    expect(env.TSCLOUD_LAMBDA_MODE).toBe('queue')
    expect(env.TSCLOUD_ENV).toBe('production')
    expect(env.TSCLOUD_QUEUE).toBe('demo-production-default')
    expect(env.TSCLOUD_CACHE_TABLE).toBe('demo-production-cache')
    expect(env.MAINTENANCE_MODE).toBe('0')
    expect(env.APP_NAME).toBe('demo')
  })

  it('injects ASSET_URL and merges secrets (secrets win)', () => {
    const env = buildFunctionEnv(
      ctx.app,
      ctx,
      'production',
      'http',
      { APP_KEY: 'sekret', APP_NAME: 'override' },
      'https://cdn/abc',
      undefined,
    )
    expect(env.ASSET_URL).toBe('https://cdn/abc')
    expect(env.APP_KEY).toBe('sekret')
    expect(env.APP_NAME).toBe('override')
  })

  it('injects serve-assets / robots env from app flags', () => {
    const c: ResolvedContext = { ...ctx, app: { ...ctx.app, serveAssets: true, redirectRobotsTxt: false } }
    const env = buildFunctionEnv(c.app, c, 'production', 'http', {}, undefined, undefined)
    expect(env.TSCLOUD_SERVE_ASSETS).toBe('1')
    expect(env.TSCLOUD_REDIRECT_ROBOTS_TXT).toBe('0')
  })

  it('omits the DynamoDB cache var when using elasticache', () => {
    const elasticacheCtx: ResolvedContext = { ...ctx, app: { ...ctx.app, cache: { driver: 'elasticache' } } }
    const env = buildFunctionEnv(elasticacheCtx.app, elasticacheCtx, 'production', 'cli', {}, undefined, undefined)
    expect(env.TSCLOUD_CACHE_TABLE).toBeUndefined()
  })

  it('merges infra env (DB/Redis hosts) from stack outputs', () => {
    const infra = { DB_HOST: 'proxy.rds', DB_PORT: '3306', REDIS_HOST: 'redis.cache' }
    const env = buildFunctionEnv(ctx.app, ctx, 'production', 'http', {}, undefined, undefined, infra)
    expect(env.DB_HOST).toBe('proxy.rds')
    expect(env.REDIS_HOST).toBe('redis.cache')
  })
})

describe('infraEnvFromOutputs', () => {
  it('prefers the RDS Proxy endpoint over the cluster endpoint', () => {
    const env = infraEnvFromOutputs({ kind: 'php' }, { DbEndpoint: 'cluster.rds', DbProxyEndpoint: 'proxy.rds' })
    expect(env.DB_HOST).toBe('proxy.rds')
    expect(env.DB_CONNECTION).toBe('mysql')
  })

  it('maps the cache endpoint to redis and flips drivers for elasticache', () => {
    const env = infraEnvFromOutputs({ kind: 'php', cache: { driver: 'elasticache' } }, { CacheEndpoint: 'redis.cache' })
    expect(env.REDIS_HOST).toBe('redis.cache')
    expect(env.CACHE_STORE).toBe('redis')
    expect(env.SESSION_DRIVER).toBe('redis')
  })

  it('returns an empty map when nothing data-related is attached', () => {
    expect(infraEnvFromOutputs({ kind: 'node' }, {})).toEqual({})
  })
})

describe('assertEnvWithinLimit', () => {
  it("accepts an env under AWS's 4KB limit", () => {
    expect(() => assertEnvWithinLimit('demo-http', { FOO: 'bar', APP_ENV: 'production' })).not.toThrow()
  })

  it('throws an actionable error when the env exceeds 4KB, naming the largest vars', () => {
    const env = { SMALL: 'x', HUGE: 'y'.repeat(5000) }
    expect(() => assertEnvWithinLimit('demo-http', env)).toThrow(/4096B limit/)
    expect(() => assertEnvWithinLimit('demo-http', env)).toThrow(/HUGE/)
  })
})

describe('resolveSecrets', () => {
  it('throws on a colliding array-form env name before hitting AWS', async () => {
    // `a/db` and `b/db` both derive env var `DB` → collision (no AWS call made).
    await expect(
      resolveSecrets({ kind: 'node', entry: 'a.ts', secrets: ['a/db', 'b/db'] }, 'us-east-1'),
    ).rejects.toThrow(/same env var/)
  })

  it('returns an empty map when no secrets are configured', async () => {
    expect(await resolveSecrets({ kind: 'node', entry: 'a.ts' }, 'us-east-1')).toEqual({})
  })
})
