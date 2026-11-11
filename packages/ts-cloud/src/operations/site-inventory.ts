/**
 * Where each of a project's sites is, in the terms needed to open a shell in it.
 *
 * `inventory.ts` answers "what does each box serve, and for whom". It stops at
 * routes, because that is what a consolidation needs. A tool that wants to
 * RUN something in a deployed site needs the rest of the address: which host,
 * as which user, with which key, in which directory, with which environment
 * file, under which unit. Until now every one of those was re-derived by
 * whoever needed it, from config defaults, and a default is a guess about a
 * box that may have been renamed, moved, or attached to someone else's.
 *
 * Nothing here is a new derivation. Each field comes from the function the
 * deploy itself uses to produce it:
 *
 *  - the stack and its state file: `resolveProjectStackName` + the driver
 *    state reader, so an attach-mode tenant resolves to the OWNER's box
 *    through its own pin, exactly as its deploys do;
 *  - the host: the pinned server ids first, then the `ts-cloud/*` labels,
 *    which is the order `findComputeTargets` uses;
 *  - the user and key: the Hetzner / ssh setting resolvers, with the user the
 *    state file recorded taking precedence over a config default;
 *  - the paths: `siteInstallBase` + `releasePaths`;
 *  - the unit: `<slug>-<site>`, the name the deploy script writes;
 *  - the hostnames: the rpx fragment the deploy would write for that site.
 *
 * It is read-only and needs no SSH. {@link deriveDeployedSites} is pure;
 * {@link listDeployedSites} adds the state file read and at most one provider
 * listing, and still answers from the state file alone when there is no API
 * token, which is the normal situation for an attached tenant.
 */
import type { CloudConfig, EnvironmentType, SiteConfig } from '@ts-cloud/core'
import type { HostSiteFragment } from '../deploy/site-ports'
import type { SiteDeployKind } from '../deploy/site-target'
import type { DriverState } from '../drivers/shared/driver-state'
import type { SshHostKeyPolicy, SshTransportOptions } from '../drivers/shared/ssh-transport'
import type { SshVia } from '../runtime/process-stream'
import type { InventoryServer, ProviderServerPayload } from './inventory'
import { resolveCloudProvider, resolveProjectStackName } from '@ts-cloud/core'
import { normalizePublicIpv6 } from '../deploy/server-dns'
import { resolveSiteKind, siteInstallBase } from '../deploy/site-target'
import { HetznerClient } from '../drivers/hetzner/client'
import { resolveHetznerApiToken, resolveHetznerSshPrivateKeyPath, resolveHetznerSshUser } from '../drivers/hetzner/config'
import { readDriverState } from '../drivers/shared/driver-state'
import { releasePaths } from '../drivers/shared/releases'
import { buildRpxConfig } from '../drivers/shared/rpx-gateway'
import { INTERACTIVE_SSH_HOST_KEY_POLICY, resolveSshHostKey } from '../drivers/shared/ssh-transport'
import { resolveSshPort, resolveSshPrivateKeyPath, resolveSshUser } from '../drivers/ssh/config'
import { ENVIRONMENT_LABEL, PROJECT_LABEL, ROLE_LABEL, routesFromFragments, toInventoryServer } from './inventory'

/** What keeps a site running, and the name to address it by. */
export type DeployedSiteRuntime =
  | {
      kind: 'systemd'
      /** `<slug>-<site>.service`: the stable name (an alias of the live release on a zero-downtime site). */
      unit: string
      /**
       * `<slug>-<site>@*.service` when the site cuts over with one templated
       * instance per release. `journalctl -u` takes the glob, so logs survive
       * a deploy without re-resolving the release id.
       */
      instancePattern?: string
    }
  /** A container on the box. Never derived from a site config; see {@link DeriveDeployedSitesInput.runtimes}. */
  | { kind: 'docker'; container: string }
  /** nginx + php-fpm: no unit of the site's own. */
  | { kind: 'php-fpm' }
  /** Files only. There is no process to exec into, but the directory is real. */
  | { kind: 'static' }

/** How a host was identified. */
export type DeployedSiteHostSource =
  /** Matched in a live provider listing by the state file's pinned id. */
  | 'state-pin'
  /** No live listing: the address the state file recorded at the last deploy. */
  | 'state-file'
  /** No pin: matched by the `ts-cloud/project`, `environment` and `role` labels. */
  | 'labels'

