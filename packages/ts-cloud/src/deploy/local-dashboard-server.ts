import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import type { AuthOidcRole, OidcFetch } from '../auth'
import type { AuthorizationCapability, AuthorizationScope, JsonValue, OperationState, OrganizationRoleTemplate } from '../control-plane'
import type { ReleaseDriverResolver } from '../release'
import type { DashboardUser } from './dashboard-auth'
import { resolveDeploymentMode } from '@ts-cloud/core'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCloudConfig } from '../config'
import { AUTH_SESSION_ABSOLUTE_TTL_MS, AuthenticationStore, beginOidcAuthorization, completeOidcAuthorization, resolveAuthEncryptionKey, sendAuthenticationEmail } from '../auth'
import { AutomationIdentityStore } from '../automation'
import { createApiV1Handler } from '../api'
import { AUTHORIZATION_CAPABILITIES, authorizeOrganization, effectiveCapabilities, searchControlPlane } from '../control-plane'
import { ensureDefaultSecurityPolicies, productionChangeReview, recordDashboardHostPosture, SecretFindingScanner, securityScope, SecurityPostureStore, SecurityScannerRunner } from '../security'
import { cloneSourceBinding, createSourceAdapter, listSourceReferences, processSourceWebhook, reconcileSourceWebhook, removeSourceWebhook, SourceConnectionStore, syncSourceRepositories, testSourceConnection, webhookEndpoint } from '../source'
import { ApplicationArtifactStore, ApplicationDraftStore, applyApplicationDraft, detectApplication, planApplication, RegistryConnectionStore, scanApplicationDirectory } from '../onboarding'
import { createDeploymentQueueHandlers, DurableOperationQueue, DurableQueueWorker } from '../queue'
import { PreviewEnvironmentService } from '../preview'
import { ComposeApplicationService, buildComposeLogsCommand, buildComposeShellCommand, listComposeTemplates } from '../compose'
import { createReleaseQueueHandlers, ReleaseService, releaseStrategyCapabilities } from '../release'
import { resolveRuntimeInventory, RuntimeOperationService, RuntimeStreamRegistry, type RuntimeStreamSnapshot } from '../runtime'
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
  /** Run the persistent deployment worker in this process. Defaults off in tests. */
  queueWorker?: boolean
  /** Maximum number of operations this process may execute in parallel. */
  queueParallelism?: number
  /** Resolve the provider-specific immutable activation primitive for release jobs. */
  releaseDriver?: ReleaseDriverResolver
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

function runtimeEventStream(registry: RuntimeStreamRegistry, session: RuntimeStreamSnapshot, after: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  let cursor = Math.max(0, Math.floor(after))
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let ended = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (ended) return
        ended = true
        unsubscribe?.()
        if (heartbeat) clearInterval(heartbeat)
        signal.removeEventListener('abort', cleanup)
        try { controller.close() } catch { /* already closed */ }
      }
      const send = (snapshot: RuntimeStreamSnapshot) => {
        if (ended) return
        if (snapshot.reset) controller.enqueue(encoder.encode(`event: reset\ndata: ${JSON.stringify({ cursor: snapshot.cursor, droppedBytes: snapshot.droppedBytes })}\n\n`))
        for (const chunk of snapshot.chunks.filter(item => item.cursor > cursor)) {
          cursor = chunk.cursor
          controller.enqueue(encoder.encode(`id: ${chunk.cursor}\nevent: ${chunk.stream}\ndata: ${JSON.stringify(chunk)}\n\n`))
        }
        if (snapshot.state !== 'open') {
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify({ state: snapshot.state, error: snapshot.error, cursor: snapshot.cursor })}\n\n`))
          cleanup()
        }
      }
      unsubscribe = registry.subscribe(session.id, session.workloadId, snapshot => send(registry.read(snapshot.id, snapshot.workloadId, cursor) ?? snapshot))
      const initial = registry.read(session.id, session.workloadId, cursor)
      if (!initial) return cleanup()
      send(initial)
      if (ended) return
      heartbeat = setInterval(() => {
        if (!ended) controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ cursor, at: new Date().toISOString() })}\n\n`))
      }, 15_000)
      heartbeat.unref?.()
      signal.addEventListener('abort', cleanup, { once: true })
    },
    cancel() {
      ended = true
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })
  return new Response(body, { headers: { 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' } })
}

const DASHBOARD_AUDIT_FIELDS = new Set(['action', 'operation', 'site', 'name', 'username', 'database', 'secretId', 'port', 'key', 'resourceId', 'environmentId'])

export function dashboardMutationAuditPayload(method: string, path: string, input: unknown, status: number, durationMs: number): { [key: string]: JsonValue } {
  const sanitized: Record<string, string | number | boolean | null> = {}
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
      if (!DASHBOARD_AUDIT_FIELDS.has(key) || !['string', 'number', 'boolean'].includes(typeof raw)) continue
      sanitized[key] = typeof raw === 'string' ? raw.slice(0, 256) : raw as number | boolean
    }
  }
  const target = String(sanitized.resourceId || sanitized.site || sanitized.secretId || sanitized.database || sanitized.name || path)
  return { method: method.toUpperCase(), path, target, status, outcome: status < 400 ? 'succeeded' : 'failed', durationMs: Math.max(0, Math.round(durationMs)), input: sanitized }
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
  'POST /api/automation/service-accounts',
  'PATCH /api/automation/service-accounts',
  'POST /api/automation/tokens',
  'POST /api/automation/tokens/rotate',
  'DELETE /api/automation/tokens',
  'POST /api/security/policies',
  'PATCH /api/security/policies',
  'POST /api/security/waivers',
  'DELETE /api/security/waivers',
  'POST /api/sources/connections',
  'PATCH /api/sources/connections',
  'DELETE /api/sources/connections',
  'POST /api/sources/deploy-keys',
  'DELETE /api/sources/deploy-keys',
  'POST /api/sources/webhooks',
  'PATCH /api/sources/webhooks',
  'DELETE /api/sources/webhooks',
  'POST /api/onboarding/registries',
  'PATCH /api/onboarding/registries',
  'DELETE /api/onboarding/registries',
  'POST /api/runtime/exec-sessions',
  'POST /api/runtime/files/read',
  'POST /api/runtime/files/write',
  'POST /api/onboarding/apply',
  'PATCH /api/queue/settings',
  'DELETE /api/queue/history',
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

async function readProcessOutput(stream: ReadableStream<Uint8Array>, kind: 'stdout' | 'stderr', onOutput?: (kind: 'stdout' | 'stderr', chunk: string) => void): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break
    const chunk = decoder.decode(value, { stream: true })
    output += chunk
    if (chunk)
      onOutput?.(kind, chunk)
  }
  const trailing = decoder.decode()
  if (trailing) {
    output += trailing
    onOutput?.(kind, trailing)
  }
  return output
}

