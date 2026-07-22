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

import type { Capability } from './dashboard-auth'

export interface RoutePolicy {
  capability: Capability
  /** Where the site name comes from, for `site:*` capabilities. */
  siteFrom?: 'body'
  /** Any authenticated user may call it, regardless of role. */
  anyUser?: boolean
}

/** Sentinel for unlisted routes: the most privileged capability. */
const FAIL_CLOSED: RoutePolicy = { capability: 'box:shell' }

/**
 * Routes reachable with no session at all. These necessarily run before there
 * is a user to authorize, so they are listed here explicitly — the set is
 * deliberately tiny and should stay that way.
 *
 * `/login` (the page) is served by the same public path.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/login',
  'POST /api/logout',
])

export function isPublicRoute(method: string, pathname: string): boolean {
  return PUBLIC_ROUTES.has(`${method.toUpperCase()} ${pathname}`)
}

const POLICIES: Record<string, RoutePolicy> = {
  // --- Any authenticated user -------------------------------------------
  // Health carries no tenant data. Dashboard data and config are scoped to the
  // caller's sites by the handler before they are serialized.
  'GET /api/health': { capability: 'site:read', anyUser: true },
  'GET /api/dashboard-data': { capability: 'site:read', anyUser: true },
  'GET /api/config': { capability: 'site:read', anyUser: true },
  'GET /api/me': { capability: 'site:read', anyUser: true },
  'GET /api/search': { capability: 'site:read', anyUser: true },
  'GET /api/search/preferences': { capability: 'site:read', anyUser: true },
  'POST /api/search/preferences': { capability: 'site:read', anyUser: true },
  'DELETE /api/search/preferences': { capability: 'site:read', anyUser: true },

  'GET /api/control-plane/operations': { capability: 'box:read' },
  'GET /api/control-plane/events': { capability: 'box:read' },
  'GET /api/tags': { capability: 'box:read' },
  'POST /api/tags': { capability: 'box:config' },
  'DELETE /api/tags': { capability: 'box:config' },

  // --- Site-scoped: a member may reach their own sites -------------------
  'POST /api/sites/deploy': { capability: 'site:deploy', siteFrom: 'body' },
  'PATCH /api/sites': { capability: 'site:settings', siteFrom: 'body' },

  // --- Box-level: admin only --------------------------------------------
  // Creating or destroying a site changes the box's routing table, so it stays
  // with the box owner even though it names a site.
  'POST /api/sites': { capability: 'box:sites:create' },
  'DELETE /api/sites': { capability: 'box:sites:delete' },

  'POST /api/env': { capability: 'box:config' },

  'GET /api/ssh-keys': { capability: 'box:ssh' },
  'POST /api/ssh-keys': { capability: 'box:ssh' },
  'DELETE /api/ssh-keys': { capability: 'box:ssh' },

  'GET /api/firewall': { capability: 'box:firewall' },
  'POST /api/firewall': { capability: 'box:firewall' },
  'DELETE /api/firewall': { capability: 'box:firewall' },

  'GET /api/databases': { capability: 'box:database' },
  'POST /api/databases': { capability: 'box:database' },
  'GET /api/databases/backups': { capability: 'box:database' },
  'POST /api/databases/backup': { capability: 'box:database' },
  'POST /api/databases/users': { capability: 'box:database' },

  // Actions and server operations shell out on the box as root.
  'GET /api/actions': { capability: 'box:read' },
  'POST /api/actions/run': { capability: 'box:shell' },
  'GET /api/server/operations': { capability: 'box:read' },
  'POST /api/server/operations/run': { capability: 'box:shell' },
  'POST /api/server/command': { capability: 'box:shell' },
  'GET /api/terminal': { capability: 'box:shell' },

  // User management is box-level: granting a site is the box owner's call.
  'GET /api/users': { capability: 'box:users' },
  'POST /api/users': { capability: 'box:users' },
  'DELETE /api/users': { capability: 'box:users' },

  // The serverless surface is account-wide, not per-site.
  'GET /api/serverless/operations': { capability: 'box:serverless' },
  'POST /api/serverless/operations/run': { capability: 'box:serverless' },
  'POST /api/serverless/command': { capability: 'box:serverless' },
  'GET /api/serverless/dlq': { capability: 'box:serverless' },
  'POST /api/serverless/dlq/redrive': { capability: 'box:serverless' },
  'POST /api/serverless/dlq/purge': { capability: 'box:serverless' },
  'GET /api/serverless/secrets': { capability: 'box:serverless' },
  'POST /api/serverless/secrets': { capability: 'box:serverless' },
  'DELETE /api/serverless/secrets': { capability: 'box:serverless' },
  'POST /api/serverless/functions/config': { capability: 'box:serverless' },
  'GET /api/serverless/alarms': { capability: 'box:serverless' },
  'POST /api/serverless/alarms': { capability: 'box:serverless' },
  'DELETE /api/serverless/alarms': { capability: 'box:serverless' },
  'GET /api/serverless/traces': { capability: 'box:serverless' },
  'POST /api/serverless/scheduler': { capability: 'box:serverless' },
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
