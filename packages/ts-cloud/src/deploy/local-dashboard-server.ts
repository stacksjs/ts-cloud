import type { CloudConfig, EnvironmentType } from '@ts-cloud/core'
import { existsSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCloudConfig } from '../config'
import { resolveDashboardData } from './dashboard-data'
import { resolveServerDashboardData } from './dashboard-data-server'
import { backupDatabase, createDatabase, createDatabaseUser, isValidDbIdentifier, listDatabaseBackups, listDatabases } from './dashboard-database'
import { buildDashboardOperations, resolveDashboardOperation, runDashboardOperation, runServerShellCommand } from './dashboard-operations'
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
  purgeDlq,
  redriveDlq,
  resolveServerlessOperation,
  runServerlessCommand,
  runServerlessOperation,
  setServerlessSecret,
  updateFunctionConfig,
} from './serverless-operations'
import { addSiteToCloudConfig, removeSiteFromCloudConfig, renderAliasesValue, renderEnvValue, renderSslValue, renderStringValue, setSitePropertyInCloudConfig } from './site-config-editor'
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
const here = dirname(fileURLToPath(import.meta.url))

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function text(data: string, status = 200): Response {
  return new Response(data, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

function selectedEnvironment(config: CloudConfig, requested?: EnvironmentType): EnvironmentType {
  if (requested)
    return requested
  const envs = Object.keys(config.environments ?? {}) as EnvironmentType[]
  return envs[0] ?? 'production'
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
 * Resolve which dashboard the project should land on. An explicit `mode` (on the
 * config root, else on `infrastructure.compute`) always wins — a project that
 * declares `mode: 'serverless'` gets the serverless cockpit even though it also
 * carries a `compute` block (e.g. for its serverless ECS/Lambda sizing). Only
 * when no mode is declared do we infer it from the presence of a compute box.
 */
function resolveDashboardMode(config: CloudConfig): 'server' | 'serverless' | 'hybrid' {
  const declared = (config as any).mode ?? (config.infrastructure?.compute as any)?.mode
  if (declared === 'hybrid' || declared === 'server' || declared === 'serverless')
    return declared
  return config.infrastructure?.compute ? 'server' : 'serverless'
}

async function resolveLiveDashboardData(config: CloudConfig, environment: EnvironmentType): Promise<Record<string, any>> {
  const mode = resolveDashboardMode(config)
  // The nav renders a mode-aware view set + a server-rendered environment switcher.
  const meta = { mode, environment, environments: Object.keys(config.environments ?? {}) }
  try {
    // Hybrid projects run both a box and serverless functions — resolve both so
    // the Server and Serverless tabs each render live data. A failing source
    // only drops its own slice (each resolver is already best-effort internally).
    if (mode === 'hybrid') {
      const [serverData, serverlessData] = await Promise.all([
        resolveServerDashboardData(config, environment).catch(() => null),
        resolveDashboardData(config, environment).catch(() => null),
      ])
      return { ...(serverData ?? {}), ...(serverlessData ?? {}), ...meta }
    }
    const data = mode === 'serverless'
      ? await resolveDashboardData(config, environment)
      : await resolveServerDashboardData(config, environment)
    return { ...(data ?? {}), ...meta }
  }
  catch {
    // A serverless config without a fully-defined app (or an unreachable box)
    // shouldn't crash the cockpit — fall back to the sample-rendered UI.
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
  try {
    const outDir = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-'))
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
      if (process.env.TSCLOUD_DASHBOARD_VERBOSE)
        console.warn(`ts-cloud dashboard: live UI build failed; serving the pre-built UI.\n${stdout}\n${stderr}`)
      return null
    }
    return outDir
  }
  catch (err) {
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
  if (!file)
    return text('Not found', 404)
  if (statSync(file).isDirectory())
    return text('Not found', 404)
  const body = await readFile(file)
  const type = contentTypes[extname(file)] ?? 'application/octet-stream'
  return new Response(body, { headers: { 'content-type': type } })
}

export async function startLocalDashboardServer(options: LocalDashboardServerOptions = {}): Promise<LocalDashboardServer> {
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
  const availableEnvironments = Object.keys((config as CloudConfig).environments ?? {})
  // The active environment is mutable: the cockpit can switch via POST /api/env,
  // which re-resolves data, actions, and rebuilds the UI for the new environment.
  let environment = selectedEnvironment(config as CloudConfig, options.environment)
  let actions = dashboardActions(environment)
  const configPath = resolveCloudConfigPath(cwd)
  const initialData = await resolveLiveDashboardData(config as CloudConfig, environment)
  let latestData = initialData
  const liveUiRoot = await buildLiveUi(cwd, initialData)
  const packagedUi = resolveUiSource(cwd)
  let activeUiRoot = liveUiRoot ?? packagedUi?.uiRoot

  if (!activeUiRoot)
    throw new Error('ts-cloud dashboard UI not found. Run `bun run build` in ts-cloud or reinstall the package.')

  // Web-terminal sessions, one shell per open WebSocket connection.
  const terminalSessions = new WeakMap<object, ReturnType<typeof createTerminalSession>>()
  const terminalEnabled = process.env.TS_CLOUD_DASHBOARD_TERMINAL !== '0'

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

      try {
        if (url.pathname === '/api/terminal') {
          if (!terminalEnabled)
            return json({ ok: false, error: 'The web terminal is disabled.' }, 403)
          if (server.upgrade(req))
            return undefined
          return text('WebSocket upgrade failed', 400)
        }

        if (url.pathname === '/api/health') {
          return json({
            ok: true,
            cwd,
            environment,
            environments: availableEnvironments,
            uiRoot: activeUiRoot,
            liveData: !!liveUiRoot,
            terminal: terminalEnabled,
            localPackage: import.meta.url.includes('/Code/Libraries/ts-cloud/'),
          })
        }

        // A serverless deployment has no server home — land on the serverless view.
        if (url.pathname === '/' && latestData?.mode === 'serverless')
          return new Response(null, { status: 302, headers: { location: '/serverless' } })

        if (url.pathname === '/api/env' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const requested = String(body.env ?? '')
          if (!availableEnvironments.includes(requested))
            return json({ ok: false, error: `Unknown environment '${requested}'.`, environments: availableEnvironments }, 404)
          if (requested !== environment) {
            environment = requested as EnvironmentType
            actions = dashboardActions(environment)
            latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
            const rebuilt = await buildLiveUi(cwd, latestData)
            if (rebuilt)
              activeUiRoot = rebuilt
          }
          return json({ ok: true, environment, environments: availableEnvironments })
        }

        if (url.pathname === '/api/config')
          return json({ ...sanitizeCloudConfig(config as CloudConfig), environment, environments: availableEnvironments })

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
          if (body.port !== undefined && body.port !== null && body.port !== '' && (!Number.isInteger(Number(body.port)) || Number(body.port) < 1 || Number(body.port) > 65_535))
            return json({ ok: false, error: 'Port must be a number between 1 and 65535.' }, 422)

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
          return json(await runAction(action, { cwd, cliEntry }))
        }

        if (url.pathname === '/api/actions')
          return json(actions)

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
          return json(latestData)
        }

        if (url.pathname === '/api/actions/run' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { action?: string, confirm?: string }
          const action = body.action ? resolveDashboardAction(body.action, environment) : undefined
          if (!action)
            return json({ ok: false, error: 'Unknown dashboard action.' }, 404)
          if (action.mutates && body.confirm !== action.confirm)
            return json({ ok: false, error: `Type "${action.confirm}" to run this action.` }, 409)
          return json(await runAction(action, { cwd, cliEntry }))
        }

        if (url.pathname === '/api/server/operations/run' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { operation?: string, confirm?: string, to?: string }
          const operation = body.operation ? resolveDashboardOperation(body.operation, config as CloudConfig, latestData) : undefined
          if (!operation)
            return json({ ok: false, error: 'Unknown or unavailable server operation.' }, 404)
          if (operation.mutates && body.confirm !== operation.confirm)
            return json({ ok: false, error: `Type "${operation.confirm}" to run this operation.` }, 409)
          return json(await runDashboardOperation(config as CloudConfig, environment, operation, { to: body.to }))
        }

        if (url.pathname === '/api/server/command' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { command?: string, confirm?: string }
          if (body.confirm !== 'run')
            return json({ ok: false, error: 'Type "run" to execute this command on the server.' }, 409)
          return json(await runServerShellCommand(config as CloudConfig, environment, String(body.command ?? '')))
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
          const result = await runServerlessOperation(config as CloudConfig, environment, operation, { min: body.min, max: body.max })
          latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
          return json(result)
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

        if (url.pathname === '/api/serverless/scheduler' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as { action?: string, confirm?: string }
          const action = String(body.action ?? '').trim()
          if (action !== 'enable' && action !== 'disable' && action !== 'run')
            return json({ ok: false, error: 'Unknown scheduler action.' }, 422)
          if (body.confirm !== action)
            return json({ ok: false, error: `Type "${action}" to ${action} the scheduler.` }, 409)
          return json(await controlScheduler(config as CloudConfig, environment, action))
        }

        // A page request with `?env=<name>` switches the active environment
        // server-side (re-resolves data + actions and rebuilds the UI), so the
        // nav's environment links work without any client JavaScript.
        const requestedEnv = url.searchParams.get('env')
        if (requestedEnv && availableEnvironments.includes(requestedEnv) && requestedEnv !== environment) {
          environment = requestedEnv as EnvironmentType
          actions = dashboardActions(environment)
          latestData = await resolveLiveDashboardData(config as CloudConfig, environment)
          const rebuilt = await buildLiveUi(cwd, latestData)
          if (rebuilt)
            activeUiRoot = rebuilt
        }

        return serveStatic(activeUiRoot as string, url.pathname)
      }
      catch (error: any) {
        if (options.verbose)
          console.error(error)
        return json({ ok: false, error: error?.message ?? String(error) }, 500)
      }
    },
  })

  return { server, url: `http://${host}:${server.port}/` }
}