export interface DeployedSiteHost {
  /** Provider server id, when one is known. */
  id?: string
  name?: string
  ipv4?: string
  ipv6?: string
  /** The address to connect to: IPv4 when there is one, else IPv6, else the configured hostname. */
  address: string
  /** Provider status; `unknown` when answering from the state file alone. */
  status: string
  source: DeployedSiteHostSource
}

export interface DeployedSiteSsh {
  user: string
  port: number
  /** Absolute path to the private key. The path only: the key is never read here. */
  identityFile: string
  /** Checked by default; see `INTERACTIVE_SSH_HOST_KEY_POLICY`. */
  hostKey: SshTransportOptions['hostKey']
}

export interface DeployedSite {
  /** The site key in `cloud.config.ts`. */
  name: string
  slug: string
  environment: string
  kind: Exclude<SiteDeployKind, 'bucket' | 'redirect' | 'proxy'>
  /** Every box the site is deployed to. One, except on a fleet. */
  hosts: DeployedSiteHost[]
  ssh: DeployedSiteSsh
  /** `/var/www/<slug>-<site>`: holds `releases/`, `shared/` and `current`. */
  installBase: string
  /** `<installBase>/current`: the live release, and the directory to run code in. */
  appPath: string
  /**
   * `/var/www/<site>/current`: where a deploy from before install directories
   * were namespaced by slug put the site, and where a hand-built one may still
   * be. Not where a current deploy ships. See {@link appPathCandidates}.
   */
  legacyAppPath: string
  /** Paths to test on the box, most likely first. Use with {@link buildAppPathProbeScript}. */
  appPathCandidates: string[]
  /**
   * `<installBase>/shared/.env`, the file the deploy writes and links into
   * every release. Absent for a static site, which has no environment.
   */
  envFile?: string
  runtime: DeployedSiteRuntime
  /** Loopback port the app listens on, when it has one. */
  port?: number
  /** Hosts the gateway routes to this site: its domain and aliases, as the deploy writes them to the rpx fragment. */
  hostnames: string[]
  /**
   * The subset of routes the BOX reports for this site, when fragments read
   * from it were supplied. `undefined` means nobody asked the box, not that it
   * routes nothing.
   */
  routedHostnames?: string[]
}

export interface DeployedSiteInventory {
  slug: string
  environment: string
  /** The stack whose state file was read. */
  stackName: string
  provider: string
  /** `cloud.attachTo`: the project that owns the box these sites ride on. */
  attachedTo?: string
  sites: DeployedSite[]
  /** Sites that are declared but have no directory on a box: bucket, redirect and proxy sites. */
  skipped: Array<{ name: string; kind: SiteDeployKind; reason: string }>
  /** Why the answer may be incomplete. Empty when it is not. */
  warnings: string[]
}

export interface DeriveDeployedSitesInput {
  config: CloudConfig
  environment: EnvironmentType
  /** The stack's driver state, or null when there is no state file. */
  state: DriverState | null
  /** A provider listing. Omit to answer from the state file alone. */
  servers?: readonly InventoryServer[]
  /**
   * Registry fragments read from the box (`probeHostRoutes` reads them), to
   * fill {@link DeployedSite.routedHostnames}.
   */
  fragments?: readonly HostSiteFragment[]
  /** @default INTERACTIVE_SSH_HOST_KEY_POLICY */
  hostKeyPolicy?: SshHostKeyPolicy
  knownHostsFile?: string
  /** Project root: resolves the default known_hosts path. */
  cwd?: string
  /**
   * Runtime per site key, for a site the caller knows is not run the way its
   * config implies (a container discovered with `docker ps`). Wins over the
   * derived value.
   */
  runtimes?: Record<string, DeployedSiteRuntime>
}

const NOT_ON_A_BOX: Record<'bucket' | 'redirect' | 'proxy', string> = {
  bucket: 'uploaded to object storage; there is no directory on a server',
  redirect: 'answered by the gateway; nothing is shipped',
  proxy: 'forwarded to a service ts-cloud does not manage',
}

