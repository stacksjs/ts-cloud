/**
 * Narrow resolved dashboard data to what a user is allowed to see.
 *
 * This runs server-side, before serialization: a member is *sent* less, not
 * merely shown less. Hiding a panel in the UI would leave every other tenant's
 * deploy history and log lines one devtools tab away.
 *
 * Admins get the payload untouched. For a member we keep only their sites and
 * the observability derived from them, and drop the box-level surface
 * (host metrics, services, SSH keys, firewall, backups) outright — none of it
 * is theirs, and some of it (open ports, auth events) is a map of the box.
 */

import type { DashboardUser } from './dashboard-auth'
import { visibleSites } from './dashboard-auth'

/**
 * Log/unit sources belonging to a site: the app service plus its queue and
 * daemon units, as named by `serverLogSources` in `dashboard-data-server`.
 */
function siteLogSources(slug: string, site: string): string[] {
  return [`${slug}-${site}`, `${slug}-${site}-queues`, `${slug}-${site}-daemons`]
}

function isVisibleLogSource(source: string, slug: string, sites: string[]): boolean {
  return sites.some(site => siteLogSources(slug, site).includes(source))
}

export interface ScopeOptions {
  user: Pick<DashboardUser, 'role' | 'sites'>
  /** Project slug, used to match a site to its systemd units. */
  slug: string
}

/**
 * Return a copy of `data` containing only what `user` may see.
 */
export function scopeDashboardData(data: Record<string, any>, options: ScopeOptions): Record<string, any> {
  const { user, slug } = options

  if (user.role === 'admin')
    return data

  const allSites: string[] = (data.sites ?? []).map((s: any) => s.name).filter(Boolean)
  const allowed = visibleSites(user, allSites)
  const allowedSet = new Set(allowed)

  const sites = (data.sites ?? []).filter((s: any) => allowedSet.has(s.name))
  const sitesDetail = (data.sitesDetail ?? []).filter((s: any) => allowedSet.has(s.name))
  const domains = new Set(sitesDetail.map((s: any) => s.domain).filter(Boolean))

  const deployments = (data.serverDeploymentsDetail ?? data.serverDeployments ?? [])
    .filter((d: any) => allowedSet.has(d.site))

  const logs = (data.serverLogs ?? []).filter((log: any) => isVisibleLogSource(log.source, slug, allowed))

  // Keep only the certificates for domains they actually run. The rest of the
  // security panel (open ports, ufw rules, sshd auth events) describes the box.
  const tlsCertificates = (data.security?.tlsCertificates ?? []).filter((cert: any) => domains.has(cert.domain))

  const activity = (data.activity ?? []).filter((entry: any) => {
    if (entry.type === 'deploy')
      return allowed.some(site => String(entry.title ?? '').startsWith(`${site} `))
    if (entry.type === 'log')
      return isVisibleLogSource(String(entry.title ?? '').split(' ')[0], slug, allowed)
    // SSH key events are box-level.
    return false
  })

  return {
    // Identity of the view, not of the box.
    mode: data.mode,
    environment: data.environment,
    environments: data.environments,
    scoped: true,

    // Present but empty. The pages fall back to a sample server name when
    // `server` is absent, which would show a member a box that does not exist —
    // a fabricated name is worse than no name. An empty one renders as nothing,
    // and still discloses none of the box's identity (ip, provider, os, uptime).
    server: { name: '' },

    sites,
    sitesDetail,
    workers: (data.workers ?? []).filter((w: any) => allowedSet.has(w.site)),

    serverDeployments: deployments.slice(0, 5),
    serverDeploymentsDetail: deployments.slice(0, 50),
    deploymentsEmptyReason: deployments.length
      ? undefined
      : 'No deployments have been recorded for your sites yet.',

    serverLogs: logs,
    serverLogsEmptyReason: logs.length ? undefined : 'No recent log entries for your sites.',

    security: {
      tlsCertificates,
      // Explicitly empty rather than absent, so the UI renders a consistent
      // shape instead of guessing.
      ports: [],
      firewall: null,
      authEvents: [],
    },

    diagnostics: (data.diagnostics ?? []).filter((check: any) =>
      ['Route conflicts', 'TLS certificates'].includes(check.name)),

    activity,
  }
}

/** Narrow the sanitized cloud config the same way. */
export function scopeCloudConfig(config: Record<string, any>, user: Pick<DashboardUser, 'role' | 'sites'>): Record<string, any> {
  if (user.role === 'admin')
    return config

  const allowed = new Set(visibleSites(user, Object.keys(config.sites ?? {})))
  return {
    project: { name: config.project?.name },
    environment: config.environment,
    environments: config.environments,
    sites: Object.fromEntries(Object.entries(config.sites ?? {}).filter(([name]) => allowed.has(name))),
    // `compute` carries the provider, SSH key fingerprints and managed services
    // — the box's shape, which is not a member's business.
  }
}
