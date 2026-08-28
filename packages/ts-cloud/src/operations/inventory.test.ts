import { describe, expect, it } from 'bun:test'
import { buildHostSitePortsScript, parseHostSiteFragments } from '../deploy/site-ports'
import {
  formatInventory,
  probeHostRoutes,
  reconcile,
  routesFromFragments,
  tenantsOf,
  toInventoryServer,
  unaccountedSites,
} from './inventory'

/**
 * The trap this module exists to avoid: a project's own config describes ONE
 * project, the boxes are shared, and so reading config alone reports a
 * multi-tenant server as if that project were alone on it. Every test that
 * matters below is about a co-tenant being visible, or about a partial answer
 * being labelled partial rather than passed off as a complete one.
 */

const STACKS_FRAGMENT = {
  slug: 'stacks',
  proxies: [
    { to: 'stacksjs.com', from: '127.0.0.1:3000' },
    { to: 'stacksjs.com', path: '/docs', static: { dir: '/var/www/stacks-docs' } },
    { to: 'stacksjs.com', path: '/discord', redirect: { to: 'https://discord.gg/example' } },
  ],
}

const RAPPID_FRAGMENT = {
  slug: 'rappid',
  proxies: [{ to: 'rappid.hq.training', from: '127.0.0.1:3024' }],
}

function site(name: string, overrides: Record<string, any> = {}) {
  return { name, path: '/', loopbackOnly: overrides.domain === undefined, ...overrides }
}

describe('shaping a provider server', () => {
  it('resolves the ts-cloud identity a box was labelled with', () => {
    expect(toInventoryServer({
      id: 12345,
      name: 'stacks-production-app',
      status: 'running',
      public_net: { ipv4: { ip: '5.161.0.1' } },
      server_type: { name: 'cpx41' },
      datacenter: { location: { name: 'fsn1' } },
      labels: { 'ts-cloud/project': 'stacks', 'ts-cloud/environment': 'production', 'ts-cloud/role': 'app' },
    })).toMatchObject({
      id: '12345',
      name: 'stacks-production-app',
      ipv4: '5.161.0.1',
      type: 'cpx41',
      location: 'fsn1',
      project: 'stacks',
      environment: 'production',
      role: 'app',
    })
  })

  it('accepts a flatter record from a driver that is not Hetzner', () => {
    expect(toInventoryServer({ id: 2, name: 'box', status: 'running', ipv4: '1.2.3.4', type: 'medium', location: 'nbg1', labels: {} }))
      .toMatchObject({ ipv4: '1.2.3.4', type: 'medium', location: 'nbg1' })
  })

  it('keeps an unlabelled box rather than dropping it', () => {
    // A box provisioned by hand, or by a ts-cloud old enough not to label, is
    // exactly the kind a consolidation needs to see.
    expect(toInventoryServer({ id: 7, name: 'legacy-box', status: 'running', labels: {} }))
      .toMatchObject({ name: 'legacy-box', project: undefined })
  })
})

