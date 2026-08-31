/**
 * What is hosted on which box, across every project sharing it.
 *
 * Consolidating servers starts with a question nothing could answer: what is
 * actually running on each one? A project's own config cannot answer it. It
 * describes ONE project's sites, and the boxes are multi-tenant - other
 * projects deploy onto them with `cloud.attachTo`, from their own repositories,
 * and appear in no file the first project owns. Reading config and calling it
 * an inventory reports a shared box as if one project were alone on it, which
 * is precisely the wrong answer to consolidate against.
 *
 * So the answer comes from the box. Each project's deploy writes an rpx
 * registry fragment into `HOST_SITES_DIR`, and those files together are the
 * only complete record of what the host serves and for whom. `site-ports`
 * already reads them to allocate ports around co-tenants; this module reads
 * the same files for the routes rather than the ports, so the two can never
 * disagree about what is on a box.
 *
 * Everything here is pure except {@link probeHostRoutes}, which takes its exec
 * as an argument - the same shape `site-move` uses, so an inventory can be
 * tested without a box, a provider, or a credential.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 * @see https://github.com/stacksjs/stacks/issues/2342
 */

import type { HostSiteFragment } from '../deploy/site-ports'
import { buildHostSitePortsScript, HOST_SITES_DIR, parseHostSiteFragments } from '../deploy/site-ports'

/** The ts-cloud labels every provisioned box carries. */
export const PROJECT_LABEL = 'ts-cloud/project'
export const ENVIRONMENT_LABEL = 'ts-cloud/environment'
export const ROLE_LABEL = 'ts-cloud/role'

/**
 * A server in the inventory, reduced to what deciding a consolidation needs.
 *
 * Structural and provider-agnostic on purpose: a Hetzner server satisfies it
 * after {@link toInventoryServer}, and another driver can satisfy it without
 * importing anything from here.
 */
export interface InventoryServer {
  id: string
  name: string
  status: string
  ipv4?: string
  ipv6?: string
  type?: string
  location?: string
  labels: Record<string, string>
  /** `ts-cloud/project`: the project that provisioned and owns this box. */
  project?: string
  /** `ts-cloud/environment`: production, staging, ... */
  environment?: string
  /** `ts-cloud/role`: app, services, lb. */
  role?: string
}

/** One route a box serves, and the project whose fragment declared it. */
export interface HostedRoute {
  slug: string
  host: string
  path: string
  /** Where the route goes: an upstream, a served directory, or a redirect target. */
  target: string
  kind: 'app' | 'static' | 'redirect' | 'unknown'
}

/** What a box answered when asked what it serves. */
export interface HostProbe {
  server: string
  ip?: string
  routes: HostedRoute[]
  /** Why the probe produced nothing, when it produced nothing. */
  unavailable?: string
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * One provider server record, as a listing returns it.
 *
 * Every field is optional and `unknown` because this is JSON from an external
 * API: `text()` is what turns each one into a string or nothing. The nested
 * fields are Hetzner's spelling; the flat ones beside them are the fallback a
 * driver with a simpler listing can answer with, which is what lets one type
 * cover more than one provider.
 */
export interface ProviderServerPayload {
  id?: unknown
  name?: unknown
  status?: unknown
  labels?: Record<string, unknown>
  public_net?: { ipv4?: { ip?: unknown } | null, ipv6?: { ip?: unknown } | null } | null
  server_type?: { name?: unknown } | null
  /**
   * Legacy shape. Hetzner has stopped returning this and sends an explicit
   * `null` in its place, which is why the null belongs in the type: it is what
   * a live listing contains today. See `location`.
   */
  datacenter?: { name?: unknown, location?: { name?: unknown } | null } | null
  ipv4?: unknown
  ipv6?: unknown
  type?: unknown
  /**
   * Current Hetzner shape is an object; a simpler driver may answer a bare
   * string. {@link placeName} reads both.
   */
  location?: unknown
}

/**
 * A place name that arrives either as `{ name }` or as a bare string.
 *
 * Hetzner's current listing nests it and its retired `datacenter` field did
 * too, so reading only the string form reported no location at all for every
 * live box. `resize.ts` and `role-swap.ts` already carry the same fallback.
 */
function placeName(value: unknown): string | undefined {
  if (typeof value === 'string')
    return text(value)
  if (value && typeof value === 'object')
    return text((value as { name?: unknown }).name)
  return undefined
}

/**
 * Shape one provider server record into {@link InventoryServer}.
 *
 * Written against the Hetzner payload, but touches only fields any provider
 * listing carries, so a driver with a different shape maps onto the same type
 * rather than forcing a second one.
 *
 * An unlabelled box is kept rather than dropped. A server provisioned by hand,
 * or by a ts-cloud old enough not to have labelled it, is exactly the kind a
 * consolidation needs to see; requiring the labels would hide it.
 */
export function toInventoryServer(raw: ProviderServerPayload | null | undefined): InventoryServer {
  const labels: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw?.labels ?? {})) {
    if (typeof value === 'string') labels[key] = value
  }

  return {
    id: String(raw?.id ?? ''),
    name: text(raw?.name) ?? '(unnamed)',
    status: text(raw?.status) ?? 'unknown',
    ipv4: text(raw?.public_net?.ipv4?.ip) ?? text(raw?.ipv4),
    ipv6: text(raw?.public_net?.ipv6?.ip) ?? text(raw?.ipv6),
    type: text(raw?.server_type?.name) ?? text(raw?.type),
    location: placeName(raw?.location) ?? placeName(raw?.datacenter?.location) ?? placeName(raw?.datacenter),
    labels,
    project: text(labels[PROJECT_LABEL]),
    environment: text(labels[ENVIRONMENT_LABEL]),
    role: text(labels[ROLE_LABEL]),
  }
}