function unique<T>(values: Iterable<T | undefined | null | false | ''>): T[] {
  return [...new Set([...values].filter(Boolean) as T[])]
}

function hostFromServer(server: InventoryServer, source: DeployedSiteHostSource): DeployedSiteHost | undefined {
  const ipv6 = normalizePublicIpv6(server.ipv6)
  const address = server.ipv4 ?? ipv6
  if (!address) return undefined
  return { id: server.id, name: server.name, ipv4: server.ipv4, ipv6, address, status: server.status, source }
}

/**
 * The boxes a stack's app sites run on.
 *
 * The order is `findComputeTargets`': the state file's pins beat the labels,
 * because on a shared box the labels name the OWNER and a tenant's own stale
 * labels may still name a server it has since left.
 */
function resolveHosts(
  input: DeriveDeployedSitesInput,
  warnings: string[],
): DeployedSiteHost[] {
  const { config, environment, state, servers } = input
  const slug = config.project.slug

  if (state?.provider === 'ssh') {
    return [{ name: state.host, ipv4: state.publicIp ?? state.lanIp, address: state.host, status: 'unknown', source: 'state-file' }]
  }

  const pinned = unique<number>([state?.serverId, ...(state?.appServerIds ?? [])])

  if (servers) {
    const hosts: DeployedSiteHost[] = []
    for (const id of pinned) {
      const server = servers.find((candidate) => candidate.id === String(id))
      if (!server) {
        warnings.push(`Server ${id} is pinned in the state file but absent from the provider listing: it was deleted, or this token cannot see it.`)
        continue
      }
      // Same guard as the deploy: a pin whose recorded name no longer matches
      // is pointing at a different machine than the one it was written for.
      if (id === state?.serverId && state.serverName && server.name !== state.serverName) {
        warnings.push(`Server ${id} is named '${server.name}', not '${state.serverName}' as pinned: not using it.`)
        continue
      }
      if (server.status === 'off') {
        warnings.push(`Server '${server.name}' is off.`)
        continue
      }
      const host = hostFromServer(server, 'state-pin')
      if (host) hosts.push(host)
    }
    if (hosts.length > 0) return hosts

    const labelled = servers.filter(
      (server) =>
        server.labels[PROJECT_LABEL] === slug &&
        server.labels[ENVIRONMENT_LABEL] === environment &&
        (server.labels[ROLE_LABEL] ?? 'app') === 'app',
    )
    const byLabel = labelled.map((server) => hostFromServer(server, 'labels')).filter((host): host is DeployedSiteHost => !!host)
    if (byLabel.length > 0) return byLabel
  }

  // No listing (or one that knows nothing): the last deploy's own record.
  if (state?.provider === 'hetzner' && pinned.length > 0 && (state.publicIp || state.publicIpv6)) {
    if (servers) warnings.push('Answering from the state file: the provider listing has none of this stack\'s servers.')
    if (pinned.length > 1) {
      warnings.push(`The state file pins ${pinned.length} app servers but records one address; list the provider's servers to reach the others.`)
    }
    const ipv6 = normalizePublicIpv6(state.publicIpv6)
    return [
      {
        id: String(state.serverId ?? pinned[0]),
        name: state.serverName,
        ipv4: state.publicIp,
        ipv6,
        address: (state.publicIp ?? ipv6)!,
        status: 'unknown',
        source: 'state-file',
      },
    ]
  }

  return []
}

function resolveSsh(input: DeriveDeployedSitesInput): DeployedSiteSsh {
  const { config, state } = input
  const hostKey = resolveSshHostKey(input.hostKeyPolicy ?? INTERACTIVE_SSH_HOST_KEY_POLICY, {
    knownHostsFile: input.knownHostsFile,
    cwd: input.cwd,
  })
  if (state?.provider === 'ssh' || (!state && resolveCloudProvider(config) === 'ssh')) {
    const configured = config.ssh?.hosts?.find((host) => host.host === (state as { host?: string } | null)?.host) ?? config.ssh?.hosts?.[0]
    return {
      // What the last deploy connected as beats what the config says today.
      user: (state?.provider === 'ssh' ? state.sshUser : undefined) ?? resolveSshUser(configured),
      port: (state?.provider === 'ssh' ? state.sshPort : undefined) ?? resolveSshPort(configured),
      identityFile: resolveSshPrivateKeyPath(configured),
      hostKey,
    }
  }
  return {
    user: resolveHetznerSshUser(config, state?.provider === 'hetzner' ? state.sshUser : undefined),
    port: 22,
    identityFile: resolveHetznerSshPrivateKeyPath(config),
    hostKey,
  }
}

