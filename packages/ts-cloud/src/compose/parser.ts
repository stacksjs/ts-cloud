import type { ComposeApplicationManifest, ComposeBuild, ComposeDependency, ComposeDiagnostic, ComposeHealthCheck, ComposeParseResult, ComposePort, ComposeService, ComposeVolumeMount } from './types'
import { createHash } from 'node:crypto'

const NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,62})$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SECRET_NAME = /(secret|token|password|passwd|private.?key|api.?key|credential)/i
const SAFE_SERVICE_KEYS = new Set(['image', 'build', 'command', 'entrypoint', 'environment', 'ports', 'volumes', 'networks', 'depends_on', 'healthcheck', 'restart', 'deploy', 'labels'])
const BLOCKED_SERVICE_KEYS = new Map([['privileged', 'Privileged containers are blocked.'], ['network_mode', 'Host/custom network modes are blocked.'], ['pid', 'Host PID namespaces are blocked.'], ['ipc', 'Host IPC namespaces are blocked.'], ['devices', 'Device access is blocked.'], ['cap_add', 'Additional Linux capabilities require an external policy exception.'], ['security_opt', 'Custom security options require an external policy exception.']])

function object(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {} }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : value == null ? [] : [value] }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63) || 'compose-app' }
function command(value: unknown): string[] | undefined { if (Array.isArray(value)) return value.map(String); if (typeof value === 'string' && value.trim()) return ['sh', '-c', value]; return undefined }
function duration(value: unknown, fallback: number): number { const text = String(value ?? ''); const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text); if (!match) return fallback; const number = Number(match[1]); return Math.max(0, Math.round(number * (match[2] === 'ms' ? .001 : match[2] === 'm' ? 60 : match[2] === 'h' ? 3600 : 1))) }
function memory(value: unknown): number | undefined { const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?$/i.exec(String(value ?? '')); if (!match) return undefined; const valueNumber = Number(match[1]); const unit = String(match[2] ?? 'b').toLowerCase(); const bytes = valueNumber * (unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('k') ? 1024 : 1); return Math.max(1, Math.round(bytes / 1024 / 1024)) }
function secretReference(value: unknown): string | undefined { if (value == null) return ''; const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-?][^}]*)?\}$/.exec(String(value)); return match?.[1] }

function environment(value: unknown, path: string, diagnostics: ComposeDiagnostic[]): Record<string, string | { secretRef: string }> {
  const result: Record<string, string | { secretRef: string }> = {}
  const entries = Array.isArray(value) ? value.map((item) => { const [name, ...rest] = String(item).split('='); return [name, rest.length ? rest.join('=') : null] }) : Object.entries(object(value))
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName)
    if (!ENV_NAME.test(name)) { diagnostics.push({ severity: 'error', path: `${path}.${name}`, code: 'environment.name', message: 'Environment variable names must use portable shell identifiers.' }); continue }
    const reference = secretReference(rawValue)
    if (reference !== undefined) { result[name] = { secretRef: reference || name }; continue }
    if (SECRET_NAME.test(name)) { diagnostics.push({ severity: 'error', path: `${path}.${name}`, code: 'secret.literal', message: 'Literal secret-like environment values are not stored.', alternative: `Use \${${name}} and supply ${name} through the secret store.` }); result[name] = { secretRef: name }; continue }
    result[name] = String(rawValue ?? '')
  }
  return result
}

function ports(value: unknown, path: string, diagnostics: ComposeDiagnostic[]): ComposePort[] {
  const result: ComposePort[] = []
  for (const [index, item] of list(value).entries()) {
    let target: number; let published: number | undefined; let protocol: 'tcp' | 'udp' = 'tcp'
    if (typeof item === 'number') target = item
    else if (typeof item === 'string') {
      const [address, rawProtocol] = item.split('/'); protocol = rawProtocol === 'udp' ? 'udp' : 'tcp'; const parts = address!.split(':'); target = Number(parts.at(-1)); published = parts.length > 1 ? Number(parts.at(-2)) : undefined
    }
    else { const entry = object(item); target = Number(entry.target); published = entry.published == null ? undefined : Number(entry.published); protocol = entry.protocol === 'udp' ? 'udp' : 'tcp' }
    if (!Number.isInteger(target) || target < 1 || target > 65535 || (published != null && (!Number.isInteger(published) || published < 1 || published > 65535))) diagnostics.push({ severity: 'error', path: `${path}[${index}]`, code: 'port.invalid', message: 'Ports must be integers from 1 through 65535.' })
    else result.push({ target, ...(published ? { published } : {}), protocol })
  }
  return result
}