/** The slug a fragment belongs to, matching the writer's `'app'` default. */
function fragmentSlug(fragment: HostSiteFragment): string {
  return fragment.slug?.trim() || 'app'
}

/**
 * Flatten registry fragments into one route list, sorted so two runs against an
 * unchanged box produce an identical listing.
 */
export function routesFromFragments(fragments: readonly HostSiteFragment[]): HostedRoute[] {
  const routes: HostedRoute[] = []

  for (const fragment of fragments) {
    const slug = fragmentSlug(fragment)

    for (const proxy of fragment.proxies ?? []) {
      const host = text(proxy?.to)
      if (!host) continue

      routes.push({ slug, host, path: text(proxy?.path) ?? '/', ...describeRouteTarget(proxy) })
    }
  }

  return routes.sort((a, b) =>
    a.slug.localeCompare(b.slug) || a.host.localeCompare(b.host) || a.path.localeCompare(b.path))
}

function describeRouteTarget(proxy: NonNullable<HostSiteFragment['proxies']>[number]): Pick<HostedRoute, 'target' | 'kind'> {
  const from = proxy?.from
  if (typeof from === 'string' && from.trim()) return { target: from.trim(), kind: 'app' }
  if (Array.isArray(from) && from.length > 0) {
    return { target: from.filter(upstream => typeof upstream === 'string').join(', '), kind: 'app' }
  }

  const served = proxy?.static
  if (typeof served === 'string' && served.trim()) return { target: served.trim(), kind: 'static' }
  if (served && typeof served === 'object' && text(served.dir)) return { target: text(served.dir)!, kind: 'static' }

  const redirect = typeof proxy?.redirect === 'string' ? text(proxy.redirect) : text(proxy?.redirect?.to)
  if (redirect) return { target: redirect, kind: 'redirect' }

  return { target: '(no upstream)', kind: 'unknown' }
}

/** Group routes by the project that owns them, biggest tenant first. */
export function tenantsOf(routes: readonly HostedRoute[]): Array<{ slug: string, routes: HostedRoute[] }> {
  const bySlug = new Map<string, HostedRoute[]>()
  for (const route of routes) {
    const bucket = bySlug.get(route.slug)
    if (bucket) bucket.push(route)
    else bySlug.set(route.slug, [route])
  }

  return [...bySlug.entries()]
    .map(([slug, grouped]) => ({ slug, routes: grouped }))
    .sort((a, b) => b.routes.length - a.routes.length || a.slug.localeCompare(b.slug))
}

/** Run a script on a host, resolving with its exit code and output. */
export type InventoryExec = (host: string, command: string) => Promise<{ code: number, stdout: string, stderr: string }>

/**
 * Ask one box what it serves.
 *
 * Never throws. A box that is off, unreachable, or refuses the key comes back
 * with an `unavailable` reason instead, so one bad server does not cost the
 * listing of every other one - and so a caller can tell "serves nothing" apart
 * from "was never asked", which are the two answers most worth not confusing.
 */
