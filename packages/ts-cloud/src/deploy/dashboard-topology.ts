/**
 * Derive the infrastructure topology the dashboard draws as a diagram.
 *
 * Deliberately built from the *resolved dashboard data* rather than straight
 * from the cloud config: the diagram then shows what the rest of the cockpit
 * shows — the same sites, services, functions and queues, with the same
 * statuses — instead of a second, subtly different reading of the world.
 *
 * Nothing here invents a resource. A slice that could not be read simply
 * contributes no node, and the reason lands in `notes` so the page can say so
 * out loud. See `packages/ui/pages/infrastructure/topology.stx`.
 */

export type TopologyStatus = 'ok' | 'warn' | 'bad' | 'idle' | 'unknown'

export type TopologyKind =
  | 'internet'
  | 'dns'
  | 'waf'
  | 'firewall'
  | 'cdn'
  | 'gateway'
  | 'proxy'
  | 'site'
  | 'function'
  | 'worker'
  | 'scheduler'
  | 'queue'
  | 'cache'
  | 'database'
  | 'storage'
  | 'filesystem'
  | 'backup'

/** How traffic or state moves along an edge — drives the edge styling. */
export type TopologyFlow = 'request' | 'async' | 'data' | 'backup'

export interface TopologyFact {
  label: string
  value: string
}

export interface TopologyNode {
  id: string
  label: string
  kind: TopologyKind
  /** Row in the diagram: 0 is the internet, higher is deeper in the stack. */
  layer: number
  status: TopologyStatus
  /** One-line subtitle: runtime, engine, instance class… */
  sub?: string
  facts: TopologyFact[]
  /** Dashboard page this resource is managed from. */
  href?: string
  /** Boundary this node sits inside (a box, a VPC, a managed account). */
  group?: string
  /** Outside the deployment — drawn as an open shape. */
  external?: boolean
}

export interface TopologyLink {
  source: string
  target: string
  flow: TopologyFlow
  label?: string
  status?: TopologyStatus
}

export interface TopologyGroup {
  id: string
  label: string
  sub?: string
}

export interface TopologyLayer {
  index: number
  id: string
  label: string
}

/** Identity the data bag doesn't carry on its own. */
export interface TopologyContext {
  project?: string
  environment?: string
}

export interface TopologyModel {
  mode: 'server' | 'serverless'
  project: string
  environment: string
  provider: string
  region: string
  generatedAt: string
  layers: TopologyLayer[]
  groups: TopologyGroup[]
  nodes: TopologyNode[]
  links: TopologyLink[]
  /** What the diagram could not show, and why. Never left implicit. */
  notes: string[]
}

const SERVER_LAYERS: TopologyLayer[] = [
  { index: 0, id: 'clients', label: 'Clients' },
  { index: 1, id: 'dns', label: 'DNS & TLS' },
  { index: 2, id: 'edge', label: 'Edge' },
  { index: 3, id: 'routing', label: 'Routing' },
  { index: 4, id: 'apps', label: 'Applications' },
  { index: 5, id: 'runtime', label: 'Background runtime' },
  { index: 6, id: 'data', label: 'Data services' },
  { index: 7, id: 'durability', label: 'Durability' },
]

const SERVERLESS_LAYERS: TopologyLayer[] = [
  { index: 0, id: 'clients', label: 'Clients' },
  { index: 1, id: 'dns', label: 'DNS & TLS' },
  { index: 2, id: 'edge', label: 'Edge' },
  { index: 3, id: 'entry', label: 'Entry points' },
  { index: 4, id: 'compute', label: 'Compute' },
  { index: 5, id: 'messaging', label: 'Messaging & pooling' },
  { index: 6, id: 'data', label: 'Data services' },
  { index: 7, id: 'durability', label: 'Durability' },
]

/** Services probed on a box that are really data stores, not web plumbing. */
const DATA_SERVICE_KINDS: Array<{ match: RegExp, kind: TopologyKind, label: string }> = [
  { match: /^redis/, kind: 'cache', label: 'Redis' },
  { match: /^(?:mysql|mariadb)/, kind: 'database', label: 'MySQL' },
  { match: /^postgres/, kind: 'database', label: 'PostgreSQL' },
  { match: /^meilisearch/, kind: 'database', label: 'Meilisearch' },
  { match: /^vitess|^vtgate/, kind: 'database', label: 'Vitess' },
  { match: /^memcached/, kind: 'cache', label: 'Memcached' },
]

