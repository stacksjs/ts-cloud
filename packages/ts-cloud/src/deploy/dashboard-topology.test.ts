import { describe, expect, it } from 'bun:test'
import { buildServerlessTopology, buildServerTopology, buildTopology } from './dashboard-topology'

function serverData(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    server: { name: 'acme-production-app', provider: 'hetzner', region: 'fsn1', ip: '1.2.3.4' },
    _serverReachable: true,
    metricsUnavailable: false,
    sites: [
      { name: 'main', route: 'acme.com', domain: 'acme.com', runtime: 'bun', deploy: 'service', tls: 'https', status: 'live', responseMs: 42, httpStatus: 200 },
      { name: 'api', route: 'internal', runtime: 'bun', deploy: 'service', tls: 'loopback', status: 'live' },
    ],
    services: [
      { name: 'rpx-gateway', status: 'running' },
      { name: 'redis', status: 'running' },
      { name: 'mysql', status: 'stopped' },
    ],
    workers: [{ name: 'main:default', site: 'main', processes: 2, status: 'running' }],
    serverScheduler: { enabled: true, lastRun: '36s ago' },
    backup: { enabled: true, destination: 's3://acme-backups', schedule: '0 2 * * *', retention: 5, last: '2h ago' },
    security: {
      firewall: { status: 'configured', summary: 'host firewall configured' },
      ports: [{ listen: '0.0.0.0:443' }],
      tlsCertificates: [{ domain: 'acme.com', daysRemaining: 60 }],
    },
    ...overrides,
  }
}

function serverlessData(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    app: { name: 'acme', env: 'production', region: 'us-east-1', url: 'https://acme.com' },
    functions: [
      { key: 'http', name: 'acme-production-http', runtime: 'provided.al2023', memory: 1024, timeout: 30, invocations: 5000, errors: 0, p95: 120 },
      { key: 'queue', name: 'acme-production-queue', runtime: 'provided.al2023', memory: 512, timeout: 120, invocations: 400, errors: 12, p95: 900 },
      { key: 'cli', name: 'acme-production-cli', runtime: 'provided.al2023', memory: 512, timeout: 300, invocations: 0, errors: 0, p95: 0 },
    ],
    queues: [{ name: 'default', visible: 0, inFlight: 0, processed: 400, dlq: 0 }],
    metrics: { invocations: 5400, errorRatePct: 0.22 },
    aurora: { id: 'acme-production-db', engine: 'aurora-mysql', status: 'available', currentAcu: 1.5, minAcu: 0.5, maxAcu: 4, connections: 12 },
    redis: { id: 'acme-production-cache', node: 'cache.t4g.micro', status: 'available', hitRate: 94.2 },
    assetsInfo: { bucket: 'acme-production-assets', cdn: 'd111.cloudfront.net', customDomain: 'assets.acme.com' },
    scheduler: { enabled: true, expression: 'rate(1 minute)', lastRun: '12s ago' },
    ...overrides,
  }
}

/** Every link must name nodes that exist, or the diagram draws into nothing. */
function assertLinksResolve(model: ReturnType<typeof buildServerTopology>): void {
  const ids = new Set(model.nodes.map((node) => node.id))
  for (const link of model.links) {
    expect(ids.has(link.source)).toBe(true)
    expect(ids.has(link.target)).toBe(true)
  }
}

describe('buildServerTopology', () => {
  it('draws the request path from the internet down to each site', () => {
    const model = buildServerTopology(serverData())
    const ids = model.nodes.map((node) => node.id)
    expect(ids).toContain('internet')
    expect(ids).toContain('dns')
    expect(ids).toContain('firewall')
    expect(ids).toContain('proxy')
    expect(ids).toContain('site:main')
    expect(ids).toContain('site:api')
    expect(model.links).toContainEqual(expect.objectContaining({ source: 'proxy', target: 'site:main', flow: 'request' }))
  })

  it('keeps every link pointing at a node it actually emitted', () => {
    assertLinksResolve(buildServerTopology(serverData()))
  })

  it('layers nodes from the edge inward', () => {
    const model = buildServerTopology(serverData())
    const layerOf = (id: string) => model.nodes.find((node) => node.id === id)!.layer
    expect(layerOf('internet')).toBe(0)
    expect(layerOf('proxy')).toBeLessThan(layerOf('site:main'))
    expect(layerOf('site:main')).toBeLessThan(layerOf('data:redis'))
  })

  it('carries service state through to node status', () => {
    const model = buildServerTopology(serverData())
    expect(model.nodes.find((node) => node.id === 'data:redis')!.status).toBe('ok')
    expect(model.nodes.find((node) => node.id === 'data:mysql')!.status).toBe('bad')
  })

  it('recognises data services and names their engine', () => {
    const model = buildServerTopology(serverData())
    const mysql = model.nodes.find((node) => node.id === 'data:mysql')!
    expect(mysql.kind).toBe('database')
    expect(mysql.label).toBe('MySQL')
    expect(model.nodes.find((node) => node.id === 'data:redis')!.kind).toBe('cache')
  })

  it('does not treat the reverse proxy as a data service', () => {
    const model = buildServerTopology(serverData())
    expect(model.nodes.some((node) => node.id === 'data:rpx-gateway')).toBe(false)
  })

  it('says so when the box could not be probed instead of guessing state', () => {
    const model = buildServerTopology(serverData({ _serverReachable: false, metricsUnavailable: true }))
    expect(model.notes.some((note) => note.includes('could not be probed'))).toBe(true)
    expect(model.nodes.find((node) => node.id === 'proxy')!.facts.some((fact) => fact.value.includes('probe'))).toBe(false)
  })

  it('explains that data edges mean co-location, not a declared binding', () => {
    const model = buildServerTopology(serverData())
    expect(model.notes.some((note) => note.includes('co-location'))).toBe(true)
  })

  it('omits the backup node when backups are off', () => {
    const model = buildServerTopology(serverData({ backup: { enabled: false } }))
    expect(model.nodes.some((node) => node.id === 'backup')).toBe(false)
    assertLinksResolve(model)
  })

  it('flags certificates that expire soon', () => {
    const model = buildServerTopology(
      serverData({ security: { firewall: {}, ports: [], tlsCertificates: [{ domain: 'acme.com', daysRemaining: 4 }] } }),
    )
    expect(model.nodes.find((node) => node.id === 'dns')!.status).toBe('warn')
  })

  it('groups on-box resources under the server boundary', () => {
    const model = buildServerTopology(serverData())
    expect(model.groups[0].label).toBe('acme-production-app')
    expect(model.nodes.find((node) => node.id === 'site:main')!.group).toBe('box')
    expect(model.nodes.find((node) => node.id === 'internet')!.group).toBeUndefined()
  })

  it('survives an empty data bag', () => {
    const model = buildServerTopology({})
    expect(model.nodes.length).toBeGreaterThan(0)
    assertLinksResolve(model)
  })
})

