import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type { DashboardUser } from './dashboard-auth'
import { resolveDeploymentMode } from '@ts-cloud/core'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCloudConfig } from '../config'
import { hashPassword, verifyPassword } from './dashboard-auth'
import { initializeDashboardControlPlane, trackDashboardOperation } from './dashboard-control-plane'
import { resolveDashboardData } from './dashboard-data'
import { resolveServerDashboardData } from './dashboard-data-server'
import { backupDatabase, createDatabase, createDatabaseUser, isValidDbIdentifier, listDatabaseBackups, listDatabases } from './dashboard-database'
import { createDashboardGuard, siteFromRequest } from './dashboard-guard'
import { renderLoginPage } from './dashboard-login-page'
import { buildDashboardOperations, resolveDashboardOperation, runDashboardOperation, runServerShellCommand } from './dashboard-operations'
import { resolveLegacyDashboardRoute } from './dashboard-route-manifest'
import { scopeCloudConfig, scopeDashboardData } from './dashboard-scope'
import { checkMemberSiteFields, checkRouteConflict } from './dashboard-site-settings'
import { clearSessionCookie, createSessionToken, resolveSessionSecret, serializeSessionCookie } from './dashboard-session'
import { LoginThrottle } from './dashboard-throttle'
import { describeUser, ensureAdminUser, findUser, isValidUsername, loadUsers, removeUser, upsertMember } from './dashboard-users'
import { addFirewallPort, isValidPort, normalizePorts, removeFirewallPort } from './firewall-config-editor'
import { resolveUiSource } from './management-dashboard'
import {
  buildServerlessOperations,
  configuredSecretIds,
  controlScheduler,
  createAlarm,
  deleteAlarm,
  deleteServerlessSecret,
  listAlarms,
  listDlqMessages,
  listTraces,
  purgeDlq,
  redriveDlq,
  resolveServerlessOperation,
  runServerlessCommand,
  runServerlessOperation,
  setServerlessSecret,
  updateFunctionConfig,
} from './serverless-operations'
import { addSiteToCloudConfig, isValidHostname, removeSiteFromCloudConfig, renderAliasesValue, renderEnvValue, renderRedirectsValue, renderSslValue, renderStringValue, setSitePropertyInCloudConfig } from './site-config-editor'
import { addSshKeyToCloudConfig, describeSshKeys, removeSshKeyFromCloudConfig } from './ssh-config-editor'
import { createTerminalSession } from './terminal-session'

export interface LocalDashboardServerOptions {
  host?: string
  port?: number
  cwd?: string
  environment?: EnvironmentType
  cliEntry?: string
  verbose?: boolean
  /**
   * Box mode: the dashboard runs ON the provisioned server. Data resolution and
   * operations execute against localhost (the {@link LocalBoxDriver}) instead of
   * reaching out over SSH/SSM.
   */
  box?: boolean
}

export interface LocalDashboardServer {
  url: string
  server: ReturnType<typeof Bun.serve>
}

export interface DashboardAction {
  id: string
  label: string
  description: string
  command: string[]
  mutates: boolean
  confirm?: string
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 7676
const MAX_OUTPUT_BYTES = 64 * 1024
const DASHBOARD_TEMP_PREFIX = 'ts-cloud-dashboard-'
const here = dirname(fileURLToPath(import.meta.url))

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error: any) {
    return error?.code !== 'ESRCH'
  }
}

export function pruneDashboardTempRoots(
  root: string = tmpdir(),
  running: (pid: number) => boolean = isProcessRunning,
): number {
  let removed = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(DASHBOARD_TEMP_PREFIX))
      continue
    const path = join(root, entry.name)
    const owned = entry.name.match(/^ts-cloud-dashboard-(\d+)-/)
    if (owned) {
      const pid = Number(owned[1])
      if (pid === process.pid || running(pid))
        continue
    }
    else if (readdirSync(path).length > 0) {
      // Legacy roots have no owner PID. Only an empty failed build is provably
      // unused; successful legacy roots are left alone for a one-time audit.
      continue
    }
    rmSync(path, { recursive: true, force: true })
    removed += 1
  }
  return removed
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

/**
 * Verified against when the username is unknown, so that a wrong username and a
 * wrong password cost the same time. Without it, login timing enumerates users.
 */
const DUMMY_HASH: string = hashPassword('ts-cloud-dummy-password')

function text(data: string, status = 200): Response {
  return new Response(data, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

function selectedEnvironment(config: CloudConfig, requested?: EnvironmentType): EnvironmentType {
  if (requested && Object.hasOwn(config.environments ?? {}, requested))
    return requested
  const envs = Object.keys(config.environments ?? {}) as EnvironmentType[]
  return envs[0] ?? 'production'
}

export function resolveDashboardEnvironment(available: readonly string[], fallback: EnvironmentType, requested?: string | null): EnvironmentType {
  return (requested && available.includes(requested) ? requested : fallback) as EnvironmentType
}

async function loadLocalEnv(cwd: string): Promise<void> {
  const candidates = [
    join(here, '..', '..', '..', '..', '.env'),
    join(cwd, '.env'),
    join(cwd, '.env.local'),
    join(cwd, '.env.production'),
  ]

  for (const file of candidates) {
    if (!existsSync(file))
      continue

    const text = await readFile(file, 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('='))
        continue

      const eq = trimmed.indexOf('=')
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key) || process.env[key] != null)
        continue
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))
        value = value.slice(1, -1)
      process.env[key] = value
    }
  }
}

function resolveCloudConfigPath(cwd: string): string | null {
  const candidates = [
    join(cwd, 'config', 'cloud.ts'),
    join(cwd, 'config', 'cloud.js'),
    join(cwd, 'cloud.config.ts'),
    join(cwd, 'cloud.config.js'),
  ]
  return candidates.find(file => existsSync(file)) ?? null
}

function computeSshKeys(config: CloudConfig): any[] {
  return (config.infrastructure?.compute as any)?.sshKeys ?? []
}

function replaceComputeSshKeys(config: CloudConfig, keys: any[]): void {
  const infrastructure = config.infrastructure ?? ((config as any).infrastructure = {})
  const compute = infrastructure.compute ?? ((infrastructure as any).compute = {})
  ;(compute as any).sshKeys = keys
}

function replaceSiteConfig(config: CloudConfig, name: string, site: Record<string, any>): void {
  const sites = config.sites ?? ((config as any).sites = {})
  ;(sites as any)[name] = site
}

function computeFirewallPorts(config: CloudConfig): number[] {
  return normalizePorts(((config.infrastructure?.compute as any)?.firewall?.allowedPorts ?? []) as number[])
}

