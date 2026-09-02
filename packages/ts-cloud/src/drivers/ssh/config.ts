/**
 * The single place ssh-provider settings are resolved.
 *
 * Same shape and the same precedence as `../hetzner/config`, for the same
 * reason: every value can come from several sources, and resolving them
 * ad-hoc at each call site is how the driver, a CLI command and the dashboard
 * end up disagreeing about which host a deploy goes to.
 *
 *   1. an explicit argument (a driver option or CLI flag: the caller means it)
 *   2. `cloud.config.ts` -> `ssh.*` (checked into the repo, reviewable)
 *   3. environment (`TS_CLOUD_SSH_*`) for per-machine overrides
 *   4. the documented default in {@link SSH_DEFAULTS}
 *
 * Config beats environment deliberately: a value written in `cloud.config.ts`
 * is the reviewed intent for the project, and a stray shell export must not
 * silently redirect a deploy to another machine.
 */
import type { CloudConfig, SshConfig, SshHostConfig } from '@ts-cloud/core'
import { expandHome } from '../hetzner/config'

export type SshProfile = NonNullable<SshConfig['profile']>
export type SshHostKeyPolicyName = NonNullable<SshConfig['hostKey']>
export type SshLanConfig = NonNullable<SshConfig['lan']>

/** The documented defaults. These are the only place an ssh default lives. */
export const SSH_DEFAULTS = {
  user: 'root',
  port: 22,
  privateKeyPath: '~/.ssh/id_ed25519',
  hostKey: 'pin',
  profile: 'generic',
  publicIp: 'auto',
} as const

const HOST_KEY_POLICIES: readonly SshHostKeyPolicyName[] = ['pin', 'accept-new', 'insecure']
const PROFILES: readonly SshProfile[] = ['raspberry-pi', 'generic']

/** First non-empty environment variable from `names`. */
function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

