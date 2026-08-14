import type { SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { shipsToBucket } from './site-target'

/**
 * A project whose sites are all server-deployed must never need DNS provider
 * credentials to deploy.
 *
 * The static-bucket pipeline used to resolve its DNS provider up front, before
 * looking at a single site. Every non-bucket site is skipped inside that loop,
 * so the credentials were demanded for work the function would not do — and
 * `resolveDnsProviderConfig` throws rather than returning null for Porkbun and
 * GoDaddy, so a server-only project with `infrastructure.dns.provider` set died
 * with a stack trace before anything was packaged. The provider is resolved on
 * first use now; these assert the shape that decision rests on.
 */
describe('DNS credential scope', () => {
  const server: SiteConfig = { deploy: 'server', root: 'dist', domain: 'example.com' }
  const redirect: SiteConfig = { domain: 'old.example.com', redirect: { to: 'https://example.com' } }
  const proxy: SiteConfig = { domain: 'api.example.com', proxyTo: 'localhost:3001' }
  const app: SiteConfig = { deploy: 'server', start: 'bun run start', port: 3000, domain: 'app.example.com' }
  const bucket: SiteConfig = { deploy: 'bucket', root: 'dist', domain: 'cdn.example.com' }

  it('does not route a server-static site through the bucket pipeline', () => {
    expect(shipsToBucket(server)).toBe(false)
  })

  it('does not route redirect or proxy sites through it either', () => {
    expect(shipsToBucket(redirect)).toBe(false)
    expect(shipsToBucket(proxy)).toBe(false)
  })

  it('does not route a server app through it', () => {
    expect(shipsToBucket(app)).toBe(false)
  })

  it('still routes an explicit bucket site through it', () => {
    expect(shipsToBucket(bucket)).toBe(true)
  })

  it('needs no bucket pipeline at all for the docs-site shape', () => {
    // The home-lang shape: one static site on a shared box plus a redirect for
    // the retired host. Nothing here should ever ask for DNS credentials.
    const sites: Record<string, SiteConfig> = { site: server, docs: redirect }

    expect(Object.values(sites).some(shipsToBucket)).toBe(false)
  })
})
