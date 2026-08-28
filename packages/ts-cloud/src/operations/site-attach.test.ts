import { describe, expect, it } from 'bun:test'
import { setAttachToInCloudConfig } from '../deploy/site-config-editor'
import { routesFromFragments, toInventoryServer } from './inventory'
import { attachConflicts, attachIsViable, attachPreconditions, formatAttachPlan, resolveAttachTarget } from './site-attach'

/**
 * The failure this is built around is not hypothetical: two services on one
 * port do not error, because the units do not bind exclusively. The kernel
 * load-balances between them, both look healthy, and each domain serves the
 * other project's site about half the time. predicthq.org spent a day and a
 * half like that. Every check here exists to catch it before a deploy rather
 * than during one.
 */

function server(overrides: Record<string, any> = {}) {
  return toInventoryServer({
    id: 1,
    name: 'stacks-production-app',
    status: 'running',
    public_net: { ipv4: { ip: '5.161.0.1' } },
    labels: { 'ts-cloud/project': 'stacks', 'ts-cloud/environment': 'production' },
    ...overrides,
  })
}

function site(name: string, overrides: Record<string, any> = {}) {
  return { name, path: '/', loopbackOnly: overrides.domain === undefined, ...overrides }
}

const BOX_ROUTES = routesFromFragments([
  {
    slug: 'stacks',
    proxies: [
      { to: 'stacksjs.com', from: '127.0.0.1:3000' },
      { to: 'stacksjs.com', path: '/docs', static: { dir: '/var/www/stacks-docs' } },
    ],
  },
  { slug: 'rappid', proxies: [{ to: 'rappid.hq.training', from: '127.0.0.1:3024' }] },
])

describe('picking the server to attach to', () => {
  const servers = [
    server(),
    toInventoryServer({ id: 2, name: 'stacks-staging-app', status: 'running', labels: { 'ts-cloud/project': 'stacks', 'ts-cloud/environment': 'staging' } }),
    toInventoryServer({ id: 3, name: 'bughq-production-app', status: 'running', labels: { 'ts-cloud/project': 'bughq' } }),
  ]

  it('accepts the provider name an operator reads off the console', () => {
    expect(resolveAttachTarget(servers, 'bughq-production-app')).toMatchObject({ server: { name: 'bughq-production-app' } })
  })

  it('accepts the owner slug that attachTo actually takes', () => {
    expect(resolveAttachTarget(servers, 'bughq')).toMatchObject({ server: { name: 'bughq-production-app' } })
  })

  it('refuses rather than guessing when one owner has several boxes', () => {
    expect(resolveAttachTarget(servers, 'stacks')).toMatchObject({ problem: expect.stringContaining('owns 2 servers') })
  })

  it('narrows several boxes by environment when one is given', () => {
    expect(resolveAttachTarget(servers, 'stacks', 'staging')).toMatchObject({ server: { name: 'stacks-staging-app' } })
  })

  it('says where to look when nothing matched', () => {
    expect(resolveAttachTarget(servers, 'nope')).toMatchObject({ problem: expect.stringContaining('ts-cloud/project=nope') })
  })
})

describe('preconditions', () => {
  it('refuses a box ts-cloud does not manage', () => {
    const unmanaged = toInventoryServer({ id: 9, name: 'hand-rolled', status: 'running', public_net: { ipv4: { ip: '1.1.1.1' } }, labels: {} })

    expect(attachPreconditions('rappid', unmanaged)[0]).toContain('no ts-cloud/project label')
  })

  it('refuses a tenant whose slug is the box owner\'s', () => {
    // A tenant deploy owns the gateway fragment named after its slug, so
    // sharing the owner's slug overwrites the owner's fragment.
    expect(attachPreconditions('stacks', server())[0]).toContain('also the slug that owns')
  })

  it('refuses a box that is not running, because nothing can be checked against it', () => {
    expect(attachPreconditions('rappid', server({ status: 'off' }))[0]).toContain('is off')
  })

  it('passes a healthy box owned by somebody else', () => {
    expect(attachPreconditions('rappid', server())).toEqual([])
  })
})

describe('conflicts with what the box already serves', () => {
  it('catches the port clash that does not error on its own', () => {
    expect(attachConflicts('rappid', [site('main', { domain: 'rappid.hq.training', port: 3000 })], BOX_ROUTES))
      .toContainEqual({ kind: 'port', site: 'main', detail: 'port 3000', heldBy: 'stacks' })
  })

  it('catches a hostname already served by another project', () => {
    expect(attachConflicts('newproject', [site('main', { domain: 'stacksjs.com', path: '/docs' })], BOX_ROUTES))
      .toContainEqual({ kind: 'route', site: 'main', detail: 'stacksjs.com/docs', heldBy: 'stacks' })
  })

  it('does not report a free port as taken', () => {
    expect(attachConflicts('rappid', [site('api', { port: 3099 })], BOX_ROUTES)).toEqual([])
  })

  it('does not count our own routes against us', () => {
    // Every repeat attach finds its own fragment on the box from the last
    // deploy; counting it would make the second one impossible.
    expect(attachConflicts('rappid', [site('main', { domain: 'rappid.hq.training', port: 3024 })], BOX_ROUTES)).toEqual([])
  })

  it('reads no port from a static or redirect route', () => {
    // Their targets are paths and URLs, and `https://x.com/y` has a colon.
    const routes = routesFromFragments([{
      slug: 'x',
      proxies: [{ to: 'a.com', static: { dir: '/var/www/a' } }, { to: 'b.com', redirect: { to: 'https://example.com:443/z' } }],
    }])

    expect(attachConflicts('mine', [site('one', { port: 443 })], routes)).toEqual([])
  })
})