describe('reading the box registry', () => {
  it('reads every project on the box, not just one', () => {
    expect(routesFromFragments([STACKS_FRAGMENT, RAPPID_FRAGMENT]).map(r => `${r.slug} ${r.host}${r.path}`)).toEqual([
      'rappid rappid.hq.training/',
      'stacks stacksjs.com/',
      'stacks stacksjs.com/discord',
      'stacks stacksjs.com/docs',
    ])
  })

  it('describes each route by where it actually goes', () => {
    const byPath = Object.fromEntries(routesFromFragments([STACKS_FRAGMENT]).map(r => [r.path, r]))

    expect(byPath['/']).toMatchObject({ kind: 'app', target: '127.0.0.1:3000' })
    expect(byPath['/docs']).toMatchObject({ kind: 'static', target: '/var/www/stacks-docs' })
    expect(byPath['/discord']).toMatchObject({ kind: 'redirect', target: 'https://discord.gg/example' })
  })

  it('reads a load-balanced route as its whole upstream pool', () => {
    expect(routesFromFragments([{ slug: 'x', proxies: [{ to: 'x.com', from: ['10.0.0.1:3000', '10.0.0.2:3000'] }] }])[0])
      .toMatchObject({ kind: 'app', target: '10.0.0.1:3000, 10.0.0.2:3000' })
  })

  it('defaults a fragment with no slug the way the writer does', () => {
    // An older ts-cloud wrote fragments without `slug`; reading them as an
    // unnamed tenant would split one project in two.
    expect(routesFromFragments([{ proxies: [{ to: 'old.example', from: '127.0.0.1:3000' }] }])[0]?.slug).toBe('app')
  })

  it('groups tenants biggest first so the box owner reads at the top', () => {
    expect(tenantsOf(routesFromFragments([STACKS_FRAGMENT, RAPPID_FRAGMENT])).map(t => t.slug)).toEqual(['stacks', 'rappid'])
  })

  it('reads the same files site-ports does, through the same script', () => {
    // The port allocator and this inventory must never disagree about what is
    // on a box, which is why neither owns its own copy of the read.
    const stdout = [STACKS_FRAGMENT, RAPPID_FRAGMENT]
      .map(fragment => Buffer.from(JSON.stringify(fragment)).toString('base64'))
      .join('\n')

    expect(routesFromFragments(parseHostSiteFragments(stdout))).toHaveLength(4)
    expect(buildHostSitePortsScript('/etc/rpx/sites.d')).toContain('/etc/rpx/sites.d')
  })
})

describe('probing a box', () => {
  const server = toInventoryServer({ id: 1, name: 'box', status: 'running', public_net: { ipv4: { ip: '5.5.5.5' } }, labels: {} })

  it('returns the routes a reachable box reports', async () => {
    const probe = await probeHostRoutes(server, async () => ({
      code: 0,
      stdout: `${Buffer.from(JSON.stringify(STACKS_FRAGMENT)).toString('base64')}\n`,
      stderr: '',
    }))

    expect(probe.unavailable).toBeUndefined()
    expect(probe.routes).toHaveLength(3)
  })

  it('reports an unreachable box instead of failing the whole listing', async () => {
    const probe = await probeHostRoutes(server, async () => {
      throw new Error('Permission denied (publickey).\nssh gave up')
    })

    expect(probe).toMatchObject({ routes: [], unavailable: 'Permission denied (publickey).' })
  })

  it('does not reach for a box that is powered off', async () => {
    let attempted = false
    const probe = await probeHostRoutes({ ...server, status: 'off' }, async () => {
      attempted = true
      return { code: 0, stdout: '', stderr: '' }
    })

    expect(attempted).toBe(false)
    expect(probe.unavailable).toBe('server is off')
  })

  it('surfaces the remote stderr when the command itself fails', async () => {
    const probe = await probeHostRoutes(server, async () => ({ code: 1, stdout: '', stderr: 'find: permission denied\n' }))

    expect(probe.unavailable).toBe('find: permission denied')
  })
})

