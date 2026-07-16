/**
 * The single place Hetzner settings are resolved.
 *
 * Every Hetzner value can come from several sources, and they used to be
 * resolved ad-hoc wherever they were needed: the driver, the API client and the
 * dashboard each had their own chain, with defaults duplicated at call sites.
 * That drifted — the dashboard honored `HETZNER_LOCATION` while the driver did
 * not, so a box provisioned in `fsn1` was reported as being somewhere else.
 *
 * One precedence, applied everywhere:
 *
 *   1. an explicit argument (a driver option — the caller means it)
 *   2. `cloud.config.ts` → `hetzner.*` (checked into the repo, reviewable)
 *   3. environment (`HCLOUD_*`, with the `HETZNER_*` alias) — for secrets and
 *      per-machine overrides
 *   4. the documented default in {@link HETZNER_DEFAULTS}
 *
 * Config beats environment deliberately, for every field without exception: a
 * value written in `cloud.config.ts` is the reviewed intent for the project,
 * and a stray shell export should not silently redirect a deploy to another
 * datacenter or another account. One rule, no special cases to remember.
 *
 * In practice the token is simply left out of `cloud.config.ts` (it is a
 * secret), so it comes from `HCLOUD_TOKEN` — but that is a convention, not a
 * different precedence.
 */

import type { CloudConfig } from '@ts-cloud/core'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The documented defaults. These are the only place a Hetzner default lives. */
export const HETZNER_DEFAULTS = {
  /** Falkenstein, Germany. */
  location: 'fsn1',
  image: 'ubuntu-24.04',
  sshUser: 'root',
  sshPrivateKeyPath: '~/.ssh/id_ed25519',
} as const

/** `~/…` → an absolute path. Hetzner key paths are user-supplied and often use `~`. */
export function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** First non-empty environment variable from `names`. */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value)
      return value
  }
  return undefined
}

function first(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed)
      return trimmed
  }
  return undefined
}

/**
 * The Hetzner API token, or undefined when none is set.
 *
 * Never defaulted: a missing token must fail loudly at the call site rather
 * than silently targeting the wrong account. Callers that need one should use
 * `requireHetznerApiToken`.
 */
export function resolveHetznerApiToken(explicit?: string, config?: CloudConfig): string | undefined {
  return first(explicit, config?.hetzner?.apiToken, env('HCLOUD_TOKEN', 'HETZNER_API_TOKEN'))
}

/** Datacenter location slug, e.g. `fsn1`, `nbg1`, `hel1`. */
export function resolveHetznerLocation(config?: CloudConfig, explicit?: string): string {
  return first(explicit, config?.hetzner?.location, env('HCLOUD_LOCATION', 'HETZNER_LOCATION'))
    ?? HETZNER_DEFAULTS.location
}

/**
 * Server image slug.
 *
 * `infrastructure.compute.image` wins over `hetzner.image`: it is the
 * provider-agnostic way to pin an image (and is what a golden-image bake sets),
 * so it is the more specific statement of intent.
 */
export function resolveHetznerImage(config?: CloudConfig, explicit?: string): string {
  const compute = config?.infrastructure?.compute as { image?: string } | undefined
  return first(explicit, compute?.image, config?.hetzner?.image, env('HCLOUD_IMAGE', 'HETZNER_IMAGE'))
    ?? HETZNER_DEFAULTS.image
}

/** SSH user for deploy commands. */
export function resolveHetznerSshUser(config?: CloudConfig, explicit?: string): string {
  return first(explicit, config?.hetzner?.sshUser, env('HCLOUD_SSH_USER', 'HETZNER_SSH_USER'))
    ?? HETZNER_DEFAULTS.sshUser
}

/** Absolute path to the SSH private key used for deploy commands. */
export function resolveHetznerSshPrivateKeyPath(config?: CloudConfig, explicit?: string): string {
  return expandHome(
    first(explicit, config?.hetzner?.sshPrivateKeyPath, env('HCLOUD_SSH_KEY', 'HETZNER_SSH_KEY'))
    ?? HETZNER_DEFAULTS.sshPrivateKeyPath,
  )
}

/**
 * Absolute path to the SSH public key uploaded to Hetzner. Defaults to the
 * private key's path with `.pub`, which is where `ssh-keygen` puts it.
 */
export function resolveHetznerSshPublicKeyPath(config?: CloudConfig, explicit?: string, privateKeyPath?: string): string {
  const explicitPath = first(explicit, config?.hetzner?.sshPublicKeyPath, env('HCLOUD_SSH_PUBLIC_KEY', 'HETZNER_SSH_PUBLIC_KEY'))
  if (explicitPath)
    return expandHome(explicitPath)
  return `${privateKeyPath ?? resolveHetznerSshPrivateKeyPath(config)}.pub`
}

/** Every resolved Hetzner setting, for a driver or a diagnostic to read at once. */
export interface ResolvedHetznerSettings {
  apiToken?: string
  location: string
  image: string
  sshUser: string
  sshPrivateKeyPath: string
  sshPublicKeyPath: string
}

export interface HetznerOverrides {
  apiToken?: string
  location?: string
  image?: string
  sshUser?: string
  sshPrivateKeyPath?: string
  sshPublicKeyPath?: string
}

/** Resolve the full Hetzner settings for `config`, applying `overrides` first. */
export function resolveHetznerSettings(config?: CloudConfig, overrides: HetznerOverrides = {}): ResolvedHetznerSettings {
  const sshPrivateKeyPath = resolveHetznerSshPrivateKeyPath(config, overrides.sshPrivateKeyPath)
  return {
    apiToken: resolveHetznerApiToken(overrides.apiToken, config),
    location: resolveHetznerLocation(config, overrides.location),
    image: resolveHetznerImage(config, overrides.image),
    sshUser: resolveHetznerSshUser(config, overrides.sshUser),
    sshPrivateKeyPath,
    sshPublicKeyPath: resolveHetznerSshPublicKeyPath(config, overrides.sshPublicKeyPath, sshPrivateKeyPath),
  }
}
