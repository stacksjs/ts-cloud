import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { AuthenticationStore } from './store'
import { totp } from './totp'

function stores(now: () => Date = () => new Date('2026-07-21T12:00:00.000Z')) {
  const controlPlane = new ControlPlaneStore({ path: ':memory:', now })
  const auth = new AuthenticationStore(controlPlane, { now, encryptionKey: 'test-encryption-key' })
  const actor = controlPlane.createActor({ kind: 'user', externalId: 'dashboard:chris', displayName: 'Chris' })
  return { controlPlane, auth, actor }
}

describe('AuthenticationStore identities', () => {
  it('keeps credentials separate from organization membership and normalizes identity lookup', () => {
    const { controlPlane, auth, actor } = stores()
    const identity = auth.createIdentity({
      actorId: actor.id,
      username: 'Chris',
      email: 'CHRIS@EXAMPLE.COM',
      emailVerified: true,
      passwordHash: 'scrypt$encoded',
    })

    expect(auth.getIdentityByUsername('chris')).toEqual(identity)
    expect(auth.getIdentityByEmail('CHRIS@example.com')).toEqual(identity)
    expect(identity).toMatchObject({ email: 'chris@example.com', credentialVersion: 1, requiresPasswordUpgrade: false })
    expect(controlPlane.listMemberships('unknown')).toEqual([])
    controlPlane.close()
  })

  it('increments credential versions and revokes sessions on password change or disable', () => {
    const { controlPlane, auth, actor } = stores()
    const identity = auth.createIdentity({ actorId: actor.id, username: 'chris', passwordHash: 'old' })
    const issued = auth.createSession({ identityId: identity.id })
    const changed = auth.updatePassword(identity.id, 'new')

    expect(changed.credentialVersion).toBe(2)
    expect(auth.verifySessionToken(issued.token)).toBeUndefined()
    const replacement = auth.createSession({ identityId: identity.id })
    expect(auth.setDisabled(identity.id, true).disabledAt).toBeDefined()
    expect(auth.verifySessionToken(replacement.token)).toBeUndefined()
    controlPlane.close()
  })

  it('rehashes legacy credentials without revoking otherwise valid sessions', () => {
    const { controlPlane, auth, actor } = stores()
    const identity = auth.createIdentity({
      actorId: actor.id,
      username: 'chris',
      passwordHash: 'legacy',
      requiresPasswordUpgrade: true,
    })
    const issued = auth.createSession({ identityId: identity.id })
    const upgraded = auth.rehashPassword(identity.id, 'modern')

    expect(upgraded).toMatchObject({ credentialVersion: 1, requiresPasswordUpgrade: false, passwordHash: 'modern' })
    expect(auth.verifySessionToken(issued.token)?.session.state).toBe('active')
    controlPlane.close()
  })
})

