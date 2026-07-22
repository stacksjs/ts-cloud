import type {
  AuthorizationCapability,
  AuthorizationGrant,
  AuthorizationScope,
  AuthorizationTarget,
  OrganizationMembership,
  OrganizationRoleTemplate,
} from './types'

export const AUTHORIZATION_CAPABILITIES: readonly AuthorizationCapability[] = [
  'project:read',
  'config:read',
  'config:write',
  'deployments:read',
  'deployments:create',
  'deployments:cancel',
  'deployments:rollback',
  'runtime:read',
  'runtime:restart',
  'runtime:logs',
  'runtime:terminal',
  'data:read',
  'data:write',
  'data:admin',
  'backups:read',
  'backups:create',
  'backups:restore',
  'secrets:read',
  'secrets:write',
  'fleet:read',
  'fleet:manage',
  'users:read',
  'users:manage',
  'users:transfer-ownership',
  'audit:read',
  'automation:read',
  'automation:manage',
  'tags:manage',
]

const VIEWER_CAPABILITIES: readonly AuthorizationCapability[] = [
  'project:read',
  'config:read',
  'deployments:read',
  'runtime:read',
  'runtime:logs',
  'data:read',
  'backups:read',
]

const ROLE_CAPABILITIES: Record<OrganizationRoleTemplate, ReadonlySet<AuthorizationCapability>> = {
  owner: new Set(AUTHORIZATION_CAPABILITIES),
  admin: new Set(AUTHORIZATION_CAPABILITIES.filter(capability => capability !== 'users:transfer-ownership')),
  deployer: new Set([...VIEWER_CAPABILITIES, 'deployments:create', 'deployments:cancel', 'deployments:rollback']),
  operator: new Set([...VIEWER_CAPABILITIES, 'runtime:restart', 'backups:create']),
  viewer: new Set(VIEWER_CAPABILITIES),
  auditor: new Set(['project:read', 'config:read', 'deployments:read', 'runtime:read', 'data:read', 'backups:read', 'audit:read']),
}

export interface AuthorizationDecision {
  allowed: boolean
  reason: 'inactive-membership' | 'scope-mismatch' | 'explicit-deny' | 'explicit-allow' | 'role-template' | 'missing-capability'
  inheritedFrom?: { kind: 'membership' | 'grant', id: string, scope: AuthorizationScope }
}

export function roleCapabilities(role: OrganizationRoleTemplate): ReadonlySet<AuthorizationCapability> {
  return ROLE_CAPABILITIES[role]
}

export function scopeContains(scope: AuthorizationScope, target: AuthorizationTarget): boolean {
  if (scope.type === 'organization')
    return scope.id === undefined || scope.id === target.organizationId
  if (!scope.id)
    return false
  if (scope.type === 'project')
    return scope.id === target.projectId
  if (scope.type === 'environment')
    return scope.id === target.environmentId
  return scope.id === target.resourceId
}

export function authorizeOrganization(input: {
  membership: OrganizationMembership | undefined
  grants: readonly AuthorizationGrant[]
  capability: AuthorizationCapability
  target: AuthorizationTarget
}): AuthorizationDecision {
  const { membership, capability, target } = input
  if (!membership || membership.status !== 'active' || membership.organizationId !== target.organizationId)
    return { allowed: false, reason: 'inactive-membership' }

  const applicable = input.grants.filter(grant =>
    grant.organizationId === target.organizationId
    && grant.membershipId === membership.id
    && grant.capability === capability
    && scopeContains(grant.scope, target),
  )
  const denied = applicable.find(grant => grant.effect === 'deny')
  if (denied)
    return { allowed: false, reason: 'explicit-deny', inheritedFrom: { kind: 'grant', id: denied.id, scope: denied.scope } }

  const allowed = applicable.find(grant => grant.effect === 'allow')
  if (allowed)
    return { allowed: true, reason: 'explicit-allow', inheritedFrom: { kind: 'grant', id: allowed.id, scope: allowed.scope } }

  if (!scopeContains(membership.scope, target))
    return { allowed: false, reason: 'scope-mismatch' }

  if (roleCapabilities(membership.roleTemplate).has(capability)) {
    return {
      allowed: true,
      reason: 'role-template',
      inheritedFrom: { kind: 'membership', id: membership.id, scope: membership.scope },
    }
  }
  return { allowed: false, reason: 'missing-capability' }
}

export function effectiveCapabilities(input: {
  membership: OrganizationMembership | undefined
  grants: readonly AuthorizationGrant[]
  target: AuthorizationTarget
}): AuthorizationCapability[] {
  return AUTHORIZATION_CAPABILITIES.filter(capability => authorizeOrganization({ ...input, capability }).allowed)
}