/** The hosts the deploy's rpx fragment routes to one site. */
function siteHostnames(config: CloudConfig, name: string, site: SiteConfig): string[] {
  if (!site.domain) return []
  const proxy = config.infrastructure?.compute?.proxy ?? { engine: 'rpx' as const }
  try {
    const fragment = buildRpxConfig({ [name]: site }, { proxy, slug: config.project.slug })
    return unique(fragment.proxies.map((route) => route.to))
  } catch {
    // A site the gateway builder rejects still has the domain it declares.
    return unique([site.domain, ...(site.aliases ?? []).map((alias) => String(alias).trim().toLowerCase())])
  }
}

/**
 * The hosts the box routes to this site, picked out of what it reports.
 *
 * A fragment does not record which site a route belongs to, only where it
 * goes, so the match is on the destination: the site's loopback port, or its
 * install directory for a static site.
 */
function routedHostnames(fragments: readonly HostSiteFragment[], slug: string, site: SiteConfig, installBase: string): string[] {
  const ours = routesFromFragments(fragments).filter((route) => route.slug === slug)
  return unique(
    ours
      .filter((route) => {
        if (route.kind === 'static') return route.target === installBase || route.target.startsWith(`${installBase}/`)
        if (route.kind !== 'app' || typeof site.port !== 'number') return false
        return route.target.split(',').some((upstream) => upstream.trim().endsWith(`:${site.port}`))
      })
      .map((route) => route.host),
  )
}

/**
 * Every server-deployed site of a project, addressed. Pure: no I/O.
 *
 * A stack with no resolvable host returns its sites with `hosts: []` and a
 * warning rather than nothing, because the paths and the unit are still true
 * and "we do not know where the box is" is an answer the caller can show.
 */
export function deriveDeployedSites(input: DeriveDeployedSitesInput): DeployedSiteInventory {
  const { config, environment } = input
  const slug = config.project.slug
  const warnings: string[] = []
  const hosts = resolveHosts(input, warnings)
  const ssh = resolveSsh(input)
  const sites: DeployedSite[] = []
  const skipped: DeployedSiteInventory['skipped'] = []

  for (const [name, site] of Object.entries(config.sites ?? {})) {
    if (!site) continue
    const kind = resolveSiteKind(site)
    if (kind === 'bucket' || kind === 'redirect' || kind === 'proxy') {
      skipped.push({ name, kind, reason: NOT_ON_A_BOX[kind] })
      continue
    }

    const installBase = siteInstallBase(slug, name)
    const paths = releasePaths(installBase, 'current')
    const legacy = releasePaths(`/var/www/${name}`, 'current')
    const unitBase = `${slug}-${name}`
    // Mirrors buildSiteDeployScript: one templated instance per release when
    // the site has a port and has not opted out of the overlapping cutover.
    const zeroDowntime = site.zeroDowntime !== false && site.port != null
    const derived: DeployedSiteRuntime =
      kind === 'server-app'
        ? { kind: 'systemd', unit: `${unitBase}.service`, ...(zeroDowntime ? { instancePattern: `${unitBase}@*.service` } : {}) }
        : kind === 'server-php'
          ? { kind: 'php-fpm' }
          : { kind: 'static' }

    sites.push({
      name,
      slug,
      environment,
      kind,
      hosts,
      ssh,
      installBase,
      appPath: paths.current,
      legacyAppPath: legacy.current,
      appPathCandidates: [paths.current, legacy.current],
      ...(kind === 'server-static' ? {} : { envFile: `${paths.shared}/.env` }),
      runtime: input.runtimes?.[name] ?? derived,
      ...(typeof site.port === 'number' ? { port: site.port } : {}),
      hostnames: siteHostnames(config, name, site),
      ...(input.fragments ? { routedHostnames: routedHostnames(input.fragments, slug, site, installBase) } : {}),
    })
  }

  if (sites.length > 0 && hosts.length === 0) {
    warnings.push(
      input.state
        ? 'No reachable server could be resolved for this stack from its state file or the provider listing.'
        : `No state file for this stack, and no labelled server was found: has '${slug}' been deployed to ${environment} from this checkout?`,
    )
  }

  return {
    slug,
    environment,
    stackName: resolveProjectStackName(config, environment),
    provider: input.state?.provider ?? resolveCloudProvider(config),
    ...(config.cloud?.attachTo?.trim() ? { attachedTo: config.cloud.attachTo.trim() } : {}),
    sites,
    skipped,
    warnings,
  }
}