function replaceFirewallPorts(config: CloudConfig, ports: number[]): void {
  const infra = config.infrastructure ?? ((config as any).infrastructure = {})
  const compute = (infra as any).compute ?? ((infra as any).compute = {})
  const firewall = compute.firewall ?? (compute.firewall = {})
  firewall.allowedPorts = ports
}

async function readJsonBody(req: Request): Promise<Record<string, any>> {
  return await req.json().catch(() => ({})) as Record<string, any>
}

/**
 * Server and serverless are mutually exclusive; the shared core detector is the
 * single source of truth (honors an explicit `config.mode`, else auto-detects a
 * serverless app vs a compute box).
 */
async function resolveLiveDashboardData(config: CloudConfig, environment: EnvironmentType): Promise<Record<string, any>> {
  const mode = resolveDeploymentMode(config)
  // The nav renders a mode-aware view set + a server-rendered environment switcher.
  const meta = {
    mode,
    environment,
    environments: Object.keys(config.environments ?? {}),
    project: { name: config.project.name, slug: config.project.slug, region: config.project.region },
  }
  try {
    const data = mode === 'serverless'
      ? await resolveDashboardData(config, environment)
      : await resolveServerDashboardData(config, environment)
    return { ...(data ?? {}), ...meta }
  }
  catch {
    // A serverless config without a fully-defined app (or an unreachable box)
    // shouldn't crash the cockpit; fall back to the sample-rendered UI.
    return { ...meta }
  }
}

function resolveUiSourceDir(cwd: string): string | null {
  const candidates = [
    // 1. Local checkout (ts-cloud repo dogfooding).
    join(cwd, 'packages', 'ui'),
    join(here, '..', '..', '..', 'ui'),
    join(here, '..', '..', 'ui'),
    // 2. The source bundle shipped inside the installed package (dist/ui-src),
    //    so consumer projects (e.g. Stacks) rebuild the cockpit with live data.
    //    Probed both from the built layout (dist/deploy → dist/ui-src) and when
    //    running from source after a build (src/deploy → ../../dist/ui-src).
    join(here, '..', 'ui-src'),
    join(here, '..', '..', 'ui-src'),
    join(here, '..', '..', 'dist', 'ui-src'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'pages')) && existsSync(join(dir, 'package.json')))
      return dir
  }
  return null
}

async function buildLiveUi(cwd: string, data: Record<string, any>): Promise<string | null> {
  const uiDir = resolveUiSourceDir(cwd)
  if (!uiDir)
    return null

  // Building the cockpit with data baked in is a best-effort *enhancement*. It
  // needs the stx toolchain, which isn't guaranteed on a bare box (and `bunx
  // stx` can't resolve when stx is scoped). On ANY failure we return null so the
  // caller falls back to the shipped pre-built UI, which fetches the same data
  // from /api/* at runtime — a build hiccup must never crash the cockpit.
  let outDir: string | undefined
  try {
    outDir = mkdtempSync(join(tmpdir(), `${DASHBOARD_TEMP_PREFIX}${process.pid}-`))
    // Prefer a locally-installed stx bin (node_modules/.bin/stx) over `bunx stx`,
    // which would try to fetch a non-existent bare `stx` package from the registry.
    const localStx = join(uiDir, 'node_modules', '.bin', 'stx')
    const cmd = existsSync(localStx)
      ? [localStx, 'build', '--pages', 'pages', '--out', outDir, '--no-sitemap', '--no-cache']
      : ['bunx', '--bun', '@stacksjs/stx', 'build', '--pages', 'pages', '--out', outDir, '--no-sitemap', '--no-cache']
    const proc = Bun.spawn(cmd, {
      cwd: uiDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TSCLOUD_DASHBOARD_DATA: JSON.stringify(data),
      },
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      rmSync(outDir, { recursive: true, force: true })
      if (process.env.TSCLOUD_DASHBOARD_VERBOSE)
        console.warn(`ts-cloud dashboard: live UI build failed; serving the pre-built UI.\n${stdout}\n${stderr}`)
      return null
    }
    return outDir
  }
  catch (err) {
    if (outDir)
      rmSync(outDir, { recursive: true, force: true })
    if (process.env.TSCLOUD_DASHBOARD_VERBOSE)
      console.warn(`ts-cloud dashboard: live UI build errored; serving the pre-built UI. ${(err as Error).message}`)
    return null
  }
}

export function sanitizeCloudConfig(config: CloudConfig): Record<string, any> {
  return {
    project: {
      name: config.project?.name,
      slug: config.project?.slug,
      region: config.project?.region,
    },
    provider: (config as any).provider,
    environments: Object.keys(config.environments ?? {}),
    compute: config.infrastructure?.compute
      ? {
          provider: (config.infrastructure.compute as any).provider,
          runtime: config.infrastructure.compute.runtime,
          webServer: config.infrastructure.compute.webServer,
          proxy: config.infrastructure.compute.proxy
            ? {
                engine: config.infrastructure.compute.proxy.engine,
                onDemandTls: config.infrastructure.compute.proxy.onDemandTls,
                cdn: !!config.infrastructure.compute.proxy.cdn,
              }
            : undefined,
          managedServices: config.infrastructure.compute.managedServices,
          sshKeys: describeSshKeys(computeSshKeys(config)).map(key => ({
            name: key.name,
            type: key.type,
            fingerprint: key.fingerprint,
            added: key.added,
          })),
        }
      : undefined,
    sites: Object.fromEntries(Object.entries(config.sites ?? {}).map(([name, site]: [string, any]) => [
      name,
      {
        domain: site.domain,
        path: site.path,
        type: site.type,
        deploy: site.deploy,
        root: site.root,
        port: site.port,
        ssl: site.ssl,
      },
    ])),
  }
}

export function dashboardActions(environment: EnvironmentType): DashboardAction[] {
  return [
    {
      id: 'status',
      label: 'Refresh Cloud Status',
      description: 'Runs the local ts-cloud status checks against configured providers.',
      command: ['status', '--env', environment],
      mutates: false,
    },
    {
      id: 'doctor',
      label: 'Run Doctor',
      description: 'Checks local tooling, credentials, and provider access.',
      command: ['doctor'],
      mutates: false,
    },
    {
      id: 'security-scan',
      label: 'Security Scan',
      description: 'Runs the pre-deploy scanner from this checkout.',
      command: ['deploy:security-scan', '--source', '.', '--fail-on', 'critical'],
      mutates: false,
    },
    {
      id: 'deploy',
      label: 'Deploy Environment',
      description: 'Deploys the selected environment from the local checkout.',
      command: ['deploy', '--env', environment, '--yes'],
      mutates: true,
      confirm: 'deploy',
    },
  ]
}

export function resolveDashboardAction(id: string, environment: EnvironmentType): DashboardAction | undefined {
  return dashboardActions(environment).find(action => action.id === id)
}

function clampOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES)
    return output
  return `${output.slice(0, MAX_OUTPUT_BYTES)}\n\n[output truncated]`
}

async function runAction(action: DashboardAction, options: Required<Pick<LocalDashboardServerOptions, 'cwd' | 'cliEntry'>>): Promise<Record<string, any>> {
  const proc = Bun.spawn([process.execPath, options.cliEntry, ...action.command], {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return {
    action: action.id,
    command: ['cloud', ...action.command].join(' '),
    exitCode,
    ok: exitCode === 0,
    stdout: clampOutput(stdout),
    stderr: clampOutput(stderr),
  }
}

/**
 * The only cockpit pages a member may open. Everything else is the box owner's
 * view (host metrics, services, databases, firewall, the team page, the whole
 * serverless surface), so a member is sent back to their sites.
 *
 * An allowlist rather than a blocklist: a page added later is box-only until
 * someone deliberately decides otherwise.
 */
const MEMBER_PAGES: ReadonlySet<string> = new Set([
  '/server/sites',
  '/server/deployments',
  '/server/logs',
  '/access-denied',
])

export function isBoxOnlyPage(pathname: string): boolean {
  // Assets (.css/.js/.svg/...) are shared chrome and carry no tenant data — the
  // per-scope build already decides what's in the HTML.
  const ext = extname(pathname)
  if (ext && ext !== '.html')
    return false
  const clean = pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/'
  if (clean === '/')
    return false // handled earlier by the member redirect
  return !MEMBER_PAGES.has(clean)
}

function staticPath(uiRoot: string, pathname: string): string | null {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '')
  const wanted = clean === '' ? 'index.html' : clean
  const normalized = normalize(wanted)
  if (normalized.startsWith('..') || normalized.includes('/../'))
    return null
  const base = join(uiRoot, normalized)
  // A real file wins. A directory does NOT (e.g. `/serverless` must serve the
  // sibling `serverless.html`, not the `serverless/` dir), so fall through to the
  // `.html` and `index.html` resolutions when `base` is a directory.
  if (existsSync(base) && !statSync(base).isDirectory())
    return base
  if (!extname(base) && existsSync(`${base}.html`))
    return `${base}.html`
  if (!extname(base) && existsSync(join(base, 'index.html')))
    return join(base, 'index.html')
  return null
}

async function serveStatic(uiRoot: string, pathname: string): Promise<Response> {
  const file = staticPath(uiRoot, pathname)
  if (!file) {
    const notFound = join(uiRoot, '404.html')
    if (existsSync(notFound))
      return new Response(await readFile(notFound), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } })
    return text('Not found', 404)
  }
  if (statSync(file).isDirectory())
    return text('Not found', 404)
  const body = await readFile(file)
  const type = contentTypes[extname(file)] ?? 'application/octet-stream'
  return new Response(body, { headers: { 'content-type': type } })
}

