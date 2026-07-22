import type { ControlPlaneId, JsonValue } from '../control-plane/types'

export type AuthActionTokenType = 'activation' | 'password_reset' | 'email_verification'
export type AuthMethod = 'local' | 'oidc'

export interface AuthIdentity {
  id: ControlPlaneId
  actorId: ControlPlaneId
  username: string
  email?: string
  emailVerifiedAt?: string
  passwordHash: string
  credentialVersion: number
  requiresPasswordUpgrade: boolean
  disabledAt?: string
  lastLoginAt?: string
  createdAt: string
  updatedAt: string
}

export interface AuthActionToken {
  id: ControlPlaneId
  identityId: ControlPlaneId
  type: AuthActionTokenType
  metadata: JsonValue
  expiresAt: string
  consumedAt?: string
  createdAt: string
  state: 'pending' | 'consumed' | 'expired'
}

export interface AuthSession {
  id: ControlPlaneId
  identityId: ControlPlaneId
  credentialVersion: number
  authMethod: AuthMethod
  userAgent?: string
  networkHint?: string
  createdAt: string
  lastUsedAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  recentAuthAt: string
  mfaAt?: string
  revokedAt?: string
  state: 'active' | 'revoked' | 'expired'
}

export interface CreateAuthIdentityInput {
  id?: ControlPlaneId
  actorId: ControlPlaneId
  username: string
  email?: string
  emailVerified?: boolean
  passwordHash: string
  requiresPasswordUpgrade?: boolean
}

export interface CreateAuthSessionInput {
  identityId: ControlPlaneId
  authMethod?: AuthMethod
  userAgent?: string
  networkHint?: string
  idleTtlMs?: number
  absoluteTtlMs?: number
  recentAuthAt?: string
  mfaAt?: string
}

export interface AuthenticationStoreOptions {
  now?: () => Date
  id?: () => string
  /** Secret used to encrypt MFA seeds at rest. MFA methods require it. */
  encryptionKey?: string
}

export interface AuthMfaFactor {
  id: ControlPlaneId
  identityId: ControlPlaneId
  type: 'totp'
  label: string
  createdAt: string
  verifiedAt?: string
  disabledAt?: string
  state: 'pending' | 'active' | 'disabled'
}

export interface AuthMfaChallenge {
  id: ControlPlaneId
  identityId: ControlPlaneId
  purpose: 'login' | 'step_up'
  attempts: number
  expiresAt: string
  consumedAt?: string
  createdAt: string
  state: 'pending' | 'consumed' | 'expired' | 'locked'
}
