import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type { AuthOidcRole, OidcFetch } from '../auth'
import type { AuthorizationCapability, AuthorizationScope, OrganizationRoleTemplate } from '../control-plane'
import type { DashboardUser } from './dashboard-auth'
import { resolveDeploymentMode } from '@ts-cloud/core'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCloudConfig } from '../config'
import { AUTH_SESSION_ABSOLUTE_TTL_MS, AuthenticationStore, beginOidcAuthorization, completeOidcAuthorization, resolveAuthEncryptionKey, sendAuthenticationEmail } from '../auth'
import { AutomationIdentityStore } from '../automation'
import { createApiV1Handler } from '../api'
import { AUTHORIZATION_CAPABILITIES, authorizeOrganization, effectiveCapabilities, searchControlPlane } from '../control-plane'
import { hashPassword, passwordNeedsRehash, verifyPassword } from './dashboard-auth'
import { ensureDashboardActor, initializeDashboardControlPlane, synchronizeDashboardUsers, trackDashboardOperation } from './dashboard-control-plane'
import { resolveDashboardData } from './dashboard-data'
import { resolveServerDashboardData } from './dashboard-data-server'
import { backupDatabase, createDatabase, createDatabaseUser, isValidDbIdentifier, listDatabaseBackups, listDatabases } from './dashboard-database'
import { createDashboardGuard, siteFromRequest } from './dashboard-guard'
import { localLoginRequiresSso, resolveOidcDashboardIdentity, synchronizeDashboardIdentities } from './dashboard-identities'
import { renderLoginPage, renderPasswordRecoveryPage } from './dashboard-login-page'
import { buildDashboardOperations, resolveDashboardOperation, runDashboardOperation, runServerShellCommand } from './dashboard-operations'
import { resolveLegacyDashboardRoute } from './dashboard-route-manifest'
import { scopeCloudConfig, scopeDashboardData } from './dashboard-scope'
import { checkMemberSiteFields, checkRouteConflict } from './dashboard-site-settings'
import { clearSessionCookie, resolveSessionSecret, serializeSessionCookie } from './dashboard-session'
import { LoginThrottle } from './dashboard-throttle'
import { describeUser, ensureAdminUser, findUser, isValidUsername, loadUsers, removeUser, updateUserPassword, upsertMember } from './dashboard-users'
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
  /** Explicit config for embedded/test callers; CLI callers load the project config. */
  config?: CloudConfig
  /** Injectable OIDC transport for deterministic integration tests. */
  oidcFetch?: OidcFetch
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

export function resolveOidcDashboardOrigin(host: string, port: number, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.TS_CLOUD_DASHBOARD_ORIGIN?.trim()
    || (env.TS_CLOUD_UI_DOMAIN?.trim() ? `https://${env.TS_CLOUD_UI_DOMAIN.trim().replace(/^https?:\/\//, '')}` : '')
  const fallbackHost = ['0.0.0.0', '::'].includes(host) ? undefined : host
  const raw = configured || (fallbackHost && ['127.0.0.1', 'localhost', '::1'].includes(fallbackHost) ? `http://${fallbackHost.includes(':') ? `[${fallbackHost}]` : fallbackHost}:${port}` : '')
  if (!raw)
    return undefined
  try {
    const url = new URL(raw)
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
      return undefined
    return url.origin
  }
  catch {
    return undefined
  }
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

/** Reject browser cross-site mutations while retaining header-light CLI access. */
export function isTrustedMutationRequest(req: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()))
    return true
  const site = req.headers.get('sec-fetch-site')
  if (site === 'cross-site')
    return false
  const origin = req.headers.get('origin')
  return !origin || origin === new URL(req.url).origin
}

const ORGANIZATION_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'deployer', 'operator', 'viewer', 'auditor'])
const AUTHORIZATION_SCOPES: ReadonlySet<string> = new Set(['organization', 'project', 'environment', 'resource'])
const RECENT_AUTH_MUTATIONS: ReadonlySet<string> = new Set([
  'POST /api/organization/invitations',
  'DELETE /api/organization/invitations',
  'POST /api/organization/invitations/resend',
  'PATCH /api/organization/memberships',
  'DELETE /api/organization/memberships',
  'POST /api/organization/grants',
  'DELETE /api/organization/grants',
  'POST /api/auth/oidc/providers',
  'PATCH /api/auth/oidc/providers',
  'POST /api/serverless/secrets',
  'DELETE /api/serverless/secrets',
])

function organizationRole(value: unknown): OrganizationRoleTemplate | undefined {
  const role = String(value ?? '')
  return ORGANIZATION_ROLES.has(role) ? role as OrganizationRoleTemplate : undefined
}