function volumes(value: unknown, declared: Set<string>, path: string, diagnostics: ComposeDiagnostic[]): ComposeVolumeMount[] {
  const result: ComposeVolumeMount[] = []
  for (const [index, item] of list(value).entries()) {
    let source = ''; let target = ''; let readOnly = false; let type = 'volume'
    if (typeof item === 'string') { const parts = item.split(':'); source = parts[0] ?? ''; target = parts[1] ?? ''; readOnly = parts.slice(2).includes('ro'); type = source.startsWith('/') || source.startsWith('.') ? 'bind' : 'volume' }
    else { const entry = object(item); source = String(entry.source ?? ''); target = String(entry.target ?? ''); readOnly = entry.read_only === true; type = String(entry.type ?? 'volume') }
    if (type !== 'volume' || source.startsWith('/') || source.startsWith('.')) { diagnostics.push({ severity: 'error', path: `${path}[${index}]`, code: 'volume.host_mount', message: 'Host and bind mounts are blocked; use a named volume.', alternative: 'Declare the volume at the top level and mount it by name.' }); continue }
    if (!NAME.test(source) || !target.startsWith('/')) { diagnostics.push({ severity: 'error', path: `${path}[${index}]`, code: 'volume.invalid', message: 'A named source and absolute container target are required.' }); continue }
    if (!declared.has(source)) diagnostics.push({ severity: 'warning', path: `${path}[${index}]`, code: 'volume.implicit', message: `Named volume ${source} is implicit and will be declared on export.` })
    declared.add(source); result.push({ source, target, readOnly })
  }
  return result
}

function dependencies(value: unknown): ComposeDependency[] {
  return Array.isArray(value)
    ? value.map(service => ({ service: String(service), condition: 'service_started' as const }))
    : Object.entries(object(value)).map(([service, config]) => ({ service, condition: (['service_started', 'service_healthy', 'service_completed_successfully'].includes(String(object(config).condition)) ? String(object(config).condition) : 'service_started') as ComposeDependency['condition'] }))
}

function health(value: unknown): ComposeHealthCheck | undefined { const entry = object(value); if (!Object.keys(entry).length || entry.disable === true) return undefined; const test = command(entry.test); return test ? { test, intervalSeconds: duration(entry.interval, 30), timeoutSeconds: duration(entry.timeout, 5), retries: Math.max(1, Number(entry.retries) || 3), ...(entry.start_period ? { startPeriodSeconds: duration(entry.start_period, 0) } : {}) } : undefined }
function build(value: unknown, path: string, diagnostics: ComposeDiagnostic[]): ComposeBuild | undefined {
  if (!value) return undefined; const entry = typeof value === 'string' ? { context: value } : object(value); const context = String(entry.context ?? '.'); const dockerfile = String(entry.dockerfile ?? 'Dockerfile')
  if (context.startsWith('/') || context.split('/').includes('..') || dockerfile.startsWith('/') || dockerfile.split('/').includes('..')) diagnostics.push({ severity: 'error', path, code: 'build.traversal', message: 'Build context and Dockerfile must stay inside the repository.' })
  return { context, dockerfile, ...(entry.target ? { target: String(entry.target) } : {}), args: environment(entry.args, `${path}.args`, diagnostics) }
}
function domains(labels: unknown, path: string, diagnostics: ComposeDiagnostic[]): string[] { const record = Array.isArray(labels) ? Object.fromEntries(labels.map(value => String(value).split('=', 2))) : object(labels); const values = String(record['ts-cloud.domains'] ?? record['ts-cloud.domain'] ?? '').split(',').map(value => value.trim()).filter(Boolean); for (const value of values) if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) diagnostics.push({ severity: 'error', path, code: 'domain.invalid', message: `Invalid service domain ${value}.` }); return values.filter(value => /\./.test(value)) }