const PROXY_SERVICES = /^(?:rpx-gateway|nginx|caddy|traefik|haproxy)$/

function text(value: unknown, fallback = ''): string {
  const out = value == null ? '' : String(value).trim()
  return out && out !== '-' && out !== '—' ? out : fallback
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

/** Map the status vocabulary used across the dashboard onto diagram tones. */
function toneOf(status: unknown): TopologyStatus {
  const value = text(status).toLowerCase()
  if (!value) return 'unknown'
  if (['running', 'live', 'active', 'available', 'success', 'ok', 'healthy', 'enabled'].includes(value)) return 'ok'
  if (['failed', 'stopped', 'unreachable', 'error', 'critical', 'disabled'].includes(value)) return 'bad'
  if (['configured', 'creating', 'pending', 'degraded', 'shadowed', 'warn', 'unknown'].includes(value)) return 'warn'
  return 'warn'
}

function pushLink(links: TopologyLink[], link: TopologyLink, ids: Set<string>): void {
  if (ids.has(link.source) && ids.has(link.target)) links.push(link)
}

/**
 * Server-mode topology: clients → DNS → host firewall → reverse proxy → sites,
 * with the box's workers, scheduler, data services and backups hanging off it.
 */
export function buildServerTopology(data: Record<string, any>, context: TopologyContext = {}): TopologyModel {
  const nodes: TopologyNode[] = []
  const links: TopologyLink[] = []
  const notes: string[] = []
  const server = data.server ?? {}
  const sites: any[] = Array.isArray(data.sites) ? data.sites : []
  const services: any[] = Array.isArray(data.services) ? data.services : []
  const workers: any[] = Array.isArray(data.workers) ? data.workers : []
  const security = data.security ?? {}
  const reachable = !!data._serverReachable && !data.metricsUnavailable
  const box = 'box'

  if (!reachable)
    notes.push('The compute box could not be probed, so live service state is missing; the shape comes from your cloud config.')

  nodes.push({
    id: 'internet',
    label: 'Internet',
    kind: 'internet',
    layer: 0,
    status: 'ok',
    sub: 'Public traffic',
    facts: [],
    external: true,
  })

  const domains = [
    ...new Set(
      sites
        .map((site) => text(site.domain) || text(site.route).split('/')[0])
        .filter((domain) => domain && domain !== 'internal' && domain !== 'loopback'),
    ),
  ]
  const certificates: any[] = Array.isArray(security.tlsCertificates) ? security.tlsCertificates : []
  const expiringSoon = certificates.filter((cert) => Number(cert?.daysRemaining ?? 999) < 21).length
  nodes.push({
    id: 'dns',
    label: domains.length === 1 ? domains[0] : 'Public domains',
    kind: 'dns',
    layer: 1,
    status: expiringSoon ? 'warn' : domains.length ? 'ok' : 'unknown',
    sub: domains.length > 1 ? `${domains.length} domains` : 'DNS & certificates',
    facts: [
      { label: 'Domains', value: domains.length ? domains.slice(0, 6).join(', ') : 'none resolved' },
      { label: 'Certificates', value: certificates.length ? `${certificates.length} issued` : 'none reported' },
      ...(expiringSoon ? [{ label: 'Expiring', value: `${expiringSoon} within 21 days` }] : []),
    ],
    href: '/server/security',
    external: true,
  })

  const firewall = security.firewall ?? {}
  const ports: any[] = Array.isArray(security.ports) ? security.ports : []
  nodes.push({
    id: 'firewall',
    label: 'Host firewall',
    kind: 'firewall',
    layer: 2,
    status: toneOf(firewall.status),
    sub: text(firewall.summary, 'Inbound filtering'),
    facts: [
      { label: 'State', value: text(firewall.status, 'unknown') },
      { label: 'Open ports', value: ports.length ? ports.map((port) => text(port.listen)).join(', ') : 'not reported' },
    ],
    href: '/server/firewall',
    group: box,
  })

  const proxyService = services.find((service) => PROXY_SERVICES.test(text(service.name)))
  nodes.push({
    id: 'proxy',
    label: text(proxyService?.name, 'Reverse proxy'),
    kind: 'proxy',
    layer: 3,
    status: proxyService ? toneOf(proxyService.status) : 'unknown',
    sub: 'TLS termination & routing',
    facts: [
      { label: 'Service', value: text(proxyService?.name, 'not detected') },
      { label: 'State', value: text(proxyService?.status, reachable ? 'not running' : 'not probed') },
      { label: 'Routes', value: `${sites.length} site${sites.length === 1 ? '' : 's'}` },
    ],
    href: '/server/services',
    group: box,
  })

  for (const site of sites) {
    const id = `site:${text(site.name)}`
    if (!text(site.name)) continue
    nodes.push({
      id,
      label: text(site.name),
      kind: 'site',
      layer: 4,
      status: toneOf(site.status),
      sub: text(site.runtime, 'runtime'),
      facts: [
        { label: 'Route', value: text(site.route, 'internal') },
        { label: 'Runtime', value: text(site.runtime, 'unknown') },
        { label: 'Delivery', value: text(site.deploy, 'unknown') },
        { label: 'TLS', value: text(site.tls, 'unknown') },
        ...(site.responseMs != null ? [{ label: 'Response', value: `${Math.round(Number(site.responseMs))} ms` }] : []),
        ...(site.httpStatus != null ? [{ label: 'HTTP', value: String(site.httpStatus) }] : []),
      ],
      href: '/server/sites',
      group: box,
    })
  }

  for (const worker of workers) {
    const id = `worker:${text(worker.name)}`
    if (!text(worker.name)) continue
    nodes.push({
      id,
      label: text(worker.name),
      kind: 'worker',
      layer: 5,
      status: toneOf(worker.status),
      sub: `${Number(worker.processes ?? 1)} process${Number(worker.processes ?? 1) === 1 ? '' : 'es'}`,
      facts: [
        { label: 'Processes', value: String(worker.processes ?? 1) },
        { label: 'State', value: text(worker.status, 'unknown') },
        ...(text(worker.site) ? [{ label: 'Site', value: text(worker.site) }] : []),
      ],
      href: '/operations/jobs',
      group: box,
    })
  }

  const scheduler = data.serverScheduler ?? {}
  if (scheduler.enabled) {
    nodes.push({
      id: 'scheduler',
      label: 'Scheduler',
      kind: 'scheduler',
      layer: 5,
      status: 'ok',
      sub: 'Cron dispatch',
      facts: [{ label: 'Last run', value: text(scheduler.lastRun, 'unknown') }],
      href: '/operations/jobs',
      group: box,
    })
  }

  const dataServices = services
    .map((service) => {
      const name = text(service.name)
      const match = DATA_SERVICE_KINDS.find((candidate) => candidate.match.test(name))
      return match ? { service, name, ...match } : null
    })
    .filter((entry): entry is { service: any, name: string, match: RegExp, kind: TopologyKind, label: string } => !!entry)

  for (const entry of dataServices) {
    nodes.push({
      id: `data:${entry.name}`,
      label: entry.label,
      kind: entry.kind,
      layer: 6,
      status: toneOf(entry.service.status),
      sub: entry.name,
      facts: [
        { label: 'Unit', value: entry.name },
        { label: 'State', value: text(entry.service.status, 'unknown') },
      ],
      href: '/data/services',
      group: box,
    })
  }

  const backup = data.backup ?? {}
  if (backup.enabled) {
    nodes.push({
      id: 'backup',
      label: 'Backups',
      kind: 'backup',
      layer: 7,
      status: 'ok',
      sub: text(backup.destination, 'destination'),
      facts: [
        { label: 'Destination', value: text(backup.destination, 'unknown') },
        { label: 'Schedule', value: text(backup.schedule, 'unknown') },
        { label: 'Retention', value: `${backup.retention ?? 0} copies` },
        { label: 'Last run', value: text(backup.last, 'unknown') },
      ],
      href: '/data/backups',
    })
  }

  const ids = new Set(nodes.map((node) => node.id))
  pushLink(links, { source: 'internet', target: 'dns', flow: 'request', label: 'https' }, ids)
  pushLink(links, { source: 'dns', target: 'firewall', flow: 'request', label: '443/80' }, ids)
  pushLink(links, { source: 'firewall', target: 'proxy', flow: 'request' }, ids)
  for (const site of sites) {
    const id = `site:${text(site.name)}`
    pushLink(links, { source: 'proxy', target: id, flow: 'request', label: text(site.path) || undefined, status: toneOf(site.status) }, ids)
  }
  for (const worker of workers) {
    const id = `worker:${text(worker.name)}`
    const site = `site:${text(worker.site)}`
    if (ids.has(site)) pushLink(links, { source: site, target: id, flow: 'async', label: 'queue' }, ids)
    else pushLink(links, { source: 'proxy', target: id, flow: 'async', label: 'queue' }, ids)
  }
  for (const worker of workers) {
    pushLink(links, { source: 'scheduler', target: `worker:${text(worker.name)}`, flow: 'async', label: 'dispatch' }, ids)
  }
  // Everything on the box shares localhost, so app and worker processes reach
  // every data service on it. Stated as co-location, not as a declared binding.
  const consumers = [...sites.map((site) => `site:${text(site.name)}`), ...workers.map((worker) => `worker:${text(worker.name)}`)]
  for (const entry of dataServices) {
    for (const consumer of consumers)
      pushLink(links, { source: consumer, target: `data:${entry.name}`, flow: 'data', label: 'localhost' }, ids)
  }
  if (dataServices.length && consumers.length)
    notes.push('Data-service edges show co-location on the box: every process on it can reach localhost. They are not a declared per-site binding.')
  for (const entry of dataServices) {
    pushLink(links, { source: `data:${entry.name}`, target: 'backup', flow: 'backup', label: 'snapshot' }, ids)
  }
  for (const site of sites) {
    pushLink(links, { source: `site:${text(site.name)}`, target: 'backup', flow: 'backup' }, ids)
  }

  return {
    mode: 'server',
    project: text(context.project) || text(data.project?.name) || text(server.name, 'project'),
    environment: text(context.environment) || text(data.environment, 'production'),
    provider: text(server.provider, 'unknown'),
    region: text(server.region, 'unknown'),
    generatedAt: new Date().toISOString(),
    layers: SERVER_LAYERS,
    groups: [
      {
        id: box,
        label: text(server.name, 'App server'),
        sub: [text(server.provider), text(server.region), text(server.ip)].filter(Boolean).join(' · '),
      },
    ],
    nodes,
    links,
    notes,
  }
}

/**
 * Serverless-mode topology: clients → DNS → WAF/CDN → the HTTP entry point →
 * functions, with queues, database, cache and object storage behind them.
 */
export function buildServerlessTopology(data: Record<string, any>, context: TopologyContext = {}): TopologyModel {
  const nodes: TopologyNode[] = []
  const links: TopologyLink[] = []
  const notes: string[] = []
  const app = data.app ?? {}
  const functions: any[] = Array.isArray(data.functions) ? data.functions : []
  const queues: any[] = Array.isArray(data.queues) ? data.queues : []
  const metrics = data.metrics ?? {}

  if (!functions.length)
    notes.push('No Lambda functions were read for this environment, so the compute layer is empty rather than assumed.')

  nodes.push({
    id: 'internet',
    label: 'Internet',
    kind: 'internet',
    layer: 0,
    status: 'ok',
    sub: 'Public traffic',
    facts: [],
    external: true,
  })

  const url = text(app.url)
  const host = url.replace(/^https?:\/\//, '').split('/')[0]
  nodes.push({
    id: 'dns',
    label: host || 'Application domain',
    kind: 'dns',
    layer: 1,
    status: host ? 'ok' : 'unknown',
    sub: 'DNS & certificates',
    facts: [{ label: 'Endpoint', value: url || 'not resolved' }],
    external: true,
  })

  const waf = data.waf
  if (waf) {
    nodes.push({
      id: 'waf',
      label: 'WAF',
      kind: 'waf',
      layer: 2,
      status: toneOf(waf.status ?? 'active'),
      sub: text(waf.scope, 'Managed rules'),
      facts: [
        { label: 'Web ACL', value: text(waf.name, 'unnamed') },
        ...(waf.blocked != null ? [{ label: 'Blocked (24h)', value: String(waf.blocked) }] : []),
        { label: 'Rules', value: String(count(data.wafRules)) },
      ],
      href: '/serverless/firewall',
    })
  }

  const assets = data.assetsInfo
  if (assets) {
    nodes.push({
      id: 'cdn',
      label: 'Asset CDN',
      kind: 'cdn',
      layer: 2,
      status: 'ok',
      sub: text(assets.cdn, 'CloudFront'),
      facts: [
        { label: 'Distribution', value: text(assets.cdn, 'unknown') },
        { label: 'Custom domain', value: text(assets.customDomain, 'none') },
      ],
      href: '/serverless/assets',
    })
    nodes.push({
      id: 'assets',
      label: 'Asset bucket',
      kind: 'storage',
      layer: 6,
      status: 'ok',
      sub: text(assets.bucket, 'S3'),
      facts: [
        { label: 'Bucket', value: text(assets.bucket, 'unknown') },
        ...(assets.files ? [{ label: 'Objects', value: String(assets.files) }] : []),
        ...(assets.sizeMb ? [{ label: 'Size', value: `${assets.sizeMb} MB` }] : []),
      ],
      href: '/serverless/assets',
    })
  }

  const httpFunction = functions.find((fn) => text(fn.key).startsWith('http'))
  nodes.push({
    id: 'gateway',
    label: 'HTTP entry point',
    kind: 'gateway',
    layer: 3,
    status: httpFunction ? 'ok' : 'unknown',
    sub: 'Function URL / API Gateway',
    facts: [
      { label: 'Endpoint', value: url || 'not resolved' },
      { label: 'Invocations (24h)', value: String(metrics.invocations ?? 0) },
      ...(metrics.errorRatePct != null ? [{ label: 'Error rate', value: `${metrics.errorRatePct}%` }] : []),
    ],
    href: '/serverless/metrics',
  })

  for (const fn of functions) {
    const id = `fn:${text(fn.name)}`
    if (!text(fn.name)) continue
    const errors = Number(fn.errors ?? 0)
    const invocations = Number(fn.invocations ?? 0)
    nodes.push({
      id,
      label: text(fn.key, text(fn.name)),
      kind: 'function',
      layer: 4,
      status: errors > 0 ? (invocations && errors / invocations > 0.02 ? 'bad' : 'warn') : invocations ? 'ok' : 'idle',
      sub: text(fn.runtime, 'lambda'),
      facts: [
        { label: 'Function', value: text(fn.name) },
        { label: 'Memory', value: `${fn.memory ?? 0} MB` },
        { label: 'Timeout', value: `${fn.timeout ?? 0}s` },
        { label: 'Invocations (24h)', value: String(invocations) },
        { label: 'Errors (24h)', value: String(errors) },
        { label: 'p95', value: `${fn.p95 ?? 0} ms` },
        ...(fn.provisioned ? [{ label: 'Provisioned', value: text(fn.provisioned) }] : []),
      ],
      href: '/serverless/functions',
    })
  }

  for (const queue of queues) {
    const id = `queue:${text(queue.name)}`
    if (!text(queue.name)) continue
    const dlq = Number(queue.dlq ?? 0)
    nodes.push({
      id,
      label: text(queue.name),
      kind: 'queue',
      layer: 5,
      status: dlq > 0 ? 'bad' : Number(queue.visible ?? 0) > 0 ? 'warn' : 'ok',
      sub: 'SQS',
      facts: [
        { label: 'Visible', value: String(queue.visible ?? 0) },
        { label: 'In flight', value: String(queue.inFlight ?? 0) },
        { label: 'Processed (24h)', value: String(queue.processed ?? 0) },
        { label: 'Dead letter', value: String(dlq) },
      ],
      href: '/serverless/queues',
    })
  }

  const aurora = data.aurora
  if (aurora) {
    nodes.push({
      id: 'database',
      label: 'Aurora Serverless',
      kind: 'database',
      layer: 6,
      status: toneOf(aurora.status),
      sub: text(aurora.engine, 'aurora'),
      facts: [
        { label: 'Cluster', value: text(aurora.id, 'unknown') },
        { label: 'Capacity', value: `${aurora.currentAcu ?? 0} ACU (${aurora.minAcu ?? 0}–${aurora.maxAcu ?? 0})` },
        { label: 'Connections', value: String(aurora.connections ?? 0) },
      ],
      href: '/serverless/data',
    })
  }

  const proxy = data.proxy
  if (proxy) {
    nodes.push({
      id: 'rds-proxy',
      label: 'RDS Proxy',
      kind: 'database',
      layer: 5,
      status: toneOf(proxy.status),
      sub: 'Connection pooling',
      facts: [
        { label: 'Proxy', value: text(proxy.name, 'unknown') },
        { label: 'Endpoint', value: text(proxy.endpoint, 'unknown') },
        { label: 'Pooled', value: String(proxy.pooledConns ?? 0) },
      ],
      href: '/serverless/data',
    })
  }

  const redis = data.redis
  if (redis) {
    nodes.push({
      id: 'cache',
      label: 'ElastiCache',
      kind: 'cache',
      layer: 6,
      status: toneOf(redis.status),
      sub: text(redis.node, 'redis'),
      facts: [
        { label: 'Group', value: text(redis.id, 'unknown') },
        { label: 'Hit rate', value: `${redis.hitRate ?? 0}%` },
      ],
      href: '/serverless/data',
    })
  }

  const efs = data.efs
  if (efs) {
    nodes.push({
      id: 'efs',
      label: 'EFS',
      kind: 'filesystem',
      layer: 6,
      status: toneOf(efs.status),
      sub: text(efs.mount, '/mnt/local'),
      facts: [
        { label: 'File system', value: text(efs.id, 'unknown') },
        { label: 'Mount', value: text(efs.mount, 'unknown') },
        { label: 'Size', value: `${efs.sizeMb ?? 0} MB` },
      ],
      href: '/data/volumes',
    })
  }

  const scheduler = data.scheduler ?? {}
  if (scheduler.enabled) {
    nodes.push({
      id: 'scheduler',
      label: 'Scheduler',
      kind: 'scheduler',
      layer: 3,
      status: 'ok',
      sub: text(scheduler.expression, 'rate(1 minute)'),
      facts: [
        { label: 'Expression', value: text(scheduler.expression, 'unknown') },
        { label: 'Last run', value: text(scheduler.lastRun, 'unknown') },
      ],
      href: '/operations/jobs',
    })
  }

  const ids = new Set(nodes.map((node) => node.id))
  const entry = ids.has('waf') ? 'waf' : 'gateway'
  pushLink(links, { source: 'internet', target: 'dns', flow: 'request', label: 'https' }, ids)
  pushLink(links, { source: 'dns', target: entry, flow: 'request' }, ids)
  pushLink(links, { source: 'dns', target: 'cdn', flow: 'request', label: 'assets' }, ids)
  pushLink(links, { source: 'waf', target: 'gateway', flow: 'request', label: 'allowed' }, ids)
  pushLink(links, { source: 'cdn', target: 'assets', flow: 'data', label: 'origin' }, ids)

  const httpFunctions = functions.filter((fn) => text(fn.key).startsWith('http'))
  const queueFunctions = functions.filter((fn) => text(fn.key).startsWith('queue'))
  const cliFunctions = functions.filter((fn) => text(fn.key).startsWith('cli'))
  for (const fn of httpFunctions)
    pushLink(links, { source: 'gateway', target: `fn:${text(fn.name)}`, flow: 'request', label: 'invoke' }, ids)
  for (const fn of cliFunctions)
    pushLink(links, { source: 'scheduler', target: `fn:${text(fn.name)}`, flow: 'async', label: 'schedule' }, ids)
  for (const queue of queues) {
    for (const fn of httpFunctions)
      pushLink(links, { source: `fn:${text(fn.name)}`, target: `queue:${text(queue.name)}`, flow: 'async', label: 'publish' }, ids)
    for (const fn of queueFunctions)
      pushLink(links, { source: `queue:${text(queue.name)}`, target: `fn:${text(fn.name)}`, flow: 'async', label: 'consume' }, ids)
  }

  const stateful = ['rds-proxy', 'database', 'cache', 'efs', 'assets']
  for (const fn of functions) {
    const id = `fn:${text(fn.name)}`
    if (ids.has('rds-proxy')) pushLink(links, { source: id, target: 'rds-proxy', flow: 'data', label: 'pooled' }, ids)
    else pushLink(links, { source: id, target: 'database', flow: 'data', label: 'sql' }, ids)
    for (const target of stateful.filter((candidate) => candidate !== 'rds-proxy' && candidate !== 'database'))
      pushLink(links, { source: id, target, flow: 'data' }, ids)
  }
  pushLink(links, { source: 'rds-proxy', target: 'database', flow: 'data', label: 'sql' }, ids)

  return {
    mode: 'serverless',
    project: text(context.project) || text(app.name, 'application'),
    environment: text(context.environment) || text(app.env, 'production'),
    provider: 'aws',
    region: text(app.region, 'unknown'),
    generatedAt: new Date().toISOString(),
    layers: SERVERLESS_LAYERS,
    groups: [],
    nodes,
    links,
    notes,
  }
}

/** Build the topology matching the dashboard mode the data was resolved for. */
export function buildTopology(
  mode: 'server' | 'serverless',
  data: Record<string, any>,
  context: TopologyContext = {},
): TopologyModel {
  return mode === 'serverless' ? buildServerlessTopology(data, context) : buildServerTopology(data, context)
}
