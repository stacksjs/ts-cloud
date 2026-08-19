import type { AuthorizationCapability, AuthorizationScope, ControlPlaneActor, ControlPlaneId, OrganizationMembership, OrganizationRoleTemplate } from '../control-plane'

export interface ServiceAccount {
  id: ControlPlaneId
  organizationId: ControlPlaneId
  actorId: ControlPlaneId
  slug: string
  name: string
  description?: string
  createdByActorId?: ControlPlaneId
  disabledAt?: string
  createdAt: string
  updatedAt: string
  state: 'active' | 'disabled'
}

export interface ApiToken {
  id: ControlPlaneId
  serviceAccountId: ControlPlaneId
  name: string
  prefix: string
  capabilities: AuthorizationCapability[]
  scope: AuthorizationScope
  expiresAt: string
  lastUsedAt?: string
  lastNetworkHint?: string
  revokedAt?: string
  rotatedFromTokenId?: string
  createdByActorId?: ControlPlaneId
  createdAt: string
  updatedAt: string
  state: 'active' | 'expired' | 'revoked'
}

export interface CreateServiceAccountInput {
  organizationId: ControlPlaneId
  slug: string
  name: string
  description?: string
  roleTemplate: Exclude<OrganizationRoleTemplate, 'owner'>
  scope?: AuthorizationScope
  createdByActorId?: ControlPlaneId
}

export interface CreateApiTokenInput {
  serviceAccountId: ControlPlaneId
  name: string
  capabilities: AuthorizationCapability[]
  scope?: AuthorizationScope
  expiresAt?: string
  createdByActorId?: ControlPlaneId
  rotatedFromTokenId?: ControlPlaneId
}

export interface ApiTokenPrincipal {
  serviceAccount: ServiceAccount
  token: ApiToken
  actor: ControlPlaneActor
  membership: OrganizationMembership
}

export interface ApiIdempotencyRecord {
  id: ControlPlaneId
  tokenId: ControlPlaneId
  key: string
  requestHash: string
  operationId?: ControlPlaneId
  responseStatus: number
  responseBody: unknown
  expiresAt: string
  createdAt: string
}
