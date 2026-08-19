/**
 * Idempotent find-or-create provisioning helpers on top of the Hetzner client.
 *
 * These are the building blocks for "deploy X onto a Hetzner box" scripts:
 * each helper reuses an existing resource when one matches (by name, or by
 * key body for SSH keys) and creates it otherwise, so re-running a deploy
 * converges instead of failing on duplicates.
 */
import type { CreateServerOptions, HetznerClient, HetznerFirewallRule, HetznerServer } from './client'
import { normalizeSshPublicKey } from './client'

export interface EnsuredResource {
  id: number
  name: string
  created: boolean
}

export interface EnsureSshKeyOptions {
  /** Name used if the key needs to be registered. */
  name: string
  /** OpenSSH public key (`<type> <base64> [comment]`). */
  publicKey: string
  labels?: Record<string, string>
}

/**
 * Register an SSH public key, reusing any already-registered key with the
 * same body (comment/whitespace differences ignored) regardless of its name.
 */
export async function ensureSshKey(client: HetznerClient, options: EnsureSshKeyOptions): Promise<EnsuredResource> {
  const body = normalizeSshPublicKey(options.publicKey)
  const existing = (await client.listSshKeys()).find((k) => normalizeSshPublicKey(k.public_key) === body)
  if (existing) return { id: existing.id, name: existing.name, created: false }
  const created = await client.createSshKey({
    name: options.name,
    publicKey: options.publicKey.trim(),
    labels: options.labels,
  })
  return { id: created.id, name: created.name, created: true }
}

export interface EnsureFirewallOptions {
  name: string
  rules: HetznerFirewallRule[]
  labels?: Record<string, string>
}

/**
 * Find a firewall by name and sync its rules to the given set, or create it.
 * Rules are replaced in-place on reuse so the firewall always matches the
 * declared config.
 */
export async function ensureFirewall(client: HetznerClient, options: EnsureFirewallOptions): Promise<EnsuredResource> {
  const existing = (await client.listFirewalls()).find((f) => f.name === options.name)
  if (existing) {
    await client.setFirewallRules(existing.id, options.rules)
    return { id: existing.id, name: existing.name, created: false }
  }
  const { firewall } = await client.createFirewall({ name: options.name, rules: options.rules, labels: options.labels })
  return { id: firewall.id, name: firewall.name, created: true }
}

export interface EnsureServerOptions extends CreateServerOptions {
  /** Wait until the (created or reused) server reaches `running`. @default true */
  waitForRunning?: boolean
}

export interface EnsuredServer {
  server: HetznerServer
  created: boolean
}

/**
 * Find a server by name or create it, waiting until it is running by default.
 * Creation options (`userData`, `sshKeys`, `firewalls`, ...) only apply when
 * the server does not exist yet — an existing server is reused as-is.
 */
export async function ensureServer(client: HetznerClient, options: EnsureServerOptions): Promise<EnsuredServer> {
  const { waitForRunning = true, ...createOptions } = options
  let server = (await client.listServers()).find((s) => s.name === options.name)
  const created = !server
  if (!server) server = (await client.createServer(createOptions)).server
  if (waitForRunning) server = await client.waitForServerRunning(server.id)
  return { server, created }
}

/** The public IPv4 of a server, throwing when it has none. */
export function serverPublicIpv4(server: HetznerServer): string {
  const ip = server.public_net.ipv4?.ip
  if (!ip) throw new Error(`Hetzner server "${server.name}" (#${server.id}) has no public IPv4`)
  return ip
}
