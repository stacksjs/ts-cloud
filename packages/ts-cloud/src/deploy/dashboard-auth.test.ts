import type { DashboardUser } from './dashboard-auth'
import { describe, expect, it } from 'bun:test'
import { authorize, generatePassword, hashPassword, isBoxCapability, verifyPassword, visibleSites } from './dashboard-auth'
import { createSessionToken, readCookie, serializeSessionCookie, verifySessionToken } from './dashboard-session'

const admin: Pick<DashboardUser, 'role' | 'sites'> = { role: 'admin', sites: {} }
const siteOwner: Pick<DashboardUser, 'role' | 'sites'> = { role: 'member', sites: { blog: 'owner' } }
const collaborator: Pick<DashboardUser, 'role' | 'sites'> = { role: 'member', sites: { blog: 'collaborator' } }

describe('authorize', () => {
  it('grants an admin every capability', () => {
    expect(authorize({ user: admin, capability: 'box:shell' })).toBe(true)
    expect(authorize({ user: admin, capability: 'box:database' })).toBe(true)
    expect(authorize({ user: admin, capability: 'site:settings', site: 'anything' })).toBe(true)
  })

  it('never grants a member box-level capabilities, even on a site they own', () => {
    for (const capability of ['box:shell', 'box:ssh', 'box:firewall', 'box:database', 'box:config', 'box:users'] as const) {
      expect(authorize({ user: siteOwner, capability })).toBe(false)
      // Passing a granted site must not unlock a box capability.
      expect(authorize({ user: siteOwner, capability, site: 'blog' })).toBe(false)
    }
  })

  it('scopes a member to the sites they were granted', () => {
    expect(authorize({ user: collaborator, capability: 'site:read', site: 'blog' })).toBe(true)
    expect(authorize({ user: collaborator, capability: 'site:read', site: 'other' })).toBe(false)
    expect(authorize({ user: collaborator, capability: 'site:deploy', site: 'other' })).toBe(false)
  })

  it('lets a site owner change settings but not a collaborator', () => {
    expect(authorize({ user: siteOwner, capability: 'site:settings', site: 'blog' })).toBe(true)
    expect(authorize({ user: collaborator, capability: 'site:settings', site: 'blog' })).toBe(false)
    // Both can still deploy.
    expect(authorize({ user: siteOwner, capability: 'site:deploy', site: 'blog' })).toBe(true)
    expect(authorize({ user: collaborator, capability: 'site:deploy', site: 'blog' })).toBe(true)
  })

  it('denies a site capability with no site named', () => {
    expect(authorize({ user: siteOwner, capability: 'site:read' })).toBe(false)
    expect(authorize({ user: collaborator, capability: 'site:deploy' })).toBe(false)
  })

  it('denies unknown capabilities for members (deny by default)', () => {
    expect(authorize({ user: siteOwner, capability: 'site:nonsense' as any, site: 'blog' })).toBe(false)
    expect(authorize({ user: siteOwner, capability: 'totally:made-up' as any, site: 'blog' })).toBe(false)
  })

  it('ignores grants with an unrecognized role', () => {
    const broken: Pick<DashboardUser, 'role' | 'sites'> = { role: 'member', sites: { blog: 'superuser' as any } }
    expect(authorize({ user: broken, capability: 'site:read', site: 'blog' })).toBe(false)
  })

  it('classifies box capabilities', () => {
    expect(isBoxCapability('box:shell')).toBe(true)
    expect(isBoxCapability('site:read')).toBe(false)
  })
})

describe('visibleSites', () => {
  const all = ['blog', 'api', 'marketing']

  it('shows an admin every site', () => {
    expect(visibleSites(admin, all)).toEqual(all)
  })

  it('shows a member only their granted sites', () => {
    expect(visibleSites(collaborator, all)).toEqual(['blog'])
  })

  it('drops grants for sites that no longer exist', () => {
    const stale: Pick<DashboardUser, 'role' | 'sites'> = { role: 'member', sites: { blog: 'owner', deleted: 'owner' } }
    expect(visibleSites(stale, all)).toEqual(['blog'])
  })
})

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const hash = hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(verifyPassword('wrong password', hash)).toBe(false)
  })

  it('never stores the plaintext', () => {
    const hash = hashPassword('hunter2')
    expect(hash).not.toContain('hunter2')
    expect(hash.startsWith('scrypt$')).toBe(true)
  })

  it('salts — the same password hashes differently each time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'))
  })

  it('rejects malformed hashes rather than throwing', () => {
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'garbage')).toBe(false)
    expect(verifyPassword('x', 'scrypt$1$2$3')).toBe(false)
    expect(verifyPassword('x', 'scrypt$N$r$p$salt$hash')).toBe(false)
    expect(verifyPassword('x', 'bcrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(false)
  })

  it('generates distinct URL-safe passwords', () => {
    const a = generatePassword()
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(generatePassword())
  })
})

describe('session tokens', () => {
  const secret = 'test-secret'

  it('round-trips a username', () => {
    const token = createSessionToken('chris', secret)
    expect(verifySessionToken(token, secret)?.u).toBe('chris')
  })

  it('round-trips organization membership versions used for revocation', () => {
    const token = createSessionToken('chris', secret, undefined, { 'org-1': 3 })
    expect(verifySessionToken(token, secret)?.mv).toEqual({ 'org-1': 3 })
  })

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken('chris', secret)
    expect(verifySessionToken(token, 'other-secret')).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const token = createSessionToken('member', secret)
    const forgedPayload = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 10_000 }), 'utf8').toString('base64url')
    const forged = `${forgedPayload}.${token.split('.')[1]}`
    expect(verifySessionToken(forged, secret)).toBeNull()
  })

  it('rejects an expired token', () => {
    const expired = createSessionToken('chris', secret, -1000)
    expect(verifySessionToken(expired, secret)).toBeNull()
  })

  it('rejects malformed and missing tokens', () => {
    expect(verifySessionToken(undefined, secret)).toBeNull()
    expect(verifySessionToken('', secret)).toBeNull()
    expect(verifySessionToken('no-dot', secret)).toBeNull()
    expect(verifySessionToken('.sig', secret)).toBeNull()
    expect(verifySessionToken('a.b', secret)).toBeNull()
  })
})

describe('session cookie', () => {
  it('is HttpOnly and SameSite=Lax, and Secure when not on loopback', () => {
    const cookie = serializeSessionCookie('token', { secure: true })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
  })

  it('omits Secure on loopback so local dev over http still works', () => {
    expect(serializeSessionCookie('token', { secure: false })).not.toContain('Secure')
  })

  it('reads a cookie out of a header', () => {
    expect(readCookie('a=1; ts_cloud_session=abc; b=2', 'ts_cloud_session')).toBe('abc')
    expect(readCookie('a=1', 'ts_cloud_session')).toBeUndefined()
    expect(readCookie(null, 'ts_cloud_session')).toBeUndefined()
  })
})