export async function probeHostRoutes(
  server: InventoryServer,
  exec: InventoryExec,
  sitesDir: string = HOST_SITES_DIR,
): Promise<HostProbe> {
  if (!server.ipv4) {
    return { server: server.name, routes: [], unavailable: 'no public IPv4 address to reach it on' }
  }

  if (server.status !== 'running') {
    return { server: server.name, ip: server.ipv4, routes: [], unavailable: `server is ${server.status}` }
  }

  try {
    const result = await exec(server.ipv4, buildHostSitePortsScript(sitesDir))
    if (result.code !== 0) {
      const reason = result.stderr.trim().split('\n')[0] || `remote command exited ${result.code}`
      return { server: server.name, ip: server.ipv4, routes: [], unavailable: reason }
    }

    return { server: server.name, ip: server.ipv4, routes: routesFromFragments(parseHostSiteFragments(result.stdout)) }
  }
  catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { server: server.name, ip: server.ipv4, routes: [], unavailable: reason }
  }
}

/** One site a project declares, in the terms the box reports. */
export interface DeclaredSite {
  name: string
  kind?: string
  domain?: string
  path: string
  port?: number
  /** `siteInstallBase(slug, name)`, when the caller resolved it. */
  installBase?: string
  /**
   * No `domain`, so the gateway never routes it and it cannot appear in a
   * registry fragment. That is a deliberate configuration - a loopback-only
   * service reached through another site's proxy - not a missing deploy.
   */
  loopbackOnly: boolean
}

/** Declared sites lined up against what one box actually serves. */
export interface Reconciliation {
  /** Declared and present on the box. */
  present: DeclaredSite[]
  /** Declared, routable, and absent from the box's registry. */
  absent: DeclaredSite[]
  /** Declared with no domain: no gateway route by design. */
  loopback: DeclaredSite[]
  /** Routes on the box owned by some other project. */
  foreign: HostedRoute[]
}

function routeKey(host: string, path: string): string {
  const normalized = path === '/' ? '/' : path.replace(/\/+$/, '')
  return `${host.toLowerCase()}${normalized || '/'}`
}

/**
 * Line a project's declared sites up against what a box serves.
 *
 * Matched on host and path rather than on the site key, because the site key is
 * local to a repository and the box has no idea what it is. Two projects both
 * calling a site `main` is ordinary; two projects serving the same host and
 * path is the collision worth seeing.
 */
export function reconcile(
  declared: readonly DeclaredSite[],
  routes: readonly HostedRoute[],
  slug: string,
): Reconciliation {
  const ours = new Set(routes.filter(route => route.slug === slug).map(route => routeKey(route.host, route.path)))

  const present: DeclaredSite[] = []
  const absent: DeclaredSite[] = []
  const loopback: DeclaredSite[] = []

  for (const site of declared) {
    if (site.loopbackOnly) loopback.push(site)
    else if (site.domain && ours.has(routeKey(site.domain, site.path))) present.push(site)
    else absent.push(site)
  }

  return { present, absent, loopback, foreign: routes.filter(route => route.slug !== slug) }
}

/**
 * Sites no probed box accounts for.
 *
 * Callers must pass only the probes that ANSWERED. A box that could not be read
 * proves nothing about what it holds, and counting it would report every site
 * on it as missing - a true statement about the listing and a false one about
 * the deployment.
 */
export function unaccountedSites(
  declared: readonly DeclaredSite[],
  answered: readonly HostProbe[],
  slug: string,
): DeclaredSite[] {
  const seen = new Set<string>()
  for (const probe of answered) {
    for (const route of probe.routes) {
      if (route.slug === slug) seen.add(routeKey(route.host, route.path))
    }
  }

  return declared.filter(site => !site.loopbackOnly && site.domain !== undefined && !seen.has(routeKey(site.domain, site.path)))
}

export interface Inventory {
  slug: string
  servers: InventoryServer[]
  probes: HostProbe[]
  declared: DeclaredSite[]
}

/**
 * The inventory as lines, ready to print.
 *
 * Lines rather than printed output, matching {@link import('./plan').formatPlan}:
 * the caller owns the stream, and the format stays testable. Every count is
 * stated so a partial answer reads as partial - a box that could not be read
 * says so on its own line, and the summary separates "not deployed" from "not
 * visible from here".
 */
