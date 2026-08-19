import type { CloudConfig } from '@ts-cloud/core'
import { resolveSiteKind } from './site-target'

/**
 * Port ownership across the projects sharing one box.
 *
 * A box can host several independent projects: each one's deploy writes its own
 * rpx registry fragment and the assembler merges them (see `RPX_SITES_DIR`).
 * That composes cleanly for ROUTES, because routes are keyed by host. It does
 * not compose for PORTS, because every app generated from the same template
 * declares the same loopback ports, and `validateDeploymentConfig` only ever
 * sees one project's `sites`.
 *
 * The second attach therefore passes validation, and then does something worse
 * than failing: ts-cloud's units do not set exclusive binding, so both listeners
 * bind and the kernel load-balances between them. Nothing errors, both services
 * look healthy, and each domain answers with the other project's site for about
 * half its requests. That is not hypothetical - it is what happened to
 * predicthq.org when a storefront picked a port by reading other projects'
 * config files rather than the box (see `assertPortsAreFree` in stacks).
 *
 * `assertPortsAreFree` catches this late, from the deploying box over SSH, by
 * comparing wanted ports against live listeners. That is the better evidence and
 * it stays the last line of defence. What it cannot do is avoid the clash: it
 * exits and tells the operator to go pick free ports by hand. This module is the
 * other half - deciding the ports before anything is shipped, from data a plan
 * already has.
 *
 * The fix does not need new bookkeeping on the box. The fragments already record
 * every upstream a project serves, so the host is its own port registry - it was
 * simply never read. This module turns those fragments into a port -> owner map,
 * finds the collisions, and allocates around them.
 *
 * Everything here is pure. The one thing that must touch the box, reading the
 * fragments, is split into a script builder and a parser so both halves are
 * testable without a server.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/168
 */

/**
 * Where the rpx gateway keeps one registry fragment per project.
 *
 * Deliberately duplicated from `RPX_SITES_DIR` rather than imported:
 * `rpx-gateway.ts` imports `site-target.ts`, and this module imports it too, so
 * importing the constant from there would close a cycle. `site-ports.test.ts`
 * asserts the two stay equal, so the duplicate cannot drift silently.
 */
export const HOST_SITES_DIR = '/etc/rpx/sites.d'

export interface SitePortRange {
  /** Lowest port the allocator may hand out, inclusive. */
  start: number
  /** Highest port the allocator may hand out, inclusive. */
  end: number
}

/**
 * The window the allocator searches.
 *
 * Chosen to contain the template's own defaults (3022/3023) so that an app which
 * has never thought about ports keeps the ports it already had whenever they are
 * free - see {@link allocateSitePorts}, which only moves a site that actually
 * collides.
 */
export const DEFAULT_SITE_PORT_RANGE: SitePortRange = { start: 3000, end: 3999 }

/**
 * One project's registry fragment, as written by the deploy:
 * `JSON.stringify({ slug, ...RpxGatewayConfig })`.
 *
 * Only the fields this module reads are declared. A fragment written by an older
 * ts-cloud may be missing `slug`, which the writer defaults to `'app'`.
 */
export interface HostSiteFragment {
  slug?: string
  proxies?: Array<{ from?: string | string[] }>
}

/** Port -> the slug of the project that already serves it on this box. */
export type PortOwners = Map<number, string>

/** The slug a fragment belongs to, matching the writer's `'app'` default. */
function fragmentSlug(fragment: HostSiteFragment): string {
  return fragment.slug?.trim() || 'app'
}

/**
 * The port from an rpx upstream (`host:port`).
 *
 * Splits on the LAST colon so a bracketed IPv6 literal (`[::1]:3022`) parses as
 * port 3022 rather than as part of the address. Returns `undefined` for anything
 * that is not a valid TCP port, so a malformed fragment narrows the map instead
 * of poisoning it with NaN.
 */
export function parseUpstreamPort(upstream: string): number | undefined {
  const separator = upstream.lastIndexOf(':')
  if (separator < 0 || separator === upstream.length - 1) return undefined

  const candidate = upstream.slice(separator + 1).trim()
  if (!/^\d+$/.test(candidate)) return undefined

  const port = Number(candidate)
  return port >= 1 && port <= 65535 ? port : undefined
}

/**
 * Every port the box already serves, mapped to the project that owns it.
 *
 * `ignoreSlug` must be set to the deploying project's own slug. Its fragment is
 * already on the box from the previous deploy, so without that the second deploy
 * of an attached app reports a conflict with itself and can never succeed.
 *
 * First writer wins for a given port, which keeps the result deterministic when
 * two fragments disagree - a state that is itself the bug being reported, so the
 * caller sees one stable owner rather than an order-dependent one.
 */