describe('AuthenticationStore MFA', () => {
  it('encrypts TOTP seeds, verifies enrollment, and consumes recovery codes once', () => {
    const now = new Date('2026-07-21T12:00:00.000Z')
    const { controlPlane, auth, actor } = stores(() => now)
    const identity = auth.createIdentity({ actorId: actor.id, username: 'chris', passwordHash: 'hash' })
    const enrollment = auth.beginTotpEnrollment(identity.id, { issuer: 'Acme' })

    expect(JSON.stringify(controlPlane.database.query('SELECT * FROM auth_mfa_factors').get())).not.toContain(
      enrollment.secret,
    )
    const verified = auth.verifyTotpEnrollment(identity.id, totp(enrollment.secret, now.getTime()))
    expect(verified.factor.state).toBe('active')
    expect(verified.recoveryCodes).toHaveLength(10)
    expect(auth.verifyMfaCode(identity.id, totp(enrollment.secret, now.getTime())).valid).toBe(false)
    expect(auth.remainingRecoveryCodes(identity.id)).toBe(10)
    expect(auth.verifyMfaCode(identity.id, verified.recoveryCodes[0])).toMatchObject({
      valid: true,
      method: 'recovery',
    })
    expect(auth.verifyMfaCode(identity.id, verified.recoveryCodes[0]).valid).toBe(false)
    expect(auth.remainingRecoveryCodes(identity.id)).toBe(9)
    controlPlane.close()
  })

  it('rate-limits, expires, and prevents replay of MFA challenges', () => {
    let now = new Date('2026-07-21T12:00:00.000Z')
    const { controlPlane, auth, actor } = stores(() => now)
    const identity = auth.createIdentity({ actorId: actor.id, username: 'chris', passwordHash: 'hash' })
    const enrollment = auth.beginTotpEnrollment(identity.id)
    auth.verifyTotpEnrollment(identity.id, totp(enrollment.secret, now.getTime()))
    now = new Date('2026-07-21T12:00:31.000Z')
    const issued = auth.createMfaChallenge(identity.id, 'login')

    expect(
      auth.completeMfaChallenge(issued.token, totp(enrollment.secret, now.getTime()), 'login').challenge.state,
    ).toBe('consumed')
    expect(() => auth.completeMfaChallenge(issued.token, totp(enrollment.secret, now.getTime()), 'login')).toThrow(
      'consumed',
    )

    const locked = auth.createMfaChallenge(identity.id, 'login')
    for (let attempt = 0; attempt < 5; attempt++)
      expect(() => auth.completeMfaChallenge(locked.token, '000000', 'login')).toThrow('invalid')
    expect(() => auth.completeMfaChallenge(locked.token, totp(enrollment.secret, now.getTime()), 'login')).toThrow(
      'locked',
    )

    const expired = auth.createMfaChallenge(identity.id, 'step_up')
    now = new Date('2026-07-21T12:06:00.000Z')
    expect(() => auth.completeMfaChallenge(expired.token, totp(enrollment.secret, now.getTime()), 'step_up')).toThrow(
      'expired',
    )
    controlPlane.close()
  })
})

describe('AuthenticationStore action tokens', () => {
  it('stores only token hashes and rejects replay and expiry', () => {
    let now = new Date('2026-07-21T12:00:00.000Z')
    const { controlPlane, auth, actor } = stores(() => now)
    const identity = auth.createIdentity({ actorId: actor.id, username: 'chris', passwordHash: 'hash' })
    const reset = auth.createActionToken(identity.id, 'password_reset', { ttlMs: 60_000 })

    expect(JSON.stringify(controlPlane.database.query('SELECT * FROM auth_action_tokens').get())).not.toContain(
      reset.token,
    )
    expect(auth.consumeActionToken(reset.token, 'password_reset').state).toBe('consumed')
    expect(() => auth.consumeActionToken(reset.token, 'password_reset')).toThrow('consumed')

    const expired = auth.createActionToken(identity.id, 'email_verification', { ttlMs: 60_000 })
    now = new Date('2026-07-21T12:02:00.000Z')
    expect(() => auth.consumeActionToken(expired.token, 'email_verification')).toThrow('expired')
    controlPlane.close()
  })
})