export async function runDashboardAction(action: DashboardAction, options: Required<Pick<LocalDashboardServerOptions, 'cwd' | 'cliEntry'>> & {
  signal?: AbortSignal
  onOutput?: (kind: 'stdout' | 'stderr', chunk: string) => void
}): Promise<Record<string, any>> {
  const proc = Bun.spawn([process.execPath, options.cliEntry, ...action.command], {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  const abort = () => {
    try { proc.kill() }
    catch { /* already exited */ }
  }
  if (options.signal?.aborted)
    abort()
  else
    options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessOutput(proc.stdout, 'stdout', options.onOutput),
      readProcessOutput(proc.stderr, 'stderr', options.onOutput),
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
  finally {
    options.signal?.removeEventListener('abort', abort)
  }
}

function deploymentLogSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => !!value && value.length >= 8 && /(?:secret|token|password|passwd|private|credential|api.?key|access.?key)/i.test(name))
    .map(([, value]) => value!)
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
  '/integrations',
  '/applications/new',
  '/applications/compose',
  '/operations/queue',
  '/operations/previews',
  '/operations/releases',
  '/account/security',
  '/security',
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
  '/server/security': 'security:read',
  '/security': 'security:read',
  '/integrations': 'sources:read',
  '/applications/new': 'applications:read',
  '/applications/compose': 'applications:read',
  '/operations/queue': 'deployments:read',
  '/operations/previews': 'deployments:read',
  '/operations/releases': 'deployments:read',
  '/server/ssh-keys': 'fleet:read',
  '/server/terminal': 'runtime:terminal',
  '/server/team': 'users:read',
  '/account/security': 'project:read',
  '/account/automation': 'users:read',
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
  const securityPosture = new SecurityPostureStore(controlPlane.store)
  const sourceConnections = new SourceConnectionStore(controlPlane.store, { encryptionKey: resolveAuthEncryptionKey(cwd) })
  const applicationDrafts = new ApplicationDraftStore(controlPlane.store)
  const applicationArtifacts = new ApplicationArtifactStore(controlPlane.store, { cwd })
  const registryConnections = new RegistryConnectionStore(controlPlane.store, { encryptionKey: resolveAuthEncryptionKey(cwd) })
  const operationQueue = new DurableOperationQueue(controlPlane.store, { workerId: `dashboard:${process.pid}` })
  const previewService = new PreviewEnvironmentService(controlPlane.store)
  const composeService = new ComposeApplicationService(controlPlane.store)
  const releaseService = new ReleaseService(controlPlane.store)
  previewService.cleanup()
  const previewCleanupSweep = setInterval(() => {
    try { previewService.cleanup() }
    catch (error) { console.error('ts-cloud preview cleanup failed:', error) }
  }, 60 * 60 * 1000)
  previewCleanupSweep.unref?.()
  const queueWorkerEnabled = options.queueWorker ?? process.env.NODE_ENV !== 'test'
  const queueSecrets = deploymentLogSecrets()
  const queueWorker = queueWorkerEnabled
    ? new DurableQueueWorker(operationQueue, { ...createDeploymentQueueHandlers({
        store: controlPlane.store,
        execute: async (command, context) => {
          const operationInput = context.operation.input && typeof context.operation.input === 'object' && !Array.isArray(context.operation.input) ? context.operation.input as Record<string, any> : {}
          const source = operationInput.source && typeof operationInput.source === 'object' ? operationInput.source as Record<string, any> : undefined
          let actionCwd = cwd
          let checkoutRoot: string | undefined
          let publishStatus: ((_state: 'pending' | 'success' | 'failure' | 'error', _description: string) => Promise<void>) | undefined
          try {
            if (source?.bindingId && source?.connectionId && source?.commitSha) {
              const binding = sourceConnections.getBinding(String(source.bindingId))
              const connection = sourceConnections.getConnection(String(source.connectionId))
              if (!binding || !connection || binding.connectionId !== connection.id) throw new Error('Queued source binding is no longer available')
              const repository = binding.repositoryId ? sourceConnections.getRepository(binding.repositoryId) : sourceConnections.listRepositories(connection.id).find(item => item.fullName.toLowerCase() === binding.repositoryFullName.toLowerCase())
              let remote = repository?.cloneUrl
              if (!remote && connection.provider === 'generic_ssh') remote = `git@${new URL(connection.host).hostname}:${binding.repositoryFullName}.git`
              if (!remote) remote = new URL(`/${binding.repositoryFullName}.git`, connection.host.endsWith('/') ? connection.host : `${connection.host}/`).href
              const deployKeyRecord = binding.deployKeyId ? sourceConnections.getDeployKey(binding.deployKeyId) : undefined
              const deployKey = deployKeyRecord && binding.deployKeyId ? { ...deployKeyRecord, privateKey: sourceConnections.getDeployPrivateKey(binding.deployKeyId) } : undefined
              if (['github', 'gitlab', 'bitbucket', 'gitea'].includes(connection.provider) && command.target.previewId) {
                const adapter = createSourceAdapter(connection, sourceConnections.getCredential(connection.id))
                const preview = previewService.previews.getInstance(command.target.previewId)
                publishStatus = async (state, description) => { try { await adapter.setCommitStatus(binding.repositoryFullName, String(source.commitSha), { state, url: preview?.url, description }) } catch (error) { context.log(`Could not publish source status: ${error instanceof Error ? error.message : String(error)}`, { stream: 'stderr' }) } }
                await publishStatus('pending', `Preview deployment started for ${String(source.commitSha).slice(0, 12)}`)
              }
              checkoutRoot = mkdtempSync(join(tmpdir(), 'ts-cloud-queued-source-'))
              context.log(`Checking out immutable source commit ${source.commitSha}.`, { stream: 'system' })
              const cloned = await cloneSourceBinding({ remote, binding, destination: join(checkoutRoot, 'checkout'), ref: String(source.branch ?? binding.defaultBranch), commitSha: String(source.commitSha) }, { credential: sourceConnections.getCredential(connection.id), deployKey })
              actionCwd = cloned.directory
            }
            const result = await runDashboardAction(command, {
              cwd: actionCwd,
              cliEntry,
              signal: context.signal,
              onOutput: (stream, chunk) => context.log(chunk, { stream, step: 'execute', secrets: queueSecrets }),
            }) as { ok: boolean, exitCode: number, command?: string, stderr?: string }
            await publishStatus?.(result.ok ? 'success' : 'failure', result.ok ? `Preview is ready at ${String(source?.commitSha).slice(0, 12)}` : `Preview deployment failed at ${String(source?.commitSha).slice(0, 12)}`)
            return result
          }
          catch (error) {
            await publishStatus?.('error', `Preview deployment could not complete at ${String(source?.commitSha).slice(0, 12)}`)
            throw error
          }
          finally {
            if (checkoutRoot) rmSync(checkoutRoot, { recursive: true, force: true })
          }
        },
      }), ...createReleaseQueueHandlers({ store: controlPlane.store, resolveDriver: options.releaseDriver ?? ((release) => ({ name: `${controlPlane.store.getResource(release.resourceId)?.provider ?? 'provider'} release driver`, capability: () => ({ strategy: release.strategy, supported: false, explanation: 'This dashboard process has no immutable activation driver configured for the target provider.', capacityMultiplier: 1, costImpact: 'none', rollback: 'The previous release remains preserved; configure a release driver before retrying.' }), activate: async () => { throw new Error('Immutable activation driver is not configured') }, rollback: async () => { throw new Error('Immutable rollback driver is not configured') } })) }) }, {
        parallelism: options.queueParallelism ?? (Number(process.env.TS_CLOUD_QUEUE_PARALLELISM) || 8),
        onError: error => console.error('ts-cloud deployment queue worker failed:', error),
      })
    : undefined
  ensureDefaultSecurityPolicies(controlPlane)
  recordDashboardHostPosture(securityPosture, securityScope(controlPlane, String(defaultEnvironment)), initialData)
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
  const runtimeStreams = new RuntimeStreamRegistry()
  const runtimeStreamSweep = setInterval(() => runtimeStreams.sweep(), 60_000)
  runtimeStreamSweep.unref?.()

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
  const apiV1 = createApiV1Handler({
    controlPlane: controlPlane.store,
    identities: automationIdentities,
    sources: sourceConnections,
    applications: { drafts: applicationDrafts, artifacts: applicationArtifacts, registries: registryConnections },
  })
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
  const mayAccessOperation = (user: DashboardUser, operationId: string, capability: AuthorizationCapability): boolean => {
    if (user.role === 'admin') return true
    const operation = controlPlane.store.getOperation(operationId); const principal = organizationPrincipal(user)
    if (!operation || !principal.membership) return false
    const scope: AuthorizationScope = operation.resourceId ? { type: 'resource', id: operation.resourceId } : operation.environmentId ? { type: 'environment', id: operation.environmentId } : operation.projectId ? { type: 'project', id: operation.projectId } : { type: 'organization' }
    const target = controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, scope)
    return !!target && authorizeOrganization({ membership: principal.membership, grants: principal.grants, capability, target }).allowed
  }
  const mayAccessResource = (user: DashboardUser, resourceId: string, capability: AuthorizationCapability): boolean => {
    if (user.role === 'admin') return true
    const principal = organizationPrincipal(user); if (!principal.membership) return false
    const target = controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, { type: 'resource', id: resourceId })
    return !!target && authorizeOrganization({ membership: principal.membership, grants: principal.grants, capability, target }).allowed
  }
  const mayAccessEnvironment = (user: DashboardUser, environmentId: string, capability: AuthorizationCapability): boolean => {
    if (user.role === 'admin') return true
    const principal = organizationPrincipal(user); if (!principal.membership) return false
    const target = controlPlane.store.resolveAuthorizationTarget(controlPlane.organization.id, { type: 'environment', id: environmentId })
    return !!target && authorizeOrganization({ membership: principal.membership, grants: principal.grants, capability, target }).allowed
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
      const auditStartedAt = Date.now()
      const auditRequest = req.clone()
      const auditCorrelationId = req.headers.get('x-request-id')?.slice(0, 128) || crypto.randomUUID()
      const auditMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
      const url = new URL(req.url)
      const handleRequest = async (): Promise<Response | undefined> => {
      const activeServer = runtimeServer ?? server
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

        const sourceWebhookRoute = /^\/api\/source\/webhooks\/([A-Za-z0-9_-]{16,200})$/.exec(url.pathname)
        if (sourceWebhookRoute && req.method === 'POST') {
          const result = await processSourceWebhook({ sources: sourceConnections, controlPlane: controlPlane.store, endpointToken: sourceWebhookRoute[1]!, headers: req.headers, rawBody: new Uint8Array(await req.arrayBuffer()) })
          return json({ accepted: result.accepted, duplicate: result.duplicate, status: result.status, operationIds: result.operations.map(operation => operation.id), message: result.message }, result.accepted ? 202 : 404)
        }

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
          if (authEnabled && RECENT_AUTH_MUTATIONS.has(`${req.method.toUpperCase()} ${url.pathname}`)) {
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

        if (url.pathname === '/api/automation' && req.method === 'GET') {
          const accounts = automationIdentities.listServiceAccounts(controlPlane.organization.id, { includeDisabled: true }).map((account) => {
            const membership = controlPlane.store.getMembershipForActor(controlPlane.organization.id, account.actorId)
            const createdBy = account.createdByActorId ? controlPlane.store.getActor(account.createdByActorId) : undefined
            const tokens = automationIdentities.listTokens(account.id, { includeInactive: true }).map(token => ({ ...token, createdBy: token.createdByActorId ? controlPlane.store.getActor(token.createdByActorId) : undefined }))
            return { account, createdBy, membership, tokens }
          })
          return json({ accounts, apiBaseUrl: `${url.origin}/api/v1`, openApiUrl: `${url.origin}/api/v1/openapi.json`, tokenEnvironmentVariable: 'TS_CLOUD_API_TOKEN' })
        }

        if (url.pathname === '/api/automation/service-accounts' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const role = organizationRole(body.roleTemplate)
          const scope = authorizationScope(body)
          if (!principal.actor || !role || role === 'owner' || !scope)
            return json({ ok: false, error: 'A non-owner role and valid organization scope are required.' }, 422)
          try {
            const created = automationIdentities.createServiceAccount({
              organizationId: controlPlane.organization.id,
              slug: String(body.slug ?? ''),
              name: String(body.name ?? ''),
              description: typeof body.description === 'string' ? body.description : undefined,
              roleTemplate: role,
              scope,
              createdByActorId: principal.actor.id,
            })
            return json({ ok: true, ...created }, 201)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Service account could not be created.' }, 422)
          }
        }

        if (url.pathname === '/api/automation/service-accounts' && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const account = automationIdentities.getServiceAccount(String(body.id ?? ''))
          if (!account || account.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'Service account was not found.' }, 404)
          return json({ ok: true, account: automationIdentities.disableServiceAccount(account.id, principal.actor?.id) })
        }

        if (url.pathname === '/api/automation/tokens' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const account = automationIdentities.getServiceAccount(String(body.serviceAccountId ?? ''))
          const scope = authorizationScope(body)
          if (!principal.actor || !account || account.organizationId !== controlPlane.organization.id || !scope || !Array.isArray(body.capabilities))
            return json({ ok: false, error: 'Service account, explicit capabilities, and valid scope are required.' }, 422)
          try {
            const issued = automationIdentities.createToken({
              serviceAccountId: account.id,
              name: String(body.name ?? 'API token'),
              capabilities: body.capabilities.map(String) as AuthorizationCapability[],
              scope,
              expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
              createdByActorId: principal.actor.id,
            })
            return json({ ok: true, token: issued.token, secret: issued.secret, revealOnce: true }, 201)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'API token could not be created.' }, 422)
          }
        }

        if (url.pathname === '/api/automation/tokens/rotate' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const token = automationIdentities.getToken(String(body.id ?? ''))
          const account = token ? automationIdentities.getServiceAccount(token.serviceAccountId) : undefined
          if (!principal.actor || !token || account?.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'API token was not found.' }, 404)
          try {
            const issued = automationIdentities.rotateToken(token.id, principal.actor.id)
            return json({ ok: true, token: issued.token, secret: issued.secret, revealOnce: true, overlap: true }, 201)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'API token could not be rotated.' }, 409)
          }
        }

        if (url.pathname === '/api/automation/tokens' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const token = automationIdentities.getToken(String(body.id ?? ''))
          const account = token ? automationIdentities.getServiceAccount(token.serviceAccountId) : undefined
          if (!token || account?.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'API token was not found.' }, 404)
          return json({ ok: true, token: automationIdentities.revokeToken(token.id, principal.actor?.id) })
        }

        if (url.pathname === '/api/onboarding' && req.method === 'GET') {
          const connections = sourceConnections.listConnections(controlPlane.organization.id)
          return json({
            drafts: applicationDrafts.list(controlPlane.project.id),
            artifacts: applicationArtifacts.list(controlPlane.project.id),
            registries: registryConnections.list(controlPlane.organization.id),
            sourceConnections: connections,
            repositories: connections.flatMap(connection => sourceConnections.listRepositories(connection.id)),
            project: { id: controlPlane.project.id, slug: controlPlane.project.slug, name: controlPlane.project.name },
            environments: [...controlPlane.environments.values()].map(item => ({ id: item.id, slug: item.slug, name: item.name, kind: item.kind, region: item.region })),
            resources: controlPlane.store.listResources(controlPlane.project.id).filter(resource => resource.kind === 'application').map(resource => ({ id: resource.id, slug: resource.slug, name: resource.name, environmentId: resource.environmentId })),
          })
        }

        if (url.pathname === '/api/onboarding/detect' && req.method === 'POST') {
          const body = await readJsonBody(req)
          try {
            if (body.source?.kind === 'git') {
              const connection = sourceConnections.getConnection(String(body.source.connectionId ?? '')); const repository = sourceConnections.getRepository(String(body.source.repositoryId ?? ''))
              if (!connection || connection.organizationId !== controlPlane.organization.id || !repository || repository.connectionId !== connection.id) throw new Error('Authorized Git repository was not found')
              const deployKey = typeof body.source.deployKeyId === 'string' ? sourceConnections.getDeployKey(body.source.deployKeyId) : undefined
              if (deployKey && deployKey.connectionId !== connection.id) throw new Error('Deploy key does not belong to this connection')
              const temporary = mkdtempSync(join(tmpdir(), 'ts-cloud-onboarding-git-'))
              try {
                const cloned = await cloneSourceBinding({ remote: repository.cloneUrl, destination: join(temporary, 'checkout'), ref: String(body.source.ref ?? repository.defaultBranch), sparsePaths: Array.isArray(body.source.sparsePaths) ? body.source.sparsePaths.map(String) : undefined, binding: { id: 'detection', projectId: controlPlane.project.id, connectionId: connection.id, repositoryId: repository.id, repositoryFullName: repository.fullName, defaultBranch: repository.defaultBranch, monorepoRoot: String(body.source.monorepoRoot ?? '.'), includePaths: [], excludePaths: [], submodules: body.source.submodules === true, cloneDepth: 1, deployKeyId: deployKey?.id, autoDeploy: false, pullRequestPreviews: false, status: 'active', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
                }, { credential: sourceConnections.getCredential(connection.id), deployKey: deployKey ? { ...deployKey, privateKey: sourceConnections.getDeployPrivateKey(deployKey.id) } : undefined, timeoutMs: 120_000 })
                return json({ ok: true, commitSha: cloned.commitSha, candidates: detectApplication(scanApplicationDirectory(cloned.directory)) })
              }
              finally { rmSync(temporary, { recursive: true, force: true }) }
            }
            if (Array.isArray(body.files)) {
              if (body.files.length > 10_000) throw new Error('Detection file-count limit exceeded')
              const files = body.files.map((item: any) => ({ path: String(item.path ?? ''), size: Number(item.size ?? 0), content: typeof item.content === 'string' ? item.content.slice(0, 256 * 1024) : undefined }))
              return json({ ok: true, candidates: detectApplication(files) })
            }
            const root = resolve(cwd, String(body.root ?? '.')); const rootRelative = relative(cwd, root)
            if (rootRelative === '..' || rootRelative.startsWith(`..${sep}`)) throw new Error('Detection root must stay inside the project')
            return json({ ok: true, candidates: detectApplication(scanApplicationDirectory(root)) })
          }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Application detection failed.' }, 422) }
        }

        if (url.pathname === '/api/onboarding/plan' && req.method === 'POST') {
          const body = await readJsonBody(req)
          try { return json({ ok: true, plan: planApplication(body.draft, Array.isArray(body.suppliedSecretNames) ? body.suppliedSecretNames.map(String) : []) }) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Application plan could not be generated.' }, 422) }
        }

        if (url.pathname === '/api/onboarding/drafts' && req.method === 'POST') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          try { return json({ ok: true, draft: applicationDrafts.create({ organizationId: controlPlane.organization.id, projectId: controlPlane.project.id, name: String(body.name ?? body.draft?.name ?? 'Application draft'), draft: { ...body.draft, projectId: controlPlane.project.id }, step: body.step, suppliedSecretNames: Array.isArray(body.suppliedSecretNames) ? body.suppliedSecretNames.map(String) : [], actorId: principal.actor?.id }) }, 201) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Application draft could not be saved.' }, 422) }
        }

        if (url.pathname === '/api/onboarding/drafts' && req.method === 'PATCH') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user); const current = applicationDrafts.get(String(body.id ?? ''))
          if (!current || current.projectId !== controlPlane.project.id) return json({ ok: false, error: 'Application draft was not found.' }, 404)
          try { return json({ ok: true, draft: applicationDrafts.update(current.id, Number(body.version), { draft: { ...body.draft, projectId: controlPlane.project.id }, step: body.step, suppliedSecretNames: Array.isArray(body.suppliedSecretNames) ? body.suppliedSecretNames.map(String) : undefined, actorId: principal.actor?.id }) }) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Application draft could not be updated.' }, 409) }
        }

        if (url.pathname === '/api/onboarding/artifacts' && req.method === 'POST') {
          const principal = organizationPrincipal(user); const declared = Number(req.headers.get('content-length') ?? 0)
          if (declared > 100 * 1024 * 1024) return json({ ok: false, error: 'Artifact exceeds the 100 MB upload limit.' }, 413)
          try { const bytes = new Uint8Array(await req.arrayBuffer()); return json({ ok: true, artifact: applicationArtifacts.create({ organizationId: controlPlane.organization.id, projectId: controlPlane.project.id, filename: req.headers.get('x-artifact-filename') ?? 'application.zip', bytes, actorId: principal.actor?.id }) }, 201) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Artifact could not be inspected.' }, 422) }
        }

        if (url.pathname === '/api/onboarding/registries' && req.method === 'POST') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          try { return json({ ok: true, registry: registryConnections.create({ organizationId: controlPlane.organization.id, provider: body.provider, name: String(body.name ?? 'Container registry'), host: String(body.host ?? ''), credential: body.token || body.password ? { username: typeof body.username === 'string' ? body.username : undefined, password: typeof body.password === 'string' ? body.password : undefined, token: typeof body.token === 'string' ? body.token : undefined } : undefined, credentialExpiresAt: typeof body.credentialExpiresAt === 'string' ? body.credentialExpiresAt : undefined, actorId: principal.actor?.id }) }, 201) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Registry connection could not be created.' }, 422) }
        }

        if (url.pathname === '/api/onboarding/registries' && req.method === 'PATCH') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user); const connection = registryConnections.get(String(body.id ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Registry connection was not found.' }, 404)
          try {
            if (body.action === 'test') return json({ ok: true, registry: await registryConnections.test(connection.id, { image: typeof body.image === 'string' ? body.image : undefined }) })
            if (body.action === 'rotate') return json({ ok: true, registry: registryConnections.rotate(connection.id, { username: typeof body.username === 'string' ? body.username : undefined, password: typeof body.password === 'string' ? body.password : undefined, token: typeof body.token === 'string' ? body.token : undefined }, { expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined, actorId: principal.actor?.id }) })
            return json({ ok: false, error: 'Registry action must be test or rotate.' }, 422)
          }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Registry connection could not be updated.' }, 422) }
        }

        if (url.pathname === '/api/onboarding/registries' && req.method === 'DELETE') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user); const connection = registryConnections.get(String(body.id ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Registry connection was not found.' }, 404)
          const affectedDrafts = applicationDrafts.list(controlPlane.project.id).filter(draft => (draft.input.source.kind === 'image' && draft.input.source.registryConnectionId === connection.id) || (draft.input.build.kind === 'prebuilt_image' && draft.input.build.registryConnectionId === connection.id))
          if (body.preview === true) return json({ ok: true, preview: true, affectedDrafts })
          return json({ ok: true, registry: registryConnections.disconnect(connection.id, principal.actor?.id), affectedDrafts })
        }

        if (url.pathname === '/api/onboarding/apply' && req.method === 'POST') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          try { const result = applyApplicationDraft({ controlPlane: controlPlane.store, drafts: applicationDrafts, draftId: String(body.id ?? ''), expectedVersion: Number(body.version), confirmEnvironment: String(body.confirmEnvironment ?? ''), actorId: principal.actor?.id }); return json({ ok: true, resource: result.resource, operation: result.operation, plan: result.plan }, 202) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Application plan could not be applied.' }, 422) }
        }

        if (url.pathname === '/api/sources' && req.method === 'GET') {
          const connections = sourceConnections.listConnections(controlPlane.organization.id)
          return json({
            connections,
            bindings: sourceConnections.listBindings({ projectId: controlPlane.project.id }),
            repositories: connections.flatMap(connection => sourceConnections.listRepositories(connection.id)),
            deployKeys: connections.flatMap(connection => sourceConnections.listDeployKeys(connection.id)),
            webhooks: connections.flatMap(connection => sourceConnections.listWebhooks(connection.id)).map(webhook => ({ ...webhook, deliveries: sourceConnections.listDeliveries(webhook.id, 20) })),
            project: { id: controlPlane.project.id, slug: controlPlane.project.slug },
            environment: securityScope(controlPlane, String(environment)),
            resources: controlPlane.store.listResources(controlPlane.project.id, securityScope(controlPlane, String(environment)).environmentId).filter(resource => resource.kind === 'application').map(resource => ({ id: resource.id, slug: resource.slug, name: resource.name })),
          })
        }

        if (url.pathname === '/api/sources/connections' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const provider = String(body.provider ?? '')
          if (!['github', 'gitlab', 'bitbucket', 'gitea', 'generic_https', 'generic_ssh'].includes(provider)) return json({ ok: false, error: 'A supported Git provider is required.' }, 422)
          try {
            const credential = provider === 'github' && (body.privateKey || body.appId)
              ? { appId: typeof body.appId === 'string' ? body.appId : undefined, installationId: typeof body.installationId === 'string' ? body.installationId : undefined, privateKey: typeof body.privateKey === 'string' ? body.privateKey : undefined }
              : provider !== 'generic_ssh' && body.token
                ? { token: typeof body.token === 'string' ? body.token : undefined, username: typeof body.username === 'string' ? body.username : undefined }
                : undefined
            const defaults: Record<string, string> = { github: 'https://github.com', gitlab: 'https://gitlab.com', bitbucket: 'https://bitbucket.org', gitea: 'https://gitea.com' }
            let connection!: ReturnType<SourceConnectionStore['createConnection']>
            let repository: ReturnType<SourceConnectionStore['upsertRepository']> | undefined
            let deployKey: ReturnType<SourceConnectionStore['createDeployKey']> | undefined
            controlPlane.store.database.transaction(() => {
              connection = sourceConnections.createConnection({ organizationId: controlPlane.organization.id, provider: provider as any, name: String(body.name ?? provider), host: String(body.host ?? defaults[provider] ?? ''), owner: typeof body.owner === 'string' ? body.owner : undefined,
                authKind: body.authKind, credential, grantedScopes: Array.isArray(body.grantedScopes) ? body.grantedScopes.map(String) : [], credentialExpiresAt: typeof body.credentialExpiresAt === 'string' ? body.credentialExpiresAt : undefined, createdByActorId: principal.actor?.id })
              if (typeof body.repositoryUrl === 'string' && typeof body.repositoryFullName === 'string') repository = sourceConnections.upsertRepository({ connectionId: connection.id, providerRepositoryId: `manual:${body.repositoryFullName}`, fullName: body.repositoryFullName, cloneUrl: body.repositoryUrl, defaultBranch: String(body.defaultBranch ?? 'main'), visibility: 'unknown', archived: false, metadata: { source: 'manual' } })
              if (provider === 'generic_ssh') deployKey = sourceConnections.createDeployKey({ connectionId: connection.id, name: String(body.deployKeyName ?? 'Repository deploy key'), publicKey: String(body.publicKey ?? ''), privateKey: String(body.deployPrivateKey ?? ''), host: String(body.sshHost ?? ''), hostKey: String(body.hostKey ?? ''), actorId: principal.actor?.id })
            })()
            if (body.test === true) connection = await testSourceConnection(sourceConnections, connection.id, repository?.id)
            return json({ ok: true, connection, repository, deployKey }, 201)
          }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Source connection could not be created.' }, 422) }
        }

        if (url.pathname === '/api/sources/connections' && req.method === 'PATCH') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          const connection = sourceConnections.getConnection(String(body.id ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source connection was not found.' }, 404)
          try {
            if (body.action === 'test') return json({ ok: true, connection: await testSourceConnection(sourceConnections, connection.id, typeof body.repositoryId === 'string' ? body.repositoryId : undefined) })
            if (body.action === 'rotate') return json({ ok: true, connection: sourceConnections.rotateCredential(connection.id, { token: typeof body.token === 'string' ? body.token : undefined, username: typeof body.username === 'string' ? body.username : undefined, appId: typeof body.appId === 'string' ? body.appId : undefined, installationId: typeof body.installationId === 'string' ? body.installationId : undefined, privateKey: typeof body.privateKey === 'string' ? body.privateKey : undefined }, { expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined, actorId: principal.actor?.id }) })
            return json({ ok: false, error: 'Connection action must be test or rotate.' }, 422)
          }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Source connection could not be updated.' }, 422) }
        }

        if (url.pathname === '/api/sources/connections' && req.method === 'DELETE') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          const connection = sourceConnections.getConnection(String(body.id ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source connection was not found.' }, 404)
          const affectedBindings = sourceConnections.listBindings({ connectionId: connection.id, status: 'active' })
          if (body.preview === true) return json({ ok: true, preview: true, affectedBindings })
          return json({ ok: true, ...sourceConnections.disconnectConnection(connection.id, principal.actor?.id) })
        }

        if (url.pathname === '/api/sources/deploy-keys' && req.method === 'POST') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          const connection = sourceConnections.getConnection(String(body.connectionId ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source connection was not found.' }, 404)
          try { return json({ ok: true, deployKey: sourceConnections.createDeployKey({ connectionId: connection.id, name: String(body.name ?? 'Repository deploy key'), publicKey: String(body.publicKey ?? ''), privateKey: String(body.privateKey ?? ''), host: String(body.host ?? ''), hostKey: String(body.hostKey ?? ''), actorId: principal.actor?.id }) }, 201) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Deploy key could not be stored.' }, 422) }
        }

        if (url.pathname === '/api/sources/deploy-keys' && req.method === 'DELETE') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          const deployKey = sourceConnections.getDeployKey(String(body.id ?? ''))
          const connection = deployKey ? sourceConnections.getConnection(deployKey.connectionId) : undefined
          if (!deployKey || !connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Deploy key was not found.' }, 404)
          const affectedBindings = sourceConnections.listBindings({ connectionId: connection.id }).filter(binding => binding.deployKeyId === deployKey.id)
          if (body.preview === true) return json({ ok: true, preview: true, affectedBindings })
          return json({ ok: true, ...sourceConnections.revokeDeployKey(deployKey.id, principal.actor?.id) })
        }

        if (url.pathname === '/api/sources/repositories/sync' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const connection = sourceConnections.getConnection(String(body.connectionId ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source connection was not found.' }, 404)
          try { return json({ ok: true, repositories: await syncSourceRepositories(sourceConnections, String(body.connectionId ?? ''), { search: typeof body.search === 'string' ? body.search : undefined }) }) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Repositories could not be synchronized.' }, 422) }
        }

        if (url.pathname === '/api/sources/references' && req.method === 'GET') {
          const connection = sourceConnections.getConnection(String(url.searchParams.get('connectionId') ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source connection was not found.' }, 404)
          try { return json(await listSourceReferences(sourceConnections, { connectionId: String(url.searchParams.get('connectionId') ?? ''), repository: String(url.searchParams.get('repository') ?? ''), repositoryId: url.searchParams.get('repositoryId') ?? undefined, deployKeyId: url.searchParams.get('deployKeyId') ?? undefined, type: url.searchParams.get('type') === 'tags' ? 'tags' : 'branches', cursor: url.searchParams.get('cursor') ?? undefined })) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'References could not be listed.' }, 422) }
        }

        if (url.pathname === '/api/sources/bindings' && req.method === 'POST') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user); const scope = securityScope(controlPlane, String(environment))
          const connection = sourceConnections.getConnection(String(body.connectionId ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source connection was not found.' }, 404)
          try { return json({ ok: true, binding: sourceConnections.createBinding({ projectId: controlPlane.project.id, environmentId: scope.environmentId, resourceId: typeof body.resourceId === 'string' ? body.resourceId : undefined, connectionId: String(body.connectionId ?? ''), repositoryId: typeof body.repositoryId === 'string' ? body.repositoryId : undefined,
            repositoryFullName: String(body.repositoryFullName ?? ''), defaultBranch: String(body.defaultBranch ?? 'main'), branchRule: typeof body.branchRule === 'string' ? body.branchRule : undefined, tagRule: typeof body.tagRule === 'string' ? body.tagRule : undefined, monorepoRoot: String(body.monorepoRoot ?? '.'), includePaths: Array.isArray(body.includePaths) ? body.includePaths.map(String) : [], excludePaths: Array.isArray(body.excludePaths) ? body.excludePaths.map(String) : [], submodules: body.submodules === true, cloneDepth: body.cloneDepth ? Number(body.cloneDepth) : undefined, deployKeyId: typeof body.deployKeyId === 'string' && body.deployKeyId ? body.deployKeyId : undefined, autoDeploy: body.autoDeploy !== false, pullRequestPreviews: body.pullRequestPreviews !== false, actorId: principal.actor?.id }) }, 201) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Source binding could not be created.' }, 422) }
        }

        if (url.pathname === '/api/sources/bindings' && req.method === 'PATCH') {
          const body = await readJsonBody(req); const principal = organizationPrincipal(user)
          const binding = sourceConnections.getBinding(String(body.id ?? ''))
          if (!binding || binding.projectId !== controlPlane.project.id) return json({ ok: false, error: 'Source binding was not found.' }, 404)
          try { return json({ ok: true, binding: sourceConnections.updateBinding(binding.id, Number(body.version), { defaultBranch: body.defaultBranch, branchRule: body.branchRule, tagRule: body.tagRule, monorepoRoot: body.monorepoRoot, includePaths: body.includePaths, excludePaths: body.excludePaths, submodules: body.submodules, cloneDepth: body.cloneDepth, deployKeyId: body.deployKeyId, autoDeploy: body.autoDeploy, pullRequestPreviews: body.pullRequestPreviews, status: body.status, disabledReason: body.disabledReason, actorId: principal.actor?.id }) }) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Source binding could not be updated.' }, 409) }
        }

        if (url.pathname === '/api/sources/webhooks' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const connection = sourceConnections.getConnection(String(body.connectionId ?? ''))
          if (!connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source connection was not found.' }, 404)
          try {
            const created = sourceConnections.createWebhook({ connectionId: String(body.connectionId ?? ''), repositoryId: typeof body.repositoryId === 'string' ? body.repositoryId : undefined, repositoryFullName: String(body.repositoryFullName ?? ''), events: Array.isArray(body.events) ? body.events.map(String) : undefined, secret: typeof body.secret === 'string' ? body.secret : undefined })
            const baseUrl = process.env.TS_CLOUD_WEBHOOK_BASE_URL?.trim() || oidcOrigin
            const endpoint = baseUrl ? webhookEndpoint(baseUrl, created.webhook) : undefined
            const webhook = body.reconcile !== false && baseUrl ? await reconcileSourceWebhook(sourceConnections, created.webhook.id, baseUrl) : created.webhook
            return json({ ok: true, webhook, endpoint, endpointRevealOnce: true }, 201)
          }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Source webhook could not be created.' }, 422) }
        }

        if (url.pathname === '/api/sources/webhooks' && req.method === 'PATCH') {
          const body = await readJsonBody(req); const baseUrl = process.env.TS_CLOUD_WEBHOOK_BASE_URL?.trim() || oidcOrigin
          const sourceWebhook = sourceConnections.getWebhook(String(body.id ?? ''))
          const connection = sourceWebhook ? sourceConnections.getConnection(sourceWebhook.connectionId) : undefined
          if (!sourceWebhook || !connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source webhook was not found.' }, 404)
          if (!baseUrl) return json({ ok: false, error: 'Set TS_CLOUD_WEBHOOK_BASE_URL to reconcile provider webhooks.' }, 422)
          try { return json({ ok: true, webhook: await reconcileSourceWebhook(sourceConnections, String(body.id ?? ''), baseUrl) }) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Source webhook could not be reconciled.' }, 422) }
        }

        if (url.pathname === '/api/sources/webhooks' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const sourceWebhook = sourceConnections.getWebhook(String(body.id ?? ''))
          const connection = sourceWebhook ? sourceConnections.getConnection(sourceWebhook.connectionId) : undefined
          if (!sourceWebhook || !connection || connection.organizationId !== controlPlane.organization.id) return json({ ok: false, error: 'Source webhook was not found.' }, 404)
          try { return json({ ok: true, webhook: await removeSourceWebhook(sourceConnections, String(body.id ?? '')) }) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Source webhook could not be removed.' }, 422) }
        }

        if (url.pathname === '/api/security/posture' && req.method === 'GET') {
          const scope = securityScope(controlPlane, String(environment))
          const findings = securityPosture.listFindings({ ...scope, limit: 500 })
          return json({
            scope,
            summary: securityPosture.summary(scope.organizationId, scope.projectId, scope.environmentId),
            findings,
            scans: securityPosture.listScanRuns({ ...scope, limit: 100 }),
            policies: securityPosture.listPolicies(scope.organizationId).filter(policy => !policy.environmentId || policy.environmentId === scope.environmentId),
            waivers: findings.flatMap(finding => securityPosture.listWaivers(finding.id)),
            decisions: securityPosture.listDecisions(scope.environmentId, 50),
            actors: controlPlane.store.listMemberships(controlPlane.organization.id).map(membership => controlPlane.store.getActor(membership.actorId)).filter(Boolean),
          })
        }

        if (url.pathname === '/api/security/export' && req.method === 'GET')
          return json(securityPosture.exportPosture(controlPlane.organization.id))

        if (url.pathname === '/api/security/scan' && req.method === 'POST') {
          const scope = securityScope(controlPlane, String(environment))
          const source = await new SecurityScannerRunner(securityPosture).run(new SecretFindingScanner(), { ...scope, artifactRoot: cwd })
          const host = recordDashboardHostPosture(securityPosture, scope, latestData ?? {})
          return json({ ok: true, source, host, summary: securityPosture.summary(scope.organizationId, scope.projectId, scope.environmentId) })
        }

        if (url.pathname === '/api/security/review' && req.method === 'POST') {
          try {
            const scope = securityScope(controlPlane, String(environment))
            return json({ ok: true, ...productionChangeReview(securityPosture, { scope, desiredConfigHash: controlPlane.project.desiredConfigHash }) })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Security change review failed.' }, 409)
          }
        }

        if (url.pathname === '/api/security/policies' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          if (!principal.actor)
            return json({ ok: false, error: 'An organization actor is required.' }, 403)
          try {
            const policy = securityPosture.createPolicy({
              organizationId: controlPlane.organization.id,
              environmentId: body.environmentId === null ? undefined : String(body.environmentId ?? securityScope(controlPlane, String(environment)).environmentId),
              name: String(body.name ?? ''),
              scannerFailMode: body.scannerFailMode === 'open' ? 'open' : 'closed',
              requiredScanners: Array.isArray(body.requiredScanners) ? body.requiredScanners.map(String) : [],
              rules: Array.isArray(body.rules) ? body.rules.map((rule: Record<string, unknown>) => ({ minimumSeverity: String(rule.minimumSeverity), action: String(rule.action), scannerId: rule.scannerId ? String(rule.scannerId) : undefined })) as any : [],
              actorId: principal.actor.id,
            })
            return json({ ok: true, policy }, 201)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Security policy could not be created.' }, 422)
          }
        }

        if (url.pathname === '/api/security/policies' && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const policy = securityPosture.getPolicy(String(body.id ?? ''))
          if (!principal.actor || !policy || policy.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'Security policy was not found.' }, 404)
          try {
            return json({ ok: true, policy: securityPosture.updatePolicy(policy.id, Number(body.version), {
              name: typeof body.name === 'string' ? body.name : undefined,
              scannerFailMode: body.scannerFailMode === 'open' || body.scannerFailMode === 'closed' ? body.scannerFailMode : undefined,
              requiredScanners: Array.isArray(body.requiredScanners) ? body.requiredScanners.map(String) : undefined,
              rules: Array.isArray(body.rules) ? body.rules.map((rule: Record<string, unknown>) => ({ minimumSeverity: String(rule.minimumSeverity), action: String(rule.action), scannerId: rule.scannerId ? String(rule.scannerId) : undefined })) as any : undefined,
              enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
              actorId: principal.actor.id,
            }) })
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Security policy could not be updated.' }, 409)
          }
        }

        if (url.pathname === '/api/security/waivers' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          if (!principal.actor)
            return json({ ok: false, error: 'An organization actor is required.' }, 403)
          try {
            return json({ ok: true, waiver: securityPosture.createWaiver({ findingId: String(body.findingId ?? ''), policyId: typeof body.policyId === 'string' ? body.policyId : undefined,
              reason: String(body.reason ?? ''), referenceUrl: typeof body.referenceUrl === 'string' ? body.referenceUrl : undefined, expiresAt: String(body.expiresAt ?? ''), actorId: principal.actor.id }) }, 201)
          }
          catch (error) {
            return json({ ok: false, error: error instanceof Error ? error.message : 'Security waiver could not be created.' }, 422)
          }
        }

        if (url.pathname === '/api/security/waivers' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          if (!principal.actor)
            return json({ ok: false, error: 'An organization actor is required.' }, 403)
          try { return json({ ok: true, waiver: securityPosture.revokeWaiver(String(body.id ?? ''), principal.actor.id) }) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Security waiver could not be revoked.' }, 404) }
        }

        if (url.pathname === '/api/security/findings' && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          const finding = securityPosture.getFinding(String(body.id ?? ''))
          if (!principal.actor || !finding || finding.organizationId !== controlPlane.organization.id)
            return json({ ok: false, error: 'Security finding was not found.' }, 404)
          try {
            const updated = body.action === 'acknowledge'
              ? securityPosture.acknowledgeFinding(finding.id, principal.actor.id)
              : securityPosture.assignFinding(finding.id, typeof body.ownerActorId === 'string' && body.ownerActorId ? body.ownerActorId : undefined, principal.actor.id)
            return json({ ok: true, finding: updated })
          }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Security finding could not be updated.' }, 422) }
        }

        if (url.pathname === '/api/security/comments' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const principal = organizationPrincipal(user)
          if (!principal.actor)
            return json({ ok: false, error: 'An organization actor is required.' }, 403)
          try { return json({ ok: true, comment: securityPosture.addComment({ findingId: String(body.findingId ?? ''), actorId: principal.actor.id, body: String(body.body ?? ''), referenceUrl: typeof body.referenceUrl === 'string' ? body.referenceUrl : undefined }) }, 201) }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Comment could not be saved.' }, 422) }
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

        if (url.pathname === '/api/queue' && req.method === 'GET') {
          const requestedState = url.searchParams.get('state')
          const queueState = requestedState && ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'].includes(requestedState) ? requestedState as OperationState : undefined
          const operations = operationQueue.list({ projectId: controlPlane.project.id, state: queueState, limit: Number(url.searchParams.get('limit')) || 250 })
            .filter(item => mayAccessOperation(user, item.operation.id, 'deployments:read'))
            .map((item) => {
              const resource = item.operation.resourceId ? controlPlane.store.getResource(item.operation.resourceId) : undefined
              const targetEnvironment = item.operation.environmentId ? controlPlane.store.listEnvironments(controlPlane.project.id).find(candidate => candidate.id === item.operation.environmentId) : undefined
              const actor = item.operation.actorId ? controlPlane.store.getActor(item.operation.actorId) : undefined
              const operationInput = item.operation.input as Record<string, any>
              return { ...item, target: resource ? { id: resource.id, name: resource.name, slug: resource.slug, kind: resource.kind } : targetEnvironment ? { id: targetEnvironment.id, name: targetEnvironment.name, slug: targetEnvironment.slug, kind: 'environment' } : { id: controlPlane.project.id, name: controlPlane.project.name, slug: controlPlane.project.slug, kind: 'project' }, actor: actor ? { id: actor.id, name: actor.displayName, kind: actor.kind } : undefined, commit: operationInput.revision ?? operationInput.source?.commitSha ?? null }
            })
          return json({ operations, concurrency: operationQueue.limits })
        }

        if (url.pathname === '/api/queue/logs' && req.method === 'GET') {
          const operationId = String(url.searchParams.get('id') ?? '')
          if (!mayAccessOperation(user, operationId, 'deployments:read')) return json({ ok: false, error: 'Operation was not found in this scope.' }, 404)
          const entries = operationQueue.logs(operationId, { after: Number(url.searchParams.get('after')) || 0, limit: Number(url.searchParams.get('limit')) || 500 })
          return json({ entries, cursor: entries.at(-1)?.sequence ?? (Number(url.searchParams.get('after')) || 0), operation: controlPlane.store.getOperation(operationId) })
        }

        if (url.pathname === '/api/queue/stream' && req.method === 'GET') {
          const operationId = String(url.searchParams.get('id') ?? '')
          if (!mayAccessOperation(user, operationId, 'deployments:read')) return json({ ok: false, error: 'Operation was not found in this scope.' }, 404)
          const lastId = req.headers.get('last-event-id')?.trim()
          let cursor = Number(lastId || url.searchParams.get('after') || 0)
          const encoder = new TextEncoder(); let timer: ReturnType<typeof setInterval> | undefined; let closed = false
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const flush = () => {
                if (closed) return
                const currentUser = guard.resolveUser(req)
                if (!currentUser || !mayAccessOperation(currentUser, operationId, 'deployments:read')) { closed = true; if (timer) clearInterval(timer); controller.close(); return }
                const entries = operationQueue.logs(operationId, { after: cursor, limit: 500 })
                for (const entry of entries) { cursor = entry.sequence; controller.enqueue(encoder.encode(`id: ${entry.sequence}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`)) }
                const operation = controlPlane.store.getOperation(operationId)
                if (operation && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(operation.state) && operationQueue.logs(operationId, { after: cursor, limit: 1 }).length === 0) { closed = true; if (timer) clearInterval(timer); controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({ state: operation.state, cursor })}\n\n`)); controller.close() }
              }
              flush(); if (!closed) timer = setInterval(flush, 500)
              req.signal.addEventListener('abort', () => { closed = true; if (timer) clearInterval(timer); try { controller.close() } catch {} }, { once: true })
            },
            cancel() { closed = true; if (timer) clearInterval(timer) },
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
        }

        if (url.pathname === '/api/queue/cancel' && req.method === 'POST') {
          const body = await readJsonBody(req); const operationId = String(body.id ?? '')
          if (!mayAccessOperation(user, operationId, 'deployments:cancel')) return json({ ok: false, error: 'Operation was not found or cannot be cancelled in this scope.' }, 404)
          const actor = ensureDashboardActor(controlPlane.store, user)
          try { return json({ ok: true, operation: operationQueue.requestCancellation(operationId, actor.id) }) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Cancellation failed.' }, 409) }
        }

        if (url.pathname === '/api/queue/retry' && req.method === 'POST') {
          const body = await readJsonBody(req); const operationId = String(body.id ?? '')
          if (!mayAccessOperation(user, operationId, 'deployments:create')) return json({ ok: false, error: 'Operation was not found or cannot be retried in this scope.' }, 404)
          const actor = ensureDashboardActor(controlPlane.store, user)
          try { return json({ ok: true, operation: operationQueue.retry(operationId, String(body.errorClass ?? 'manual'), { delayMs: Number(body.delayMs) || 0, actorId: actor.id }) }) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Retry failed.' }, 409) }
        }

        if (url.pathname === '/api/queue/settings' && req.method === 'GET') return json({ concurrency: operationQueue.limits })
        if (url.pathname === '/api/queue/settings' && req.method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body.confirm !== 'update queue limits') return json({ ok: false, error: 'Type "update queue limits" to confirm production concurrency changes.' }, 409)
          const actor = ensureDashboardActor(controlPlane.store, user)
          return json({ ok: true, concurrency: operationQueue.configureConcurrency(body.concurrency ?? {}, { organizationId: controlPlane.organization.id, actorId: actor.id }) })
        }
        if (url.pathname === '/api/queue/history' && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          if (body.confirm !== 'clear completed') return json({ ok: false, error: 'Type "clear completed" to confirm retained history cleanup.' }, 409)
          const actor = ensureDashboardActor(controlPlane.store, user)
          return json({ ok: true, deleted: operationQueue.clearCompleted({ projectId: controlPlane.project.id, before: typeof body.before === 'string' ? body.before : undefined, actorId: actor.id }) })
        }

        if (url.pathname === '/api/previews' && req.method === 'GET') {
          const previews = previewService.previews.listInstances({ projectId: controlPlane.project.id }).filter(item => mayAccessResource(user, item.resourceId, 'deployments:read'))
          const definitions = previewService.previews.listDefinitions(controlPlane.project.id).filter(item => mayAccessResource(user, item.resourceId, 'project:read'))
          const resources = controlPlane.store.listResources(controlPlane.project.id).filter(item => item.kind === 'application' && mayAccessResource(user, item.id, 'project:read')).map(item => ({ id: item.id, slug: item.slug, name: item.name, environmentId: item.environmentId }))
          return json({ previews, definitions, resources, environments: [...controlPlane.environments.values()] })
        }
        if (url.pathname === '/api/releases' && req.method === 'GET') {
          const environments = [...controlPlane.environments.values()]
          const resources = controlPlane.store.listResources(controlPlane.project.id).filter(item => mayAccessResource(user, item.id, 'deployments:read'))
          const visible = new Set(resources.map(item => item.id))
          const releases = releaseService.releases.list({ projectId: controlPlane.project.id }).filter(item => visible.has(item.resourceId)).map((item) => {
            const resource = resources.find(value => value.id === item.resourceId)
            const environment = environments.find(value => value.id === item.environmentId)
            const previous = item.previousReleaseId ? releaseService.releases.get(item.previousReleaseId) : undefined
            return { ...item, resource: resource ? { id: resource.id, name: resource.name, slug: resource.slug, provider: resource.provider } : undefined, environment: environment ? { id: environment.id, name: environment.name, slug: environment.slug, kind: environment.kind } : undefined, artifact: releaseService.releases.getArtifact(item.artifactId), transitions: releaseService.releases.transitions(item.id), approvals: releaseService.releases.approvals(item.id), previous, comparison: previous ? releaseService.releases.compare(previous.id, item.id) : undefined, capabilities: releaseStrategyCapabilities({ kind: item.kind, provider: resource?.provider, hasHealthGate: !!item.healthGate, replicas: Number((item.manifest as any)?.replicas) || 1 }) }
          })
          return json({ releases, resources: resources.map(item => ({ id: item.id, name: item.name, slug: item.slug, environmentId: item.environmentId, provider: item.provider })), environments })
        }
        if (url.pathname === '/api/releases/action' && req.method === 'POST') {
          const body = await readJsonBody(req); const release = releaseService.releases.get(String(body.id ?? '')); const action = String(body.action ?? '')
          if (!release || !mayAccessResource(user, release.resourceId, 'deployments:create')) return json({ ok: false, error: 'Release was not found in this scope.' }, 404)
          const actor = ensureDashboardActor(controlPlane.store, user)
          try {
            if (action === 'activate') return json({ ok: true, operation: releaseService.enqueueActivation(release, { actorId: actor.id }) })
            if (action === 'rollback') { const resource = controlPlane.store.getResource(release.resourceId); if (body.confirm !== resource?.slug) return json({ ok: false, error: `Type "${resource?.slug ?? ''}" to confirm rollback.` }, 409); return json({ ok: true, operation: releaseService.enqueueRollback(release, { actorId: actor.id, targetReleaseId: typeof body.targetReleaseId === 'string' ? body.targetReleaseId : undefined }) }) }
            if (action === 'approve') { const environment = controlPlane.store.listEnvironments(release.projectId).find(item => item.id === release.environmentId); if (body.confirm !== environment?.slug) return json({ ok: false, error: `Type "${environment?.slug ?? ''}" to confirm the environment gate.` }, 409); return json({ ok: true, release: releaseService.releases.approve(release.id, { actorId: actor.id, decision: body.decision === 'rejected' ? 'rejected' : 'approved', comment: typeof body.comment === 'string' ? body.comment : undefined }) }) }
            if (action === 'pin') return json({ ok: true, release: releaseService.releases.pin(release.id, body.pinned !== false, typeof body.reason === 'string' ? body.reason : undefined) })
            if (action === 'promote') { const targetResource = controlPlane.store.getResource(String(body.targetResourceId ?? '')); const targetEnvironment = targetResource ? controlPlane.store.listEnvironments(release.projectId).find(item => item.id === targetResource.environmentId) : undefined; if (!targetResource || !targetEnvironment || !mayAccessResource(user, targetResource.id, 'deployments:create')) return json({ ok: false, error: 'Promotion target was not found in this scope.' }, 404); if (body.confirm !== targetEnvironment.slug) return json({ ok: false, error: `Type "${targetEnvironment.slug}" to confirm promotion.` }, 409); return json({ ok: true, release: releaseService.releases.promote(release.id, { targetEnvironmentId: targetEnvironment.id, targetResourceId: targetResource.id, config: body.config && typeof body.config === 'object' ? body.config : {}, strategy: typeof body.strategy === 'string' ? body.strategy as any : undefined, actorId: actor.id, approvalRequired: body.approvalRequired === true }) }) }
            return json({ ok: false, error: 'Unsupported release action.' }, 422)
          }
          catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Release action failed.' }, 409) }
        }
        if (url.pathname === '/api/compose' && req.method === 'GET') {
          const applications = composeService.applications.list({ projectId: controlPlane.project.id }).filter(item => mayAccessResource(user, item.resourceId, 'applications:read')).map(item => ({ ...item, services: composeService.applications.services(item.id) }))
          return json({ applications, templates: listComposeTemplates(), environments: [...controlPlane.environments.values()] })
        }
        if (url.pathname === '/api/compose/preview' && req.method === 'POST') {
          const body = await readJsonBody(req); const environmentId = String(body.environmentId ?? '')
          if (!mayAccessEnvironment(user, environmentId, 'applications:manage')) return json({ ok: false, error: 'Environment was not found in this scope.' }, 404)
          try { return json({ ok: true, result: composeService.applications.preview(String(body.source ?? ''), { name: String(body.name ?? ''), slug: typeof body.slug === 'string' ? body.slug : undefined, projectId: controlPlane.project.id, environmentId }) }) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Compose could not be parsed.' }, 422) }
        }
        if ((url.pathname === '/api/compose/import' || url.pathname === '/api/compose/template') && req.method === 'POST') {
          const body = await readJsonBody(req); const environmentId = String(body.environmentId ?? '')
          if (!mayAccessEnvironment(user, environmentId, 'applications:manage')) return json({ ok: false, error: 'Environment was not found in this scope.' }, 404)
          const actor = ensureDashboardActor(controlPlane.store, user)
          try { const result = url.pathname.endsWith('/template') ? composeService.applications.fromTemplate(String(body.templateId ?? ''), body.inputs && typeof body.inputs === 'object' ? body.inputs : {}, { name: String(body.name ?? ''), projectId: controlPlane.project.id, environmentId, version: typeof body.templateVersion === 'string' ? body.templateVersion : undefined, createdByActorId: actor.id }) : composeService.applications.import(String(body.source ?? ''), { name: String(body.name ?? ''), slug: typeof body.slug === 'string' ? body.slug : undefined, projectId: controlPlane.project.id, environmentId, createdByActorId: actor.id }); return json({ ok: true, application: result.application, diagnostics: result.parsed.diagnostics }) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Compose application could not be saved.' }, 422) }
        }
        if (url.pathname === '/api/compose/action' && req.method === 'POST') {
          const body = await readJsonBody(req); const application = composeService.applications.get(String(body.id ?? '')); const action = String(body.action ?? '') as 'deploy' | 'redeploy' | 'start' | 'stop' | 'scale' | 'delete'
          const capability: AuthorizationCapability = action === 'delete' || action === 'stop' ? 'deployments:cancel' : 'deployments:create'
          if (!application || !mayAccessResource(user, application.resourceId, capability)) return json({ ok: false, error: 'Compose application was not found in this scope.' }, 404)
          try { const actor = ensureDashboardActor(controlPlane.store, user); return json({ ok: true, operation: composeService.enqueue(application, action, { actorId: actor.id, service: typeof body.service === 'string' ? body.service : undefined, replicas: Number.isFinite(Number(body.replicas)) ? Number(body.replicas) : undefined, removeVolumes: body.removeVolumes === true, confirmation: typeof body.confirm === 'string' ? body.confirm : undefined }) }) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Compose operation could not be queued.' }, 409) }
        }
        if ((url.pathname === '/api/compose/logs' || url.pathname === '/api/compose/shell') && req.method === 'POST') {
          const body = await readJsonBody(req); const application = composeService.applications.get(String(body.id ?? '')); const shell = url.pathname.endsWith('/shell'); const capability: AuthorizationCapability = shell ? 'runtime:terminal' : 'runtime:logs'
          if (!application || !mayAccessResource(user, application.resourceId, capability)) return json({ ok: false, error: 'Compose service was not found in this scope.' }, 404)
          const serviceName = String(body.service ?? ''); if (!application.manifest.spec.services[serviceName]) return json({ ok: false, error: 'Compose service was not found.' }, 404)
          if (shell && body.confirm !== serviceName) return json({ ok: false, error: `Type "${serviceName}" to run a service command.` }, 409)
          const environmentSlug = controlPlane.store.listEnvironments(application.projectId).find(item => item.id === application.environmentId)?.slug as EnvironmentType | undefined
          if (!environmentSlug) return json({ ok: false, error: 'Compose environment was not found.' }, 404)
          const command = shell ? buildComposeShellCommand(application.manifest, serviceName, Array.isArray(body.command) ? body.command.map(String) : ['sh']) : buildComposeLogsCommand(application.manifest, serviceName, Number(body.lines) || 200)
          return json(await runServerShellCommand(config as CloudConfig, environmentSlug, command))
        }
        if (url.pathname === '/api/previews/definitions' && req.method === 'POST') {
          const body = await readJsonBody(req); const resourceId = String(body.resourceId ?? '')
          if (!mayAccessResource(user, resourceId, 'config:write')) return json({ ok: false, error: 'Application was not found in this scope.' }, 404)
          const actor = ensureDashboardActor(controlPlane.store, user)
          try { return json({ ok: true, definition: previewService.previews.createDefinition({ ...body, projectId: controlPlane.project.id, resourceId, baseEnvironmentId: String(body.baseEnvironmentId ?? ''), domainPattern: String(body.domainPattern ?? ''), createdByActorId: actor.id }) }) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Preview policy could not be created.' }, 409) }
        }
        if (url.pathname === '/api/previews/deploy' && req.method === 'POST') {
          const body = await readJsonBody(req); const policy = previewService.previews.getDefinition(String(body.definitionId ?? ''))
          if (!policy || !mayAccessResource(user, policy.resourceId, 'deployments:create')) return json({ ok: false, error: 'Preview policy was not found in this scope.' }, 404)
          const actor = ensureDashboardActor(controlPlane.store, user)
          try { const persisted = previewService.previews.upsert({ definitionId: policy.id, sourceProvider: 'dashboard', repository: 'dashboard', branch: String(body.branch ?? ''), pullRequestNumber: Number(body.pullRequestNumber) || undefined, commitSha: String(body.commitSha ?? ''), createdByActorId: actor.id }); return json({ ok: true, preview: persisted.preview, operation: previewService.enqueueDeploy(persisted.preview, { created: persisted.created, actorId: actor.id }) }) } catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : 'Preview could not be queued.' }, 409) }
        }
        if (url.pathname === '/api/previews/destroy' && req.method === 'POST') {
          const body = await readJsonBody(req); const preview = previewService.previews.getInstance(String(body.id ?? ''))
          if (!preview || !mayAccessResource(user, preview.resourceId, 'deployments:cancel')) return json({ ok: false, error: 'Preview was not found in this scope.' }, 404)
          if (body.confirm !== preview.name) return json({ ok: false, error: `Type "${preview.name}" to confirm tagged teardown.` }, 409)
          const actor = ensureDashboardActor(controlPlane.store, user); return json({ ok: true, operation: previewService.enqueueDestroy(preview, 'dashboard', actor.id) })
        }
        if (url.pathname === '/api/previews/extend' && req.method === 'POST') {
          const body = await readJsonBody(req); const preview = previewService.previews.getInstance(String(body.id ?? ''))
          if (!preview || !mayAccessResource(user, preview.resourceId, 'deployments:create')) return json({ ok: false, error: 'Preview was not found in this scope.' }, 404)
          return json({ ok: true, preview: previewService.previews.extend(preview.id, Number(body.hours)) })
        }
        if (url.pathname === '/api/previews/rebuild' && req.method === 'POST') {
          const body = await readJsonBody(req); const preview = previewService.previews.getInstance(String(body.id ?? ''))
          if (!preview || !mayAccessResource(user, preview.resourceId, 'deployments:create')) return json({ ok: false, error: 'Preview was not found in this scope.' }, 404)
          const actor = ensureDashboardActor(controlPlane.store, user); return json({ ok: true, operation: previewService.enqueueDeploy(preview, { actorId: actor.id, reason: 'manual_rebuild' }) })
        }
        if (url.pathname === '/api/previews/cleanup' && req.method === 'POST') {
          const body = await readJsonBody(req)
          if (!body.dryRun && body.confirm !== 'cleanup previews') return json({ ok: false, error: 'Type "cleanup previews" to confirm teardown.' }, 409)
          const actor = ensureDashboardActor(controlPlane.store, user); return json({ ok: true, ...previewService.cleanup({ dryRun: body.dryRun === true, maxAgeHours: Number(body.maxAgeHours) || undefined, keepCount: Number(body.keepCount) || undefined, actorId: actor.id }) })
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
          const postureScope = securityScope(controlPlane, String(environment))
          await new SecurityScannerRunner(securityPosture).run(new SecretFindingScanner(), { ...postureScope, artifactRoot: cwd })
          recordDashboardHostPosture(securityPosture, postureScope, latestData ?? {})
          const securityReview = productionChangeReview(securityPosture, { scope: postureScope, desiredConfigHash: controlPlane.project.desiredConfigHash })
          if (securityReview.decision.outcome === 'block') {
            return json({ ok: false, error: `Deployment blocked by security policy: ${securityReview.decision.explanation}`, securityReview }, 409)
          }
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
            execute: () => runDashboardAction(action, { cwd, cliEntry }) as Promise<{ ok: boolean } & Record<string, any>>,
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation, securityReview })
        }

        if (url.pathname === '/api/actions')
          return json(dashboardActions(environment))

        if (url.pathname === '/api/server/operations')
          return json(buildDashboardOperations(config as CloudConfig, latestData))

        if (url.pathname === '/api/runtime/workloads' && req.method === 'GET') {
          const inventory = await resolveRuntimeInventory(config as CloudConfig, environment)
          return json(inventory)
        }

        if (url.pathname === '/api/runtime/logs' && req.method === 'GET') {
          const workloadId = String(url.searchParams.get('workload') ?? '')
          if (!workloadId)
            return json({ ok: false, error: 'A workload query parameter is required.' }, 422)
          const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200))
          try {
            return json(await new RuntimeOperationService(config as CloudConfig, environment).logs(workloadId, { limit }))
          }
          catch (error: any) {
            return json({ ok: false, error: String(error?.message ?? error) }, 404)
          }
        }

        if (url.pathname === '/api/runtime/log-sessions' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const workloadId = String(body.workloadId ?? '')
          if (!workloadId) return json({ ok: false, error: 'A workloadId is required.' }, 422)
          const inventory = await resolveRuntimeInventory(config as CloudConfig, environment)
          const workload = inventory.workloads.find(item => item.id === workloadId)
          if (!workload) return json({ ok: false, error: 'Workload was not found in the current project and environment.' }, 404)
          if (!workload.capabilities.logs.supported) return json({ ok: false, error: workload.capabilities.logs.reason ?? 'Logs are unsupported for this workload.' }, 409)
          const service = new RuntimeOperationService(config as CloudConfig, environment, { inventory: async () => inventory })
          const session = runtimeStreams.create('logs', workloadId)
          void (async () => {
            let since = new Date(Date.now() - Math.min(3_600_000, Math.max(1_000, Number(body.sinceMs) || 60_000)))
            try {
              for (let attempt = 0; attempt < 200 && !runtimeStreams.signal(session.id)?.aborted; attempt++) {
                const result = await service.logs(workloadId, { limit: Math.min(500, Math.max(1, Number(body.limit) || 200)), since })
                for (const line of result.lines) {
                  runtimeStreams.append(session.id, `${line.timestamp ? `${line.timestamp} ` : ''}${line.message}\n`)
                  if (line.timestamp) since = new Date(Math.max(since.getTime(), new Date(line.timestamp).getTime() + 1))
                }
                await Bun.sleep(3_000)
              }
              if (!runtimeStreams.signal(session.id)?.aborted) runtimeStreams.close(session.id, 'complete')
            }
            catch (error) {
              runtimeStreams.append(session.id, error instanceof Error ? error.message : String(error), 'stderr')
              runtimeStreams.close(session.id, 'failed', error instanceof Error ? error.message : String(error))
            }
          })()
          return json({ ok: true, session, streamUrl: `/api/runtime/log-stream?id=${encodeURIComponent(session.id)}&workload=${encodeURIComponent(workloadId)}` }, 201)
        }

        if ((url.pathname === '/api/runtime/log-stream' || url.pathname === '/api/runtime/exec-stream') && req.method === 'GET') {
          const id = String(url.searchParams.get('id') ?? '')
          const workloadId = String(url.searchParams.get('workload') ?? '')
          const after = Number(req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0) || 0
          const session = runtimeStreams.read(id, workloadId, after)
          const expectedKind = url.pathname.includes('exec') ? 'exec' : 'logs'
          if (!session || session.kind !== expectedKind) return json({ ok: false, error: 'Runtime stream was not found in this workload scope.' }, 404)
          return runtimeEventStream(runtimeStreams, session, after, req.signal)
        }

        if ((url.pathname === '/api/runtime/log-sessions' || url.pathname === '/api/runtime/exec-sessions') && req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const cancelled = runtimeStreams.cancel(String(body.id ?? ''), String(body.workloadId ?? ''))
          if (!cancelled) return json({ ok: false, error: 'Runtime stream was not found in this workload scope.' }, 404)
          return json({ ok: true, session: cancelled })
        }

        if (url.pathname === '/api/runtime/exec-sessions' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const workloadId = String(body.workloadId ?? '')
          const inventory = await resolveRuntimeInventory(config as CloudConfig, environment)
          const workload = inventory.workloads.find(item => item.id === workloadId)
          if (!workload) return json({ ok: false, error: 'Workload was not found in the current project and environment.' }, 404)
          const sessionRecord = guard.resolveSession(req)
          const service = new RuntimeOperationService(config as CloudConfig, environment, { inventory: async () => inventory })
          const stream = runtimeStreams.create('exec', workloadId)
          void trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: 'runtime.exec',
            resourceSlug: workload.links.service,
            input: { workloadId, provider: workload.provider, preset: body.preset ? String(body.preset) : null, freeForm: !!String(body.command ?? '').trim() },
            execute: () => service.exec({
              workloadId,
              preset: ['process', 'sockets', 'filesystem'].includes(String(body.preset)) ? String(body.preset) as 'process' | 'sockets' | 'filesystem' : undefined,
              command: typeof body.command === 'string' ? body.command : undefined,
              confirm: String(body.confirm ?? ''),
              recentAuth: !authEnabled || (!!sessionRecord && authentication.isRecentlyAuthenticated(sessionRecord)),
            }),
          }).then(({ result, operation }) => {
            runtimeStreams.append(stream.id, `operation ${operation.id}\n`, 'system')
            if (result.stdout) runtimeStreams.append(stream.id, result.stdout, 'stdout')
            if (result.stderr) runtimeStreams.append(stream.id, result.stderr, 'stderr')
            runtimeStreams.close(stream.id, result.ok ? 'complete' : 'failed', result.error)
          }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            runtimeStreams.append(stream.id, message, 'stderr')
            runtimeStreams.close(stream.id, 'failed', message)
          })
          return json({ ok: true, session: stream, streamUrl: `/api/runtime/exec-stream?id=${encodeURIComponent(stream.id)}&workload=${encodeURIComponent(workloadId)}` }, 202)
        }

        if (url.pathname === '/api/runtime/files/read' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const inventory = await resolveRuntimeInventory(config as CloudConfig, environment)
          const sessionRecord = guard.resolveSession(req)
          const result = await new RuntimeOperationService(config as CloudConfig, environment, { inventory: async () => inventory }).readFile({
            workloadId: String(body.workloadId ?? ''), path: String(body.path ?? ''), confirm: String(body.confirm ?? ''),
            recentAuth: !authEnabled || (!!sessionRecord && authentication.isRecentlyAuthenticated(sessionRecord)),
          })
          return json(result, result.ok ? 200 : 409)
        }

        if (url.pathname === '/api/runtime/files/write' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const inventory = await resolveRuntimeInventory(config as CloudConfig, environment)
          const workloadId = String(body.workloadId ?? '')
          const workload = inventory.workloads.find(item => item.id === workloadId)
          if (!workload) return json({ ok: false, error: 'Workload was not found in the current project and environment.' }, 404)
          const sessionRecord = guard.resolveSession(req)
          const service = new RuntimeOperationService(config as CloudConfig, environment, { inventory: async () => inventory })
          const tracked = await trackDashboardOperation({
            controlPlane, environment, actor: user, kind: 'runtime.file.write', resourceSlug: workload.links.service,
            input: { workloadId, provider: workload.provider, path: String(body.path ?? ''), bytes: Buffer.from(String(body.contentBase64 ?? ''), 'base64').byteLength },
            execute: () => service.writeFile({
              workloadId, path: String(body.path ?? ''), contentBase64: String(body.contentBase64 ?? ''), confirm: String(body.confirm ?? ''),
              recentAuth: !authEnabled || (!!sessionRecord && authentication.isRecentlyAuthenticated(sessionRecord)),
            }),
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation }, tracked.result.ok ? 200 : 409)
        }

        if (url.pathname === '/api/runtime/operations' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const workloadId = String(body.workloadId ?? '')
          const action = String(body.action ?? '') as import('../runtime').LifecycleAction
          if (!workloadId || !['start', 'stop', 'restart', 'redeploy', 'scale', 'inspect'].includes(action))
            return json({ ok: false, error: 'A valid workloadId and lifecycle action are required.' }, 422)
          const inventory = await resolveRuntimeInventory(config as CloudConfig, environment)
          const workload = inventory.workloads.find(item => item.id === workloadId)
          if (!workload)
            return json({ ok: false, error: 'Workload was not found in the current project and environment.' }, 404)
          const session = guard.resolveSession(req)
          const service = new RuntimeOperationService(config as CloudConfig, environment, { inventory: async () => inventory })
          const tracked = await trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: `runtime.${action}`,
            resourceSlug: workload.links.service,
            input: { workloadId, provider: workload.provider, action, replicas: body.replicas == null ? null : Number(body.replicas) },
            execute: () => service.run({
              workloadId,
              action,
              replicas: body.replicas == null ? undefined : Number(body.replicas),
              confirm: String(body.confirm ?? ''),
              recentAuth: !authEnabled || (!!session && authentication.isRecentlyAuthenticated(session)),
            }),
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation }, tracked.result.ok ? 200 : 409)
        }

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
            execute: () => runDashboardAction(action, { cwd, cliEntry }) as Promise<{ ok: boolean } & Record<string, any>>,
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
          const postureScope = securityScope(controlPlane, String(environment))
          await new SecurityScannerRunner(securityPosture).run(new SecretFindingScanner(), { ...postureScope, artifactRoot: cwd })
          const securityReview = productionChangeReview(securityPosture, { scope: postureScope, desiredConfigHash: controlPlane.project.desiredConfigHash })
          if (securityReview.decision.outcome === 'block')
            return json({ ok: false, error: `Operation blocked by security policy: ${securityReview.decision.explanation}`, securityReview }, 409)
          const tracked = await trackDashboardOperation({
            controlPlane,
            environment,
            actor: user,
            kind: `dashboard.server.${operation.id}`,
            resourceSlug: operation.target,
            input: { operation: operation.id, target: operation.target, to: body.to ?? null },
            execute: () => runDashboardOperation(config as CloudConfig, environment, operation, { to: body.to }),
          })
          return json({ ...tracked.result, controlPlaneOperation: tracked.operation, securityReview })
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
      }
      const response = await handleRequest()
      if (!response) return response
      if (auditMutation && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'))) {
        let input: unknown
        const contentType = auditRequest.headers.get('content-type') || ''
        if (contentType.includes('application/json')) input = await auditRequest.json().catch(() => undefined)
        const user = guard.resolveUser(req)
        const actor = user ? organizationPrincipal(user).actor : undefined
        controlPlane.store.appendEvent({
          organizationId: controlPlane.organization.id,
          projectId: controlPlane.project.id,
          actorId: actor?.id,
          correlationId: auditCorrelationId,
          type: response.status < 400 ? 'dashboard.mutation.succeeded' : 'dashboard.mutation.failed',
          level: response.status < 400 ? 'info' : 'warning',
          payload: dashboardMutationAuditPayload(req.method, url.pathname, input, response.status, Date.now() - auditStartedAt),
        })
      }
      response.headers.set('x-request-id', auditCorrelationId)
      return response
    },
  })

  queueWorker?.start()

  const stop = server.stop.bind(server)
  server.stop = ((closeActiveConnections?: boolean) => {
    clearInterval(throttleSweep)
    clearInterval(recoveryThrottleSweep)
    clearInterval(mfaThrottleSweep)
    clearInterval(runtimeStreamSweep)
    clearInterval(previewCleanupSweep)
    clearUiCache()
    runtimeStreams.clear()
    queueWorker?.stop()
    const result = stop(closeActiveConnections)
    if (queueWorker) void queueWorker.settled().finally(() => controlPlane.store.close())
    else controlPlane.store.close()
    return result
  }) as typeof server.stop

  return { server, url: `http://${host}:${server.port}/` }
}