function order(services: Record<string, ComposeService>, diagnostics: ComposeDiagnostic[]): string[] {
  const result: string[] = []; const visiting = new Set<string>(); const visited = new Set<string>()
  const visit = (name: string) => { if (visited.has(name)) return; if (visiting.has(name)) { diagnostics.push({ severity: 'error', path: `services.${name}.depends_on`, code: 'dependency.cycle', message: 'Service dependencies contain a cycle.' }); return } visiting.add(name); for (const dependency of services[name]?.dependsOn ?? []) { if (!services[dependency.service]) diagnostics.push({ severity: 'error', path: `services.${name}.depends_on.${dependency.service}`, code: 'dependency.missing', message: `Dependency ${dependency.service} does not exist.` }); else visit(dependency.service) } visiting.delete(name); visited.add(name); result.push(name) }
  Object.keys(services).sort().forEach(visit); return result
}

export function parseCompose(source: string, input: { name: string, projectId: string, environmentId: string, slug?: string }): ComposeParseResult {
  if (Buffer.byteLength(source) > 512 * 1024) throw new Error('Compose source exceeds the 512 KiB limit')
  let root: Record<string, any>
  try { root = object(Bun.YAML.parse(source)) } catch (error) { throw new Error(`Compose YAML could not be parsed: ${error instanceof Error ? error.message : String(error)}`) }
  const diagnostics: ComposeDiagnostic[] = []; const serviceInput = object(root.services); const serviceNames = Object.keys(serviceInput)
  if (!serviceNames.length) diagnostics.push({ severity: 'error', path: 'services', code: 'services.required', message: 'At least one service is required.' })
  if (serviceNames.length > 64) diagnostics.push({ severity: 'error', path: 'services', code: 'services.limit', message: 'A Compose application may contain at most 64 services.' })
  const declaredVolumes = new Set(Object.keys(object(root.volumes))); const declaredNetworks = new Set(Object.keys(object(root.networks))); const services: Record<string, ComposeService> = {}
  for (const name of serviceNames.sort()) {
    const path = `services.${name}`; const raw = object(serviceInput[name])
    if (!NAME.test(name)) { diagnostics.push({ severity: 'error', path, code: 'service.name', message: 'Service names must be portable lowercase identifiers.' }); continue }
    for (const [key, message] of BLOCKED_SERVICE_KEYS) if (raw[key] != null && raw[key] !== false && (!Array.isArray(raw[key]) || raw[key].length)) diagnostics.push({ severity: 'error', path: `${path}.${key}`, code: `unsafe.${key}`, message })
    for (const key of Object.keys(raw)) if (!SAFE_SERVICE_KEYS.has(key) && !BLOCKED_SERVICE_KEYS.has(key)) diagnostics.push({ severity: 'warning', path: `${path}.${key}`, code: 'field.unsupported', message: `Compose field ${key} is not in the supported subset and will not be deployed.` })
    const image = raw.image ? String(raw.image) : undefined; const serviceBuild = build(raw.build, `${path}.build`, diagnostics)
    if (!image && !serviceBuild) diagnostics.push({ severity: 'error', path, code: 'service.source', message: 'Each service requires image or build.' })
    if (image && (!image.includes('@sha256:') && (!image.includes(':') || image.endsWith(':latest')))) diagnostics.push({ severity: 'warning', path: `${path}.image`, code: 'image.floating', message: `Image ${image} is not pinned to a digest or explicit tag.` })
    const networks = list(raw.networks).map(value => typeof value === 'string' ? value : String(object(value).name ?? '')).filter(Boolean); networks.forEach(network => declaredNetworks.add(network))
    const deploy = object(raw.deploy); const resources = object(deploy.resources); const limits = object(resources.limits)
    const restart = ['no', 'always', 'on-failure', 'unless-stopped'].includes(String(raw.restart)) ? String(raw.restart) as ComposeService['restart'] : 'unless-stopped'
    services[name] = { name, ...(image ? { image } : {}), ...(serviceBuild ? { build: serviceBuild } : {}), ...(command(raw.command) ? { command: command(raw.command) } : {}), ...(command(raw.entrypoint) ? { entrypoint: command(raw.entrypoint) } : {}), environment: environment(raw.environment, `${path}.environment`, diagnostics), ports: ports(raw.ports, `${path}.ports`, diagnostics), volumes: volumes(raw.volumes, declaredVolumes, `${path}.volumes`, diagnostics), networks, dependsOn: dependencies(raw.depends_on), ...(health(raw.healthcheck) ? { healthCheck: health(raw.healthcheck) } : {}), restart, ...(Number(limits.cpus) > 0 ? { cpu: Number(limits.cpus) } : {}), ...(memory(limits.memory) ? { memoryMb: memory(limits.memory) } : {}), replicas: Math.max(1, Math.min(100, Number(deploy.replicas) || 1)), domains: domains(raw.labels, `${path}.labels`, diagnostics) }
  }
  const dependencyOrder = order(services, diagnostics)
  const manifest: ComposeApplicationManifest = { apiVersion: 'ts-cloud.dev/v1', kind: 'ComposeApplication', metadata: { name: input.name.trim(), slug: slug(input.slug ?? input.name), projectId: input.projectId, environmentId: input.environmentId }, spec: { services, networks: [...declaredNetworks].sort(), volumes: [...declaredVolumes].sort(), dependencyOrder } }
  const redactedSource = exportCompose(manifest)
  return { valid: !diagnostics.some(issue => issue.severity === 'error'), manifest, diagnostics, redactedSource, sourceHash: createHash('sha256').update(source).digest('hex') }
}

