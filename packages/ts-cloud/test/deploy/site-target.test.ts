import type { CloudConfig, SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  resolveSiteDeployTarget,
  resolveSiteKind,
  siteInstallBase,
  validateDeploymentConfig,
} from '../../src/deploy/site-target'

function makeConfig(sites: Record<string, SiteConfig>, withCompute = false): CloudConfig {
  return {
    project: { name: 'demo', slug: 'demo', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    sites,
    ...(withCompute ? { infrastructure: { compute: { mode: 'server' } } } : {}),
  } as CloudConfig
}

describe('resolveSiteDeployTarget', () => {
  it('infers bucket when neither deploy nor start is set', () => {
    expect(resolveSiteDeployTarget({ root: 'dist' })).toBe('bucket')
  })

  it('infers server when start is present', () => {
    expect(resolveSiteDeployTarget({ root: '.output', start: 'bun run server.ts' })).toBe('server')
  })

  it('honors an explicit deploy:bucket even with start (backward-compat override)', () => {
    expect(resolveSiteDeployTarget({ root: 'dist', start: 'bun run x', deploy: 'bucket' })).toBe('bucket')
  })

  it('honors an explicit deploy:server even without start', () => {
    expect(resolveSiteDeployTarget({ root: 'docs/.bunpress/dist', deploy: 'server' })).toBe('server')
  })
})

describe('resolveSiteKind', () => {
  it('bucket', () => {
    expect(resolveSiteKind({ root: 'dist' })).toBe('bucket')
  })

  it('server-app (server + start)', () => {
    expect(resolveSiteKind({ root: '.output', start: 'bun run server.ts' })).toBe('server-app')
    expect(resolveSiteKind({ root: '.output', start: 'bun run server.ts', deploy: 'server' })).toBe('server-app')
  })

  it('server-static (server + no start, has root)', () => {
    expect(resolveSiteKind({ root: 'docs/dist', deploy: 'server' })).toBe('server-static')
  })

  it('explicit deploy:bucket on a start site resolves to bucket', () => {
    expect(resolveSiteKind({ root: 'dist', start: 'bun run x', deploy: 'bucket' })).toBe('bucket')
  })

  it('redirect (set redirect → gateway-only, wins over root/start)', () => {
    expect(resolveSiteKind({ domain: 'alt.com', redirect: 'https://canonical.com' })).toBe('redirect')
    expect(resolveSiteKind({ domain: 'alt.com', redirect: { to: 'https://canonical.com' }, root: 'dist', start: 'bun run x' })).toBe('redirect')
  })
})

describe('validateDeploymentConfig', () => {
  it('a bucket-only project with NO server validates clean', () => {
    const { errors, warnings } = validateDeploymentConfig(makeConfig({
      web: { root: 'dist', domain: 'example.com' },
      docs: { root: 'docs/dist', domain: 'docs.example.com' },
    }))
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it('errors when a project declares both a server and a serverless app (no coexistence)', () => {
    const config = makeConfig({ web: { root: 'dist', domain: 'example.com' } }, true)
    ;(config.environments as any).production.app = { kind: 'bun' }
    const { errors } = validateDeploymentConfig(config)
    expect(errors.some(e => /cannot be both a server and a serverless/i.test(e))).toBe(true)
  })

  it('errors when a server-app site has no compute configured', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      app: { root: '.output', domain: 'app.example.com', start: 'bun run server.ts', port: 3000 },
    }, false))
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('app')
    expect(errors[0]).toContain('infrastructure.compute')
  })

  it('passes when a server-app site HAS compute configured', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      app: { root: '.output', domain: 'app.example.com', start: 'bun run server.ts', port: 3000 },
    }, true))
    expect(errors).toEqual([])
  })

  it('errors when a server-static site has compute but no root', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      docs: { domain: 'docs.example.com', deploy: 'server' },
    }, true))
    expect(errors.some(e => e.includes('docs') && e.includes('root'))).toBe(true)
  })

  it('errors when a server-static site has no compute configured', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      docs: { root: 'docs/dist', domain: 'docs.example.com', deploy: 'server' },
    }, false))
    expect(errors.some(e => e.includes('docs') && e.includes('infrastructure.compute'))).toBe(true)
  })

  it('errors when a bucket site is missing root', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      web: { domain: 'example.com' },
    }))
    expect(errors.some(e => e.includes('web') && e.includes('root'))).toBe(true)
  })

  it("errors when deploy:'server' has neither start nor root", () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      x: { domain: 'x.example.com', deploy: 'server' },
    }, true))
    expect(errors.some(e => e.includes('neither'))).toBe(true)
  })

  it('warns (not errors) when a bucket site sets server-only fields', () => {
    const { errors, warnings } = validateDeploymentConfig(makeConfig({
      web: { root: 'dist', domain: 'example.com', deploy: 'bucket', start: 'bun run x', port: 3000, preStart: ['bun i'] },
    }))
    expect(errors).toEqual([])
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('start')
    expect(warnings[0]).toContain('port')
    expect(warnings[0]).toContain('preStart')
  })

  it('errors on duplicate ports among server-app sites', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      a: { root: '.', domain: 'a.example.com', start: 'bun run a', port: 3000 },
      b: { root: '.', domain: 'b.example.com', start: 'bun run b', port: 3000 },
    }, true))
    expect(errors.some(e => e.includes('3000') && e.includes('distinct ports'))).toBe(true)
  })

  it('allows distinct ports among server-app sites', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      a: { root: '.', domain: 'a.example.com', start: 'bun run a', port: 3000 },
      b: { root: '.', domain: 'b.example.com', start: 'bun run b', port: 3001 },
    }, true))
    expect(errors).toEqual([])
  })

  it('validates a mixed stacks-style config: app=server-app, docs/blog=server-static, plus compute', () => {
    const { errors, warnings } = validateDeploymentConfig(makeConfig({
      app: { root: '.output', domain: 'example.com', start: 'bun run server.ts', port: 3000 },
      docs: { root: 'docs/dist', domain: 'docs.example.com', deploy: 'server', build: 'bun run docs:build' },
      blog: { root: 'blog/dist', domain: 'blog.example.com', deploy: 'server' },
    }, true))
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it('accepts a redirect site (domain + target, no root) with compute', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      alt: { domain: 'very-good-adblock.org', redirect: 'https://verygoodadblock.org' },
    }, true))
    expect(errors).toEqual([])
  })

  it('flags a redirect site missing a domain or target', () => {
    const { errors } = validateDeploymentConfig(makeConfig({
      noDomain: { redirect: 'https://x.com' },
      noTarget: { domain: 'a.com', redirect: { to: '' } },
    }, true))
    expect(errors.some(e => e.includes('noDomain') && e.includes('domain'))).toBe(true)
    expect(errors.some(e => e.includes('noTarget') && e.includes('target'))).toBe(true)
  })
})

describe('siteInstallBase', () => {
  it('namespaces the install dir by project slug, mirroring the <slug>-<site> unit name', () => {
    expect(siteInstallBase('bughq', 'main')).toBe('/var/www/bughq-main')
    expect(siteInstallBase('ghostanalytics', 'main')).toBe('/var/www/ghostanalytics-main')
  })

  it('gives two projects with the SAME site name disjoint install dirs (the shared-box collision this prevents)', () => {
    // Before: both a tenant and the box owner keyed a site `main` → both fought
    // over /var/www/main, silently overwriting each other's releases.
    const tenant = siteInstallBase('bughq', 'main')
    const owner = siteInstallBase('stacks', 'main')
    expect(tenant).not.toBe(owner)
    expect(tenant.startsWith('/var/www/')).toBe(true)
    expect(owner.startsWith('/var/www/')).toBe(true)
  })
})
