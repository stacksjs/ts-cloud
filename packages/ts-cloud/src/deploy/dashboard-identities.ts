import type { AuthIdentity, AuthenticationStore, VerifiedOidcIdentity } from '../auth'
import type { DashboardControlPlane } from './dashboard-control-plane'
import type { DashboardUser } from './dashboard-auth'
import { createHash } from 'node:crypto'
import { ensureDashboardActor } from './dashboard-control-plane'
import { findUser, loadUsers, upsertMember } from './dashboard-users'

/**
 * Non-breaking bridge from the original local user file into durable auth.
 * The control-plane identity becomes authoritative after the first migration;
 * memberships remain a separate authorization concern.
 */
export function synchronizeDashboardIdentities(
  authentication: AuthenticationStore,
  controlPlane: DashboardControlPlane,
  users: DashboardUser[],
): void {
  for (const user of users) {
    const actor = ensureDashboardActor(controlPlane.store, user)
    if (authentication.getIdentityByActor(actor.id))
      continue
    authentication.createIdentity({
      actorId: actor.id,
      username: user.username,
      email: user.email,
      emailVerified: !!user.email,
      passwordHash: user.passwordHash,
      requiresPasswordUpgrade: true,
    })
  }
}

function availableOidcUsername(authentication: AuthenticationStore, users: DashboardUser[], email: string): string {
  const localPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 24)
  const base = /^[a-z0-9][a-z0-9._-]{1,31}$/.test(localPart) ? localPart : 'sso-user'
  if (!authentication.getIdentityByUsername(base) && !findUser(users, base))
    return base
  const suffix = createHash('sha256').update(email).digest('hex').slice(0, 7)
  return `${base.slice(0, 24)}-${suffix}`
}

export function resolveOidcDashboardIdentity(
  authentication: AuthenticationStore,
  controlPlane: DashboardControlPlane,
  cwd: string,
  verified: VerifiedOidcIdentity,
): { identity: AuthIdentity, user: DashboardUser, provisioned: boolean } {
  if (verified.provider.organizationId !== controlPlane.organization.id)
    throw new Error('OIDC provider is not configured for this organization')

  const linked = authentication.getOidcSubject(verified.provider.id, verified.subject)
  let identity = linked ? authentication.getIdentity(linked.identityId) : authentication.getIdentityByEmail(verified.email)
  if (identity?.disabledAt)
    throw new Error('OIDC identity is disabled')
  if (!linked && identity && !identity.emailVerifiedAt)
    throw new Error('OIDC cannot automatically link an unverified local email address')

  const users = loadUsers(cwd)
  let provisioned = false
  let user = identity ? findUser(users, identity.username) : undefined
  if (identity && !user)
    throw new Error('OIDC identity has no dashboard user')

  if (!identity) {
    const username = availableOidcUsername(authentication, users, verified.email)
    const created = upsertMember(cwd, {
      username,
      name: verified.name,
      email: verified.email,
      sites: {},
    })
    user = created.user
    const actor = ensureDashboardActor(controlPlane.store, user)
    identity = authentication.createIdentity({
      actorId: actor.id,
      username: user.username,
      email: verified.email,
      emailVerified: true,
      passwordHash: user.passwordHash,
    })
    provisioned = true
  }
  else if (identity.email !== verified.email) {
    identity = authentication.setVerifiedEmail(identity.id, verified.email)
  }

  const actor = controlPlane.store.getActor(identity.actorId)
  if (!actor)
    throw new Error('OIDC identity actor was not found')
  const membership = controlPlane.store.getMembershipForActor(controlPlane.organization.id, actor.id)
  if (membership?.status === 'revoked')
    throw new Error('OIDC organization membership is revoked')
  if (!membership) {
    controlPlane.store.createMembership({
      organizationId: controlPlane.organization.id,
      actorId: actor.id,
      roleTemplate: verified.provider.defaultRole,
      scope: { type: 'organization' },
      source: 'manual',
    })
  }
  authentication.linkOidcSubject(verified.provider.id, identity.id, verified.subject, verified.email)
  return { identity, user: user!, provisioned }
}

export function localLoginRequiresSso(
  authentication: AuthenticationStore,
  controlPlane: DashboardControlPlane,
  identity: AuthIdentity,
): boolean {
  const membership = controlPlane.store.getMembershipForActor(controlPlane.organization.id, identity.actorId)
  if (!membership || membership.status !== 'active' || membership.roleTemplate === 'owner' || !identity.emailVerifiedAt || !identity.email)
    return false
  const domain = identity.email.split('@')[1]?.toLowerCase()
  return authentication.listOidcProviders(controlPlane.organization.id)
    .some(provider => provider.enforceSso && !!domain && provider.allowedDomains.includes(domain))
}