describe('buildServerlessTopology', () => {
  it('draws the request path from the internet through to the functions', () => {
    const model = buildServerlessTopology(serverlessData())
    const ids = model.nodes.map((node) => node.id)
    expect(ids).toContain('gateway')
    expect(ids).toContain('fn:acme-production-http')
    expect(model.links).toContainEqual(
      expect.objectContaining({ source: 'gateway', target: 'fn:acme-production-http', flow: 'request' }),
    )
  })

  it('keeps every link pointing at a node it actually emitted', () => {
    assertLinksResolve(buildServerlessTopology(serverlessData()))
  })

  it('wires publish and consume around the queue', () => {
    const model = buildServerlessTopology(serverlessData())
    expect(model.links).toContainEqual(
      expect.objectContaining({ source: 'fn:acme-production-http', target: 'queue:default', label: 'publish' }),
    )
    expect(model.links).toContainEqual(
      expect.objectContaining({ source: 'queue:default', target: 'fn:acme-production-queue', label: 'consume' }),
    )
  })

  it('routes database traffic through the proxy when one exists', () => {
    const model = buildServerlessTopology(
      serverlessData({ proxy: { name: 'acme-proxy', endpoint: 'proxy.rds', pooledConns: 8, status: 'available' } }),
    )
    expect(model.links).toContainEqual(
      expect.objectContaining({ source: 'fn:acme-production-http', target: 'rds-proxy', flow: 'data' }),
    )
    expect(model.links).toContainEqual(expect.objectContaining({ source: 'rds-proxy', target: 'database' }))
    expect(model.links.some((link) => link.source.startsWith('fn:') && link.target === 'database')).toBe(false)
  })

  it('grades function health by error rate rather than error count alone', () => {
    const model = buildServerlessTopology(serverlessData())
    expect(model.nodes.find((node) => node.id === 'fn:acme-production-http')!.status).toBe('ok')
    expect(model.nodes.find((node) => node.id === 'fn:acme-production-queue')!.status).toBe('bad')
    expect(model.nodes.find((node) => node.id === 'fn:acme-production-cli')!.status).toBe('idle')
  })

  it('marks a queue with dead letters as bad', () => {
    const model = buildServerlessTopology(serverlessData({ queues: [{ name: 'default', visible: 0, dlq: 3 }] }))
    expect(model.nodes.find((node) => node.id === 'queue:default')!.status).toBe('bad')
  })

  it('sends traffic through the WAF when one is configured', () => {
    const model = buildServerlessTopology(serverlessData({ waf: { name: 'acme-acl', status: 'active', blocked: 12 } }))
    expect(model.links).toContainEqual(expect.objectContaining({ source: 'dns', target: 'waf' }))
    expect(model.links).toContainEqual(expect.objectContaining({ source: 'waf', target: 'gateway' }))
    expect(model.links.some((link) => link.source === 'dns' && link.target === 'gateway')).toBe(false)
  })

  it('omits optional services that this environment does not run', () => {
    const model = buildServerlessTopology(serverlessData({ redis: undefined, assetsInfo: undefined, aurora: undefined }))
    expect(model.nodes.some((node) => ['cache', 'cdn', 'assets', 'database'].includes(node.id))).toBe(false)
    assertLinksResolve(model)
  })

  it('says so when no functions could be read', () => {
    const model = buildServerlessTopology(serverlessData({ functions: [] }))
    expect(model.notes.some((note) => note.includes('No Lambda functions'))).toBe(true)
  })

  it('survives an empty data bag', () => {
    const model = buildServerlessTopology({})
    expect(model.nodes.length).toBeGreaterThan(0)
    assertLinksResolve(model)
  })
})

describe('buildTopology', () => {
  it('dispatches on mode and honours the caller context', () => {
    expect(buildTopology('server', serverData(), { project: 'Acme', environment: 'staging' })).toMatchObject({
      mode: 'server',
      project: 'Acme',
      environment: 'staging',
    })
    expect(buildTopology('serverless', serverlessData()).mode).toBe('serverless')
  })
})