function first(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * The hosts to deploy to: explicit, else `ssh.hosts`, else the single host
 * named by `TS_CLOUD_SSH_HOST`. Throws when none is configured, because a
 * driver without a host has nothing it can honestly do.
 */
export function resolveSshHosts(config?: CloudConfig, explicit?: SshHostConfig[]): SshHostConfig[] {
  if (explicit?.length) return explicit
  if (config?.ssh?.hosts?.length) return config.ssh.hosts
  const fromEnv = env('TS_CLOUD_SSH_HOST')
  if (fromEnv) return [{ host: fromEnv }]
  throw new Error('No ssh host configured. Set ssh.hosts in cloud.config.ts or TS_CLOUD_SSH_HOST.')
}

/** SSH user for deploy commands. Per host: the value lives on the `ssh.hosts[]` entry. */
export function resolveSshUser(host?: SshHostConfig, explicit?: string): string {
  return first(explicit, host?.user, env('TS_CLOUD_SSH_USER')) ?? SSH_DEFAULTS.user
}

/** SSH port. A non-numeric or out-of-range value is a configuration error, not port 22. */
export function resolveSshPort(host?: SshHostConfig, explicit?: number): number {
  const candidates: Array<{ source: string; value: number | string | undefined }> = [
    { source: 'the explicit port', value: explicit },
    { source: `ssh.hosts[].port for ${host?.host ?? 'the host'}`, value: host?.port },
    { source: 'TS_CLOUD_SSH_PORT', value: env('TS_CLOUD_SSH_PORT') },
  ]
  for (const { source, value } of candidates) {
    if (value === undefined || value === '') continue
    const port = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Invalid SSH port from ${source}: ${String(value)}`)
    return port
  }
  return SSH_DEFAULTS.port
}

/** Absolute path to the SSH private key used for deploy commands. */
export function resolveSshPrivateKeyPath(host?: SshHostConfig, explicit?: string): string {
  return expandHome(first(explicit, host?.privateKeyPath, env('TS_CLOUD_SSH_KEY')) ?? SSH_DEFAULTS.privateKeyPath)
}

/** How the host key is trusted; see `SshConfig.hostKey`. */
export function resolveSshHostKeyPolicy(config?: CloudConfig, explicit?: string): SshHostKeyPolicyName {
  const value = first(explicit, config?.ssh?.hostKey, env('TS_CLOUD_SSH_HOST_KEY')) ?? SSH_DEFAULTS.hostKey
  if (!HOST_KEY_POLICIES.includes(value as SshHostKeyPolicyName))
    throw new Error(`Invalid ssh.hostKey '${value}'. Use one of: ${HOST_KEY_POLICIES.join(', ')}.`)
  return value as SshHostKeyPolicyName
}

/**
 * Whether remote scripts run through `sudo -n`. Explicit, else `ssh.sudo`,
 * else on for any user that is not root: a deploy user that cannot become
 * root cannot install the stack.
 */
export function resolveSshSudo(config?: CloudConfig, user: string = SSH_DEFAULTS.user, explicit?: boolean): boolean {
  return explicit ?? config?.ssh?.sudo ?? user !== 'root'
}

/** Host profile; see `SshConfig.profile`. */
export function resolveSshProfile(config?: CloudConfig, explicit?: string): SshProfile {
  const value = first(explicit, config?.ssh?.profile, env('TS_CLOUD_SSH_PROFILE')) ?? SSH_DEFAULTS.profile
  if (!PROFILES.includes(value as SshProfile))
    throw new Error(`Invalid ssh.profile '${value}'. Use one of: ${PROFILES.join(', ')}.`)
  return value as SshProfile
}

/** The public IP DNS should point at: `'auto'` or a literal address. */
export function resolveSshPublicIp(config?: CloudConfig, explicit?: string): string {
  return first(explicit, config?.ssh?.publicIp) ?? SSH_DEFAULTS.publicIp
}

/**
 * LAN access settings, or `undefined` when the project configured none.
 *
 * This used to answer `{}` for "unset", which reads as a LAN with defaults
 * once anything acts on it: with the gateway now wired to `lan`, that sentinel
 * would give every adopted host a local certificate authority for
 * `<slug>.local` that nobody asked for. Absent has to be absent.
 */
export function resolveSshLan(config?: CloudConfig, explicit?: SshLanConfig): SshLanConfig | undefined {
  return explicit ?? config?.ssh?.lan
}

/** One host with every per-host value resolved. */
export interface ResolvedSshHost {
  host: string
  user: string
  port: number
  privateKeyPath: string
  role: 'app'
}

/** Every resolved ssh setting, for a driver or a diagnostic to read at once. */
export interface ResolvedSshSettings {
  hosts: ResolvedSshHost[]
  hostKey: SshHostKeyPolicyName
  sudo: boolean
  profile: SshProfile
  publicIp: string
  /** LAN access settings, or `undefined` when this project configured none. */
  lan?: SshLanConfig
}

export interface SshOverrides {
  hosts?: SshHostConfig[]
  user?: string
  port?: number
  privateKeyPath?: string
  hostKey?: string
  sudo?: boolean
  profile?: string
  publicIp?: string
  lan?: SshLanConfig
}

/** Resolve the full ssh settings for `config`, applying `overrides` first. */
export function resolveSshSettings(config?: CloudConfig, overrides: SshOverrides = {}): ResolvedSshSettings {
  const hosts = resolveSshHosts(config, overrides.hosts).map((host): ResolvedSshHost => ({
    host: host.host,
    user: resolveSshUser(host, overrides.user),
    port: resolveSshPort(host, overrides.port),
    privateKeyPath: resolveSshPrivateKeyPath(host, overrides.privateKeyPath),
    role: host.role ?? 'app',
  }))
  return {
    hosts,
    hostKey: resolveSshHostKeyPolicy(config, overrides.hostKey),
    sudo: resolveSshSudo(config, hosts[0]?.user, overrides.sudo),
    profile: resolveSshProfile(config, overrides.profile),
    publicIp: resolveSshPublicIp(config, overrides.publicIp),
    lan: resolveSshLan(config, overrides.lan),
  }
}
