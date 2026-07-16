/**
 * The request-time gate: resolve who is calling, then decide whether the
 * {@link routePolicy} for their request permits it.
 *
 * Every dashboard request passes through here before reaching a handler, so
 * this file and {@link import('./dashboard-policy')} together are the complete
 * authorization story for the HTTP API.
 */

import type { DashboardUser } from './dashboard-auth'
import { authorize } from './dashboard-auth'
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
  /** Whether `user` may perform `req`. `site` is required for site-scoped routes. */
  check: (req: Request, pathname: string, user: DashboardUser | null, site?: string) => GuardDecision
}

export function createDashboardGuard(options: GuardOptions): DashboardGuard {
  const { cwd, enabled, secret } = options

  return {
    enabled,

    resolveUser(req: Request): DashboardUser | null {
      if (!enabled)
        return LOCAL_ADMIN

      const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE)
      const payload = verifySessionToken(token, secret)
      if (!payload)
        return null

      // Re-read the user on every request rather than trusting the token's
      // claims: revoking a grant or deleting a user then takes effect at once,
      // instead of lingering until the session expires.
      return findUser(loadUsers(cwd), payload.u) ?? null
    },

    check(req: Request, pathname: string, user: DashboardUser | null, site?: string): GuardDecision {
      if (!enabled)
        return { ok: true }

      if (!user)
        return { ok: false, status: 401, error: 'Sign in to continue.', unauthenticated: true }

      const policy = routePolicy(req.method, pathname)
      if (policy.anyUser)
        return { ok: true }

      if (policy.siteFrom === 'body' && !site) {
        return { ok: false, status: 400, error: 'This request must name a site.' }
      }

      if (!authorize({ user, capability: policy.capability, site })) {
        // Say the same thing whether the site exists or the grant is missing, so
        // a member can't probe for other tenants' site names.
        return { ok: false, status: 403, error: 'You do not have access to this.' }
      }

      return { ok: true }
    },
  }
}

/**
 * Read the site name a site-scoped route acts on, without consuming the body
 * the handler will read (the request is cloned).
 */
export async function siteFromRequest(req: Request, pathname: string): Promise<string | undefined> {
  const policy = routePolicy(req.method, pathname)
  if (policy.siteFrom !== 'body')
    return undefined
  try {
    const body = await req.clone().json() as Record<string, any>
    const name = String(body?.name ?? '').trim()
    return name || undefined
  }
  catch {
    return undefined
  }
}
