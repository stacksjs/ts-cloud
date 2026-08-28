/**
 * Whether a project may safely attach to a server another project owns.
 *
 * `cloud.attachTo` already works: the attaching project's deploy puts its sites
 * on the owner's box instead of provisioning one. What has never existed is the
 * check BEFORE that deploy.
 *
 * Every way an attach goes wrong is currently discovered while it is going
 * wrong. `validateDeploymentConfig` only ever sees one project's `sites`, so a
 * second attach passes it; the port guard that would catch the clash runs from
 * inside the deploy, after the operator has committed a config change and
 * started shipping. And the worst case does not error at all: ts-cloud's units
 * do not set exclusive binding, so two services on one port both bind and the
 * kernel load-balances between them. Both look healthy, nothing is logged, and
 * each domain serves the other project's site about half the time - which is
 * what happened to predicthq.org for a day and a half.
 *
 * The checks here are the same ones the deploy makes, moved to before anything
 * is written or shipped, and answered from the box's own registry rather than
 * from any project's config.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 * @see https://github.com/stacksjs/ts-cloud/issues/168
 * @see https://github.com/stacksjs/stacks/issues/2342
 */

import type { DeclaredSite, HostedRoute, InventoryServer } from './inventory'
import { occupiedHostPorts } from '../deploy/site-ports'

/** The server an attach would target, or why one could not be picked. */
export type AttachTarget =
  | { server: InventoryServer }
  | { problem: string }

/**
 * Pick the box named by the caller, by provider name or by owning project.
 *
 * Both spellings are accepted because both are what an operator has in front of
 * them: the provider console shows `stacks-production-app`, while `attachTo`
 * takes the owner's slug (`stacks`). Making them translate between the two is
 * how the wrong box gets named. An ambiguous match refuses rather than picking.
 */
export function resolveAttachTarget(
  servers: readonly InventoryServer[],
  wanted: string,
  environment?: string,
): AttachTarget {
  const target = wanted.trim()
  if (!target) return { problem: 'No server named.' }

  const [named, ...alsoNamed] = servers.filter(server => server.name === target)
  if (named && alsoNamed.length === 0) return { server: named }

  let byOwner = servers.filter(server => server.project === target)
  if (byOwner.length > 1 && environment) {
    byOwner = byOwner.filter(server => !server.environment || server.environment === environment)
  }

  const [owned, ...alsoOwned] = byOwner
  if (owned && alsoOwned.length === 0) return { server: owned }

  if (byOwner.length > 1) {
    return {
      problem: `'${target}' owns ${byOwner.length} servers (${byOwner.map(server => server.name).join(', ')}). `
        + 'Name one of them, or narrow it by environment.',
    }
  }

  return {
    problem: `No server matched '${target}'. Nothing is named that, and no box carries the label `
      + `ts-cloud/project=${target}.`,
  }
}

/**
 * Reasons an attach must not proceed at all, independent of what is on the box.
 *
 * Separate from conflicts because these are about identity rather than
 * occupancy: no amount of moving ports would make any of them safe.
 */
export function attachPreconditions(slug: string, server: InventoryServer): string[] {
  const problems: string[] = []

  if (!server.project) {
    problems.push(
      `'${server.name}' carries no ts-cloud/project label, so it is not a box ts-cloud provisioned. `
      + 'Attaching to it would deploy into a host nothing manages.',
    )
  }
  else if (server.project === slug) {
    // The deploy refuses this too, but only once it is already running: a
    // tenant's deploy owns its own `<slug>.json` gateway fragment, so sharing a
    // slug with the owner means overwriting the owner's fragment and taking its
    // sites down.
    problems.push(
      `This project's slug is '${slug}', which is also the slug that owns '${server.name}'. `
      + 'A tenant deploy owns the gateway fragment named after its slug, so attaching would '
      + `overwrite '${server.project}'s own fragment and take its sites down. Change this project's slug first.`,
    )
  }

  if (server.status !== 'running') {
    problems.push(`'${server.name}' is ${server.status}, so what it serves could not be read.`)
  }

  if (!server.ipv4) {
    problems.push(`'${server.name}' has no public IPv4 address, so it cannot be reached to check what it serves.`)
  }

  return problems
}

export interface AttachConflict {
  kind: 'port' | 'route'
  site: string
  detail: string
  /** The slug already holding it. */
  heldBy: string
}

function routeKey(host: string, path: string): string {
  const normalized = path === '/' ? '/' : path.replace(/\/+$/, '')
  return `${host.toLowerCase()}${normalized || '/'}`
}

