import type { CloudConfig, SiteConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { RPX_SITES_DIR } from '../../src/drivers/shared/rpx-gateway'
import {
  allocateSitePorts,
  buildHostSitePortsScript,
  DEFAULT_SITE_PORT_RANGE,
  HOST_SITES_DIR,
  occupiedHostPorts,
  parseHostSiteFragments,
  parseUpstreamPort,
} from '../../src/deploy/site-ports'
import { validateDeploymentConfig } from '../../src/deploy/site-target'

function makeConfig(sites: Record<string, SiteConfig>, slug = 'loghq'): CloudConfig {
  return {
    project: { name: slug, slug, region: 'us-east-1' },
    environments: { production: { type: 'production' } },
    cloud: { provider: 'hetzner', attachTo: 'statushq' },
    sites,
  } as CloudConfig
}

/** Encode fragments the way `buildHostSitePortsScript` emits them. */
function encodeFragments(...fragments: unknown[]): string {
  return `${fragments.map(f => Buffer.from(JSON.stringify(f, null, 2)).toString('base64')).join('\n')}\n`
}

describe('HOST_SITES_DIR', () => {
  // site-ports cannot import RPX_SITES_DIR without closing an import cycle, so
  // the literal is duplicated. This is what stops the duplicate drifting.
  it('matches the gateway registry directory it duplicates', () => {
    expect(HOST_SITES_DIR).toBe(RPX_SITES_DIR)
  })
})

describe('parseUpstreamPort', () => {
  it('reads the port from a host:port upstream', () => {
    expect(parseUpstreamPort('127.0.0.1:3022')).toBe(3022)
    expect(parseUpstreamPort('localhost:80')).toBe(80)
  })

  it('splits on the last colon so bracketed IPv6 parses', () => {
    expect(parseUpstreamPort('[::1]:3023')).toBe(3023)
  })

  it('rejects anything that is not a usable port', () => {
    expect(parseUpstreamPort('127.0.0.1')).toBeUndefined()
    expect(parseUpstreamPort('127.0.0.1:')).toBeUndefined()
    expect(parseUpstreamPort('127.0.0.1:bun')).toBeUndefined()
    expect(parseUpstreamPort('127.0.0.1:0')).toBeUndefined()
    expect(parseUpstreamPort('127.0.0.1:70000')).toBeUndefined()
  })
})

describe('occupiedHostPorts', () => {
  it('maps every upstream port to the project serving it', () => {
    const owners = occupiedHostPorts([
      { slug: 'statushq', proxies: [{ from: '127.0.0.1:3000' }, { from: '127.0.0.1:3001' }] },
      { slug: 'bughq', proxies: [{ from: '127.0.0.1:3022' }] },
    ])

    expect([...owners.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [3000, 'statushq'],
      [3001, 'statushq'],
      [3022, 'bughq'],
    ])
  })

  it('reads an array of upstreams, as a load-balanced route has', () => {
    const owners = occupiedHostPorts([
      { slug: 'statushq', proxies: [{ from: ['10.0.0.1:3100', '10.0.0.2:3101'] }] },
    ])

    expect(owners.get(3100)).toBe('statushq')
    expect(owners.get(3101)).toBe('statushq')
  })

  it("attributes a fragment with no slug to 'app', matching the writer's default", () => {
    expect(occupiedHostPorts([{ proxies: [{ from: '127.0.0.1:3022' }] }]).get(3022)).toBe('app')
  })

  it('skips the deploying project so a redeploy does not conflict with itself', () => {
    const fragments = [
      { slug: 'loghq', proxies: [{ from: '127.0.0.1:3022' }] },
      { slug: 'bughq', proxies: [{ from: '127.0.0.1:3030' }] },
    ]

    const owners = occupiedHostPorts(fragments, { ignoreSlug: 'loghq' })

    expect(owners.has(3022)).toBe(false)
    expect(owners.get(3030)).toBe('bughq')
  })

  it('ignores routes with no upstream, such as static and redirect sites', () => {
    expect(occupiedHostPorts([{ slug: 'statushq', proxies: [{}, { from: undefined }] }]).size).toBe(0)
  })

  it('keeps the first owner when two fragments claim one port', () => {
    const owners = occupiedHostPorts([
      { slug: 'bughq', proxies: [{ from: '127.0.0.1:3022' }] },
      { slug: 'loghq', proxies: [{ from: '127.0.0.1:3022' }] },
    ])

    expect(owners.get(3022)).toBe('bughq')
  })
})

describe('buildHostSitePortsScript', () => {
  it('enumerates the registry directory and guards against the empty glob', () => {
    const script = buildHostSitePortsScript()

    expect(script).toContain(`${HOST_SITES_DIR}/*.json`)
    expect(script).toContain('[ -f "$__tsc_fragment" ] || continue')
    expect(script).toContain('base64')
  })

  it('accepts a custom directory', () => {
    expect(buildHostSitePortsScript('/tmp/sites.d')).toContain('/tmp/sites.d/*.json')
  })
})

describe('parseHostSiteFragments', () => {
  it('round-trips what the script emits', () => {
    const stdout = encodeFragments(
      { slug: 'statushq', proxies: [{ to: 'status.example', from: '127.0.0.1:3000' }] },
      { slug: 'bughq', proxies: [{ to: 'bugs.example', from: '127.0.0.1:3022' }] },
    )

    expect(parseHostSiteFragments(stdout).map(f => f.slug)).toEqual(['statushq', 'bughq'])
  })

  it('reads nothing from a box with no fragments', () => {
    expect(parseHostSiteFragments('')).toEqual([])
    expect(parseHostSiteFragments('\n  \n')).toEqual([])
  })

  it('skips a corrupt fragment instead of failing the whole read', () => {
    const good = Buffer.from(JSON.stringify({ slug: 'bughq', proxies: [{ from: '127.0.0.1:3022' }] })).toString('base64')
    const notBase64Json = Buffer.from('this is not json').toString('base64')
    const stdout = `${notBase64Json}\n${good}\n`

    const fragments = parseHostSiteFragments(stdout)

    expect(fragments).toHaveLength(1)
    expect(fragments[0]!.slug).toBe('bughq')
  })

  it('ignores a fragment that is not an object', () => {
    expect(parseHostSiteFragments(encodeFragments([1, 2], 'nope', 7))).toEqual([])
  })
})

describe('allocateSitePorts', () => {
  const sites: Record<string, SiteConfig> = {
    app: { root: 'dist', start: 'bun run server.ts', port: 3022 },
    api: { root: 'dist', start: 'bun run api.ts', port: 3023 },
  }

  it('keeps declared ports when the box has no co-tenants', () => {
    const { allocations, errors } = allocateSitePorts(makeConfig(sites), new Map())

    expect(errors).toEqual([])
    expect(allocations).toEqual([
      { site: 'app', port: 3022, declared: 3022, moved: false },
      { site: 'api', port: 3023, declared: 3023, moved: false },
    ])
  })

  it('moves only the sites whose ports are taken, to the next free port', () => {
    // bughq is already on the box holding the template's default pair.
    const occupied = new Map([[3022, 'bughq'], [3023, 'bughq']])

    const { allocations, errors } = allocateSitePorts(makeConfig(sites), occupied)

    expect(errors).toEqual([])
    expect(allocations).toEqual([
      { site: 'app', port: 3024, declared: 3022, moved: true },
      { site: 'api', port: 3025, declared: 3023, moved: true },
    ])
  })

  it('does not hand the same port to two sites in one config', () => {
    const config = makeConfig({
      app: { root: 'dist', start: 'bun run a.ts', port: 3022 },
      api: { root: 'dist', start: 'bun run b.ts', port: 3022 },
    })

    const ports = allocateSitePorts(config, new Map()).allocations.map(a => a.port)

    expect(new Set(ports).size).toBe(2)
    expect(ports).toEqual([3022, 3023])
  })

  it('allocates from the range start for a site that declares no port', () => {
    const config = makeConfig({ app: { root: 'dist', start: 'bun run server.ts' } })

    expect(allocateSitePorts(config, new Map()).allocations).toEqual([
      { site: 'app', port: DEFAULT_SITE_PORT_RANGE.start, declared: undefined, moved: false },
    ])
  })

  it('ignores sites that bind nothing', () => {
    const config = makeConfig({
      bucket: { root: 'dist' },
      static: { root: 'dist', deploy: 'server' },
      redirect: { domain: 'old.example', redirect: 'new.example' },
      proxy: { domain: 'svc.example', proxyTo: '127.0.0.1:9000' },
      app: { root: 'dist', start: 'bun run server.ts', port: 3022 },
    })

    expect(allocateSitePorts(config, new Map()).allocations.map(a => a.site)).toEqual(['app'])
  })

  it('reports the holder when the range is exhausted', () => {
    const occupied = new Map([[3022, 'bughq']])
    const config = makeConfig({ app: { root: 'dist', start: 'bun run server.ts', port: 3022 } })

    const { allocations, errors } = allocateSitePorts(config, occupied, { start: 3022, end: 3022 })

    expect(allocations).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("site 'app'")
    expect(errors[0]).toContain("held by 'bughq'")
  })
})

describe('validateDeploymentConfig with co-tenant ports (#168)', () => {
  const sites: Record<string, SiteConfig> = {
    app: { root: 'dist', start: 'bun run server.ts', port: 3022 },
  }

  it('is silent about co-tenants when no occupancy is supplied', () => {
    // The pre-existing contract: one config in, no knowledge of the box.
    expect(validateDeploymentConfig(makeConfig(sites)).errors).toEqual([])
  })

  it('reports the collision at plan time, naming the project that holds the port', () => {
    const errors = validateDeploymentConfig(makeConfig(sites), {
      occupiedPorts: new Map([[3022, 'bughq']]),
    }).errors

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("Site 'app' wants port 3022")
    expect(errors[0]).toContain("project 'bughq' already serves")
  })

  it('still reports two sites in one config sharing a port', () => {
    const config = makeConfig({
      app: { root: 'dist', start: 'bun run a.ts', port: 3022 },
      api: { root: 'dist', start: 'bun run b.ts', port: 3022 },
    })

    const errors = validateDeploymentConfig(config).errors

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('both use port 3022')
  })

  it("does not flag the deploying project's own fragment from a previous deploy", () => {
    const stdout = encodeFragments({ slug: 'loghq', proxies: [{ from: '127.0.0.1:3022' }] })
    const occupiedPorts = occupiedHostPorts(parseHostSiteFragments(stdout), { ignoreSlug: 'loghq' })

    expect(validateDeploymentConfig(makeConfig(sites), { occupiedPorts }).errors).toEqual([])
  })

  it('catches the exact case from the issue: two template apps on one box', () => {
    // loghq and bughq are both untouched from the template, so both want
    // 3022/3023. bughq attached first and its fragment is on the box.
    const onBox = encodeFragments({
      slug: 'bughq',
      proxies: [
        { to: 'bugs.example', from: '127.0.0.1:3022' },
        { to: 'bugs.example', path: '/api', from: '127.0.0.1:3023' },
      ],
    })

    const loghq = makeConfig({
      app: { root: 'dist', start: 'bun run server.ts', port: 3022 },
      api: { root: 'dist', start: 'bun run api.ts', port: 3023 },
    }, 'loghq')

    const occupiedPorts = occupiedHostPorts(parseHostSiteFragments(onBox), { ignoreSlug: 'loghq' })
    const { errors } = validateDeploymentConfig(loghq, { occupiedPorts })

    expect(errors).toHaveLength(2)
    expect(errors.join('\n')).toContain("project 'bughq'")

    // ...and allocation gets loghq onto the box without either app editing a port.
    const { allocations, errors: allocErrors } = allocateSitePorts(loghq, occupiedPorts)
    expect(allocErrors).toEqual([])
    expect(allocations.map(a => a.port)).toEqual([3024, 3025])
  })
})
