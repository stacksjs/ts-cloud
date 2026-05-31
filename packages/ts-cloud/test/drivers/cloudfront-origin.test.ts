import { describe, expect, it } from 'bun:test'
import {
  buildCloudFrontOriginConfig,
  MANAGED_CACHE_POLICY_DISABLED,
  MANAGED_CACHE_POLICY_OPTIMIZED,
  MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER,
} from '../../src/drivers/shared/cloudfront-origin'

const base = {
  aliases: ['stacksjs.com', 'www.stacksjs.com'],
  originDomain: 'origin.stacksjs.com',
  viewerCertificateArn: 'arn:aws:acm:us-east-1:123:certificate/abc',
  behaviors: [
    { pathPattern: '/api/*', kind: 'dynamic' as const },
    { pathPattern: '/docs', kind: 'static' as const },
    { pathPattern: '/docs/*', kind: 'static' as const },
  ],
}

describe('buildCloudFrontOriginConfig', () => {
  it('produces a single custom https-only origin pointing at the box', () => {
    const c = buildCloudFrontOriginConfig(base)
    expect(c.Origins.Quantity).toBe(1)
    const o = c.Origins.Items[0]
    expect(o.DomainName).toBe('origin.stacksjs.com')
    expect(o.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only')
  })

  it('leaves DefaultRootObject empty (avoids the /index.html → / loop)', () => {
    expect(buildCloudFrontOriginConfig(base).DefaultRootObject).toBe('')
  })

  it('attaches no CloudFront Functions or Lambda associations on any behavior', () => {
    const c = buildCloudFrontOriginConfig(base)
    const all = [c.DefaultCacheBehavior, ...c.CacheBehaviors.Items]
    for (const b of all) {
      expect(b.FunctionAssociations.Quantity).toBe(0)
      expect(b.LambdaFunctionAssociations.Quantity).toBe(0)
    }
  })

  it('forwards Host via AllViewer and caches static, disables cache for dynamic', () => {
    const c = buildCloudFrontOriginConfig(base)
    expect(c.DefaultCacheBehavior.OriginRequestPolicyId).toBe(MANAGED_ORIGIN_REQUEST_POLICY_ALL_VIEWER)
    expect(c.DefaultCacheBehavior.CachePolicyId).toBe(MANAGED_CACHE_POLICY_OPTIMIZED)
    const api = c.CacheBehaviors.Items.find((b: any) => b.PathPattern === '/api/*')
    expect(api.CachePolicyId).toBe(MANAGED_CACHE_POLICY_DISABLED)
    expect(api.AllowedMethods.Items).toContain('POST')
    const docs = c.CacheBehaviors.Items.find((b: any) => b.PathPattern === '/docs/*')
    expect(docs.CachePolicyId).toBe(MANAGED_CACHE_POLICY_OPTIMIZED)
  })

  it('orders behaviors most-specific-first', () => {
    const items = buildCloudFrontOriginConfig(base).CacheBehaviors.Items.map((b: any) => b.PathPattern)
    expect(items.indexOf('/docs/*')).toBeLessThan(items.indexOf('/docs'))
  })

  it('injects the origin secret header when provided (lockdown)', () => {
    const c = buildCloudFrontOriginConfig({ ...base, originSecret: 'shh' })
    const ch = c.Origins.Items[0].CustomHeaders
    expect(ch.Quantity).toBe(1)
    expect(ch.Items[0]).toEqual({ HeaderName: 'X-Origin-Verify', HeaderValue: 'shh' })
  })

  it('omits custom headers when no secret', () => {
    expect(buildCloudFrontOriginConfig(base).Origins.Items[0].CustomHeaders.Quantity).toBe(0)
  })

  it('uses the ACM cert for the viewer with sni-only', () => {
    const c = buildCloudFrontOriginConfig(base)
    expect(c.ViewerCertificate.ACMCertificateArn).toBe(base.viewerCertificateArn)
    expect(c.ViewerCertificate.SSLSupportMethod).toBe('sni-only')
    expect(c.Aliases.Items).toEqual(['stacksjs.com', 'www.stacksjs.com'])
  })

  it('rejects an originDomain that collides with an alias (would loop)', () => {
    expect(() => buildCloudFrontOriginConfig({ ...base, originDomain: 'stacksjs.com' })).toThrow(/loop/)
  })

  it('requires at least one alias', () => {
    expect(() => buildCloudFrontOriginConfig({ ...base, aliases: [] })).toThrow(/alias/)
  })
})