export function exportCompose(manifest: ComposeApplicationManifest): string {
  const services = Object.fromEntries(Object.entries(manifest.spec.services).map(([name, service]) => [name, {
    ...(service.image ? { image: service.image } : {}), ...(service.build ? { build: { context: service.build.context, dockerfile: service.build.dockerfile, ...(service.build.target ? { target: service.build.target } : {}), ...(Object.keys(service.build.args).length ? { args: Object.fromEntries(Object.entries(service.build.args).map(([key, value]) => [key, typeof value === 'string' ? value : `\${${value.secretRef}:?required secret ${value.secretRef}}`])) } : {}) } } : {}),
    ...(service.command ? { command: service.command } : {}), ...(service.entrypoint ? { entrypoint: service.entrypoint } : {}), ...(Object.keys(service.environment).length ? { environment: Object.fromEntries(Object.entries(service.environment).map(([key, value]) => [key, typeof value === 'string' ? value : `\${${value.secretRef}:?required secret ${value.secretRef}}`])) } : {}),
    ...(service.ports.length ? { ports: service.ports.map(port => `${port.published ? `${port.published}:` : ''}${port.target}${port.protocol === 'udp' ? '/udp' : ''}`) } : {}), ...(service.volumes.length ? { volumes: service.volumes.map(volume => `${volume.source}:${volume.target}${volume.readOnly ? ':ro' : ''}`) } : {}), ...(service.networks.length ? { networks: service.networks } : {}), ...(service.dependsOn.length ? { depends_on: Object.fromEntries(service.dependsOn.map(dependency => [dependency.service, { condition: dependency.condition }])) } : {}), ...(service.healthCheck ? { healthcheck: { test: service.healthCheck.test, interval: `${service.healthCheck.intervalSeconds}s`, timeout: `${service.healthCheck.timeoutSeconds}s`, retries: service.healthCheck.retries, ...(service.healthCheck.startPeriodSeconds != null ? { start_period: `${service.healthCheck.startPeriodSeconds}s` } : {}) } } : {}), restart: service.restart, ...(service.cpu || service.memoryMb || service.replicas !== 1 ? { deploy: { replicas: service.replicas, resources: { limits: { ...(service.cpu ? { cpus: String(service.cpu) } : {}), ...(service.memoryMb ? { memory: `${service.memoryMb}M` } : {}) } } } } : {}), ...(service.domains.length ? { labels: { 'ts-cloud.domains': service.domains.join(',') } } : {}),
  }]))
  return Bun.YAML.stringify({ services, ...(manifest.spec.networks.length ? { networks: Object.fromEntries(manifest.spec.networks.map(name => [name, {}])) } : {}), ...(manifest.spec.volumes.length ? { volumes: Object.fromEntries(manifest.spec.volumes.map(name => [name, {}])) } : {}) })
}

export function diffCompose(previous: ComposeApplicationManifest, next: ComposeApplicationManifest): Array<{ path: string, before?: unknown, after?: unknown }> {
  const changes: Array<{ path: string, before?: unknown, after?: unknown }> = []; const walk = (path: string, before: any, after: any) => { if (JSON.stringify(before) === JSON.stringify(after)) return; if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) { for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) walk(path ? `${path}.${key}` : key, before[key], after[key]); return } changes.push({ path, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }) }; walk('', previous, next); return changes
}