export interface ListDeployedSitesOptions extends Omit<DeriveDeployedSitesInput, 'state' | 'servers'> {
  /**
   * The one list call. Defaults to the Hetzner server listing when a token
   * resolves; with no token the answer comes from the state file alone. Pass
   * `false` to never call a provider.
   */
  listServers?: (() => Promise<ProviderServerPayload[]>) | false
  /** Read the state file from somewhere else. For tests. */
  readState?: (stackName: string, cwd?: string) => Promise<DriverState | null>
}

/**
 * {@link deriveDeployedSites} for the project in `cwd`: reads the stack's
 * pinned state, makes at most one provider list call, changes nothing.
 *
 * A listing that fails (an expired token, no network) degrades to the state
 * file with a warning rather than failing: the last deploy's record is still
 * the best available answer, and the caller is told it is not a live one.
 */
export async function listDeployedSites(options: ListDeployedSitesOptions): Promise<DeployedSiteInventory> {
  const { listServers, readState = readDriverState, ...input } = options
  const stackName = resolveProjectStackName(input.config, input.environment)
  const state = await readState(stackName, input.cwd)

  let lister = listServers === false ? undefined : listServers
  if (lister === undefined && listServers !== false && state?.provider !== 'ssh' && resolveCloudProvider(input.config) === 'hetzner') {
    const apiToken = resolveHetznerApiToken(undefined, input.config)
    if (apiToken) lister = () => new HetznerClient({ apiToken }).listServers() as Promise<ProviderServerPayload[]>
  }

  let servers: InventoryServer[] | undefined
  let listingFailure: string | undefined
  if (lister) {
    try {
      servers = (await lister()).map(toInventoryServer)
    } catch (error) {
      // First line only: an API error body is not something to relay.
      listingFailure = (error instanceof Error ? error.message : String(error)).split('\n')[0]
    }
  }

  const inventory = deriveDeployedSites({ ...input, state, servers })
  if (listingFailure) inventory.warnings.unshift(`Could not list servers (${listingFailure}); answering from the state file.`)
  return inventory
}

/** The SSH destination for one of a site's hosts, ready for `streamSshCommand` or `KubectlOptions.via`. */
export function deployedSiteSshVia(site: DeployedSite, host: DeployedSiteHost | undefined = site.hosts[0]): SshVia {
  if (!host) throw new Error(`Site '${site.name}' has no resolved host to connect to`)
  return {
    host: host.address,
    ssh: { user: site.ssh.user, port: site.ssh.port, identityFile: site.ssh.identityFile, hostKey: site.ssh.hostKey },
  }
}

const APP_PATH_MARKER = '__TSCLOUD_APP_PATH__='

/**
 * A script that prints which of a site's candidate paths exists on the box.
 * Read-only: it tests directories and prints one line.
 */
export function buildAppPathProbeScript(site: Pick<DeployedSite, 'appPathCandidates'>): string {
  const quoted = site.appPathCandidates.map((path) => `'${path.replace(/'/g, `'\\''`)}'`).join(' ')
  return [`for __tsc_path in ${quoted}; do`, `  if [ -d "$__tsc_path" ]; then printf '${APP_PATH_MARKER}%s\\n' "$__tsc_path"; exit 0; fi`, 'done', `printf '${APP_PATH_MARKER}\\n'`].join('\n')
}

/** The path {@link buildAppPathProbeScript} found, or undefined when the box has none of them. */
export function parseAppPathProbe(stdout: string): string | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(APP_PATH_MARKER))
  return line?.slice(APP_PATH_MARKER.length).trim() || undefined
}
