/**
 * The dashboard's route → capability table.
 *
 * This is the whole authorization surface of the HTTP API in one readable
 * place, so it can be reviewed without tracing handlers. {@link routePolicy}
 * maps a method and path to the {@link Capability} it needs.
 *
 * **Fails closed.** A route with no entry resolves to `box:shell` — the most
 * privileged capability, admin-only. Adding a route and forgetting to give it a
 * policy therefore locks members out rather than quietly exposing the route.
 *
 * Site-scoped routes take their site from the request body, so their entry sets
 * `siteFrom: 'body'` and the caller supplies the parsed name.
 */

import type { AuthorizationCapability } from '../control-plane'

export interface RoutePolicy {
  capability: AuthorizationCapability
  /** Resource ancestry used when evaluating the capability. Defaults to project. */
  scope?: 'organization' | 'project' | 'site'
  /** Where the site name comes from, for `site:*` capabilities. */
  siteFrom?: 'body'
  /** Any authenticated user may call it, regardless of role. */
  anyUser?: boolean
}

/** Sentinel for unlisted routes: the most privileged capability. */
const FAIL_CLOSED: RoutePolicy = { capability: 'runtime:terminal', scope: 'organization' }

/**
 * Routes reachable with no session at all. These necessarily run before there
 * is a user to authorize, so they are listed here explicitly — the set is
 * deliberately tiny and should stay that way.
 *
 * `/login` (the page) is served by the same public path.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /auth/oidc/:provider/callback',
  'GET /auth/oidc/:provider/start',
  'POST /api/login',
  'POST /api/logout',
  'POST /api/invitations/accept',
  'POST /api/auth/password-reset/request',
  'POST /api/auth/password-reset/complete',
  'POST /api/auth/mfa/complete',
])

export function isPublicRoute(method: string, pathname: string): boolean {
  if (method.toUpperCase() === 'GET' && /^\/auth\/oidc\/[a-z0-9-]+\/(?:start|callback)$/.test(pathname))
    return true
  return PUBLIC_ROUTES.has(`${method.toUpperCase()} ${pathname}`)
}

const POLICIES: Record<string, RoutePolicy> = {
  // --- Any authenticated user -------------------------------------------
  // Health carries no tenant data. Dashboard data and config are scoped to the
  // caller's sites by the handler before they are serialized.
  'GET /api/health': { capability: 'project:read', anyUser: true },
  'GET /api/dashboard-data': { capability: 'project:read', anyUser: true },
  'GET /api/config': { capability: 'config:read', anyUser: true },
  'GET /api/me': { capability: 'project:read', anyUser: true },
  'GET /api/search': { capability: 'project:read', anyUser: true },
  'GET /api/search/preferences': { capability: 'project:read', anyUser: true },
  'POST /api/search/preferences': { capability: 'project:read', anyUser: true },
  'DELETE /api/search/preferences': { capability: 'project:read', anyUser: true },
  'GET /api/auth/security': { capability: 'project:read', anyUser: true },
  'GET /api/auth/sessions': { capability: 'project:read', anyUser: true },
  'DELETE /api/auth/sessions': { capability: 'project:read', anyUser: true },
  'POST /api/auth/sessions/revoke-others': { capability: 'project:read', anyUser: true },
  'POST /api/auth/password/change': { capability: 'project:read', anyUser: true },
  'POST /api/auth/mfa/enroll': { capability: 'project:read', anyUser: true },
  'POST /api/auth/mfa/verify': { capability: 'project:read', anyUser: true },
  'DELETE /api/auth/mfa': { capability: 'project:read', anyUser: true },
  'POST /api/auth/step-up': { capability: 'project:read', anyUser: true },

  'GET /api/auth/oidc/providers': { capability: 'users:read', scope: 'organization' },
  'POST /api/auth/oidc/providers': { capability: 'users:manage', scope: 'organization' },
  'PATCH /api/auth/oidc/providers': { capability: 'users:manage', scope: 'organization' },

  'GET /api/organization': { capability: 'users:read', scope: 'organization' },
  'GET /api/organization/invitations': { capability: 'users:read', scope: 'organization' },
  'POST /api/organization/invitations': { capability: 'users:manage', scope: 'organization' },
  'DELETE /api/organization/invitations': { capability: 'users:manage', scope: 'organization' },
  'POST /api/organization/invitations/resend': { capability: 'users:manage', scope: 'organization' },
  'PATCH /api/organization/memberships': { capability: 'users:manage', scope: 'organization' },
  'DELETE /api/organization/memberships': { capability: 'users:manage', scope: 'organization' },
  'POST /api/organization/grants': { capability: 'users:manage', scope: 'organization' },
  'DELETE /api/organization/grants': { capability: 'users:manage', scope: 'organization' },

  'GET /api/control-plane/operations': { capability: 'deployments:read' },
  'GET /api/control-plane/events': { capability: 'audit:read' },
  'GET /api/tags': { capability: 'project:read' },
  'POST /api/tags': { capability: 'tags:manage' },
  'DELETE /api/tags': { capability: 'tags:manage' },

  // --- Site-scoped: a member may reach their own sites -------------------
  'POST /api/sites/deploy': { capability: 'deployments:create', scope: 'site', siteFrom: 'body' },
  'PATCH /api/sites': { capability: 'config:write', scope: 'site', siteFrom: 'body' },

  // --- Box-level: admin only --------------------------------------------
  // Creating or destroying a site changes the box's routing table, so it stays
  // with the box owner even though it names a site.
  'POST /api/sites': { capability: 'config:write' },
  'DELETE /api/sites': { capability: 'config:write' },

  'POST /api/env': { capability: 'config:write' },

  'GET /api/ssh-keys': { capability: 'fleet:read' },
  'POST /api/ssh-keys': { capability: 'fleet:manage' },
  'DELETE /api/ssh-keys': { capability: 'fleet:manage' },

  'GET /api/firewall': { capability: 'fleet:read' },
  'POST /api/firewall': { capability: 'fleet:manage' },
  'DELETE /api/firewall': { capability: 'fleet:manage' },

  'GET /api/databases': { capability: 'data:read' },
  'POST /api/databases': { capability: 'data:admin' },
  'GET /api/databases/backups': { capability: 'backups:read' },
  'POST /api/databases/backup': { capability: 'backups:create' },
  'POST /api/databases/users': { capability: 'data:admin' },

  // Actions and server operations shell out on the box as root.
  'GET /api/actions': { capability: 'runtime:read' },
  'POST /api/actions/run': { capability: 'fleet:manage' },
  'GET /api/server/operations': { capability: 'fleet:read' },
  'POST /api/server/operations/run': { capability: 'fleet:manage' },
  'POST /api/server/command': { capability: 'runtime:terminal', scope: 'organization' },
  'GET /api/terminal': { capability: 'runtime:terminal', scope: 'organization' },

  // User management is box-level: granting a site is the box owner's call.
  'GET /api/users': { capability: 'users:read', scope: 'organization' },
  'POST /api/users': { capability: 'users:manage', scope: 'organization' },
  'DELETE /api/users': { capability: 'users:manage', scope: 'organization' },

  // The serverless surface is account-wide, not per-site.
  'GET /api/serverless/operations': { capability: 'deployments:read' },
  'POST /api/serverless/operations/run': { capability: 'deployments:create' },
  'POST /api/serverless/command': { capability: 'runtime:terminal', scope: 'organization' },
  'GET /api/serverless/dlq': { capability: 'data:read' },
  'POST /api/serverless/dlq/redrive': { capability: 'data:write' },
  'POST /api/serverless/dlq/purge': { capability: 'data:admin' },
  'GET /api/serverless/secrets': { capability: 'secrets:read' },
  'POST /api/serverless/secrets': { capability: 'secrets:write' },
  'DELETE /api/serverless/secrets': { capability: 'secrets:write' },
  'POST /api/serverless/functions/config': { capability: 'config:write' },
  'GET /api/serverless/alarms': { capability: 'runtime:read' },
  'POST /api/serverless/alarms': { capability: 'config:write' },
  'DELETE /api/serverless/alarms': { capability: 'config:write' },
  'GET /api/serverless/traces': { capability: 'runtime:read' },
  'POST /api/serverless/scheduler': { capability: 'automation:manage' },
}

/**
 * The policy for a request. Unlisted API routes fail closed to admin-only.
 */
export function routePolicy(method: string, pathname: string): RoutePolicy {
  return POLICIES[`${method.toUpperCase()} ${pathname}`] ?? FAIL_CLOSED
}

/** Every policy entry, for tests and documentation. */
export function allRoutePolicies(): Record<string, RoutePolicy> {
  return { ...POLICIES }
}