function authorizationScope(body: Record<string, any>): AuthorizationScope | undefined {
  const type = String(body.scopeType ?? 'organization')
  if (!AUTHORIZATION_SCOPES.has(type))
    return undefined
  if (type === 'organization')
    return { type: 'organization' }
  const id = String(body.scopeId ?? '').trim()
  return id ? { type: type as Exclude<AuthorizationScope['type'], 'organization'>, id } : undefined
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
  '/account/security',
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

const PAGE_CAPABILITIES: Readonly<Record<string, AuthorizationCapability>> = {
  '/': 'runtime:read',
  '/server/activity': 'audit:read',
  '/server/sites': 'project:read',
  '/server/deployments': 'deployments:read',
  '/server/logs': 'runtime:logs',
  '/server/metrics': 'runtime:read',
  '/server/services': 'runtime:read',
  '/server/workers': 'automation:read',
  '/server/backups': 'backups:read',
  '/server/actions': 'runtime:restart',
  '/server/database': 'data:read',
  '/server/firewall': 'fleet:read',
  '/server/security': 'audit:read',
  '/server/ssh-keys': 'fleet:read',
  '/server/terminal': 'runtime:terminal',
  '/server/team': 'users:read',
  '/account/security': 'project:read',
  '/serverless': 'project:read',
  '/serverless/deployments': 'deployments:read',
  '/serverless/logs': 'runtime:logs',
  '/serverless/metrics': 'runtime:read',
  '/serverless/traces': 'runtime:read',
  '/serverless/functions': 'config:read',
  '/serverless/queues': 'data:read',
  '/serverless/scheduler': 'automation:read',
  '/serverless/data': 'data:read',
  '/serverless/assets': 'project:read',
  '/serverless/secrets': 'secrets:read',
  '/serverless/firewall': 'fleet:read',
  '/serverless/alarms': 'runtime:read',
  '/serverless/cost': 'project:read',
}

export function canOpenDashboardPage(pathname: string, user: DashboardUser & { capabilities?: AuthorizationCapability[], organizationSource?: string }): boolean {
  if (user.role === 'admin')
    return true
  const extension = extname(pathname)
  if (extension && extension !== '.html')
    return true
  if (user.organizationSource === 'legacy')
    return !isBoxOnlyPage(pathname)
  const clean = pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/'
  if (clean === '/access-denied')
    return true
  const required = PAGE_CAPABILITIES[clean]
  return !!required && !!user.capabilities?.includes(required)
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
  const config = options.config ?? await loadCloudConfig()
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

  function dashboardViewUser(user: DashboardUser, environment: EnvironmentType): DashboardUser & { organizationRole?: OrganizationRoleTemplate, organizationSource?: string, capabilities?: AuthorizationCapability[] } {
    if (user.role === 'admin' && !controlPlane.store.getActorByExternalId('user', `dashboard:${user.username.toLowerCase()}`))
      return user
    const actor = controlPlane.store.getActorByExternalId('user', `dashboard:${user.username.toLowerCase()}`)
    const membership = actor ? controlPlane.store.getMembershipForActor(controlPlane.organization.id, actor.id) : undefined
    if (!membership || membership.status !== 'active')
      return { ...user, role: 'member', sites: {}, capabilities: [] }
    const grants = controlPlane.store.listGrants(membership.id)
    const scopeTarget = controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, membership.scope)
      ?? controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, { type: 'project', id: controlPlane.project.id })!
    const capabilities = effectiveCapabilities({ membership, grants, target: scopeTarget })
    if (membership.roleTemplate === 'owner' || membership.roleTemplate === 'admin')
      return { ...user, role: 'admin', sites: {}, organizationRole: membership.roleTemplate, organizationSource: membership.source, capabilities }
    const environmentRecord = controlPlane.environments.get(environment)
    const sites: DashboardUser['sites'] = {}
    for (const resource of controlPlane.store.listResources(controlPlane.project.id, environmentRecord?.id).filter(resource => resource.kind === 'application')) {
      const target = controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, { type: 'resource', id: resource.id })
      if (!target || !authorizeOrganization({ membership, grants, capability: 'project:read', target }).allowed)
        continue
      sites[resource.slug] = authorizeOrganization({ membership, grants, capability: 'config:write', target }).allowed ? 'owner' : 'collaborator'
    }
    return { ...user, role: 'member', sites, organizationRole: membership.roleTemplate, organizationSource: membership.source, capabilities }
  }

  function clearUiCache(): void {
    uiGeneration += 1
    uiCache.clear()
    for (const root of ownedUiRoots)
      rmSync(root, { recursive: true, force: true })
    ownedUiRoots.clear()
  }

  const scopeKey = (user: DashboardUser & { capabilities?: AuthorizationCapability[] }, environment: EnvironmentType): string => `${environment}:${user.role === 'admin'
    ? 'admin'
    : `member:${Object.entries(user.sites).sort(([a], [b]) => a.localeCompare(b)).map(([site, role]) => `${site}=${role}`).join(',')}`}:${[...(user.capabilities ?? [])].sort().join(',')}`

  async function uiRootFor(user: DashboardUser, environment: EnvironmentType): Promise<string | undefined> {
    const viewUser = dashboardViewUser(user, environment)
    const key = scopeKey(viewUser, environment)
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
        ...scopeDashboardData(latestData, { user: viewUser, slug: (config as CloudConfig).project.slug }),
        viewer: { role: viewUser.role, organizationRole: viewUser.organizationRole, organizationSource: viewUser.organizationSource, capabilities: viewUser.capabilities ?? [] },
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
  const bootstrap = authEnabled ? ensureAdminUser(cwd, process.env.TS_CLOUD_UI_USERNAME?.trim() || 'admin') : undefined
  const authentication = new AuthenticationStore(controlPlane.store, { encryptionKey: resolveAuthEncryptionKey(cwd) })
  const automationIdentities = new AutomationIdentityStore(controlPlane.store)
  if (bootstrap) {
    synchronizeDashboardUsers(controlPlane, bootstrap.users)
    synchronizeDashboardIdentities(authentication, controlPlane, bootstrap.users)
  }
  const guard = createDashboardGuard({
    cwd,
    enabled: authEnabled,
    secret,
    authentication,
    authorization: {
      store: controlPlane.store,
      organizationId: controlPlane.organization.id,
      projectId: controlPlane.project.id,
      defaultEnvironment: String(defaultEnvironment),
    },
  })

  // The login is internet-facing and guards a box hosting other people's sites,
  // so failed attempts are rate-limited. Pruned periodically so the counters
  // cannot grow without bound; unref'd so it never holds the process open.
  const throttle = new LoginThrottle()
  const recoveryThrottle = new LoginThrottle(3, 15 * 60 * 1000, 15 * 60 * 1000)
  const mfaThrottle = new LoginThrottle(8, 15 * 60 * 1000, 15 * 60 * 1000)
  const throttleSweep = setInterval(() => throttle.prune(), 5 * 60 * 1000)
  const recoveryThrottleSweep = setInterval(() => recoveryThrottle.prune(), 5 * 60 * 1000)
  const mfaThrottleSweep = setInterval(() => mfaThrottle.prune(), 5 * 60 * 1000)
  throttleSweep.unref?.()
  recoveryThrottleSweep.unref?.()
  mfaThrottleSweep.unref?.()

  if (authEnabled) {
    if (bootstrap?.generated) {
      console.warn(`\n  ts-cloud dashboard: created the first admin.\n    username: ${bootstrap.generated.username}\n    password: ${bootstrap.generated.password}\n  Saved (hashed) to .ts-cloud/dashboard-users.json. This password is shown once.\n`)
    }
  }
  else {
    console.warn('  ts-cloud dashboard: authentication is DISABLED (TS_CLOUD_DASHBOARD_AUTH=0). Every request runs as an admin.')
  }

  // Cookies are marked Secure unless we're serving plain http on loopback.
  const cookieSecure = host !== '127.0.0.1' && host !== 'localhost'
  const networkHint = (address: string): string => createHash('sha256').update(`${secret}:${address}`).digest('hex').slice(0, 16)
  const apiV1 = createApiV1Handler({ controlPlane: controlPlane.store, identities: automationIdentities })
  const userAgentLabel = (req: Request): string | undefined => req.headers.get('user-agent')?.trim().slice(0, 256) || undefined
  const issueSession = (identityId: string, req: Request, address: string, authMethod: 'local' | 'oidc' = 'local') => authentication.createSession({
    identityId,
    authMethod,
    userAgent: userAgentLabel(req),
    networkHint: networkHint(address),
  })
  const organizationPrincipal = (user: DashboardUser) => {
    const actor = controlPlane.store.getActorByExternalId('user', `dashboard:${user.username.toLowerCase()}`)
    const membership = actor ? controlPlane.store.getMembershipForActor(controlPlane.organization.id, actor.id) : undefined
    return { actor, membership, grants: membership ? controlPlane.store.listGrants(membership.id) : [] }
  }

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
    async fetch(req, runtimeServer) {
      const activeServer = runtimeServer ?? server
      const url = new URL(req.url)
      const oidcOrigin = resolveOidcDashboardOrigin(host, activeServer.port ?? port)
      const apiResponse = await apiV1(req, networkHint(activeServer.requestIP(req)?.address ?? 'unknown'))
      if (apiResponse)
        return apiResponse
      const requestedEnvironment = url.searchParams.get('env')
      const environment = resolveDashboardEnvironment(availableEnvironments, defaultEnvironment, requestedEnvironment)
      let latestData = latestDataByEnvironment.get(environment)
      if (!latestData) {
        latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
        latestDataByEnvironment.set(environment, latestData)
      }

      try {
        if (!isTrustedMutationRequest(req))
          return json({ ok: false, error: 'Cross-site requests are not allowed.' }, 403)

        // --- Public: the login endpoints and the login page itself ----------
        const oidcRoute = /^\/auth\/oidc\/([a-z0-9-]+)\/(start|callback)$/.exec(url.pathname)
        if (oidcRoute && req.method === 'GET') {
          const [, providerSlug, action] = oidcRoute
          if (!oidcOrigin)
            return new Response(null, { status: 302, headers: { location: '/login?sso_error=configuration' } })
          if (action === 'start') {
            try {
              const started = await beginOidcAuthorization(authentication, providerSlug, oidcOrigin, url.searchParams.get('return') ?? undefined, options.oidcFetch)
              return new Response(null, { status: 302, headers: { location: started.authorizationUrl, 'cache-control': 'no-store' } })
            }
            catch (error) {
              controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, type: 'auth.oidc.start_failed', level: 'warning', payload: { provider: providerSlug, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' } })
              return new Response(null, { status: 302, headers: { location: '/login?sso_error=start', 'cache-control': 'no-store' } })
            }
          }
          try {
            if (url.searchParams.has('error')) {
              const provider = authentication.getOidcProviderBySlug(providerSlug)
              const state = url.searchParams.get('state')
              if (provider && state)
                authentication.consumeOidcTransaction(provider.id, state)
              throw new Error('OIDC provider returned an authorization error')
            }
            const completed = await completeOidcAuthorization(authentication, {
              providerSlug,
              state: url.searchParams.get('state') ?? '',
              code: url.searchParams.get('code') ?? '',
              origin: oidcOrigin,
            }, options.oidcFetch)
            const resolved = resolveOidcDashboardIdentity(authentication, controlPlane, cwd, completed.identity)
            authentication.recordLogin(resolved.identity.id)
            const issued = issueSession(resolved.identity.id, req, activeServer.requestIP(req)?.address ?? 'unknown', 'oidc')
            clearUiCache()
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: resolved.identity.actorId, type: 'auth.login.succeeded', payload: { method: 'oidc', provider: providerSlug, provisioned: resolved.provisioned } })
            return new Response(null, { status: 302, headers: {
              location: completed.returnPath,
              'cache-control': 'no-store',
              'set-cookie': serializeSessionCookie(issued.token, { secure: cookieSecure, maxAgeMs: AUTH_SESSION_ABSOLUTE_TTL_MS }),
            } })
          }
          catch (error) {
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, type: 'auth.oidc.callback_failed', level: 'warning', payload: { provider: providerSlug, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' } })
            return new Response(null, { status: 302, headers: { location: '/login?sso_error=callback', 'cache-control': 'no-store' } })
          }
        }

        if (url.pathname === '/api/invitations/accept' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const invitationToken = String(body.token ?? '').trim()
          const username = String(body.username ?? '').trim()
          const password = String(body.password ?? '')
          if (!invitationToken || !isValidUsername(username) || password.length < 12)
            return json({ ok: false, error: 'Invitation token, valid username, and a password of at least 12 characters are required.' }, 422)
          const invitation = controlPlane.store.inspectInvitationToken(invitationToken)
          if (!invitation || invitation.state !== 'pending')
            return json({ ok: false, error: invitation ? `Invitation is ${invitation.state}` : 'Invitation is invalid' }, invitation ? 409 : 404)
          const existing = findUser(loadUsers(cwd), username)
          const existingIdentity = authentication.getIdentityByUsername(username)
          if (existing && !verifyPassword(password, existingIdentity?.passwordHash ?? existing.passwordHash))
            return json({ ok: false, error: 'That username already exists; enter its current password to continue.' }, 401)
          const emailOwner = authentication.getIdentityByEmail(invitation.email)
          if (emailOwner && emailOwner.id !== existingIdentity?.id)
            return json({ ok: false, error: 'This invitation belongs to an existing account. Sign in with that account or ask an owner to resend it.' }, 409)
          const result = upsertMember(cwd, {
            username,
            password: existing ? undefined : password,
            name: typeof body.name === 'string' ? body.name : undefined,
            email: invitation.email,
            sites: existing?.sites ?? {},
          })
          const actor = ensureDashboardActor(controlPlane.store, result.user)
          try {
            const accepted = controlPlane.store.acceptInvitation(invitationToken, actor.id)
            const identity = existingIdentity
              ? authentication.setVerifiedEmail(existingIdentity.id, accepted.invitation.email)
              : authentication.createIdentity({ actorId: actor.id, username: result.user.username, email: accepted.invitation.email, emailVerified: true, passwordHash: result.user.passwordHash })
            const issued = issueSession(identity.id, req, activeServer.requestIP(req)?.address ?? 'unknown')
            clearUiCache()
            return json({ ok: true, user: describeUser(result.user), organization: controlPlane.organization, membership: accepted.membership }, 200, {
              'set-cookie': serializeSessionCookie(issued.token, { secure: cookieSecure, maxAgeMs: AUTH_SESSION_ABSOLUTE_TTL_MS }),
            })
          }
          catch (error) {
            if (!existing)
              removeUser(cwd, result.user.username)
            const message = error instanceof Error ? error.message : 'Invitation could not be accepted.'
            return json({ ok: false, error: message }, message.includes('expired') || message.includes('revoked') || message.includes('accepted') ? 409 : 404)
          }
        }

        if (url.pathname === '/api/auth/password-reset/request' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const identifier = String(body.identifier ?? '').trim().toLowerCase()
          const address = activeServer.requestIP(req)?.address ?? 'unknown'
          const gate = recoveryThrottle.check(identifier, address)
          const identity = identifier.includes('@')
            ? authentication.getIdentityByEmail(identifier)
            : authentication.getIdentityByUsername(identifier)
          if (gate.allowed)
            recoveryThrottle.recordFailure(identifier, address)
          if (gate.allowed && identity?.email && identity.emailVerifiedAt && !identity.disabledAt) {
            authentication.revokeActionTokens(identity.id, 'password_reset')
            const created = authentication.createActionToken(identity.id, 'password_reset')
            const resetUrl = `${url.origin}/reset-password?token=${encodeURIComponent(created.token)}`
            const delivered = await sendAuthenticationEmail(config as CloudConfig, {
              to: identity.email,
              subject: 'Reset your ts-cloud password',
              text: `Reset your ts-cloud password: ${resetUrl}\n\nThis link expires in one hour and can be used once.`,
            })
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: identity.actorId, type: 'auth.password_reset.requested', payload: { delivered } })
          }
          return json({ ok: true, message: 'If that account has a verified email, a reset link has been sent.' }, 202)
        }

        if (url.pathname === '/api/auth/password-reset/complete' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const token = String(body.token ?? '').trim()
          const password = String(body.password ?? '')
          if (!token || password.length < 12)
            return json({ ok: false, error: 'A valid reset token and password of at least 12 characters are required.' }, 422)
          try {
            const consumed = authentication.consumeActionToken(token, 'password_reset')
            const passwordHash = hashPassword(password)
            const identity = authentication.updatePassword(consumed.identityId, passwordHash)
            updateUserPassword(cwd, identity.username, passwordHash)
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: identity.actorId, type: 'auth.password_reset.completed' })
            return json({ ok: true, message: 'Password changed. Sign in again.' }, 200, { 'set-cookie': clearSessionCookie({ secure: cookieSecure }) })
          }
          catch (error) {
            const message = error instanceof Error ? error.message : 'Password reset failed.'
            return json({ ok: false, error: message.replace('Action token', 'Reset link') }, message.includes('consumed') || message.includes('expired') ? 409 : 404)
          }
        }

        if (url.pathname === '/api/login' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const username = String(body.username ?? '').trim()
          const password = String(body.password ?? '')
          const address = activeServer.requestIP(req)?.address ?? 'unknown'

          const gate = throttle.check(username, address)
          if (!gate.allowed) {
            return json(
              { ok: false, error: `Too many failed attempts. Try again in ${Math.ceil((gate.retryAfterSeconds ?? 0) / 60)} minute(s).` },
              429,
              { 'retry-after': String(gate.retryAfterSeconds ?? 60) },
            )
          }

          const user = findUser(loadUsers(cwd), username)
          const identity = authentication.getIdentityByUsername(username)

          // Verify against a dummy hash when the user is unknown, so a missing
          // user and a wrong password take the same time and can't be told
          // apart by an attacker enumerating usernames.
          const hash = identity?.passwordHash ?? user?.passwordHash ?? DUMMY_HASH
          const ok = verifyPassword(password, hash) && !!user && !!identity && !identity.disabledAt
          if (!ok) {
            throttle.recordFailure(username, address)
            return json({ ok: false, error: 'Incorrect username or password.' }, 401)
          }

          if (localLoginRequiresSso(authentication, controlPlane, identity!))
            return json({ ok: false, error: 'Single sign-on is required for this account.' }, 403)

          throttle.recordSuccess(username, address)
          let currentIdentity = identity!
          const passwordUpgraded = currentIdentity.requiresPasswordUpgrade || passwordNeedsRehash(currentIdentity.passwordHash)
          if (passwordUpgraded) {
            const passwordHash = hashPassword(password)
            currentIdentity = authentication.rehashPassword(currentIdentity.id, passwordHash)
            updateUserPassword(cwd, currentIdentity.username, passwordHash)
          }
          authentication.recordLogin(currentIdentity.id)
          if (authentication.getMfaFactor(currentIdentity.id)?.state === 'active') {
            const challenge = authentication.createMfaChallenge(currentIdentity.id, 'login')
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: currentIdentity.actorId, type: 'auth.mfa.challenge.created', payload: { purpose: 'login' } })
            return json({ ok: true, mfaRequired: true, challengeToken: challenge.token, passwordUpgraded })
          }
          const issued = issueSession(currentIdentity.id, req, address)
          controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: currentIdentity.actorId, type: 'auth.login.succeeded', payload: { method: 'local' } })
          return json({ ok: true, user: describeUser(user!), passwordUpgraded }, 200, {
            'set-cookie': serializeSessionCookie(issued.token, { secure: cookieSecure, maxAgeMs: AUTH_SESSION_ABSOLUTE_TTL_MS }),
          })
        }

        if (url.pathname === '/api/auth/mfa/complete' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const challengeToken = String(body.challengeToken ?? '').trim()
          const code = String(body.code ?? '').trim()
          const address = activeServer.requestIP(req)?.address ?? 'unknown'
          const challenge = authentication.inspectMfaChallengeToken(challengeToken, 'login')
          const throttleKey = challenge?.identityId ?? 'unknown-mfa'
          const gate = mfaThrottle.check(throttleKey, address)
          if (!gate.allowed)
            return json({ ok: false, error: 'Too many MFA attempts. Try again later.' }, 429, { 'retry-after': String(gate.retryAfterSeconds ?? 60) })
          try {
            const completed = authentication.completeMfaChallenge(challengeToken, code, 'login')
            mfaThrottle.recordSuccess(throttleKey, address)
            const now = new Date().toISOString()
            const issued = authentication.createSession({
              identityId: completed.identity.id,
              userAgent: userAgentLabel(req),
              networkHint: networkHint(address),
              mfaAt: now,
              recentAuthAt: now,
            })
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: completed.identity.actorId, type: 'auth.mfa.succeeded', payload: { purpose: 'login', method: completed.method } })
            return json({ ok: true }, 200, {
              'set-cookie': serializeSessionCookie(issued.token, { secure: cookieSecure, maxAgeMs: AUTH_SESSION_ABSOLUTE_TTL_MS }),
            })
          }
          catch {
            mfaThrottle.recordFailure(throttleKey, address)
            return json({ ok: false, error: 'Authenticator or recovery code is incorrect.' }, 401)
          }
        }

        if (url.pathname === '/api/logout' && req.method === 'POST') {
          const session = guard.resolveSession(req)
          if (session)
            authentication.revokeSession(session.identityId, session.id)
          const cookie = clearSessionCookie({ secure: cookieSecure })
          // The nav signs out with a plain form post (no client JS), so send a
          // browser back to the login page instead of a JSON body it would render.
          if (req.headers.get('accept')?.includes('text/html'))
            return new Response(null, { status: 302, headers: { 'location': '/login', 'set-cookie': cookie } })
          return json({ ok: true }, 200, { 'set-cookie': cookie })
        }

        if (url.pathname === '/login') {
          const providers = authentication.listOidcProviders(controlPlane.organization.id).map(provider => ({ slug: provider.slug, name: provider.name }))
          return new Response(renderLoginPage(initialData?.mode === 'serverless', providers), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }

        if (url.pathname === '/forgot-password' || url.pathname === '/reset-password') {
          return new Response(renderPasswordRecoveryPage(url.pathname === '/reset-password' ? 'reset' : 'request'), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }

        if (url.pathname === '/accept-invitation')
          return serveStatic(adminUiRoot, url.pathname)

        // --- Everything else requires a session ----------------------------
        const user = guard.resolveUser(req)
        if (!user) {
          // Browsers navigating get the login page; API callers get a 401 they
          // can act on rather than a page they'd have to parse.
          if (!url.pathname.startsWith('/api/') && req.headers.get('accept')?.includes('text/html'))
            return new Response(null, { status: 302, headers: { location: '/login' } })
          return json({ ok: false, error: 'Sign in to continue.' }, 401)
        }
        const scopedUser = dashboardViewUser(user, environment)

        if (url.pathname === '/api/me') {
          const actor = controlPlane.store.getActorByExternalId('user', `dashboard:${user.username.toLowerCase()}`)
          const membership = actor ? controlPlane.store.getMembershipForActor(controlPlane.organization.id, actor.id) : undefined
          const target = controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, membership?.scope ?? { type: 'project', id: controlPlane.project.id })
            ?? controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, { type: 'project', id: controlPlane.project.id })!
          return json({
            ok: true,
            user: describeUser(user),
            authEnabled,
            organization: controlPlane.organization,
            membership,
            capabilities: effectiveCapabilities({ membership, grants: membership ? controlPlane.store.listGrants(membership.id) : [], target }),
          })
        }

        if (url.pathname.startsWith('/api/')) {
          const site = await siteFromRequest(req, url.pathname)
          const decision = guard.check(req, url.pathname, user, site)
          if (!decision.ok)
            return json({ ok: false, error: decision.error }, decision.status ?? 403)
          if (RECENT_AUTH_MUTATIONS.has(`${req.method.toUpperCase()} ${url.pathname}`)) {
            const session = guard.resolveSession(req)
            if (!session || !authentication.isRecentlyAuthenticated(session))
              return json({ ok: false, error: 'Recent authentication is required for this change.', stepUpRequired: true }, 401)
          }
        }

        if (url.pathname === '/api/auth/security' && req.method === 'GET') {
          const principal = organizationPrincipal(user)
          const identity = principal.actor ? authentication.getIdentityByActor(principal.actor.id) : undefined
          const session = guard.resolveSession(req)
          return json({
            identity: identity ? {
              username: identity.username,
              email: identity.email,
              emailVerifiedAt: identity.emailVerifiedAt,
              requiresPasswordUpgrade: identity.requiresPasswordUpgrade,
              lastLoginAt: identity.lastLoginAt,
            } : undefined,
            currentSessionId: session?.id,
            sessions: identity ? authentication.listSessions(identity.id, { includeInactive: true }) : [],
            mfa: identity ? {
              factor: authentication.getMfaFactor(identity.id),
              recoveryCodesRemaining: authentication.remainingRecoveryCodes(identity.id),
            } : undefined,
          })
        }

        if (url.pathname === '/api/auth/oidc/providers' && req.method === 'GET') {
          return json({
            providers: authentication.listOidcProviders(controlPlane.organization.id, { includeDisabled: true }),
            callbackOrigin: oidcOrigin,
            callbackPattern: oidcOrigin ? `${oidcOrigin}/auth/oidc/{slug}/callback` : undefined,
            localOwnerRecovery: true,
          })
        }

        if (url.pathname === '/api/auth/oidc/providers' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const identity = principal.actor ? authentication.getIdentityByActor(principal.actor.id) : undefined
          const enforceSso = body.enforceSso === true
          if (enforceSso && (!identity?.emailVerifiedAt || authentication.remainingRecoveryCodes(identity.id) < 1)) {
            return json({ ok: false, error: 'Verify the owner email and generate MFA recovery codes before enforcing SSO.' }, 409)
          }
          try {
            const requestedRole = organizationRole(body.defaultRole)
            const provider = authentication.upsertOidcProvider({
              id: typeof body.id === 'string' ? body.id : undefined,
              organizationId: controlPlane.organization.id,
              slug: String(body.slug ?? ''),
              name: String(body.name ?? ''),
              issuer: String(body.issuer ?? ''),
              clientId: String(body.clientId ?? ''),
              clientSecret: typeof body.clientSecret === 'string' && body.clientSecret ? body.clientSecret : undefined,
              scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : undefined,
              allowedDomains: Array.isArray(body.allowedDomains) ? body.allowedDomains.map(String) : [],
              defaultRole: requestedRole && requestedRole !== 'owner' ? requestedRole as AuthOidcRole : undefined,
              enabled: body.enabled !== false,
              enforceSso,
            })
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: principal.actor?.id, type: 'auth.oidc.provider.configured', payload: { providerId: provider.id, issuer: provider.issuer, enabled: provider.enabled, enforceSso: provider.enforceSso } })
            return json({ ok: true, provider })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'OIDC provider could not be saved.' }, 422)
          }
        }

        if (url.pathname === '/api/auth/oidc/providers' && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const provider = authentication.getOidcProvider(String(body.id ?? ''))
          if (!provider || provider.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'OIDC provider was not found.' }, 404)
          const principal = organizationPrincipal(user)
          const updated = authentication.setOidcProviderEnabled(provider.id, body.enabled === true)
          controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: principal.actor?.id, type: updated.enabled ? 'auth.oidc.provider.enabled' : 'auth.oidc.provider.disabled', payload: { providerId: provider.id } })
          return json({ ok: true, provider: updated })
        }

        if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
          const session = guard.resolveSession(req)
          return json({ currentSessionId: session?.id, sessions: session ? authentication.listSessions(session.identityId, { includeInactive: true }) : [] })
        }

        if (url.pathname === '/api/auth/sessions' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const current = guard.resolveSession(req)
          if (!current)
            return json({ ok: false, error: 'Sign in again to manage sessions.' }, 401)
          const sessionId = String(body.id ?? '')
          const revoked = authentication.revokeSession(current.identityId, sessionId)
          const headers = sessionId === current.id && revoked ? { 'set-cookie': clearSessionCookie({ secure: cookieSecure }) } : undefined
          return json({ ok: revoked, signedOut: sessionId === current.id && revoked }, revoked ? 200 : 404, headers)
        }

        if (url.pathname === '/api/auth/sessions/revoke-others' && req.method === 'POST') {
          const current = guard.resolveSession(req)
          if (!current)
            return json({ ok: false, error: 'Sign in again to manage sessions.' }, 401)
          return json({ ok: true, revoked: authentication.revokeOtherSessions(current.identityId, current.id) })
        }

        if (url.pathname === '/api/auth/password/change' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const currentPassword = String(body.currentPassword ?? '')
          const nextPassword = String(body.password ?? '')
          const principal = organizationPrincipal(user)
          const identity = principal.actor ? authentication.getIdentityByActor(principal.actor.id) : undefined
          if (!identity || !verifyPassword(currentPassword, identity.passwordHash))
            return json({ ok: false, error: 'Current password is incorrect.' }, 401)
          if (nextPassword.length < 12)
            return json({ ok: false, error: 'New password must be at least 12 characters.' }, 422)
          if (verifyPassword(nextPassword, identity.passwordHash))
            return json({ ok: false, error: 'Choose a different password.' }, 409)
          const passwordHash = hashPassword(nextPassword)
          const changed = authentication.updatePassword(identity.id, passwordHash)
          updateUserPassword(cwd, changed.username, passwordHash)
          const issued = issueSession(changed.id, req, activeServer.requestIP(req)?.address ?? 'unknown')
          controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: changed.actorId, type: 'auth.password.changed' })
          return json({ ok: true, message: 'Password changed and other sessions were signed out.' }, 200, {
            'set-cookie': serializeSessionCookie(issued.token, { secure: cookieSecure, maxAgeMs: AUTH_SESSION_ABSOLUTE_TTL_MS }),
          })
        }

        if (url.pathname === '/api/auth/mfa/enroll' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const current = guard.resolveSession(req)
          const principal = organizationPrincipal(user)
          const identity = principal.actor ? authentication.getIdentityByActor(principal.actor.id) : undefined
          if (!current || !identity)
            return json({ ok: false, error: 'Sign in again before enabling MFA.' }, 401)
          if (!verifyPassword(String(body.password ?? ''), identity.passwordHash))
            return json({ ok: false, error: 'Current password is incorrect.' }, 401)
          try {
            const enrollment = authentication.beginTotpEnrollment(identity.id, { issuer: controlPlane.organization.name })
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: identity.actorId, type: 'auth.mfa.enrollment.started' })
            return json({ factor: enrollment.factor, secret: enrollment.secret, uri: enrollment.uri })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'MFA enrollment failed.' }, 409)
          }
        }

        if (url.pathname === '/api/auth/mfa/verify' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const current = guard.resolveSession(req)
          const principal = organizationPrincipal(user)
          const identity = principal.actor ? authentication.getIdentityByActor(principal.actor.id) : undefined
          if (!current || !identity)
            return json({ ok: false, error: 'Sign in again before enabling MFA.' }, 401)
          try {
            const verified = authentication.verifyTotpEnrollment(identity.id, String(body.code ?? ''))
            authentication.markSessionStepUp(current.id, true)
            controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: identity.actorId, type: 'auth.mfa.enabled', payload: { recoveryCodeCount: verified.recoveryCodes.length } })
            return json(verified)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'MFA enrollment failed.' }, 422)
          }
        }

        if (url.pathname === '/api/auth/mfa' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const current = guard.resolveSession(req)
          const principal = organizationPrincipal(user)
          const identity = principal.actor ? authentication.getIdentityByActor(principal.actor.id) : undefined
          if (!current || !identity || !verifyPassword(String(body.password ?? ''), identity.passwordHash))
            return json({ ok: false, error: 'Current password is incorrect.' }, 401)
          const verification = authentication.verifyMfaCode(identity.id, String(body.code ?? ''))
          if (!verification.valid || !verification.method)
            return json({ ok: false, error: 'Authenticator or recovery code is incorrect.' }, 401)
          authentication.disableMfa(identity.id)
          authentication.revokeOtherSessions(identity.id, current.id)
          authentication.markSessionStepUp(current.id)
          controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: identity.actorId, type: 'auth.mfa.disabled', payload: { method: verification.method } })
          return json({ ok: true })
        }

        if (url.pathname === '/api/auth/step-up' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const current = guard.resolveSession(req)
          const principal = organizationPrincipal(user)
          const identity = principal.actor ? authentication.getIdentityByActor(principal.actor.id) : undefined
          if (!current || !identity || !verifyPassword(String(body.password ?? ''), identity.passwordHash))
            return json({ ok: false, error: 'Current password is incorrect.' }, 401)
          const factor = authentication.getMfaFactor(identity.id)
          if (factor?.state === 'active') {
            const verification = authentication.verifyMfaCode(identity.id, String(body.code ?? ''))
            if (!verification.valid)
              return json({ ok: false, error: 'Authenticator or recovery code is incorrect.' }, 401)
          }
          const session = authentication.markSessionStepUp(current.id, factor?.state === 'active')
          controlPlane.store.appendEvent({ organizationId: controlPlane.organization.id, actorId: identity.actorId, type: 'auth.step_up.succeeded', payload: { mfa: factor?.state === 'active' } })
          return json({ ok: true, recentAuthAt: session.recentAuthAt })
        }

        if (url.pathname === '/api/terminal') {
          if (!terminalEnabled)
            return json({ ok: false, error: 'The web terminal is disabled.' }, 403)
          // The gate above already refused any non-admin, so an upgraded socket
          // always belongs to someone entitled to a root shell.
          if (activeServer.upgrade(req))
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
              organizationId: controlPlane.organization.id,
              projectId: controlPlane.project.id,
              operationId: url.searchParams.get('operationId') ?? undefined,
              correlationId: url.searchParams.get('correlationId') ?? undefined,
              afterSequence: Number(url.searchParams.get('afterSequence')) || undefined,
              limit: Number(url.searchParams.get('limit')) || 200,
            }),
          })
        }

        if (url.pathname === '/api/search') {
          const query = String(url.searchParams.get('q') ?? '').trim().slice(0, 128)
          const allowedResourceSlugs = scopedUser.role === 'member' ? new Set(Object.keys(scopedUser.sites)) : undefined
          const results = query
            ? searchControlPlane(controlPlane.store, {
                projectId: controlPlane.project.id,
                query,
                allowedResourceSlugs,
                limit: Number(url.searchParams.get('limit')) || 20,
              })
            : []
          return json({ query, results, stale: false })
        }

        if (url.pathname === '/api/search/preferences' && req.method === 'GET') {
          const actorKey = `dashboard:${user.username.toLowerCase()}`
          return json({
            savedFilters: controlPlane.store.listSavedFilters(actorKey),
            navigation: controlPlane.store.listNavigation(actorKey),
          })
        }

        if (url.pathname === '/api/search/preferences' && req.method === 'POST') {
          const actorKey = `dashboard:${user.username.toLowerCase()}`
          const body = await readJsonBody(req)
          const action = String(body.action ?? '')
          if (action === 'save-filter') {
            return json({ savedFilter: controlPlane.store.saveFilter(actorKey, String(body.name ?? ''), String(body.routeId ?? ''), (body.query ?? {}) as Record<string, any>) })
          }
          if (action === 'favorite') {
            return json({ navigation: controlPlane.store.setFavorite(actorKey, String(body.entityType ?? ''), String(body.entityId ?? ''), body.favorite !== false) })
          }
          if (action === 'visit') {
            return json({ navigation: controlPlane.store.recordNavigation(actorKey, String(body.entityType ?? ''), String(body.entityId ?? '')) })
          }
          return json({ ok: false, error: 'Unknown search preference action.' }, 422)
        }

        if (url.pathname === '/api/search/preferences' && req.method === 'DELETE') {
          const actorKey = `dashboard:${user.username.toLowerCase()}`
          const body = await readJsonBody(req)
          return json({ ok: controlPlane.store.deleteSavedFilter(actorKey, String(body.id ?? '')) })
        }

        if (url.pathname === '/api/organization' && req.method === 'GET') {
          const memberships = controlPlane.store.listMemberships(controlPlane.organization.id, { includeRevoked: true }).map((membership) => {
            const actor = controlPlane.store.getActor(membership.actorId)
            return {
              ...membership,
              actor: actor ? { id: actor.id, displayName: actor.displayName, externalId: actor.externalId, disabledAt: actor.disabledAt } : undefined,
              grants: controlPlane.store.listGrants(membership.id),
            }
          })
          return json({
            organization: controlPlane.organization,
            project: controlPlane.project,
            environments: controlPlane.store.listEnvironments(controlPlane.project.id),
            resources: controlPlane.store.listResources(controlPlane.project.id).map(resource => ({
              id: resource.id,
              environmentId: resource.environmentId,
              kind: resource.kind,
              slug: resource.slug,
              name: resource.name,
            })),
            memberships,
            invitations: controlPlane.store.listInvitations(controlPlane.organization.id),
          })
        }

        if (url.pathname === '/api/organization/invitations' && req.method === 'GET')
          return json({ invitations: controlPlane.store.listInvitations(controlPlane.organization.id) })

        if (url.pathname === '/api/organization/invitations' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const roleTemplate = organizationRole(body.roleTemplate)
          const scope = authorizationScope(body)
          if (!roleTemplate || !scope)
            return json({ ok: false, error: 'Choose a valid role template and resource scope.' }, 422)
          const principal = organizationPrincipal(user)
          if (!principal.actor || !principal.membership)
            return json({ ok: false, error: 'Your organization membership is unavailable.' }, 403)
          if (roleTemplate === 'owner' && (!verifyPassword(String(body.password ?? ''), user.passwordHash) || principal.membership.roleTemplate !== 'owner'))
            return json({ ok: false, error: 'Owner invitations require an owner to re-enter their password.' }, 401)
          try {
            const created = controlPlane.store.createInvitation({
              organizationId: controlPlane.organization.id,
              email: String(body.email ?? ''),
              roleTemplate,
              scope,
              invitedByActorId: principal.actor.id,
              expiresInMs: Number(body.expiresInMs) || undefined,
            })
            const acceptUrl = `${url.origin}/accept-invitation?token=${encodeURIComponent(created.token)}`
            const delivered = await sendAuthenticationEmail(config as CloudConfig, {
              to: created.invitation.email,
              subject: 'Your ts-cloud organization invitation',
              text: `Accept your ts-cloud invitation: ${acceptUrl}\n\nThis link expires ${created.invitation.expiresAt} and can be used once.`,
            })
            return json({
              invitation: created.invitation,
              token: created.token,
              acceptUrl,
              delivered,
            }, 201)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Invitation could not be created.' }, 422)
          }
        }

        if (url.pathname === '/api/organization/invitations' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          try {
            return json({ invitation: controlPlane.store.revokeInvitation(String(body.id ?? ''), principal.actor?.id) })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Invitation could not be revoked.' }, 409)
          }
        }

        if (url.pathname === '/api/organization/invitations/resend' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          try {
            const created = controlPlane.store.reissueInvitation(String(body.id ?? ''), principal.actor?.id)
            const acceptUrl = `${url.origin}/accept-invitation?token=${encodeURIComponent(created.token)}`
            const delivered = await sendAuthenticationEmail(config as CloudConfig, {
              to: created.invitation.email,
              subject: 'Your ts-cloud organization invitation',
              text: `Accept your ts-cloud invitation: ${acceptUrl}\n\nThis replacement link expires ${created.invitation.expiresAt} and can be used once.`,
            })
            return json({ invitation: created.invitation, token: created.token, acceptUrl, delivered })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Invitation could not be resent.' }, 409)
          }
        }

        if (url.pathname === '/api/organization/memberships' && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const membership = controlPlane.store.getMembership(String(body.id ?? ''))
          const roleTemplate = organizationRole(body.roleTemplate)
          const scope = authorizationScope(body)
          if (!membership || membership.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'Membership was not found.' }, 404)
          if (!roleTemplate || !scope)
            return json({ ok: false, error: 'Choose a valid role template and resource scope.' }, 422)
          const principal = organizationPrincipal(user)
          const ownerChange = membership.roleTemplate === 'owner' || roleTemplate === 'owner'
          if (ownerChange && (!verifyPassword(String(body.password ?? ''), user.passwordHash) || principal.membership?.roleTemplate !== 'owner'))
            return json({ ok: false, error: 'Ownership changes require an owner to re-enter their password.' }, 401)

          const comparisonTarget = controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, scope)
            ?? controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, { type: 'project', id: controlPlane.project.id })!
          const grants = controlPlane.store.listGrants(membership.id)
          const before = effectiveCapabilities({ membership, grants, target: comparisonTarget })
          const proposed = { ...membership, roleTemplate, scope }
          const after = effectiveCapabilities({ membership: proposed, grants, target: comparisonTarget })
          const accessDiff = { gained: after.filter(capability => !before.includes(capability)), lost: before.filter(capability => !after.includes(capability)) }
          if (body.preview === true)
            return json({ membership, proposed: { roleTemplate, scope }, accessDiff })
          if (String(body.confirm ?? '') !== membership.id)
            return json({ ok: false, error: `Confirm this change with membership ID ${membership.id}.`, accessDiff }, 409)
          try {
            return json({ membership: controlPlane.store.updateMembership({ id: membership.id, roleTemplate, scope, actorId: principal.actor?.id }), accessDiff })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Membership could not be updated.' }, 409)
          }
        }

        if (url.pathname === '/api/organization/memberships' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const membership = controlPlane.store.getMembership(String(body.id ?? ''))
          if (!membership || membership.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'Membership was not found.' }, 404)
          if (String(body.confirm ?? '') !== membership.id)
            return json({ ok: false, error: `Confirm removal with membership ID ${membership.id}.` }, 409)
          const principal = organizationPrincipal(user)
          if (membership.roleTemplate === 'owner' && (principal.membership?.roleTemplate !== 'owner' || !verifyPassword(String(body.password ?? ''), user.passwordHash)))
            return json({ ok: false, error: 'Removing an owner requires an owner to re-enter their current password.' }, 401)
          try {
            return json({ membership: controlPlane.store.revokeMembership(membership.id, principal.actor?.id) })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Membership could not be removed.' }, 409)
          }
        }

        if (url.pathname === '/api/organization/grants' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const capability = String(body.capability ?? '') as AuthorizationCapability
          const effect = body.effect === 'deny' ? 'deny' : body.effect === 'allow' ? 'allow' : undefined
          const scope = authorizationScope(body)
          const principal = organizationPrincipal(user)
          if (!effect || !scope || !AUTHORIZATION_CAPABILITIES.includes(capability))
            return json({ ok: false, error: 'Choose a valid capability, effect, and resource scope.' }, 422)
          try {
            return json({ grant: controlPlane.store.upsertGrant({
              organizationId: controlPlane.organization.id,
              membershipId: String(body.membershipId ?? ''),
              effect,
              capability,
              scope,
              actorId: principal.actor?.id,
            }) }, 201)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Grant could not be created.' }, 422)
          }
        }

        if (url.pathname === '/api/organization/grants' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const grant = controlPlane.store.getGrant(String(body.id ?? ''))
          if (!grant || grant.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'Grant was not found.' }, 404)
          return json({ ok: controlPlane.store.removeGrant(grant.id, principal.actor?.id) })
        }

        if (url.pathname === '/api/tags' && req.method === 'GET') {
          return json({
            tags: controlPlane.store.listTags(controlPlane.project.id),
            assignments: controlPlane.store.listResourceTags(controlPlane.project.id),
          })
        }

        if (url.pathname === '/api/tags' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const tag = controlPlane.store.upsertTag(controlPlane.project.id, String(body.name ?? ''), String(body.color ?? '#5a8be0'))
          if (body.resourceId)
            controlPlane.store.assignTag(String(body.resourceId), tag.id)
          return json({ tag }, 201)
        }

        if (url.pathname === '/api/tags' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          controlPlane.store.removeTag(String(body.resourceId ?? ''), String(body.tagId ?? ''))
          return json({ ok: true })
        }

        // The home page is the box's own dashboard (host metrics, services,
        // backups), which a member has no access to — land them on their sites.
        if (url.pathname === '/' && !canOpenDashboardPage(url.pathname, scopedUser))
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
          return json(scopeCloudConfig(sanitized, scopedUser))
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
          if (scopedUser.role === 'member') {
            const fields = checkMemberSiteFields(body)
            if (!fields.ok)
              return json({ ok: false, error: fields.error }, 403)

            // Routing is theirs to set, but not to take from someone else.
            const conflict = checkRouteConflict({
              siteName: name,
              body,
              sites: (config.sites ?? {}) as Record<string, any>,
              ownSites: Object.keys(scopedUser.sites),
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
          return json(scopeDashboardData(latestData, { user: scopedUser, slug: (config as CloudConfig).project.slug }))
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
          synchronizeDashboardUsers(controlPlane, loadUsers(cwd))
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
          const targetUser = findUser(loadUsers(cwd), username)
          const targetActor = targetUser
            ? controlPlane.store.getActorByExternalId('user', `dashboard:${targetUser.username.toLowerCase()}`)
            : undefined
          const targetMembership = targetActor
            ? controlPlane.store.getMembershipForActor(controlPlane.organization.id, targetActor.id)
            : undefined
          if (targetMembership && targetMembership.source !== 'legacy')
            return json({ ok: false, error: 'Organization members must be removed from Organization access.' }, 409)
          const result = removeUser(cwd, username)
          if (!result.ok)
            return json(result, 409)
          synchronizeDashboardUsers(controlPlane, loadUsers(cwd))
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
        if (!canOpenDashboardPage(url.pathname, scopedUser))
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
    clearInterval(recoveryThrottleSweep)
    clearInterval(mfaThrottleSweep)
    clearUiCache()
    const result = stop(closeActiveConnections)
    controlPlane.store.close()
    return result
  }) as typeof server.stop

  return { server, url: `http://${host}:${server.port}/` }
}