describe('the plan an operator reads', () => {
  const declared = [
    site('main', { domain: 'rappid.hq.training', port: 3024, installBase: '/var/www/rappid-main' }),
    site('api', { port: 3008, installBase: '/var/www/rappid-api' }),
  ]

  function plan(overrides: Record<string, any> = {}): any {
    return { slug: 'rappid', owner: 'stacks', server: server(), declared, conflicts: [], registryRead: true, ...overrides }
  }

  it('will not claim there are no conflicts when the box was never read', () => {
    // "No conflicts" after failing to ask is the single most dangerous thing
    // this could print.
    const output = formatAttachPlan(plan({ registryRead: false, registryProblem: 'Permission denied (publickey).' })).join('\n')

    expect(output).toContain('UNCHECKED')
    expect(output).toContain('Permission denied (publickey).')
    expect(output).not.toContain('No conflicts')
  })

  it('explains why a port clash is not a loud failure', () => {
    const output = formatAttachPlan(plan({ conflicts: [{ kind: 'port', site: 'main', detail: 'port 3000', heldBy: 'stacks' }] })).join('\n')

    expect(output).toContain('site \'main\' wants port 3000, held by \'stacks\'')
    expect(output).toContain('the kernel load-balances')
  })

  it('shows loopback-only sites as such rather than inventing a hostname', () => {
    expect(formatAttachPlan(plan()).join('\n')).toContain('api  loopback only on :3008')
  })

  it('is viable only when the box answered and answered clean', () => {
    expect(attachIsViable(plan())).toBe(true)
    expect(attachIsViable(plan({ registryRead: false }))).toBe(false)
    expect(attachIsViable(plan({ conflicts: [{ kind: 'port', site: 'a', detail: 'port 1', heldBy: 'x' }] }))).toBe(false)
  })
})

describe('writing the attach into a cloud config', () => {
  const CONFIG = `import { env } from '@stacksjs/env'

export const tsCloud = {
  project: {
    name: 'app',
    slug: 'app',
  },

  cloud: {
    provider: 'hetzner',
  },

  mode: 'server',
}
`

  it('adds attachTo to the shape the templates generate', () => {
    const text = setAttachToInCloudConfig({ configText: CONFIG, owner: 'stacks' })

    expect(text).toContain('attachTo: \'stacks\',')
    expect(text).toContain('provider: \'hetzner\',')

    // Nothing else moved: strip the two added lines and the original comes back
    // byte for byte, so a config full of comments cannot be quietly reflowed.
    const kept = text.split('\n')
    for (const line of ['    // Deploy onto the box \'stacks\' owns rather than provisioning one.', '    attachTo: \'stacks\',']) {
      const at = kept.indexOf(line)
      expect(at).toBeGreaterThan(-1)
      kept.splice(at, 1)
    }
    expect(kept.join('\n')).toBe(CONFIG)
  })

  it('is a no-op when it already attaches to that owner', () => {
    const once = setAttachToInCloudConfig({ configText: CONFIG, owner: 'stacks' })

    expect(setAttachToInCloudConfig({ configText: once, owner: 'stacks' })).toBe(once)
  })

  it('repoints an existing attachTo at a different owner', () => {
    const once = setAttachToInCloudConfig({ configText: CONFIG, owner: 'stacks' })
    const moved = setAttachToInCloudConfig({ configText: once, owner: 'bughq' })

    expect(moved).toContain('attachTo: \'bughq\',')
    expect(moved).not.toContain('attachTo: \'stacks\',')
  })

  it('refuses a cloud block holding a nested object rather than guessing', () => {
    const nested = CONFIG.replace('    provider: \'hetzner\',', '    provider: \'hetzner\',\n    hetzner: { location: \'fsn1\' },')

    expect(() => setAttachToInCloudConfig({ configText: nested, owner: 'stacks' })).toThrow('nested object')
  })

  it('refuses when there is more than one cloud block', () => {
    expect(() => setAttachToInCloudConfig({ configText: CONFIG + CONFIG, owner: 'stacks' })).toThrow('ambiguous')
  })

  it('refuses when there is no cloud block at all', () => {
    expect(() => setAttachToInCloudConfig({ configText: 'export const tsCloud = {}\n', owner: 'stacks' })).toThrow('No `cloud:')
  })
})
