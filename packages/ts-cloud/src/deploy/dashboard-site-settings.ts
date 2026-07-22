/**
 * Which site settings a member may change, and route-conflict checks.
 *
 * `site:settings` lets a site owner edit their own site — but a site's config
 * is not all equally harmless on a box shared with other tenants:
 *
 * - `build` and `start` are **shell commands run on the box at deploy time**,
 *   as root. A member who could set them would own the whole server, and every
 *   other tenant's site with it.
 * - `root` is a filesystem path. Pointed at another site's directory (or `/`),
 *   it serves someone else's files to the internet.
 * - `port`, `type` and `php` pick runtime and bind ports, which are the box's
 *   to allocate, not one tenant's.
 *
 * Those stay with the box owner. What is left is genuinely the tenant's own:
 * TLS, their app's env, their redirects, and their routing — and routing is
 * still checked against other tenants, since claiming `example.com` when
 * someone else already serves it is hijacking their traffic.
 *
 * An allowlist, not a blocklist: a site field added later is admin-only until
 * someone decides it is safe to hand over.
 */

/** Fields a member holding `site:settings` on the site may change. */
export const MEMBER_EDITABLE_SITE_FIELDS: ReadonlySet<string> = new Set([
  'name', // The site being addressed, not a change.
  'ssl',
  'env',
  'redirects',
  'aliases',
  'domain',
  'path',
])

/**
 * Fields only the box owner may change, with why — used to explain the refusal
 * rather than a bare 403.
 */
export const ADMIN_ONLY_SITE_FIELDS: Readonly<Record<string, string>> = {
  build: 'build runs as a shell command on the server',
  start: 'start runs as a shell command on the server',
  root: 'root is a filesystem path on the shared server',
  port: 'ports are allocated by the server owner',
  type: 'the deploy type is set by the server owner',
  php: 'the PHP runtime is set by the server owner',
}

export interface FieldCheck {
  ok: boolean
  error?: string
}

/**
 * Whether a member may apply `body` to a site. Refuses the whole request if it
 * touches any admin-only field, rather than silently applying the safe subset —
 * a caller who asked to set `start` should be told it did not happen.
 */
export function checkMemberSiteFields(body: Record<string, any>): FieldCheck {
  const touched = Object.keys(body).filter((key) => body[key] !== undefined)

  const forbidden = touched.filter((key) => key in ADMIN_ONLY_SITE_FIELDS)
  if (forbidden.length) {
    const reasons = forbidden.map((key) => `${key} (${ADMIN_ONLY_SITE_FIELDS[key]})`).join(', ')
    return { ok: false, error: `Only the server owner can change ${reasons}.` }
  }

  const unknown = touched.filter((key) => !MEMBER_EDITABLE_SITE_FIELDS.has(key))
  if (unknown.length) return { ok: false, error: `Only the server owner can change ${unknown.join(', ')}.` }

  return { ok: true }
}

function normalizeHost(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
}

function normalizePath(value: unknown): string {
  const path = String(value ?? '/').trim()
  if (!path || path === '/') return '/'
  return (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/, '') || '/'
}

/** Every host a site answers on: its domain plus any aliases. */
function siteHosts(site: any): string[] {
  const hosts = [normalizeHost(site?.domain)]
  if (Array.isArray(site?.aliases)) hosts.push(...site.aliases.map(normalizeHost))
  return hosts.filter(Boolean)
}

export interface RouteConflictInput {
  /** The site being edited. */
  siteName: string
  /** The requested changes (domain / path / aliases). */
  body: Record<string, any>
  /** All sites on the box, by name. */
  sites: Record<string, any>
  /** Site names the editor holds a grant on — conflicts with these are theirs. */
  ownSites: string[]
}

/**
 * Refuse a routing change that would claim a host another tenant already
 * serves. Conflicts with the editor's own sites are allowed: moving a domain
 * between two sites you control is your business.
 */
export function checkRouteConflict({ siteName, body, sites, ownSites }: RouteConflictInput): FieldCheck {
  const current = sites[siteName] ?? {}
  const owned = new Set(ownSites)

  const wantedHosts = new Set<string>()
  if (body.domain !== undefined) wantedHosts.add(normalizeHost(body.domain))
  if (Array.isArray(body.aliases)) for (const alias of body.aliases) wantedHosts.add(normalizeHost(alias))
  wantedHosts.delete('')

  if (wantedHosts.size === 0) return { ok: true }

  const wantedPath = normalizePath(body.path !== undefined ? body.path : current.path)

  for (const [otherName, other] of Object.entries(sites)) {
    if (otherName === siteName || owned.has(otherName)) continue

    const otherPath = normalizePath(other?.path)
    for (const host of siteHosts(other)) {
      if (!wantedHosts.has(host)) continue
      // Same host is only a conflict when the paths overlap; two sites can
      // share a domain on different paths (example.com and example.com/docs),
      // which is a supported layout.
      if (otherPath === wantedPath) {
        return {
          ok: false,
          // Name the host they asked for, which they already know — never the
          // other site's name, which would leak another tenant.
          error: `${host}${wantedPath === '/' ? '' : wantedPath} is already served by another site on this server.`,
        }
      }
    }
  }

  return { ok: true }
}