describe('AuthenticationStore OIDC', () => {
  it('encrypts provider and transaction secrets and consumes state once', () => {
    const { controlPlane, auth } = stores()
    const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
    const provider = auth.upsertOidcProvider({
      organizationId: organization.id,
      slug: 'workforce',
      name: 'Acme Workforce',
      issuer: 'https://identity.acme.test/',
      clientId: 'ts-cloud',
      clientSecret: 'provider-secret',
      allowedDomains: ['ACME.test', 'acme.test'],
      enforceSso: true,
    })
    const issued = auth.beginOidcTransaction(
      provider.id,
      'https://cloud.acme.test/auth/oidc/workforce/callback',
      '/projects',
    )
    const persisted = JSON.stringify(controlPlane.database.query('SELECT * FROM auth_oidc_transactions').get())

    expect(provider).toMatchObject({
      issuer: 'https://identity.acme.test',
      allowedDomains: ['acme.test'],
      scopes: ['openid', 'email', 'profile'],
    })
    expect(JSON.stringify(controlPlane.database.query('SELECT * FROM auth_oidc_providers').get())).not.toContain(
      'provider-secret',
    )
    expect(persisted).not.toContain(issued.state)
    expect(persisted).not.toContain(issued.nonce)
    expect(persisted).not.toContain(issued.verifier)
    expect(auth.consumeOidcTransaction(provider.id, issued.state)).toMatchObject({
      nonce: issued.nonce,
      verifier: issued.verifier,
    })
    expect(() => auth.consumeOidcTransaction(provider.id, issued.state)).toThrow('consumed')
    controlPlane.close()
  })

  it('links an external subject to exactly one local identity', () => {
    const { controlPlane, auth, actor } = stores()
    const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
    const provider = auth.upsertOidcProvider({
      organizationId: organization.id,
      slug: 'workforce',
      name: 'Workforce',
      issuer: 'https://identity.acme.test',
      clientId: 'ts-cloud',
      clientSecret: 'secret',
      allowedDomains: ['acme.test'],
    })
    const identity = auth.createIdentity({
      actorId: actor.id,
      username: 'chris',
      email: 'chris@acme.test',
      emailVerified: true,
      passwordHash: 'hash',
    })
    const linked = auth.linkOidcSubject(provider.id, identity.id, 'external-123', 'CHRIS@acme.test')

    expect(linked).toMatchObject({ identityId: identity.id, subject: 'external-123', email: 'chris@acme.test' })
    expect(auth.getOidcSubject(provider.id, 'external-123')).toEqual(linked)
    controlPlane.close()
  })

  it('disables SSO enforcement and pending transactions when a provider is disabled', () => {
    const { controlPlane, auth } = stores()
    const organization = controlPlane.createOrganization({ slug: 'acme', name: 'Acme' })
    const provider = auth.upsertOidcProvider({
      organizationId: organization.id,
      slug: 'workforce',
      name: 'Workforce',
      issuer: 'https://identity.acme.test',
      clientId: 'ts-cloud',
      clientSecret: 'secret',
      allowedDomains: ['acme.test'],
      enforceSso: true,
    })
    const transaction = auth.beginOidcTransaction(provider.id, 'https://cloud.acme.test/callback', '/')

    expect(auth.setOidcProviderEnabled(provider.id, false)).toMatchObject({ enabled: false, enforceSso: false })
    expect(auth.getOidcTransaction(transaction.transaction.id)?.state).toBe('consumed')
    controlPlane.close()
  })
})

describe('AuthenticationStore sessions', () => {
  it('uses opaque versioned tokens, enforces idle and absolute expiry, and supports revocation', () => {
    let now = new Date('2026-07-21T12:00:00.000Z')
    const { controlPlane, auth, actor } = stores(() => now)
    const identity = auth.createIdentity({ actorId: actor.id, username: 'chris', passwordHash: 'hash' })
    const first = auth.createSession({
      identityId: identity.id,
      idleTtlMs: 60_000,
      absoluteTtlMs: 120_000,
      userAgent: 'Browser',
    })
    const second = auth.createSession({ identityId: identity.id, idleTtlMs: 60_000, absoluteTtlMs: 120_000 })

    expect(first.token).toStartWith(`v2.${first.session.id}.`)
    expect(
      JSON.stringify(controlPlane.database.query('SELECT * FROM auth_sessions WHERE id = ?').get(first.session.id)),
    ).not.toContain(first.token)
    now = new Date('2026-07-21T12:00:30.000Z')
    expect(auth.verifySessionToken(first.token)?.identity.username).toBe('chris')
    expect(auth.isRecentlyAuthenticated(first.session, 20_000)).toBe(false)
    expect(auth.markSessionStepUp(first.session.id, true).mfaAt).toBeDefined()
    expect(auth.revokeOtherSessions(identity.id, first.session.id)).toBe(1)
    expect(auth.verifySessionToken(second.token)).toBeUndefined()
    now = new Date('2026-07-21T12:02:01.000Z')
    expect(auth.verifySessionToken(first.token)).toBeUndefined()
    controlPlane.close()
  })
})