export function formatInventory(inventory: Inventory): string[] {
  const { slug, servers, probes, declared } = inventory
  const lines: string[] = []

  lines.push(servers.length === 0
    ? 'No servers found.'
    : `${servers.length} server${servers.length === 1 ? '' : 's'}:`)
  if (servers.length > 0) lines.push('')

  const probesByServer = new Map(probes.map(probe => [probe.server, probe]))

  for (const server of servers) {
    const facts = [server.ipv4, server.type, server.location, server.status].filter(Boolean)
    lines.push(`  ${server.name}  ${facts.join('  ')}`)
    lines.push(`    ${describeOwnership(server)}`)

    const probe = probesByServer.get(server.name)
    if (!probe) {
      lines.push('    not probed, so co-tenants on this box are not listed')
    }
    else if (probe.unavailable) {
      lines.push(`    could not read ${HOST_SITES_DIR}: ${probe.unavailable}`)
    }
    else {
      lines.push(...describeTenants(probe, slug))
    }

    lines.push('')
  }

  lines.push(...describeDeclared(inventory))

  return lines
}

function describeOwnership(server: InventoryServer): string {
  if (!server.project) {
    return 'no ts-cloud labels: provisioned outside ts-cloud, or by a version that did not label boxes'
  }

  const detail = [server.environment, server.role && `role ${server.role}`].filter(Boolean).join(', ')
  return `owned by '${server.project}'${detail ? ` (${detail})` : ''}`
}

function describeTenants(probe: HostProbe, slug: string): string[] {
  const tenants = tenantsOf(probe.routes)
  if (tenants.length === 0) return [`    serves nothing: ${HOST_SITES_DIR} is empty or absent`]

  const lines = [
    `    serves ${probe.routes.length} route${probe.routes.length === 1 ? '' : 's'} `
    + `for ${tenants.length} project${tenants.length === 1 ? '' : 's'}:`,
  ]

  for (const tenant of tenants) {
    lines.push(`      ${tenant.slug}${tenant.slug === slug ? ' (this project)' : ''}`)
    for (const route of tenant.routes) {
      lines.push(`        ${route.host}${route.path === '/' ? '/' : route.path}  ->  ${describeTarget(route)}`)
    }
  }

  return lines
}

function describeTarget(route: HostedRoute): string {
  if (route.kind === 'redirect') return `redirect to ${route.target}`
  if (route.kind === 'static') return `static ${route.target}`
  return route.target
}

function describeDeclared(inventory: Inventory): string[] {
  const { slug, declared, probes, servers } = inventory
  if (declared.length === 0) return [`This project ('${slug}') declares no sites.`]

  const lines = [
    `This project ('${slug}') declares ${declared.length} site${declared.length === 1 ? '' : 's'}: `
    + declared.map(site => site.name).join(', '),
  ]

  const loopback = declared.filter(site => site.loopbackOnly)
  if (loopback.length > 0) {
    lines.push(
      `  ${loopback.length} with no domain, so the gateway never routes ${loopback.length === 1 ? 'it' : 'them'} `
      + `(reached through another site's proxy): ${loopback.map(site => site.name).join(', ')}`,
    )
  }

  // Reconciliation needs at least one box that actually answered. Without one,
  // every routable site is "not found", which is the shape of wrong answer this
  // module exists to stop producing.
  const answered = probes.filter(probe => !probe.unavailable)
  if (answered.length === 0) {
    lines.push('  Nothing to reconcile them against: no box reported what it serves.')
    return lines
  }

  const unaccounted = unaccountedSites(declared, answered, slug)
  lines.push(`  ${declared.length - loopback.length - unaccounted.length} routed by a box above`)

  if (unaccounted.length > 0) {
    // Two very different causes, and this listing cannot tell them apart, so it
    // must not pick one: an undeployed site and a site on a box that was not
    // read look identical from here.
    lines.push(`  ${unaccounted.length} not routed by any box above: ${unaccounted.map(site => site.name).join(', ')}`)

    const unread = probes.length - answered.length
    const unprobed = servers.length - probes.length
    if (unread > 0) {
      lines.push(`    Either they were never deployed, or they are on one of the ${unread} server${unread === 1 ? '' : 's'} that could not be read.`)
    }
    else if (unprobed > 0) {
      lines.push(`    Either they were never deployed, or they are on one of the ${unprobed} server${unprobed === 1 ? '' : 's'} this run did not probe.`)
    }
    else {
      lines.push('    Either they were never deployed, or they are on a server this listing did not cover.')
    }
  }

  return lines
}
