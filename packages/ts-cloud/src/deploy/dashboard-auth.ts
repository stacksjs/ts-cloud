/**
 * Identity and authorization for the management dashboard.
 *
 * The dashboard hosts sites for more than one party: Stacks owns the box, and
 * collaborators are invited to individual sites. That makes authorization a
 * security boundary rather than a convenience — a site collaborator must never
 * reach another tenant's data, and must never reach the box itself.
 *
 * The model has two levels:
 * - Box role: `admin` (owns the box — everything) or `member` (only what they
 *   have been granted).
 * - Site grants: a member holds a {@link SiteRole} per site. `owner` may change
 *   the site's settings; `collaborator` may view and deploy it.
 *
 * Box-level capabilities (shell, terminal, SSH keys, firewall, databases,
 * cloud-config edits) are **admin-only and never grantable per site**. Each of
 * them yields root on the box, which would hand a single site's collaborator
 * control of every other tenant's site. There is deliberately no grant that
 * unlocks them for a member.
 *
 * Authorization is deny-by-default: {@link authorize} answers `false` for any
 * capability it does not explicitly recognize.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Box-wide role. `admin` owns the server and everything hosted on it. */
export type BoxRole = 'admin' | 'member'

/**
 * A member's role on one site. `owner` can additionally change that site's
 * settings; `collaborator` is limited to viewing and deploying it.
 */
export type SiteRole = 'owner' | 'collaborator'

export interface DashboardUser {
  username: string
  /** Encoded scrypt hash — see {@link hashPassword}. Never a plaintext password. */
  passwordHash: string
  role: BoxRole
  /** Site name → role. Ignored for admins, who reach every site. */
  sites: Record<string, SiteRole>
  /** Display name shown in the UI. Defaults to the username. */
  name?: string
  createdAt?: string
}

/**
 * Everything the dashboard can be asked to do.
 *
 * `box:*` capabilities are admin-only. `site:*` capabilities are evaluated
 * against a specific site and may be granted to a member.
 */
export type Capability =
  // Box-level — admin only.
  | 'box:read' // Host metrics, services, the box's own health.
  | 'box:shell' // Web terminal + arbitrary remote commands. Root on the box.
  | 'box:ssh' // Authorized SSH keys. Root on the box.
  | 'box:firewall' // Host firewall ports.
  | 'box:database' // Database and DB-user management, backups.
  | 'box:config' // Read/write the cloud config, switch environment.
  | 'box:sites:create'
  | 'box:sites:delete'
  | 'box:serverless' // The whole serverless surface (account-wide).
  | 'box:users' // Manage collaborators.
  // Site-level — grantable.
  | 'site:read'
  | 'site:deploy'
  | 'site:settings'

/** Capabilities a member may hold on a site, by site role. */
const SITE_ROLE_CAPABILITIES: Record<SiteRole, ReadonlySet<Capability>> = {
  owner: new Set<Capability>(['site:read', 'site:deploy', 'site:settings']),
  collaborator: new Set<Capability>(['site:read', 'site:deploy']),
}

/**
 * Capabilities that are never grantable to a member, for any site. Listed
 * explicitly so that adding a `site:*` capability can't silently widen a
 * member's reach into box-level control.
 */
export function isBoxCapability(capability: Capability): boolean {
  return capability.startsWith('box:')
}

export interface AuthorizeInput {
  user: Pick<DashboardUser, 'role' | 'sites'>
  capability: Capability
  /** Required for every `site:*` capability; ignored for `box:*`. */
  site?: string
}

/**
 * The single authorization decision point. Deny-by-default: an unrecognized
 * capability, a missing site, or a site the member holds no grant on all
 * return `false`.
 */
export function authorize({ user, capability, site }: AuthorizeInput): boolean {
  // Admins own the box and everything on it.
  if (user.role === 'admin')
    return true

  // Members can never perform box-level work, regardless of their site grants.
  if (isBoxCapability(capability))
    return false

  // Every site capability must name the site it applies to. A `site:*` check
  // with no site is a programming error at the call site; refuse it rather than
  // guessing which site was meant.
  if (!site)
    return false

  const siteRole = user.sites?.[site]
  if (!siteRole)
    return false

  return SITE_ROLE_CAPABILITIES[siteRole]?.has(capability) ?? false
}

/** The sites a user may see. Admins see everything, so pass the full list. */
export function visibleSites(user: Pick<DashboardUser, 'role' | 'sites'>, allSites: string[]): string[] {
  if (user.role === 'admin')
    return [...allSites]
  // Intersect the grants with the sites that actually exist, so a stale grant
  // for a deleted site never conjures a phantom entry in the UI.
  return allSites.filter(site => !!user.sites?.[site])
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * scrypt parameters. N=16384 keeps a single hash near ~50ms on a small box,
 * which is a reasonable brute-force cost without stalling the login request.
 */
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32
const SALT_LEN = 16

/**
 * Hash a password for storage: `scrypt$N$r$p$salt$hash` (both salt and hash
 * base64url). The parameters travel with the hash so they can be raised later
 * without invalidating existing credentials.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN)
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

/**
 * Verify a password against an encoded hash, in constant time. Returns false
 * for malformed hashes rather than throwing — a corrupt user record must fail
 * the login, not crash the server.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt')
      return false

    const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts
    const N = Number(nRaw)
    const r = Number(rRaw)
    const p = Number(pRaw)
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p))
      return false

    const salt = Buffer.from(saltRaw, 'base64url')
    const expected = Buffer.from(hashRaw, 'base64url')
    if (salt.length === 0 || expected.length === 0)
      return false

    // scrypt needs maxmem raised for larger N; 256MB covers N up to ~1M.
    const actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 })
    return timingSafeEqual(actual, expected)
  }
  catch {
    return false
  }
}

/** A URL-safe generated password, for invites and the bootstrap admin. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url')
}
