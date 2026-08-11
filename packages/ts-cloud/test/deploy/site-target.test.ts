import type { CloudConfig, SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  hasProxyUpstream,
  resolveProxyUpstreams,
  resolveSiteDeployTarget,
  resolveSiteKind,
  shipsARelease,
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
    expect(
      resolveSiteKind({
        domain: 'alt.com',
        redirect: { to: 'https://canonical.com' },
        root: 'dist',
        start: 'bun run x',
      }),
    ).toBe('redirect')
  })
})

describe('validateDeploymentConfig', () => {
  it('a bucket-only project with NO server validates clean', () => {
    const { errors, warnings } = validateDeploymentConfig(
      makeConfig({
        web: { root: 'dist', domain: 'example.com' },
        docs: { root: 'docs/dist', domain: 'docs.example.com' },
      }),
    )
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it('errors when a project declares both a server and a serverless app (no coexistence)', () => {
    const config = makeConfig({ web: { root: 'dist', domain: 'example.com' } }, true)
    ;(config.environments as any).production.app = { kind: 'bun' }
    const { errors } = validateDeploymentConfig(config)
    expect(errors.some((e) => /cannot be both a server and a serverless/i.test(e))).toBe(true)
  })

  it('errors when a server-app site has no compute configured', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          app: { root: '.output', domain: 'app.example.com', start: 'bun run server.ts', port: 3000 },
        },
        false,
      ),
    )
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('app')
    expect(errors[0]).toContain('infrastructure.compute')
  })

  it('passes when a server-app site HAS compute configured', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          app: { root: '.output', domain: 'app.example.com', start: 'bun run server.ts', port: 3000 },
        },
        true,
      ),
    )
    expect(errors).toEqual([])
  })

  it('accepts server sites and redirects that attach to an owner compute box', () => {
    const config = makeConfig({
      app: { root: '.', domain: 'app.example.com', start: 'bun run serve', port: 3000 },
      docs: { root: 'dist', domain: 'docs.example.com', deploy: 'server' },
      www: { domain: 'www.example.com', redirect: 'https://example.com' },
    })
    config.cloud = { provider: 'hetzner', attachTo: 'stacks' }

    const { errors } = validateDeploymentConfig(config)

    expect(errors).toEqual([])
  })

  it('errors when a server-static site has compute but no root', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          docs: { domain: 'docs.example.com', deploy: 'server' },
        },
        true,
      ),
    )
    expect(errors.some((e) => e.includes('docs') && e.includes('root'))).toBe(true)
  })

  it('errors when a server-static site has no compute configured', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          docs: { root: 'docs/dist', domain: 'docs.example.com', deploy: 'server' },
        },
        false,
      ),
    )
    expect(errors.some((e) => e.includes('docs') && e.includes('infrastructure.compute'))).toBe(true)
  })

  it('errors when a bucket site is missing root', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig({
        web: { domain: 'example.com' },
      }),
    )
    expect(errors.some((e) => e.includes('web') && e.includes('root'))).toBe(true)
  })

  it("errors when deploy:'server' has neither start nor root", () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          x: { domain: 'x.example.com', deploy: 'server' },
        },
        true,
      ),
    )
    expect(errors.some((e) => e.includes('neither'))).toBe(true)
  })

  it('warns (not errors) when a bucket site sets server-only fields', () => {
    const { errors, warnings } = validateDeploymentConfig(
      makeConfig({
        web: {
          root: 'dist',
          domain: 'example.com',
          deploy: 'bucket',
          start: 'bun run x',
          port: 3000,
          preStart: ['bun i'],
        },
      }),
    )
    expect(errors).toEqual([])
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('start')
    expect(warnings[0]).toContain('port')
    expect(warnings[0]).toContain('preStart')
  })

  it('errors on duplicate ports among server-app sites', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          a: { root: '.', domain: 'a.example.com', start: 'bun run a', port: 3000 },
          b: { root: '.', domain: 'b.example.com', start: 'bun run b', port: 3000 },
        },
        true,
      ),
    )
    expect(errors.some((e) => e.includes('3000') && e.includes('distinct ports'))).toBe(true)
  })

  it('allows distinct ports among server-app sites', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          a: { root: '.', domain: 'a.example.com', start: 'bun run a', port: 3000 },
          b: { root: '.', domain: 'b.example.com', start: 'bun run b', port: 3001 },
        },
        true,
      ),
    )
    expect(errors).toEqual([])
  })

  it('validates a mixed stacks-style config: app=server-app, docs/blog=server-static, plus compute', () => {
    const { errors, warnings } = validateDeploymentConfig(
      makeConfig(
        {
          app: { root: '.output', domain: 'example.com', start: 'bun run server.ts', port: 3000 },
          docs: { root: 'docs/dist', domain: 'docs.example.com', deploy: 'server', build: 'bun run docs:build' },
          blog: { root: 'blog/dist', domain: 'blog.example.com', deploy: 'server' },
        },
        true,
      ),
    )
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it('accepts a redirect site (domain + target, no root) with compute', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          alt: { domain: 'very-good-adblock.org', redirect: 'https://verygoodadblock.org' },
        },
        true,
      ),
    )
    expect(errors).toEqual([])
  })

  it('flags a redirect site missing a domain or target', () => {
    const { errors } = validateDeploymentConfig(
      makeConfig(
        {
          noDomain: { redirect: 'https://x.com' },
          noTarget: { domain: 'a.com', redirect: { to: '' } },
        },
        true,
      ),
    )
    expect(errors.some((e) => e.includes('noDomain') && e.includes('domain'))).toBe(true)
    expect(errors.some((e) => e.includes('noTarget') && e.includes('target'))).toBe(true)
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

describe('shipsARelease', () => {
  it('excludes redirect-only sites, which have no root to package', () => {
    // Regression: the deploy command filtered only `bucket`, so a redirect
    // site reached the packaging loop, which read its undefined `root` and
    // aborted the entire deploy with "Build output not found at undefined".
    expect(shipsARelease({ domain: 'www.example.com', redirect: 'https://example.com' })).toBe(false)
    expect(shipsARelease({ domain: 'a.com', redirect: { to: 'https://b.com', status: 308 } })).toBe(false)
  })

  it('excludes bucket sites, handled by the static-site path', () => {
    expect(shipsARelease({ root: 'dist' })).toBe(false)
  })

  it('includes the sites that actually produce a release', () => {
    expect(shipsARelease({ root: 'dist', deploy: 'server' })).toBe(true)
    expect(shipsARelease({ root: '.', start: 'bun run server.ts', port: 3000 })).toBe(true)
  })
})

describe('proxy-only sites', () => {
  const registry: SiteConfig = { domain: 'registry.pantry.dev', proxyTo: 'localhost:3001' }

  it('resolves to the proxy kind', () => {
    expect(resolveSiteKind(registry)).toBe('proxy')
    expect(resolveSiteKind({ domain: 'a.com', proxyTo: ['10.0.0.1:8080', '10.0.0.2:8080'] })).toBe('proxy')
  })

  it('ships no release, so the packaging loop never looks for a root', () => {
    expect(shipsARelease(registry)).toBe(false)
  })

  it('wins over root/start, so a stale field cannot turn it back into a release', () => {
    // The motivating config had a leftover static `root` from an older shape.
    // If that still produced a release, deploying would overwrite the very
    // service the proxy exists to leave alone.
    expect(resolveSiteKind({ ...registry, root: './public' })).toBe('proxy')
    expect(resolveSiteKind({ ...registry, root: '.', start: 'bun run server.ts', port: 3001 })).toBe('proxy')
    expect(shipsARelease({ ...registry, root: '.', start: 'bun run server.ts', port: 3001 })).toBe(false)
  })

  it('yields to redirect, which answers the domain instead of forwarding it', () => {
    expect(resolveSiteKind({ ...registry, redirect: 'https://elsewhere.example' })).toBe('redirect')
  })

  it('ignores a blank upstream rather than routing to nothing', () => {
    expect(resolveProxyUpstreams({ domain: 'a.com', proxyTo: '  ' })).toEqual([])
    expect(hasProxyUpstream({ domain: 'a.com', proxyTo: '  ' })).toBe(false)
    expect(resolveSiteKind({ domain: 'a.com', proxyTo: '' })).not.toBe('proxy')
    expect(resolveProxyUpstreams({ domain: 'a.com', proxyTo: [' a:1 ', '', 'b:2'] })).toEqual(['a:1', 'b:2'])
  })
})

describe('validateDeploymentConfig for proxy sites', () => {
  const compute = { infrastructure: { compute: { size: 'small' } } } as any

  it('accepts a proxy site with a domain and an upstream', () => {
    const result = validateDeploymentConfig({
      ...compute,
      project: { name: 'pantry', slug: 'pantry' },
      sites: { registry: { domain: 'registry.pantry.dev', proxyTo: 'localhost:3001' } },
    })
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('requires a domain to route from', () => {
    const result = validateDeploymentConfig({
      ...compute,
      project: { name: 'p', slug: 'p' },
      sites: { registry: { proxyTo: 'localhost:3001' } },
    })
    expect(result.errors.some((e) => e.includes('no `domain` to route from'))).toBe(true)
  })

  it('requires a gateway to forward through', () => {
    const result = validateDeploymentConfig({
      project: { name: 'p', slug: 'p' },
      sites: { registry: { domain: 'r.example.com', proxyTo: 'localhost:3001' } },
    } as any)
    expect(result.errors.some((e) => e.includes('no `infrastructure.compute` is configured'))).toBe(true)
  })

  it('does not enter the server-app port-collision check', () => {
    // The proxied service is not ts-cloud's to supervise, so two proxy sites
    // pointing at one upstream is normal, not a collision.
    const result = validateDeploymentConfig({
      ...compute,
      project: { name: 'p', slug: 'p' },
      sites: {
        registry: { domain: 'registry.example.com', proxyTo: 'localhost:3001' },
        apex: { domain: 'example.com', proxyTo: 'localhost:3001' },
      },
    })
    expect(result.errors).toEqual([])
  })

  it('warns that fields it will not act on are ignored', () => {
    const result = validateDeploymentConfig({
      ...compute,
      project: { name: 'p', slug: 'p' },
      sites: { registry: { domain: 'r.example.com', proxyTo: 'localhost:3001', root: './public', build: 'bun run build' } },
    })
    expect(result.errors).toEqual([])
    expect(result.warnings.some((w) => w.includes('root') && w.includes('build'))).toBe(true)
  })
})