describe('reconciling declared sites against a box', () => {
  const declared = [
    site('main', { domain: 'stacksjs.com', path: '/' }),
    site('docs', { domain: 'stacksjs.com', path: '/docs' }),
    site('blog', { domain: 'stacksjs.com', path: '/blog' }),
    site('api', { port: 3008 }),
  ]
  const routes = routesFromFragments([STACKS_FRAGMENT, RAPPID_FRAGMENT])

  it('separates present, absent, loopback and somebody else entirely', () => {
    const result = reconcile(declared, routes, 'stacks')

    expect(result.present.map(s => s.name).sort()).toEqual(['docs', 'main'])
    expect(result.absent.map(s => s.name)).toEqual(['blog'])
    expect(result.loopback.map(s => s.name)).toEqual(['api'])
    expect(result.foreign.map(r => r.slug)).toEqual(['rappid'])
  })

  it('matches on host and path, not on the site key', () => {
    // The box has no idea what a repository calls its sites, and two projects
    // both naming one `main` is ordinary.
    expect(reconcile([site('frontend', { domain: 'stacksjs.com', path: '/' })], routes, 'stacks').present.map(s => s.name))
      .toEqual(['frontend'])
  })

  it('does not credit our site to another project serving the same host', () => {
    expect(reconcile([site('main', { domain: 'rappid.hq.training', path: '/' })], routes, 'stacks').absent.map(s => s.name))
      .toEqual(['main'])
  })

  it('ignores a trailing slash on a path prefix', () => {
    expect(reconcile([site('docs', { domain: 'stacksjs.com', path: '/docs/' })], routes, 'stacks').present).toHaveLength(1)
  })

  it('only counts a site missing when no answering box serves it', () => {
    const probes = [
      { server: 'a', routes: routesFromFragments([STACKS_FRAGMENT]) },
      { server: 'b', routes: routesFromFragments([RAPPID_FRAGMENT]) },
    ]

    expect(unaccountedSites(declared, probes, 'stacks').map(s => s.name)).toEqual(['blog'])
  })
})

describe('the listing an operator reads', () => {
  const servers = [toInventoryServer({
    id: 1,
    name: 'stacks-production-app',
    status: 'running',
    public_net: { ipv4: { ip: '5.161.0.1' } },
    server_type: { name: 'cpx41' },
    labels: { 'ts-cloud/project': 'stacks', 'ts-cloud/environment': 'production', 'ts-cloud/role': 'app' },
  })]

  const declared = [
    site('main', { domain: 'stacksjs.com', path: '/' }),
    site('blog', { domain: 'blog.example', path: '/' }),
    site('api', { port: 3008 }),
  ]

  it('names the co-tenant sharing the box', () => {
    const output = formatInventory({
      slug: 'stacks',
      servers,
      probes: [{ server: 'stacks-production-app', routes: routesFromFragments([STACKS_FRAGMENT, RAPPID_FRAGMENT]) }],
      declared,
    }).join('\n')

    expect(output).toContain('serves 4 routes for 2 projects')
    expect(output).toContain('stacks (this project)')
    expect(output).toContain('rappid.hq.training/  ->  127.0.0.1:3024')
  })

  it('says a box was not probed rather than implying it hosts nothing', () => {
    const output = formatInventory({ slug: 'stacks', servers, probes: [], declared }).join('\n')

    expect(output).toContain('not probed')
    expect(output).toContain('Nothing to reconcile them against')
  })

  it('refuses to reconcile against a box that could not be read', () => {
    // "Every site is missing" is a true statement about the listing and a false
    // one about the deployment.
    const output = formatInventory({
      slug: 'stacks',
      servers,
      probes: [{ server: 'stacks-production-app', routes: [], unavailable: 'Permission denied (publickey).' }],
      declared,
    }).join('\n')

    expect(output).toContain('could not read /etc/rpx/sites.d: Permission denied (publickey).')
    expect(output).toContain('Nothing to reconcile them against')
    expect(output).not.toContain('not routed by any box above')
  })

  it('blames an unreadable box before it blames the deploy', () => {
    const output = formatInventory({
      slug: 'stacks',
      servers: [...servers, toInventoryServer({ id: 2, name: 'other', status: 'running', labels: {} })],
      probes: [
        { server: 'stacks-production-app', routes: routesFromFragments([STACKS_FRAGMENT]) },
        { server: 'other', routes: [], unavailable: 'Permission denied (publickey).' },
      ],
      declared,
    }).join('\n')

    expect(output).toContain('1 not routed by any box above: blog')
    expect(output).toContain('one of the 1 server that could not be read')
  })

  it('explains a domainless site instead of listing it as missing', () => {
    const output = formatInventory({
      slug: 'stacks',
      servers,
      probes: [{ server: 'stacks-production-app', routes: routesFromFragments([STACKS_FRAGMENT]) }],
      declared,
    }).join('\n')

    expect(output).toContain('1 with no domain')
    expect(output).toContain('1 not routed by any box above: blog')
  })
})