/**
 * Where this project's sites would land on top of another project's.
 *
 * Two independent collisions, and the port one is the dangerous half: a route
 * clash produces a visibly wrong page, while a port clash produces a working
 * box that serves the wrong site to about half its visitors with nothing
 * logged as an error.
 *
 * Ports come from {@link occupiedHostPorts} rather than from the routes
 * directly, so the collision check and the port allocator can never disagree
 * about which ports are taken. Our own slug is ignored on both axes: a
 * re-attach finds its own fragment on the box from the last deploy, and
 * counting it would make every repeat run conflict with itself.
 */
export function attachConflicts(
  slug: string,
  declared: readonly DeclaredSite[],
  routes: readonly HostedRoute[],
): AttachConflict[] {
  const conflicts: AttachConflict[] = []

  const ports = occupiedHostPorts(
    routes
      .filter(route => route.kind === 'app')
      .map(route => ({ slug: route.slug, proxies: [{ from: route.target.split(',').map(upstream => upstream.trim()) }] })),
    { ignoreSlug: slug },
  )

  const taken = new Map<string, string>()
  for (const route of routes) {
    if (route.slug !== slug) taken.set(routeKey(route.host, route.path), route.slug)
  }

  for (const site of declared) {
    if (site.port !== undefined) {
      const holder = ports.get(site.port)
      if (holder) conflicts.push({ kind: 'port', site: site.name, detail: `port ${site.port}`, heldBy: holder })
    }

    if (site.domain) {
      const holder = taken.get(routeKey(site.domain, site.path))
      if (holder) {
        conflicts.push({
          kind: 'route',
          site: site.name,
          detail: `${site.domain}${site.path === '/' ? '/' : site.path}`,
          heldBy: holder,
        })
      }
    }
  }

  return conflicts
}

export interface AttachPlan {
  /** The attaching project. */
  slug: string
  /** The project that owns the box. */
  owner: string
  server: InventoryServer
  declared: readonly DeclaredSite[]
  conflicts: readonly AttachConflict[]
  /** Was the box's registry actually read? A check that saw nothing proves nothing. */
  registryRead: boolean
  /** Why the registry could not be read, when it could not. */
  registryProblem?: string
}

/** Is this attach safe to carry out? */
export function attachIsViable(plan: AttachPlan): boolean {
  return plan.registryRead && plan.conflicts.length === 0
}

/**
 * The attach as lines, ready to print.
 *
 * Deliberately does not describe the config edits an attach needs. Those live
 * in two different repositories - `attachTo` here, the tenant's slug in the
 * owner's `tenants` - so which of them a given caller can make is the caller's
 * business, and printing "these edits make it real" underneath a refusal reads
 * as though the operation is going ahead.
 */
export function formatAttachPlan(plan: AttachPlan): string[] {
  const { slug, owner, server, declared, conflicts } = plan
  const lines: string[] = []

  lines.push(`Attach '${slug}' to '${server.name}' (${server.ipv4 ?? 'no IPv4'}), owned by '${owner}'.`, '')

  lines.push(`  ${declared.length} site${declared.length === 1 ? '' : 's'} would deploy onto this box:`)
  for (const site of declared) {
    const where = site.loopbackOnly
      ? `loopback only${site.port ? ` on :${site.port}` : ''}`
      : `${site.domain}${site.path === '/' ? '/' : site.path}${site.port ? ` on :${site.port}` : ''}`
    lines.push(`    ${site.name}  ${where}  ->  ${site.installBase ?? '(install path unresolved)'}`)
  }
  lines.push('')

  if (!plan.registryRead) {
    // Saying "no conflicts" here would be a claim about a box nobody asked.
    lines.push(`  Could not read what '${server.name}' already serves: ${plan.registryProblem ?? 'unknown reason'}`)
    lines.push('  So this attach is UNCHECKED: a port or hostname already taken by another')
    lines.push('  project would not error, it would serve that project\'s site from your domain.')
  }
  else if (conflicts.length > 0) {
    lines.push(`  ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} with what the box already serves:`)
    for (const conflict of conflicts) {
      lines.push(`    site '${conflict.site}' wants ${conflict.detail}, held by '${conflict.heldBy}'`)
    }
    lines.push('')
    lines.push('  Two services on one port do not error: the kernel load-balances, and each')
    lines.push('  domain serves the other\'s site about half the time. Pick free ports and')
    lines.push('  hostnames, then re-run.')
  }
  else {
    lines.push(`  No conflicts with what '${server.name}' already serves.`)
  }

  return lines
}