export function occupiedHostPorts(
  fragments: HostSiteFragment[],
  options: { ignoreSlug?: string } = {},
): PortOwners {
  const ignore = options.ignoreSlug?.trim()
  const owners: PortOwners = new Map()

  for (const fragment of fragments) {
    const slug = fragmentSlug(fragment)
    if (ignore && slug === ignore) continue

    for (const proxy of fragment.proxies ?? []) {
      const upstreams = typeof proxy.from === 'string' ? [proxy.from] : (proxy.from ?? [])
      for (const upstream of upstreams) {
        const port = parseUpstreamPort(upstream)
        if (port !== undefined && !owners.has(port)) owners.set(port, slug)
      }
    }
  }

  return owners
}

/**
 * A shell snippet that dumps every registry fragment on the box, one
 * base64-encoded JSON document per line.
 *
 * base64 rather than raw `cat`, because the fragments are pretty-printed and so
 * span many lines; encoding makes the output unambiguously one record per line
 * without depending on a JSON tool being installed. Only POSIX utilities plus
 * `base64` are used, both present on the provisioned image - the same reason
 * `resize-remote.ts` enumerates these files with plain `find`.
 *
 * A missing directory is not an error: a box with no fragments yet prints
 * nothing, and {@link parseHostSiteFragments} reads that as "no co-tenants".
 */
export function buildHostSitePortsScript(sitesDir: string = HOST_SITES_DIR): string {
  return [
    `for __tsc_fragment in ${sitesDir}/*.json; do`,
    '  [ -f "$__tsc_fragment" ] || continue',
    '  base64 < "$__tsc_fragment" | tr -d \'\\n\'',
    '  printf \'\\n\'',
    'done',
  ].join('\n')
}

/**
 * Parse the output of {@link buildHostSitePortsScript}.
 *
 * A fragment that will not decode or parse is skipped rather than thrown, which
 * matches how the box's own assembler treats a corrupt fragment: one bad file
 * must not take the operation down. The cost is that its ports are invisible to
 * the collision check, which is strictly better than today, where every
 * project's ports are.
 */
export function parseHostSiteFragments(stdout: string): HostSiteFragment[] {
  const fragments: HostSiteFragment[] = []

  for (const line of stdout.split('\n')) {
    const encoded = line.trim()
    if (!encoded) continue

    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fragments.push(parsed as HostSiteFragment)
    }
    catch {
      continue
    }
  }

  return fragments
}

export interface SitePortAllocation {
  /** Site name within the deploying project's `sites`. */
  site: string
  /** The port the site should bind after allocation. */
  port: number
  /** What the config asked for, when it asked for anything. */
  declared?: number
  /** Did the allocation have to move the site off its declared port? */
  moved: boolean
}

export interface SitePortAllocationResult {
  allocations: SitePortAllocation[]
  errors: string[]
}

/**
 * Assign a free port to every server-app site, preferring the one it declared.
 *
 * The declared port is kept whenever it is free, so allocation is a no-op on a
 * box with no co-tenants and an app's ports stay stable across deploys. A site
 * whose port is taken walks upward to the next free one, which keeps the result
 * deterministic and close to what the author wrote - a template app landing on
 * 3024 rather than an arbitrary high port.
 *
 * Only `server-app` sites are considered. A bucket, static, redirect or proxy
 * site binds nothing, and `validateDeploymentConfig` already warns when one of
 * those declares a port.
 */
export function allocateSitePorts(
  config: CloudConfig,
  occupied: ReadonlyMap<number, string>,
  range: SitePortRange = DEFAULT_SITE_PORT_RANGE,
): SitePortAllocationResult {
  const allocations: SitePortAllocation[] = []
  const errors: string[] = []
  const taken = new Set<number>(occupied.keys())

  for (const [name, site] of Object.entries(config.sites ?? {})) {
    if (!site || resolveSiteKind(site) !== 'server-app') continue

    const declared = typeof site.port === 'number' ? site.port : undefined
    const preferred = Math.max(declared ?? range.start, range.start)

    let port: number | undefined
    for (let candidate = preferred; candidate <= range.end; candidate++) {
      if (!taken.has(candidate)) {
        port = candidate
        break
      }
    }

    if (port === undefined) {
      const owner = declared !== undefined ? occupied.get(declared) : undefined
      errors.push(
        `No free port for site '${name}' in ${range.start}-${range.end}`
        + `${declared !== undefined ? ` (wanted ${declared}${owner ? `, held by '${owner}'` : ''})` : ''}. `
        + 'Widen the range or free a port on the box.',
      )
      continue
    }

    taken.add(port)
    allocations.push({ site: name, port, declared, moved: declared !== undefined && port !== declared })
  }

  return { allocations, errors }
}
