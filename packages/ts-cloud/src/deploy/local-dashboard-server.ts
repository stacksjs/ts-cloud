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
import { buildDashboardOperations, resolveDashboardOperation, runDashboardOperation } from './dashboard-operations'
import { resolveUiSource } from './management-dashboard'
import { addSiteToCloudConfig, removeSiteFromCloudConfig, renderEnvValue, renderSslValue, renderStringValue, setSitePropertyInCloudConfig } from './site-config-editor'
import { addSshKeyToCloudConfig, describeSshKeys, removeSshKeyFromCloudConfig } from './ssh-config-editor'

export interface LocalDashboardServerOptions {
  host?: string
  port?: number
  cwd?: string
  environment?: EnvironmentType
  cliEntry?: string
  verbose?: boolean
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

async function readJsonBody(req: Request): Promise<Record<string, any>> {
  return await req.json().catch(() => ({})) as Record<string, any>
}

async function resolveLiveDashboardData(config: CloudConfig, environment: EnvironmentType): Promise<Record<string, any>> {
  const data = config.infrastructure?.compute
    ? await resolveServerDashboardData(config, environment)
    : await resolveDashboardData(config, environment)
  return data ?? {}
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

  const outDir = mkdtempSync(join(tmpdir(), 'ts-cloud-dashboard-'))
  const proc = Bun.spawn([
    'bunx',
    '--bun',
    'stx',
    'build',
    '--pages',
    'pages',
    '--out',
    outDir,
    '--no-sitemap',
    '--no-cache',
  ], {
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
  if (exitCode !== 0)
    throw new Error(`Failed to build live dashboard UI.\n${stdout}\n${stderr}`)

  return outDir
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
  if (existsSync(base))
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
  await loadLocalEnv(cwd)
  const config = await loadCloudConfig()
  const environment = selectedEnvironment(config as CloudConfig, options.environment)
  const actions = dashboardActions(environment)
  const configPath = resolveCloudConfigPath(cwd)
  const initialData = await resolveLiveDashboardData(config as CloudConfig, environment)
  let latestData = initialData
  const liveUiRoot = await buildLiveUi(cwd, initialData)
  const packagedUi = resolveUiSource(cwd)
  const uiRoot = liveUiRoot ?? packagedUi?.uiRoot

  if (!uiRoot)
    throw new Error('ts-cloud dashboard UI not found. Run `bun run build` in ts-cloud or reinstall the package.')

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url)

      try {
        if (url.pathname === '/api/health') {
          return json({
            ok: true,
            cwd,
            environment,
            uiRoot,
            liveData: !!liveUiRoot,
            localPackage: import.meta.url.includes('/Code/Libraries/ts-cloud/'),
          })
        }

        if (url.pathname === '/serverless' || url.pathname.startsWith('/serverless/'))
          return text('Serverless dashboard is hidden for now.', 404)

        if (url.pathname === '/api/config')
          return json(sanitizeCloudConfig(config as CloudConfig))

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
          for (const key of ['domain', 'path', 'build', 'start', 'type', 'root']) {
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

        return serveStatic(uiRoot, url.pathname)
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
