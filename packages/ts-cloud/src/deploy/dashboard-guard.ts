/**
 * The request-time gate: resolve who is calling, then decide whether the
 * {@link routePolicy} for their request permits it.
 *
 * Every dashboard request passes through here before reaching a handler, so
 * this file and {@link import('./dashboard-policy')} together are the complete
 * authorization story for the HTTP API.
 */
import type { AuthenticationStore, AuthSession } from '../auth'
import type { ControlPlaneStore } from '../control-plane'
import type { DashboardUser } from './dashboard-auth'
import { authorizeOrganization } from '../control-plane'
import { routePolicy } from './dashboard-policy'
import { readCookie, SESSION_COOKIE, verifySessionToken } from './dashboard-session'
import { findUser, loadUsers } from './dashboard-users'

/**
 * A synthetic admin used only when auth is explicitly disabled for local
 * development. It is never persisted and never has a password.
 */
export const LOCAL_ADMIN: DashboardUser = {
  username: 'local',
  passwordHash: '',
  role: 'admin',
  sites: {},
  name: 'Local (auth disabled)',
}

export interface GuardOptions {
  cwd: string
  /** When false, every request is treated as {@link LOCAL_ADMIN}. */
  enabled: boolean
  secret: string
  authentication?: AuthenticationStore
  authorization: {
    store: ControlPlaneStore
    organizationId: string
    projectId: string
    defaultEnvironment: string
  }
}

export interface GuardDecision {
  ok: boolean
  status?: number
  error?: string
  /** True when the caller has no valid session at all (vs. lacking a grant). */
  unauthenticated?: boolean
}

export interface DashboardGuard {
  enabled: boolean
  /** The user for this request, or null when unauthenticated. */
  resolveUser: (req: Request) => DashboardUser | null
  /** Durable v2 session metadata, when this request did not use a legacy cookie. */
  resolveSession: (req: Request) => AuthSession | null
  /** Whether `user` may perform `req`. `site` is required for site-scoped routes. */
  check: (req: Request, pathname: string, user: DashboardUser | null, site?: string) => GuardDecision
}

export function createDashboardGuard(options: GuardOptions): DashboardGuard {
  const { cwd, enabled, secret, authorization, authentication } = options

  const durableSession = (req: Request) => {
    if (!authentication) return undefined
    const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE)
    return token?.startsWith('v2.') ? authentication.verifySessionToken(token) : undefined
  }

  const identity = (user: DashboardUser) => {
    const actor = authorization.store.getActorByExternalId('user', `dashboard:${user.username.toLowerCase()}`)
    const membership = actor
      ? authorization.store.getMembershipForActor(authorization.organizationId, actor.id)
      : undefined
    return { actor, membership }
  }

  return {
    enabled,

    resolveUser(req: Request): DashboardUser | null {
      if (!enabled) return LOCAL_ADMIN

      const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE)
      const durable = durableSession(req)
      const payload = durable ? undefined : verifySessionToken(token, secret)
      const username = durable?.identity.username ?? payload?.u
      if (!username) return null

      // Re-read the user and membership on every request rather than trusting the token's
      // claims: revoking a grant or deleting a user then takes effect at once,
      // instead of lingering until the session expires.
      const user = findUser(loadUsers(cwd), username)
      if (!user) return null
      const { membership } = identity(user)
      if (
        !membership ||
        membership.status !== 'active' ||
        (!durable && payload?.mv?.[authorization.organizationId] !== membership.sessionVersion)
      )
        return null
      if (!membership.lastActiveAt || Date.now() - new Date(membership.lastActiveAt).getTime() > 5 * 60 * 1000)
        authorization.store.touchMembership(membership.id)
      return user
    },

    resolveSession(req: Request): AuthSession | null {
      return durableSession(req)?.session ?? null
    },

    check(req: Request, pathname: string, user: DashboardUser | null, site?: string): GuardDecision {
      if (!enabled) return { ok: true }

      if (!user) return { ok: false, status: 401, error: 'Sign in to continue.', unauthenticated: true }

      const policy = routePolicy(req.method, pathname)
      if (policy.anyUser) return { ok: true }

      if (policy.siteFrom === 'body' && !site) {
        return { ok: false, status: 400, error: 'This request must name a site.' }
      }

      const { membership } = identity(user)
      if (!membership) return { ok: false, status: 401, error: 'Sign in to continue.', unauthenticated: true }

      let target =
        policy.scope === 'organization'
          ? { organizationId: authorization.organizationId }
          : authorization.store.resolveAuthorizationTarget(authorization.organizationId, {
              type: 'project',
              id: authorization.projectId,
            })
      if (policy.scope === 'site') {
        const environmentSlug = new URL(req.url).searchParams.get('env') ?? authorization.defaultEnvironment
        const environment = authorization.store.getEnvironmentBySlug(authorization.projectId, environmentSlug)
        const resource = authorization.store
          .listResources(authorization.projectId, environment?.id)
          .find((candidate) => candidate.kind === 'application' && candidate.slug === site)
        target = resource
          ? authorization.store.resolveAuthorizationTarget(authorization.organizationId, {
              type: 'resource',
              id: resource.id,
            })
          : undefined
      }

      const decision = target
        ? authorizeOrganization({
            membership,
            grants: authorization.store.listGrants(membership.id),
            capability: policy.capability,
            target,
          })
        : { allowed: false }
      if (!decision.allowed) {
        // Say the same thing whether the site exists or the grant is missing, so
        // a member can't probe for other tenants' site names.
        return { ok: false, status: 403, error: 'You do not have access to this.' }
      }

      return { ok: true }
    },
  }
}

export function dashboardMembershipVersions(
  store: ControlPlaneStore,
  organizationId: string,
  user: DashboardUser,
): Record<string, number> {
  const actor = store.getActorByExternalId('user', `dashboard:${user.username.toLowerCase()}`)
  const membership = actor ? store.getMembershipForActor(organizationId, actor.id) : undefined
  return membership?.status === 'active' ? { [organizationId]: membership.sessionVersion } : {}
}

/**
 * Read the site name a site-scoped route acts on, without consuming the body
 * the handler will read (the request is cloned).
 */
export async function siteFromRequest(req: Request, pathname: string): Promise<string | undefined> {
  const policy = routePolicy(req.method, pathname)
  if (policy.siteFrom !== 'body') return undefined
  try {
    const body = (await req.clone().json()) as Record<string, any>
    const name = String(body?.name ?? '').trim()
    return name || undefined
  } catch {
    return undefined
  }
}
