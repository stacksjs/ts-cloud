/**
 * The dashboard's user store: a JSON file of {@link DashboardUser} records at
 * `.ts-cloud/dashboard-users.json` (0600), holding scrypt hashes and site
 * grants. Small on purpose — a box hosts a handful of collaborators, not a
 * directory service.
 *
 * On first use the store bootstraps a single admin so a freshly provisioned
 * dashboard is never reachable without credentials. The generated password is
 * returned to the caller to print once; only its hash is ever written.
 */

import type { BoxRole, DashboardUser, SiteRole } from './dashboard-auth'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generatePassword, hashPassword } from './dashboard-auth'

export const USERS_FILE: string = join('.ts-cloud', 'dashboard-users.json')

interface UsersFile {
  users: DashboardUser[]
}

/** Usernames are used in URLs and shell-free contexts; keep them boring. */
export function isValidUsername(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{1,31}$/i.test(value)
}

function normalizeUser(raw: any): DashboardUser | null {
  if (!raw || typeof raw.username !== 'string' || typeof raw.passwordHash !== 'string')
    return null
  const role: BoxRole = raw.role === 'admin' ? 'admin' : 'member'
  const sites: Record<string, SiteRole> = {}
  if (raw.sites && typeof raw.sites === 'object') {
    for (const [site, siteRole] of Object.entries(raw.sites)) {
      // Anything that isn't a recognized site role is dropped rather than
      // coerced — a typo must not silently widen a grant.
      if (siteRole === 'owner' || siteRole === 'collaborator')
        sites[site] = siteRole
    }
  }
  return {
    username: raw.username,
    passwordHash: raw.passwordHash,
    role,
    sites,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
  }
}

export function parseUsersFile(text: string): DashboardUser[] {
  try {
    const parsed = JSON.parse(text) as UsersFile
    if (!Array.isArray(parsed?.users))
      return []
    return parsed.users.map(normalizeUser).filter((u): u is DashboardUser => u !== null)
  }
  catch {
    return []
  }
}

export function usersFilePath(cwd: string): string {
  return join(cwd, USERS_FILE)
}

export function loadUsers(cwd: string): DashboardUser[] {
  const file = usersFilePath(cwd)
  if (!existsSync(file))
    return []
  try {
    return parseUsersFile(readFileSync(file, 'utf8'))
  }
  catch {
    return []
  }
}

export function saveUsers(cwd: string, users: DashboardUser[]): void {
  const file = usersFilePath(cwd)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ users }, null, 2)}\n`)
  // Hashes are not plaintext, but they are still offline-crackable material.
  chmodSync(file, 0o600)
}

export function findUser(users: DashboardUser[], username: string): DashboardUser | undefined {
  const wanted = username.trim().toLowerCase()
  return users.find(u => u.username.toLowerCase() === wanted)
}

export interface BootstrapResult {
  users: DashboardUser[]
  /** Set only when an admin was just created — print it once, then it's gone. */
  generated?: { username: string, password: string }
}

/**
 * Ensure at least one admin exists. When the store is empty, create an admin
 * using `TS_CLOUD_UI_PASSWORD` if set, else a generated password that is
 * returned for one-time display.
 */
export function ensureAdminUser(cwd: string, username = 'admin'): BootstrapResult {
  const users = loadUsers(cwd)
  if (users.some(u => u.role === 'admin'))
    return { users }

  const password = process.env.TS_CLOUD_UI_PASSWORD?.trim() || generatePassword()
  const admin: DashboardUser = {
    username,
    passwordHash: hashPassword(password),
    role: 'admin',
    sites: {},
    name: 'Administrator',
    createdAt: new Date().toISOString(),
  }
  const next = [...users, admin]
  saveUsers(cwd, next)
  return { users: next, generated: { username, password } }
}

export interface UpsertMemberInput {
  username: string
  password?: string
  name?: string
  sites: Record<string, SiteRole>
}

/**
 * Create or update a member and their site grants. Returns the generated
 * password when one was minted (a new user without an explicit password).
 *
 * Members are created through this path only — it cannot produce an admin, so
 * an invite flow can never escalate someone to box-wide control.
 */
export function upsertMember(cwd: string, input: UpsertMemberInput): { user: DashboardUser, password?: string } {
  const users = loadUsers(cwd)
  const existing = findUser(users, input.username)

  const password = input.password?.trim() || (existing ? undefined : generatePassword())
  const user: DashboardUser = {
    username: existing?.username ?? input.username,
    passwordHash: password ? hashPassword(password) : existing!.passwordHash,
    // Never change an existing user's box role here; an admin edited through
    // the invite path must stay an admin, and a member must stay a member.
    role: existing?.role ?? 'member',
    sites: input.sites,
    name: input.name ?? existing?.name,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }

  const next = existing
    ? users.map(u => (u.username.toLowerCase() === user.username.toLowerCase() ? user : u))
    : [...users, user]
  saveUsers(cwd, next)
  return { user, password }
}

/**
 * Remove a user. The last admin cannot be removed — that would lock everyone
 * out of the box with no way back in short of editing the file by hand.
 */
export function removeUser(cwd: string, username: string): { ok: boolean, error?: string } {
  const users = loadUsers(cwd)
  const target = findUser(users, username)
  if (!target)
    return { ok: false, error: `No such user: ${username}` }

  if (target.role === 'admin' && users.filter(u => u.role === 'admin').length === 1)
    return { ok: false, error: 'Cannot remove the last admin.' }

  saveUsers(cwd, users.filter(u => u.username.toLowerCase() !== target.username.toLowerCase()))
  return { ok: true }
}

/** Public shape for the UI — never leaks the password hash. */
export function describeUser(user: DashboardUser): Record<string, any> {
  return {
    username: user.username,
    name: user.name ?? user.username,
    role: user.role,
    sites: user.sites,
    siteCount: Object.keys(user.sites).length,
    createdAt: user.createdAt,
  }
}
