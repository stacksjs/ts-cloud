import { describe, expect, it } from 'bun:test'
import { ControlPlaneStore } from '../control-plane'
import { AuthenticationStore } from './store'

function stores(now: () => Date = () => new Date('2026-07-21T12:00:00.000Z')) {
  const controlPlane = new ControlPlaneStore({ path: ':memory:', now })
  const auth = new AuthenticationStore(controlPlane, { now })
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
})

describe('AuthenticationStore action tokens', () => {
  it('stores only token hashes and rejects replay and expiry', () => {
    let now = new Date('2026-07-21T12:00:00.000Z')
    const { controlPlane, auth, actor } = stores(() => now)
    const identity = auth.createIdentity({ actorId: actor.id, username: 'chris', passwordHash: 'hash' })
    const reset = auth.createActionToken(identity.id, 'password_reset', { ttlMs: 60_000 })

    expect(JSON.stringify(controlPlane.database.query('SELECT * FROM auth_action_tokens').get())).not.toContain(reset.token)
    expect(auth.consumeActionToken(reset.token, 'password_reset').state).toBe('consumed')
    expect(() => auth.consumeActionToken(reset.token, 'password_reset')).toThrow('consumed')

    const expired = auth.createActionToken(identity.id, 'email_verification', { ttlMs: 60_000 })
    now = new Date('2026-07-21T12:02:00.000Z')
    expect(() => auth.consumeActionToken(expired.token, 'email_verification')).toThrow('expired')
    controlPlane.close()
  })
})

describe('AuthenticationStore sessions', () => {
  it('uses opaque versioned tokens, enforces idle and absolute expiry, and supports revocation', () => {
    let now = new Date('2026-07-21T12:00:00.000Z')
    const { controlPlane, auth, actor } = stores(() => now)
    const identity = auth.createIdentity({ actorId: actor.id, username: 'chris', passwordHash: 'hash' })
    const first = auth.createSession({ identityId: identity.id, idleTtlMs: 60_000, absoluteTtlMs: 120_000, userAgent: 'Browser' })
    const second = auth.createSession({ identityId: identity.id, idleTtlMs: 60_000, absoluteTtlMs: 120_000 })

    expect(first.token).toStartWith(`v2.${first.session.id}.`)
    expect(JSON.stringify(controlPlane.database.query('SELECT * FROM auth_sessions WHERE id = ?').get(first.session.id))).not.toContain(first.token)
    now = new Date('2026-07-21T12:00:30.000Z')
    expect(auth.verifySessionToken(first.token)?.identity.username).toBe('chris')
    expect(auth.revokeOtherSessions(identity.id, first.session.id)).toBe(1)
    expect(auth.verifySessionToken(second.token)).toBeUndefined()
    now = new Date('2026-07-21T12:02:01.000Z')
    expect(auth.verifySessionToken(first.token)).toBeUndefined()
    controlPlane.close()
  })
})