export async function startLocalDashboardServer(options: LocalDashboardServerOptions = {}): Promise<LocalDashboardServer> {
  pruneDashboardTempRoots()
  const cwd = options.cwd ?? process.cwd()
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const cliEntry = options.cliEntry ?? process.argv[1]
  // Box mode: route all driver work to the local machine for the rest of this
  // process (set before any createCloudDriver call resolves a driver).
  if (options.box)
    process.env.TS_CLOUD_DASHBOARD_BOX = '1'
  await loadLocalEnv(cwd)
  const config = await loadCloudConfig()
  const controlPlane = initializeDashboardControlPlane(cwd, config as CloudConfig)
  if (controlPlane.reconciliation.failed > 0) {
    console.warn(`  ts-cloud dashboard: marked ${controlPlane.reconciliation.failed} orphaned operation(s) as failed after restart.`)
  }
  const availableEnvironments = Object.keys((config as CloudConfig).environments ?? {})
  // Environment scope belongs to each URL/request, not this process. This is
  // what lets two tabs safely inspect or operate on different environments.
  const defaultEnvironment = selectedEnvironment(config as CloudConfig, options.environment)
  const configPath = resolveCloudConfigPath(cwd)
  const initialData = await resolveLiveDashboardData(config as CloudConfig, defaultEnvironment)
  const latestDataByEnvironment = new Map<EnvironmentType, Record<string, any>>([[defaultEnvironment, initialData]])
  const packagedUi = resolveUiSource(cwd)

  // The stx pages render their data at BUILD time (baked into the HTML), so a
  // single shared build would hand every visitor every tenant's sites, logs and
  // deploy history — API scoping alone would protect nothing. Instead we build
  // one UI per distinct access scope and cache it. Users with identical grants
  // share a build, so a box with a handful of collaborators builds a handful of
  // times, not once per request.
  const uiCache = new Map<string, string>()
  const uiBuilds = new Map<string, Promise<string | undefined>>()
  const ownedUiRoots = new Set<string>()
  let uiGeneration = 0

  function clearUiCache(): void {
    uiGeneration += 1
    uiCache.clear()
    for (const root of ownedUiRoots)
      rmSync(root, { recursive: true, force: true })
    ownedUiRoots.clear()
  }

  const scopeKey = (user: DashboardUser, environment: EnvironmentType): string => `${environment}:${user.role === 'admin'
    ? 'admin'
    : `member:${Object.entries(user.sites).sort(([a], [b]) => a.localeCompare(b)).map(([site, role]) => `${site}=${role}`).join(',')}`}`

  async function uiRootFor(user: DashboardUser, environment: EnvironmentType): Promise<string | undefined> {
    const key = scopeKey(user, environment)
    const cached = uiCache.get(key)
    if (cached)
      return cached
    const pending = uiBuilds.get(key)
    if (pending)
      return pending

    const generation = uiGeneration
    const build = (async (): Promise<string | undefined> => {
      // `viewer` tells the nav which surfaces to offer. Only the ROLE is baked in,
      // never the username: builds are shared by everyone with the same grants, so
      // a name baked here would show up in someone else's page.
      const latestData = latestDataByEnvironment.get(environment)
        ?? await resolveLiveDashboardData(config as CloudConfig, environment)
      latestDataByEnvironment.set(environment, latestData)
      const scoped = {
        ...scopeDashboardData(latestData, { user, slug: (config as CloudConfig).project.slug }),
        viewer: { role: user.role },
      }
      // A failed build falls back to the packaged UI, which ships no baked data
      // (it renders its placeholder sample and hydrates from /api/*), so the
      // fallback can't leak either.
      const liveRoot = await buildLiveUi(cwd, scoped)
      if (liveRoot && generation !== uiGeneration) {
        rmSync(liveRoot, { recursive: true, force: true })
        return packagedUi?.uiRoot
      }
      if (liveRoot)
        ownedUiRoots.add(liveRoot)
      const root = liveRoot ?? packagedUi?.uiRoot
      if (root)
        uiCache.set(key, root)
      return root
    })()
    uiBuilds.set(key, build)
    try {
      return await build
    }
    finally {
      uiBuilds.delete(key)
    }
  }

  // Prime the admin build and fail fast if there's no UI at all to serve.
  const adminUiRoot = await uiRootFor({ username: '', passwordHash: '', role: 'admin', sites: {} }, defaultEnvironment)
  if (!adminUiRoot)
    throw new Error('ts-cloud dashboard UI not found. Run `bun run build` in ts-cloud or reinstall the package.')

  // Web-terminal sessions, one shell per open WebSocket connection.
  const terminalSessions = new WeakMap<object, ReturnType<typeof createTerminalSession>>()
  const terminalEnabled = process.env.TS_CLOUD_DASHBOARD_TERMINAL !== '0'

  // Authentication is on by default. It can be turned off for local work, but
  // never in box mode: there the dashboard sits behind a public proxy, so
  // disabling auth would expose a root shell to the internet.
  const authDisabled = process.env.TS_CLOUD_DASHBOARD_AUTH === '0'
  if (authDisabled && options.box)
    throw new Error('TS_CLOUD_DASHBOARD_AUTH=0 is refused in box mode: the dashboard is internet-facing there, and disabling auth would expose a root shell.')
  const authEnabled = !authDisabled

  const secret = resolveSessionSecret(cwd)
  const guard = createDashboardGuard({ cwd, enabled: authEnabled, secret })

  // The login is internet-facing and guards a box hosting other people's sites,
  // so failed attempts are rate-limited. Pruned periodically so the counters
  // cannot grow without bound; unref'd so it never holds the process open.
  const throttle = new LoginThrottle()
  const throttleSweep = setInterval(() => throttle.prune(), 5 * 60 * 1000)
  throttleSweep.unref?.()

  if (authEnabled) {
    const bootstrap = ensureAdminUser(cwd, process.env.TS_CLOUD_UI_USERNAME?.trim() || 'admin')
    if (bootstrap.generated) {
      console.warn(`\n  ts-cloud dashboard: created the first admin.\n    username: ${bootstrap.generated.username}\n    password: ${bootstrap.generated.password}\n  Saved (hashed) to .ts-cloud/dashboard-users.json. This password is shown once.\n`)
    }
  }
  else {
    console.warn('  ts-cloud dashboard: authentication is DISABLED (TS_CLOUD_DASHBOARD_AUTH=0). Every request runs as an admin.')
  }

  // Cookies are marked Secure unless we're serving plain http on loopback.
  const cookieSecure = host !== '127.0.0.1' && host !== 'localhost'

  const server = Bun.serve({
    hostname: host,
    port,
    websocket: {
      open(ws) {
        if (!terminalEnabled) {
          ws.send('The web terminal is disabled (TS_CLOUD_DASHBOARD_TERMINAL=0).\r\n')
          ws.close()
          return
        }
        const session = createTerminalSession(chunk => ws.send(chunk), {
          cwd,
          onExit: () => { try { ws.close() } catch { /* already closed */ } },
        })
        terminalSessions.set(ws, session)
        ws.send(`Connected to ${host === '127.0.0.1' ? 'localhost' : host} shell. This is a line-oriented shell (no full-screen apps).\r\n`)
      },
      message(ws, message) {
        terminalSessions.get(ws)?.write(typeof message === 'string' ? message : new TextDecoder().decode(message))
      },
      close(ws) {
        terminalSessions.get(ws)?.close()
        terminalSessions.delete(ws)
      },
    },
    async fetch(req, server) {
      const url = new URL(req.url)
      const requestedEnvironment = url.searchParams.get('env')
      const environment = resolveDashboardEnvironment(availableEnvironments, defaultEnvironment, requestedEnvironment)
      let latestData = latestDataByEnvironment.get(environment)
      if (!latestData) {
        latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
        latestDataByEnvironment.set(environment, latestData)
      }

      try {
        // --- Public: the login endpoints and the login page itself ----------
        if (url.pathname === '/api/login' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const username = String(body.username ?? '').trim()
          const password = String(body.password ?? '')
          const address = server.requestIP(req)?.address ?? 'unknown'

          const gate = throttle.check(username, address)
          if (!gate.allowed) {
            return json(
              { ok: false, error: `Too many failed attempts. Try again in ${Math.ceil((gate.retryAfterSeconds ?? 0) / 60)} minute(s).` },
              429,
              { 'retry-after': String(gate.retryAfterSeconds ?? 60) },
            )
          }

          const user = findUser(loadUsers(cwd), username)

          // Verify against a dummy hash when the user is unknown, so a missing
          // user and a wrong password take the same time and can't be told
          // apart by an attacker enumerating usernames.
          const hash = user?.passwordHash || DUMMY_HASH
          const ok = verifyPassword(password, hash) && !!user
          if (!ok) {
            throttle.recordFailure(username, address)
            return json({ ok: false, error: 'Incorrect username or password.' }, 401)
          }

          throttle.recordSuccess(username, address)
          const token = createSessionToken(user!.username, secret)
          return json({ ok: true, user: describeUser(user!) }, 200, {
            'set-cookie': serializeSessionCookie(token, { secure: cookieSecure }),
          })
        }

        if (url.pathname === '/api/logout' && req.method === 'POST') {
          const cookie = clearSessionCookie({ secure: cookieSecure })
          // The nav signs out with a plain form post (no client JS), so send a
          // browser back to the login page instead of a JSON body it would render.
          if (req.headers.get('accept')?.includes('text/html'))
            return new Response(null, { status: 302, headers: { 'location': '/login', 'set-cookie': cookie } })
          return json({ ok: true }, 200, { 'set-cookie': cookie })
        }

        if (url.pathname === '/login') {
          return new Response(renderLoginPage(initialData?.mode === 'serverless'), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }

        // --- Everything else requires a session ----------------------------
        const user = guard.resolveUser(req)
        if (!user) {
          // Browsers navigating get the login page; API callers get a 401 they
          // can act on rather than a page they'd have to parse.
          if (!url.pathname.startsWith('/api/') && req.headers.get('accept')?.includes('text/html'))
            return new Response(null, { status: 302, headers: { location: '/login' } })
          return json({ ok: false, error: 'Sign in to continue.' }, 401)
        }

        if (url.pathname === '/api/me')
          return json({ ok: true, user: describeUser(user), authEnabled })

        if (url.pathname.startsWith('/api/')) {
          const site = await siteFromRequest(req, url.pathname)
          const decision = guard.check(req, url.pathname, user, site)
          if (!decision.ok)
            return json({ ok: false, error: decision.error }, decision.status ?? 403)
        }

        if (url.pathname === '/api/terminal') {
          if (!terminalEnabled)
            return json({ ok: false, error: 'The web terminal is disabled.' }, 403)
          // The gate above already refused any non-admin, so an upgraded socket
          // always belongs to someone entitled to a root shell.
          if (server.upgrade(req))
            return undefined
          return text('WebSocket upgrade failed', 400)
        }

        if (url.pathname === '/api/health') {
          const storage = controlPlane.store.health()
          return json({
            ok: true,
            cwd,
            environment,
            environments: availableEnvironments,
            uiRoot: await uiRootFor(user, environment),
            liveData: uiCache.size > 0,
            terminal: terminalEnabled,
            localPackage: import.meta.url.includes('/Code/Libraries/ts-cloud/'),
            controlPlane: {
              schemaVersion: storage.schemaVersion,
              supportedSchemaVersion: storage.supportedSchemaVersion,
              integrity: storage.integrity,
              pendingRetryableOperations: storage.pendingRetryableOperations,
            },
          })
        }

        if (url.pathname === '/api/control-plane/operations') {
          const state = url.searchParams.get('state')
          const validState = state && ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'].includes(state)
            ? state as 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
            : undefined
          return json({
            operations: controlPlane.store.listOperations({
              projectId: controlPlane.project.id,
              state: validState,
              kind: url.searchParams.get('kind') ?? undefined,
              limit: Number(url.searchParams.get('limit')) || 100,
            }),
          })
        }

        if (url.pathname === '/api/control-plane/events') {
          return json({
            events: controlPlane.store.listEvents({
              projectId: controlPlane.project.id,
              operationId: url.searchParams.get('operationId') ?? undefined,
              correlationId: url.searchParams.get('correlationId') ?? undefined,
              afterSequence: Number(url.searchParams.get('afterSequence')) || undefined,
              limit: Number(url.searchParams.get('limit')) || 200,
            }),
          })
        }

        // The home page is the box's own dashboard (host metrics, services,
        // backups), which a member has no access to — land them on their sites.
        if (url.pathname === '/' && user.role === 'member')
          return new Response(null, { status: 302, headers: { location: `/server/sites?env=${encodeURIComponent(environment)}` } })

        // A serverless deployment has no server home — land on the serverless view.
        if (url.pathname === '/' && latestData?.mode === 'serverless')
          return new Response(null, { status: 302, headers: { location: `/serverless?env=${encodeURIComponent(environment)}` } })

        const legacyRoute = resolveLegacyDashboardRoute(url.pathname)
        if (legacyRoute)
          return new Response(null, { status: 308, headers: { location: `${legacyRoute}?env=${encodeURIComponent(environment)}` } })

        if (url.pathname === '/api/env' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const requested = String(body.env ?? '')
          if (!availableEnvironments.includes(requested))
            return json({ ok: false, error: `Unknown environment '${requested}'.`, environments: availableEnvironments }, 404)
          return json({ ok: true, environment: requested, environments: availableEnvironments, href: `?env=${encodeURIComponent(requested)}` })
        }

        if (url.pathname === '/api/config') {
          const sanitized = { ...sanitizeCloudConfig(config as CloudConfig), environment, environments: availableEnvironments }
          return json(scopeCloudConfig(sanitized, user))
        }

        if (url.pathname === '/api/ssh-keys' && req.method === 'GET') {
          return json({
            configPath,
            keys: describeSshKeys(computeSshKeys(config as CloudConfig)),
          })
        }

        if (url.pathname === '/api/ssh-keys' && req.method === 'POST') {
          if (!configPath)
            return json({ ok: false, error: 'No cloud config file was found in this checkout.' }, 404)
          const body = await readJsonBody(req)
          const before = await readFile(configPath, 'utf8')
          const currentKeys = computeSshKeys(config as CloudConfig)
          const after = addSshKeyToCloudConfig({
            configText: before,
            name: String(body.name ?? ''),
            publicKey: String(body.publicKey ?? ''),
            existingKeys: currentKeys,
          })
          await writeFile(configPath, after)
          replaceComputeSshKeys(config as CloudConfig, [...currentKeys, { name: String(body.name ?? '').trim(), publicKey: String(body.publicKey ?? '').trim().replace(/\s+/g, ' ') }])
          return json({ ok: true, configPath, keys: describeSshKeys(computeSshKeys(config as CloudConfig)) })
        }

        if (url.pathname === '/api/ssh-keys' && req.method === 'DELETE') {
          if (!configPath)
            return json({ ok: false, error: 'No cloud config file was found in this checkout.' }, 404)
          const body = await readJsonBody(req)
          const name = String(body.name ?? url.searchParams.get('name') ?? '')
          const before = await readFile(configPath, 'utf8')
          const currentKeys = computeSshKeys(config as CloudConfig)
          const after = removeSshKeyFromCloudConfig({
            configText: before,
            name,
            existingKeys: currentKeys,
          })
          await writeFile(configPath, after)
          replaceComputeSshKeys(config as CloudConfig, currentKeys.filter(key => key.name !== name.trim()))
          return json({ ok: true, configPath, keys: describeSshKeys(computeSshKeys(config as CloudConfig)) })
        }

        // ── Host firewall (UFW) allowed ports ─────────────────────────────────
        if (url.pathname === '/api/firewall' && req.method === 'GET')
          return json({ configPath, alwaysOpen: [22, 80, 443], ports: computeFirewallPorts(config as CloudConfig) })

        if (url.pathname === '/api/firewall' && req.method === 'POST') {
          if (!configPath)
            return json({ ok: false, error: 'No cloud config file was found in this checkout.' }, 404)
          const body = await readJsonBody(req)
          const port = Number(body.port)
          if (!isValidPort(port))
            return json({ ok: false, error: 'Port must be an integer between 1 and 65535.' }, 422)
          const current = computeFirewallPorts(config as CloudConfig)
          const before = await readFile(configPath, 'utf8')
          try {
            await writeFile(configPath, addFirewallPort(before, port, current))
          }
          catch (error: any) {
            return json({ ok: false, error: error?.message ?? String(error) }, 422)
          }
          const ports = normalizePorts([...current, port])
          replaceFirewallPorts(config as CloudConfig, ports)
          const apply = body.apply === false ? null : await runServerShellCommand(config as CloudConfig, environment, `ufw allow ${port}/tcp`).catch((e: any) => ({ ok: false, error: String(e?.message ?? e) }))
          return json({ ok: true, configPath, ports, apply })
        }

        if (url.pathname === '/api/firewall' && req.method === 'DELETE') {
          if (!configPath)
            return json({ ok: false, error: 'No cloud config file was found in this checkout.' }, 404)
          const body = await readJsonBody(req)
          const port = Number(body.port ?? url.searchParams.get('port'))
          if (!isValidPort(port))
            return json({ ok: false, error: 'Port must be an integer between 1 and 65535.' }, 422)
          const current = computeFirewallPorts(config as CloudConfig)
          const before = await readFile(configPath, 'utf8')
          await writeFile(configPath, removeFirewallPort(before, port, current))
          const ports = normalizePorts(current.filter(p => p !== port))
          replaceFirewallPorts(config as CloudConfig, ports)
          const apply = body.apply === false ? null : await runServerShellCommand(config as CloudConfig, environment, `ufw delete allow ${port}/tcp`).catch((e: any) => ({ ok: false, error: String(e?.message ?? e) }))
          return json({ ok: true, configPath, ports, apply })
        }

        if (url.pathname === '/api/sites' && req.method === 'POST') {
          if (!configPath)
            return json({ ok: false, error: 'No cloud config file was found in this checkout.' }, 404)
          const body = await readJsonBody(req)
          const siteName = String(body.name ?? '').trim()
          const root = String(body.root ?? '').trim()
          if (!siteName || !root)
            return json({ ok: false, error: 'Site name and root are required.' }, 422)
          const site = {
            deploy: body.deploy === 'bucket' ? 'bucket' : 'server',
            root,
            path: String(body.path ?? '').trim() || undefined,
            domain: String(body.domain ?? '').trim() || undefined,
            build: String(body.build ?? '').trim() || undefined,
            start: String(body.start ?? '').trim() || undefined,
            port: body.port ? Number(body.port) : undefined,
            type: String(body.type ?? '').trim() || undefined,
          }
          if (site.port !== undefined && (!Number.isInteger(site.port) || site.port < 1 || site.port > 65_535))
            return json({ ok: false, error: 'Port must be a number between 1 and 65535.' }, 422)
          const before = await readFile(configPath, 'utf8')
          const after = addSiteToCloudConfig({
            configText: before,
            name: siteName,
            root: site.root,
            domain: site.domain,
            path: site.path,
            deploy: site.deploy as 'bucket' | 'server',
            build: site.build,
            start: site.start,
            port: site.port,
            type: site.type,
          })
          await writeFile(configPath, after)
          replaceSiteConfig(config as CloudConfig, siteName, Object.fromEntries(Object.entries(site).filter(([, value]) => value !== undefined)))
          latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
          latestDataByEnvironment.set(environment, latestData)
          return json({ ok: true, configPath, site: siteName, data: latestData })
        }

        if (url.pathname === '/api/sites' && req.method === 'DELETE') {
          if (!configPath)
            return json({ ok: false, error: 'No cloud config file was found in this checkout.' }, 404)
          const body = await readJsonBody(req)
          const name = String(body.name ?? url.searchParams.get('name') ?? '').trim()
          if (!name || !(config.sites as any)?.[name])
            return json({ ok: false, error: `Site '${name}' was not found.` }, 404)
          const before = await readFile(configPath, 'utf8')
          await writeFile(configPath, removeSiteFromCloudConfig({ configText: before, name }))
          delete (config.sites as Record<string, unknown>)[name]
          latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
          latestDataByEnvironment.set(environment, latestData)
          return json({ ok: true, configPath, site: name, data: latestData })
        }

        if (url.pathname === '/api/sites' && req.method === 'PATCH') {
          if (!configPath)
            return json({ ok: false, error: 'No cloud config file was found in this checkout.' }, 404)
          const body = await readJsonBody(req)
          const name = String(body.name ?? '').trim()
          const existing = (config.sites as any)?.[name]
          if (!name || !existing)
            return json({ ok: false, error: `Site '${name}' was not found.` }, 404)

          // A member owns their site's content, not the server it runs on.
          // `build`/`start` are shell commands run as root at deploy time and
          // `root` is a filesystem path, so those stay with the box owner —
          // otherwise `site:settings` would quietly be root on a shared box.
          if (user.role === 'member') {
            const fields = checkMemberSiteFields(body)
            if (!fields.ok)
              return json({ ok: false, error: fields.error }, 403)

            // Routing is theirs to set, but not to take from someone else.
            const conflict = checkRouteConflict({
              siteName: name,
              body,
              sites: (config.sites ?? {}) as Record<string, any>,
              ownSites: Object.keys(user.sites),
            })
            if (!conflict.ok)
              return json({ ok: false, error: conflict.error }, 409)
          }

          if (body.port !== undefined && body.port !== null && body.port !== '' && (!Number.isInteger(Number(body.port)) || Number(body.port) < 1 || Number(body.port) > 65_535))
            return json({ ok: false, error: 'Port must be a number between 1 and 65535.' }, 422)

          // `domain` lands in the generated nginx `server_name`, so it must be a
          // hostname and nothing else — an unvalidated value can close the
          // server block and open an attacker-controlled one. `aliases` (same
          // destination) has always been checked; this closes the gap for the
          // primary domain. Validated before any write so a bad value can't
          // leave the config half-edited.
          if (typeof body.domain === 'string' && body.domain.trim() && !isValidHostname(body.domain.trim()))
            return json({ ok: false, error: `Domain '${body.domain.trim()}' is not a valid hostname.` }, 422)

          let text = await readFile(configPath, 'utf8')
          const set = (key: string, valueText: string): void => {
            text = setSitePropertyInCloudConfig({ configText: text, siteName: name, key, valueText })
          }
          if (body.ssl !== undefined) {
            set('ssl', renderSslValue(body.ssl))
            existing.ssl = body.ssl
          }
          if (body.env !== undefined && body.env && typeof body.env === 'object') {
            set('env', renderEnvValue(body.env))
            existing.env = body.env
          }
          if (body.aliases !== undefined && Array.isArray(body.aliases)) {
            const aliases = body.aliases.map((a: any) => String(a))
            set('aliases', renderAliasesValue(aliases))
            existing.aliases = aliases.map((a: string) => a.trim().toLowerCase()).filter(Boolean)
          }
          if (body.redirects !== undefined && body.redirects && typeof body.redirects === 'object') {
            set('redirects', renderRedirectsValue(body.redirects))
            existing.redirects = body.redirects
          }
          for (const key of ['domain', 'path', 'build', 'start', 'type', 'root', 'php']) {
            if (typeof body[key] === 'string' && body[key].trim()) {
              set(key, renderStringValue(String(body[key]).trim()))
              existing[key] = String(body[key]).trim()
            }
          }
          if (body.port !== undefined && body.port !== null && body.port !== '') {
            set('port', String(Number(body.port)))
            existing.port = Number(body.port)
          }
          await writeFile(configPath, text)
          latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
          latestDataByEnvironment.set(environment, latestData)
          return json({ ok: true, configPath, site: name, data: latestData })
        }

        if (url.pathname === '/api/sites/deploy' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const name = String(body.name ?? '').trim()
          if (!name || !(config.sites as any)?.[name])
            return json({ ok: false, error: `Site '${name}' was not found.` }, 404)
          if (body.confirm !== name)
            return json({ ok: false, error: `Type "${name}" to deploy this site.` }, 409)
          const action: DashboardAction = {
            id: `deploy:${name}`,
            label: `Deploy ${name}`,
            description: `Deploy the ${name} site for ${environment}.`,
            command: ['deploy', '--env', environment, '--site', name, '--yes'],
            mutates: true,
          }
          const tracked = await trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: 'dashboard.site.deploy',
            resourceSlug: name,
            input: { site: name },
            execute: () => runAction(action, { cwd, cliEntry }) as Promise<{ ok: boolean } & Record<string, any>>,
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation })
        }

        if (url.pathname === '/api/actions')
          return json(dashboardActions(environment))

        if (url.pathname === '/api/server/operations')
          return json(buildDashboardOperations(config as CloudConfig, latestData))

        if (url.pathname === '/api/databases' && req.method === 'GET')
          return json(await listDatabases(config as CloudConfig, environment))

        if (url.pathname === '/api/databases' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const name = String(body.name ?? '').trim()
          if (!isValidDbIdentifier(name))
            return json({ ok: false, error: 'Database name must be a valid identifier (letters, numbers, underscore; not starting with a digit).' }, 422)
          return json({ ...(await createDatabase(config as CloudConfig, environment, name)), name })
        }

        if (url.pathname === '/api/databases/backups' && req.method === 'GET')
          return json(await listDatabaseBackups(config as CloudConfig, environment))

        if (url.pathname === '/api/databases/backup' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const name = String(body.database ?? '').trim()
          if (!isValidDbIdentifier(name))
            return json({ ok: false, error: 'Database name must be a valid identifier.' }, 422)
          if (body.confirm !== name)
            return json({ ok: false, error: `Type "${name}" to back up this database.` }, 409)
          return json(await backupDatabase(config as CloudConfig, environment, name))
        }

        if (url.pathname === '/api/databases/users' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const username = String(body.username ?? '').trim()
          const password = String(body.password ?? '')
          const database = String(body.database ?? '').trim() || undefined
          const access = body.access === 'readonly' ? 'readonly' : 'all'
          if (!isValidDbIdentifier(username))
            return json({ ok: false, error: 'Username must be a valid identifier.' }, 422)
          if (!password)
            return json({ ok: false, error: 'Password is required.' }, 422)
          if (database && !isValidDbIdentifier(database))
            return json({ ok: false, error: 'Database must be a valid identifier.' }, 422)
          return json({ ...(await createDatabaseUser(config as CloudConfig, environment, { username, password, database, access })), username })
        }

        if (url.pathname === '/api/dashboard-data') {
          latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
          latestDataByEnvironment.set(environment, latestData)
          return json(scopeDashboardData(latestData, { user, slug: (config as CloudConfig).project.slug }))
        }

        // --- Collaborators -------------------------------------------------
        if (url.pathname === '/api/users' && req.method === 'GET')
          return json({ ok: true, users: loadUsers(cwd).map(describeUser) })

        if (url.pathname === '/api/users' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const username = String(body.username ?? '').trim()
          if (!isValidUsername(username))
            return json({ ok: false, error: 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore.' }, 422)

          // Grants may only name sites that exist, and only with a known role.
          const requested = (body.sites && typeof body.sites === 'object') ? body.sites as Record<string, string> : {}
          const known = new Set(Object.keys((config as CloudConfig).sites ?? {}))
          const sites: Record<string, 'owner' | 'collaborator'> = {}
          for (const [site, role] of Object.entries(requested)) {
            if (!known.has(site))
              return json({ ok: false, error: `Site '${site}' was not found.` }, 404)
            if (role !== 'owner' && role !== 'collaborator')
              return json({ ok: false, error: `Unknown site role '${role}'. Use 'owner' or 'collaborator'.` }, 422)
            sites[site] = role
          }

          const password = typeof body.password === 'string' && body.password.trim() ? body.password.trim() : undefined
          if (password && password.length < 12)
            return json({ ok: false, error: 'Password must be at least 12 characters.' }, 422)

          const result = upsertMember(cwd, { username, password, name: typeof body.name === 'string' ? body.name : undefined, sites })
          // Their grants changed, so any UI built for their old scope is stale.
          clearUiCache()
          // The generated password is returned once, at creation, and never stored.
          return json({ ok: true, user: describeUser(result.user), password: result.password })
        }

        if (url.pathname === '/api/users' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const username = String(body.username ?? '').trim()
          if (username.toLowerCase() === user.username.toLowerCase())
            return json({ ok: false, error: 'You cannot remove your own account.' }, 409)
          const result = removeUser(cwd, username)
          if (!result.ok)
            return json(result, 409)
          uiCache.clear()
          return json({ ok: true, username })
        }

        if (url.pathname === '/api/actions/run' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { action?: string, confirm?: string }
          const action = body.action ? resolveDashboardAction(body.action, environment) : undefined
          if (!action)
            return json({ ok: false, error: 'Unknown dashboard action.' }, 404)
          if (action.mutates && body.confirm !== action.confirm)
            return json({ ok: false, error: `Type "${action.confirm}" to run this action.` }, 409)
          const tracked = await trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: `dashboard.action.${action.id}`,
            input: { action: action.id },
            execute: () => runAction(action, { cwd, cliEntry }) as Promise<{ ok: boolean } & Record<string, any>>,
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation })
        }

        if (url.pathname === '/api/server/operations/run' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { operation?: string, confirm?: string, to?: string }
          const operation = body.operation ? resolveDashboardOperation(body.operation, config as CloudConfig, latestData) : undefined
          if (!operation)
            return json({ ok: false, error: 'Unknown or unavailable server operation.' }, 404)
          if (operation.mutates && body.confirm !== operation.confirm)
            return json({ ok: false, error: `Type "${operation.confirm}" to run this operation.` }, 409)
          const tracked = await trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: `dashboard.server.${operation.id}`,
            resourceSlug: operation.target,
            input: { operation: operation.id, target: operation.target, to: body.to ?? null },
            execute: () => runDashboardOperation(config as CloudConfig, environment, operation, { to: body.to }),
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation })
        }

        if (url.pathname === '/api/server/command' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { command?: string, confirm?: string }
          if (body.confirm !== 'run')
            return json({ ok: false, error: 'Type "run" to execute this command on the server.' }, 409)
          const tracked = await trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: 'dashboard.server.command',
            input: { source: 'interactive-command' },
            execute: () => runServerShellCommand(config as CloudConfig, environment, String(body.command ?? '')),
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation })
        }

        // ── Serverless (Vapor-style) mutating operations ──────────────────────
        if (url.pathname === '/api/serverless/operations')
          return json(buildServerlessOperations(config as CloudConfig, environment, latestData))

        if (url.pathname === '/api/serverless/operations/run' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { operation?: string, confirm?: string, min?: number, max?: number }
          const operation = body.operation ? resolveServerlessOperation(body.operation, config as CloudConfig, environment, latestData) : undefined
          if (!operation)
            return json({ ok: false, error: 'Unknown or unavailable serverless operation.' }, 404)
          if (operation.mutates && body.confirm !== operation.confirm)
            return json({ ok: false, error: `Type "${operation.confirm}" to run this operation.` }, 409)
          const tracked = await trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: `dashboard.serverless.${operation.id}`,
            input: { operation: operation.id, min: body.min ?? null, max: body.max ?? null },
            execute: () => runServerlessOperation(config as CloudConfig, environment, operation, { min: body.min, max: body.max }),
          })
          latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
          latestDataByEnvironment.set(environment, latestData)
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation })
        }

        if (url.pathname === '/api/serverless/command' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { command?: string, confirm?: string }
          if (body.confirm !== 'run')
            return json({ ok: false, error: 'Type "run" to execute this command.' }, 409)
          return json(await runServerlessCommand(config as CloudConfig, environment, String(body.command ?? '')))
        }

        if (url.pathname === '/api/serverless/dlq' && req.method === 'GET') {
          const max = Number(url.searchParams.get('max')) || 10
          return json(await listDlqMessages(config as CloudConfig, environment, max))
        }

        if (url.pathname === '/api/serverless/dlq/redrive' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { confirm?: string, max?: number, targetQueue?: string }
          if (body.confirm !== 'redrive')
            return json({ ok: false, error: 'Type "redrive" to move messages back onto a source queue.' }, 409)
          return json(await redriveDlq(config as CloudConfig, environment, { max: body.max, targetQueue: body.targetQueue }))
        }

        if (url.pathname === '/api/serverless/dlq/purge' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { confirm?: string }
          if (body.confirm !== 'purge')
            return json({ ok: false, error: 'Type "purge" to permanently discard every DLQ message.' }, 409)
          return json(await purgeDlq(config as CloudConfig, environment))
        }

        if (url.pathname === '/api/serverless/secrets' && req.method === 'GET')
          return json({ secrets: configuredSecretIds(config as CloudConfig, environment) })

        if (url.pathname === '/api/serverless/secrets' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { secretId?: string, value?: string }
          const secretId = String(body.secretId ?? '').trim()
          if (!secretId)
            return json({ ok: false, error: 'A secret id is required.' }, 422)
          if (typeof body.value !== 'string' || body.value === '')
            return json({ ok: false, error: 'A non-empty value is required.' }, 422)
          return json(await setServerlessSecret(config as CloudConfig, environment, secretId, body.value))
        }

        if (url.pathname === '/api/serverless/secrets' && req.method === 'DELETE') {
          const body = await req.json().catch(() => ({})) as { secretId?: string, confirm?: string }
          const secretId = String(body.secretId ?? '').trim()
          if (!secretId)
            return json({ ok: false, error: 'A secret id is required.' }, 422)
          if (body.confirm !== secretId)
            return json({ ok: false, error: `Type "${secretId}" to delete this secret.` }, 409)
          return json(await deleteServerlessSecret(config as CloudConfig, environment, secretId))
        }

        if (url.pathname === '/api/serverless/functions/config' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { mode?: string, memory?: number, timeout?: number, confirm?: string }
          const mode = String(body.mode ?? '').trim()
          if (body.confirm !== mode)
            return json({ ok: false, error: `Type "${mode}" to update this function.` }, 409)
          return json(await updateFunctionConfig(config as CloudConfig, environment, mode, { memory: body.memory, timeout: body.timeout }))
        }

        if (url.pathname === '/api/serverless/alarms' && req.method === 'GET')
          return json(await listAlarms(config as CloudConfig, environment))

        if (url.pathname === '/api/serverless/alarms' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { preset?: string, threshold?: number }
          const preset = String(body.preset ?? '').trim()
          const threshold = Number(body.threshold)
          if (!preset)
            return json({ ok: false, error: 'An alarm metric is required.' }, 422)
          if (!Number.isFinite(threshold))
            return json({ ok: false, error: 'A numeric threshold is required.' }, 422)
          return json(await createAlarm(config as CloudConfig, environment, preset, threshold))
        }

        if (url.pathname === '/api/serverless/alarms' && req.method === 'DELETE') {
          const body = await req.json().catch(() => ({})) as { name?: string, confirm?: string }
          const name = String(body.name ?? '').trim()
          if (!name)
            return json({ ok: false, error: 'An alarm name is required.' }, 422)
          if (body.confirm !== name)
            return json({ ok: false, error: `Type "${name}" to delete this alarm.` }, 409)
          return json(await deleteAlarm(config as CloudConfig, environment, name))
        }

        if (url.pathname === '/api/serverless/traces' && req.method === 'GET') {
          const minutes = Number(url.searchParams.get('minutes')) || 30
          return json(await listTraces(config as CloudConfig, environment, minutes))
        }

        if (url.pathname === '/api/serverless/scheduler' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { action?: string, confirm?: string }
          const action = String(body.action ?? '').trim()
          if (action !== 'enable' && action !== 'disable' && action !== 'run')
            return json({ ok: false, error: 'Unknown scheduler action.' }, 422)
          if (body.confirm !== action)
            return json({ ok: false, error: `Type "${action}" to ${action} the scheduler.` }, 409)
          return json(await controlScheduler(config as CloudConfig, environment, action))
        }

        // Members get the pages built for their scope; the rest of the cockpit
        // is the box owner's. Their data is already withheld, so this is about
        // not handing someone a page whose every request will 403 at them.
        if (user.role === 'member' && isBoxOnlyPage(url.pathname))
          return new Response(null, { status: 302, headers: { location: `/access-denied?env=${encodeURIComponent(environment)}` } })

        const uiRoot = await uiRootFor(user, environment)
        if (!uiRoot)
          return text('ts-cloud dashboard UI is unavailable.', 503)
        return serveStatic(uiRoot, url.pathname)
      }
      catch (error: any) {
        if (options.verbose)
          console.error(error)
        return json({ ok: false, error: error?.message ?? String(error) }, 500)
      }
    },
  })

  const stop = server.stop.bind(server)
  server.stop = ((closeActiveConnections?: boolean) => {
    clearInterval(throttleSweep)
    clearUiCache()
    const result = stop(closeActiveConnections)
    controlPlane.store.close()
    return result
  }) as typeof server.stop

  return { server, url: `http://${host}:${server.port}/` }
}
