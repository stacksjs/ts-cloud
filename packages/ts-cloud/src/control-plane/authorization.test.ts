import type { AuthorizationGrant, AuthorizationTarget, OrganizationMembership, OrganizationRoleTemplate } from './types'
import { describe, expect, it } from 'bun:test'
import { authorizeOrganization, roleCapabilities } from './authorization'
import { ControlPlaneStore } from './store'

function membership(roleTemplate: OrganizationRoleTemplate, scope: OrganizationMembership['scope'] = { type: 'organization' }): OrganizationMembership {
  return {
    id: 'membership-1',
    organizationId: 'org-1',
    actorId: 'actor-1',
    roleTemplate,
    scope,
    source: 'manual',
    status: 'active',
    sessionVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const target: AuthorizationTarget = {
  organizationId: 'org-1',
  projectId: 'project-1',
  environmentId: 'environment-1',
  resourceId: 'resource-1',
}

describe('organization authorization', () => {
  it('keeps viewer, deployer, operator, admin, and owner templates least-privileged', () => {
    expect(roleCapabilities('viewer').has('deployments:create')).toBe(false)
    expect(roleCapabilities('deployer').has('deployments:create')).toBe(true)
    expect(roleCapabilities('deployer').has('secrets:read')).toBe(false)
    expect(roleCapabilities('operator').has('runtime:restart')).toBe(true)
    expect(roleCapabilities('operator').has('runtime:terminal')).toBe(false)
    expect(roleCapabilities('admin').has('users:transfer-ownership')).toBe(false)
    expect(roleCapabilities('owner').has('users:transfer-ownership')).toBe(true)
  })

  it('inherits a role only through its assigned resource ancestry', () => {
    const deployer = membership('deployer', { type: 'environment', id: 'environment-1' })
    expect(authorizeOrganization({ membership: deployer, grants: [], capability: 'deployments:create', target }).allowed).toBe(true)
    expect(authorizeOrganization({
      membership: deployer,
      grants: [],
      capability: 'deployments:create',
      target: { ...target, environmentId: 'environment-2', resourceId: 'resource-2' },
    })).toMatchObject({ allowed: false, reason: 'scope-mismatch' })
  })

  it('applies explicit deny before role and explicit allow grants', () => {
    const grants: AuthorizationGrant[] = [
      {
        id: 'allow', organizationId: 'org-1', membershipId: 'membership-1', effect: 'allow', capability: 'secrets:read',
        scope: { type: 'resource', id: 'resource-1' }, source: 'manual', createdAt: '', updatedAt: '',
      },
      {
        id: 'deny', organizationId: 'org-1', membershipId: 'membership-1', effect: 'deny', capability: 'secrets:read',
        scope: { type: 'environment', id: 'environment-1' }, source: 'manual', createdAt: '', updatedAt: '',
      },
    ]
    expect(authorizeOrganization({ membership: membership('owner'), grants, capability: 'secrets:read', target })).toMatchObject({ allowed: false, reason: 'explicit-deny' })
    expect(authorizeOrganization({ membership: membership('viewer'), grants: [grants[0]], capability: 'secrets:read', target })).toMatchObject({ allowed: true, reason: 'explicit-allow' })
  })

  it('denies inactive and cross-organization memberships before evaluating grants', () => {
    expect(authorizeOrganization({ membership: { ...membership('owner'), status: 'revoked' }, grants: [], capability: 'project:read', target }).allowed).toBe(false)
    expect(authorizeOrganization({ membership: membership('owner'), grants: [], capability: 'project:read', target: { organizationId: 'org-2' } }).allowed).toBe(false)
  })
})

describe('organization membership and invitations', () => {
  it('stores only invitation hashes and rejects expiry and replay', () => {
    let now = new Date('2026-01-01T00:00:00.000Z')
    const store = new ControlPlaneStore({ path: ':memory:', now: () => now })
    const organization = store.createOrganization({ slug: 'acme-inc', name: 'Acme' })
    const actor = store.createActor({ kind: 'user', externalId: 'dashboard:dev', displayName: 'Dev' })
    const created = store.createInvitation({ organizationId: organization.id, email: 'dev@acme.test', roleTemplate: 'deployer', expiresInMs: 60_000 })
    expect(created.invitation).not.toHaveProperty('tokenHash')
    expect(store.inspectInvitationToken(created.token)).toMatchObject({ id: created.invitation.id, state: 'pending' })
    expect(JSON.stringify(created.invitation)).not.toContain(created.token)

    const accepted = store.acceptInvitation(created.token, actor.id)
    expect(accepted.invitation.state).toBe('accepted')
    expect(accepted.membership.roleTemplate).toBe('deployer')
    expect(() => store.acceptInvitation(created.token, actor.id)).toThrow('accepted')

    const expiring = store.createInvitation({ organizationId: organization.id, email: 'late@acme.test', roleTemplate: 'viewer', expiresInMs: 60_000 })
    now = new Date('2026-01-01T00:01:01.000Z')
    expect(() => store.acceptInvitation(expiring.token, actor.id)).toThrow('expired')
    store.close()
  })

  it('protects the last owner and invalidates membership sessions on changes', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const organization = store.createOrganization({ slug: 'acme-inc', name: 'Acme' })
    const firstActor = store.createActor({ kind: 'user', externalId: 'dashboard:first', displayName: 'First' })
    const secondActor = store.createActor({ kind: 'user', externalId: 'dashboard:second', displayName: 'Second' })
    const first = store.createMembership({ organizationId: organization.id, actorId: firstActor.id, roleTemplate: 'owner' })
    expect(() => store.revokeMembership(first.id)).toThrow('last organization owner')

    store.createMembership({ organizationId: organization.id, actorId: secondActor.id, roleTemplate: 'owner' })
    const revoked = store.revokeMembership(first.id)
    expect(revoked.status).toBe('revoked')
    expect(revoked.sessionVersion).toBe(first.sessionVersion + 1)
    store.close()
  })

  it('adds an invitation scope to an existing member without replacing prior access', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const organization = store.createOrganization({ slug: 'acme-inc', name: 'Acme' })
    const actor = store.createActor({ kind: 'user', externalId: 'dashboard:dev', displayName: 'Dev' })
    const project = store.createProject({ organizationId: organization.id, slug: 'acme', name: 'Acme' })
    const firstEnvironment = store.createEnvironment({ projectId: project.id, slug: 'staging', name: 'Staging', kind: 'staging' })
    const secondEnvironment = store.createEnvironment({ projectId: project.id, slug: 'production', name: 'Production', kind: 'production' })
    const membership = store.createMembership({ organizationId: organization.id, actorId: actor.id, roleTemplate: 'viewer', scope: { type: 'environment', id: firstEnvironment.id } })
    const created = store.createInvitation({ organizationId: organization.id, email: 'dev@acme.test', roleTemplate: 'deployer', scope: { type: 'environment', id: secondEnvironment.id } })

    const accepted = store.acceptInvitation(created.token, actor.id)
    const grants = store.listGrants(membership.id)
    expect(accepted.membership.scope).toEqual({ type: 'environment', id: firstEnvironment.id })
    expect(authorizeOrganization({
      membership: accepted.membership,
      grants,
      capability: 'deployments:create',
      target: { organizationId: organization.id, projectId: project.id, environmentId: secondEnvironment.id },
    }).allowed).toBe(true)
    expect(accepted.membership.sessionVersion).toBeGreaterThan(membership.sessionVersion)
    store.close()
  })

  it('rejects guessed scopes from another organization and isolates audit events', () => {
    const store = new ControlPlaneStore({ path: ':memory:' })
    const first = store.createOrganization({ slug: 'first-org', name: 'First' })
    const second = store.createOrganization({ slug: 'second-org', name: 'Second' })
    const project = store.createProject({ organizationId: first.id, slug: 'private', name: 'Private' })
    const actor = store.createActor({ kind: 'user', externalId: 'dashboard:member', displayName: 'Member' })
    expect(() => store.createMembership({ organizationId: second.id, actorId: actor.id, roleTemplate: 'viewer', scope: { type: 'project', id: project.id } })).toThrow('not found in this organization')

    store.createInvitation({ organizationId: first.id, email: 'first@acme.test', roleTemplate: 'viewer' })
    store.createInvitation({ organizationId: second.id, email: 'second@acme.test', roleTemplate: 'viewer' })
    expect(store.listEvents({ organizationId: first.id }).every(event => event.organizationId === first.id)).toBe(true)
    expect(store.listEvents({ organizationId: first.id }).map(event => event.payload)).not.toEqual(store.listEvents({ organizationId: second.id }).map(event => event.payload))
    store.close()
  })
})
