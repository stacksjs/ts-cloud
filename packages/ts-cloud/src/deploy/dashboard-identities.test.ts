import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthenticationStore } from '../auth'
import { initializeDashboardControlPlane } from './dashboard-control-plane'
import { localLoginRequiresSso, resolveOidcDashboardIdentity } from './dashboard-identities'
import { loadUsers } from './dashboard-users'

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ts-cloud-oidc-identity-'))
  const controlPlane = initializeDashboardControlPlane(cwd, {
    project: { slug: 'acme', name: 'Acme', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
  } as any)
  const authentication = new AuthenticationStore(controlPlane.store, { encryptionKey: 'test-key' })
  const provider = authentication.upsertOidcProvider({
    organizationId: controlPlane.organization.id,
    slug: 'workforce',
    name: 'Workforce',
    issuer: 'https://identity.acme.test',
    clientId: 'cloud',
    clientSecret: 'secret',
    allowedDomains: ['acme.test'],
    enforceSso: true,
  })
  return { cwd, controlPlane, authentication, provider }
}

describe('dashboard OIDC identity resolution', () => {
  it('provisions an organization-scoped user from a verified provider identity', () => {
    const { cwd, controlPlane, authentication, provider } = fixture()
    const resolved = resolveOidcDashboardIdentity(authentication, controlPlane, cwd, {
      provider,
      subject: 'employee-123',
      email: 'chris@acme.test',
      name: 'Chris',
      claims: {},
    })
    const membership = controlPlane.store.getMembershipForActor(controlPlane.organization.id, resolved.identity.actorId)

    expect(resolved).toMatchObject({ provisioned: true, user: { username: 'chris', email: 'chris@acme.test', role: 'member' } })
    expect(membership).toMatchObject({ roleTemplate: 'viewer', scope: { type: 'organization' }, status: 'active' })
    expect(authentication.getOidcSubject(provider.id, 'employee-123')?.identityId).toBe(resolved.identity.id)
    expect(localLoginRequiresSso(authentication, controlPlane, resolved.identity)).toBe(true)
    controlPlane.store.close()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('reuses a stable subject and refuses an unverified local-email takeover', () => {
    const { cwd, controlPlane, authentication, provider } = fixture()
    const first = resolveOidcDashboardIdentity(authentication, controlPlane, cwd, {
      provider,
      subject: 'employee-123',
      email: 'chris@acme.test',
      claims: {},
    })
    const second = resolveOidcDashboardIdentity(authentication, controlPlane, cwd, {
      provider,
      subject: 'employee-123',
      email: 'chris@acme.test',
      claims: {},
    })
    expect(second.identity.id).toBe(first.identity.id)
    expect(loadUsers(cwd)).toHaveLength(1)

    const localUser = { username: 'victim', passwordHash: 'hash', role: 'member' as const, sites: {} }
    const actor = controlPlane.store.createActor({ kind: 'user', externalId: 'dashboard:victim', displayName: 'Victim' })
    authentication.createIdentity({ actorId: actor.id, username: localUser.username, email: 'victim@acme.test', passwordHash: localUser.passwordHash })
    expect(() => resolveOidcDashboardIdentity(authentication, controlPlane, cwd, {
      provider,
      subject: 'employee-456',
      email: 'victim@acme.test',
      claims: {},
    })).toThrow('unverified')
    controlPlane.store.close()
    rmSync(cwd, { recursive: true, force: true })
  })
})
