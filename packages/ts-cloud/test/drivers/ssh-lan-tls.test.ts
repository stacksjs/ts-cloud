/**
 * LAN TLS: the gateway's own certificate authority.
 *
 * `ssh.lan` used to reach nothing but a comment in the bootstrap script
 * header, so a host on a private network was documented as serving HTTPS from
 * its own CA and in fact served nothing of the sort. These tests pin the wire
 * that closed that gap, and, just as importantly, pin that no other provider's
 * emitted configuration moved by a byte while it was being closed.
 */
import type { CloudConfig, ComputeProxyConfig, SiteConfig } from '@ts-cloud/core'
import type { SshPreflightFacts } from '../../src/drivers/ssh/preflight'
import { describe, expect, it } from 'bun:test'
import {
  buildRpxConfig,
  buildRpxProvisionScript,
  DEFAULT_LOCAL_CA_DIR,
  isLanHostname,
  lanTlsMode,
  localCaCertPath,
  mergeRpxFragments,
  renderRpxAssembler,
  renderRpxLauncher,
  resolveGatewayLan,
  resolveGatewayProfile,
} from '../../src/drivers/shared/rpx-gateway'
import { buildSshBootstrapScript } from '../../src/drivers/ssh/bootstrap'

const rpxProxy: ComputeProxyConfig = { engine: 'rpx' }

/** A Pi serving one app on an mDNS name, with no public DNS anywhere. */
const lanSites: Record<string, SiteConfig> = {
  web: { domain: 'pi-app.local', port: 3000, root: '.output', start: 'bun run server.ts' },
}

const lan = { hostname: 'pi-app.local', tls: 'local-ca' as const, ip: '192.168.1.20' }

describe('buildRpxConfig: the LAN certificate authority', () => {
  it('emits localCa with the LAN hostname and the box address', () => {
    const config = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan })
    expect(config.localCa).toEqual({
      dir: '/etc/rpx/local-ca',
      hosts: ['pi-app.local'],
      ips: ['192.168.1.20'],
      installTrust: true,
    })
    expect(config.https).toBe(true)
  })

  it('falls back to <slug>.local when no LAN hostname is configured', () => {
    const config = buildRpxConfig({}, { proxy: rpxProxy, slug: 'pi-app', lan: { tls: 'local-ca' } })
    expect(config.localCa?.hosts).toEqual(['pi-app.local'])
  })

  it("treats a present lan with no tls as 'local-ca'", () => {
    expect(lanTlsMode({ hostname: 'pi-app.local' })).toBe('local-ca')
    expect(lanTlsMode(undefined)).toBeUndefined()
    const config = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan: { hostname: 'pi-app.local' } })
    expect(config.localCa?.hosts).toEqual(['pi-app.local'])
  })

  it('picks up .local and bare single-label site domains', () => {
    const sites: Record<string, SiteConfig> = {
      web: { domain: 'pi-app.local', port: 3000, root: '.output', start: 'bun run server.ts' },
      wiki: { domain: 'wiki.pi-app.local', port: 3001, root: '.output', start: 'bun run wiki.ts' },
      intranet: { domain: 'intranet', port: 3002, root: '.output', start: 'bun run intranet.ts' },
    }
    const config = buildRpxConfig(sites, { proxy: rpxProxy, slug: 'pi-app', lan })
    expect(config.localCa?.hosts).toEqual(['pi-app.local', 'wiki.pi-app.local', 'intranet'])
  })

  it('leaves publicly resolvable site domains to a public CA', () => {
    const sites: Record<string, SiteConfig> = {
      web: { domain: 'pi-app.local', port: 3000, root: '.output', start: 'bun run server.ts' },
      public: { domain: 'example.com', port: 3001, root: '.output', start: 'bun run public.ts' },
    }
    const config = buildRpxConfig(sites, { proxy: rpxProxy, slug: 'pi-app', lan })
    expect(config.localCa?.hosts).toEqual(['pi-app.local'])
  })

  it('covers the dashboard host when this project deploys a dashboard', () => {
    const sites: Record<string, SiteConfig> = {
      ...lanSites,
      'dashboard-pi-app': { domain: 'dashboard.pi-app.local', deploy: 'server', root: 'ui/dist', type: 'static' },
    }
    const config = buildRpxConfig(sites, { proxy: rpxProxy, slug: 'pi-app', lan })
    expect(config.localCa?.hosts).toContain('dashboard.pi-app.local')
  })

  it('omits the dashboard host when there is no dashboard site', () => {
    const config = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan })
    expect(config.localCa?.hosts).not.toContain('dashboard.pi-app.local')
  })

  it('never invents an address: no ip means no iPAddress SAN', () => {
    const config = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan: { hostname: 'pi-app.local' } })
    expect(config.localCa).not.toHaveProperty('ips')
  })

  it('drops an ip that is not an address rather than putting it on a certificate', () => {
    const config = buildRpxConfig(lanSites, {
      proxy: rpxProxy,
      slug: 'pi-app',
      lan: { hostname: 'pi-app.local', ip: 'pi.local' },
    })
    expect(config.localCa).not.toHaveProperty('ips')
  })

  it('adds no www. redirect for an mDNS name, which nothing resolves', () => {
    const config = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan })
    expect(config.proxies.map(route => route.to)).toEqual(['pi-app.local'])
  })

  it('reaches the launcher, which is what the box actually runs', () => {
    const launcher = renderRpxLauncher(buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan }))
    expect(launcher).toContain('"localCa"')
    expect(launcher).toContain('"dir": "/etc/rpx/local-ca"')
  })
})

describe("buildRpxConfig: lan.tls 'off'", () => {
  const off = { hostname: 'pi-app.local', tls: 'off' as const, ip: '192.168.1.20' }

  it('serves plain HTTP: https false and no local CA', () => {
    const config = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan: off })
    expect(config.https).toBe(false)
    expect(config.localCa).toBeUndefined()
  })

  it('keeps every route it would otherwise have served', () => {
    const withTls = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan })
    const withoutTls = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan: off })
    expect(withoutTls.proxies).toEqual(withTls.proxies)
  })
})

describe('buildRpxConfig: LAN and public TLS cannot claim one host', () => {
  const onDemand: ComputeProxyConfig = { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'ops@example.com' }

  it('throws naming the host and both sources', () => {
    const sites: Record<string, SiteConfig> = {
      web: { domain: 'pi-app.local', port: 3000, root: '.output', start: 'bun run server.ts' },
    }
    const build = (): unknown =>
      buildRpxConfig(sites, { proxy: onDemand, slug: 'pi-app', lan: { hostname: 'pi-app.local' } })
    expect(build).toThrow(/"pi-app\.local"/)
    expect(build).toThrow(/ssh\.lan\.hostname/)
    expect(build).toThrow(/on-demand TLS allowed suffix "pi-app\.local"/)
  })

  it('catches a host covered by a parent suffix, exactly as rpx would', () => {
    const sites: Record<string, SiteConfig> = {
      web: { domain: 'pi-app.local', port: 3000, root: '.output', start: 'bun run server.ts' },
    }
    expect(() =>
      buildRpxConfig(sites, { proxy: onDemand, slug: 'pi-app', lan: { hostname: 'wiki.pi-app.local' } }),
    ).toThrow(/"wiki\.pi-app\.local"/)
  })

  it('names the dashboard as the source when the dashboard host is the clash', () => {
    const sites: Record<string, SiteConfig> = {
      web: { domain: 'dashboard.pi-app.local', port: 3000, root: '.output', start: 'bun run server.ts' },
      'dashboard-pi-app': { domain: 'dashboard.pi-app.local', deploy: 'server', root: 'ui/dist', type: 'static' },
    }
    expect(() => buildRpxConfig(sites, { proxy: onDemand, slug: 'pi-app', lan: { hostname: 'pi-app.local' } })).toThrow(
      /the management dashboard site/,
    )
  })

  it('allows a LAN name alongside genuinely public domains', () => {
    const sites: Record<string, SiteConfig> = {
      public: { domain: 'example.com', port: 3000, root: '.output', start: 'bun run server.ts' },
    }
    const config = buildRpxConfig(sites, { proxy: onDemand, slug: 'pi-app', lan: { hostname: 'pi-app.local' } })
    expect(config.localCa?.hosts).toEqual(['pi-app.local'])
    expect(config.onDemandTls?.allowedSuffixes).toContain('example.com')
  })
})

describe('isLanHostname', () => {
  it('accepts mDNS names and bare hostnames', () => {
    expect(isLanHostname('pi-app.local')).toBe(true)
    expect(isLanHostname('wiki.pi-app.local')).toBe(true)
    expect(isLanHostname('intranet')).toBe(true)
  })

  it('rejects public names, addresses and wildcards', () => {
    expect(isLanHostname('example.com')).toBe(false)
    expect(isLanHostname('192.168.1.20')).toBe(false)
    expect(isLanHostname('*.pi-app.local')).toBe(false)
    expect(isLanHostname('')).toBe(false)
  })
})

describe('resolveGatewayLan: the provider gate', () => {
  const ssh = { hosts: [{ host: 'pi.local' }], lan: { hostname: 'pi-app.local' } }

  it('resolves LAN settings for the ssh provider', () => {
    expect(resolveGatewayLan({ cloud: { provider: 'ssh' }, ssh } as CloudConfig, '192.168.1.20')).toEqual({
      hostname: 'pi-app.local',
      tls: 'local-ca',
      ip: '192.168.1.20',
    })
  })

  it('ignores ssh.lan for a cloud provider, which has no LAN to reach', () => {
    expect(resolveGatewayLan({ cloud: { provider: 'hetzner' }, ssh } as CloudConfig)).toBeUndefined()
    expect(resolveGatewayLan({ cloud: { provider: 'aws' }, ssh } as CloudConfig)).toBeUndefined()
  })

  it('is undefined when the ssh provider configured no LAN at all', () => {
    expect(resolveGatewayLan({ cloud: { provider: 'ssh' }, ssh: { hosts: [{ host: 'pi.local' }] } } as CloudConfig))
      .toBeUndefined()
  })

  it('a host with no LAN config keeps its public gateway untouched', () => {
    const publicSites: Record<string, SiteConfig> = {
      web: { domain: 'pi.example.com', port: 3000, root: '.output', start: 'bun run server.ts' },
    }
    const config = buildRpxConfig(publicSites, { proxy: rpxProxy, slug: 'pi-app', lan: undefined })
    expect(config.localCa).toBeUndefined()
    expect(config.https).toBe(true)
  })

  it('reports the host profile for the ssh provider only', () => {
    expect(resolveGatewayProfile({ cloud: { provider: 'ssh' }, ssh: { profile: 'raspberry-pi' } } as CloudConfig))
      .toBe('raspberry-pi')
    expect(resolveGatewayProfile({ cloud: { provider: 'hetzner' }, ssh: { profile: 'raspberry-pi' } } as CloudConfig))
      .toBeUndefined()
  })
})

describe('the Hetzner path is unchanged', () => {
  const sites: Record<string, SiteConfig> = {
    main: { domain: 'stacksjs.com', path: '/api', root: '.output', start: 'bun run server.ts', port: 3000 },
    docs: { domain: 'stacksjs.com', path: '/docs', deploy: 'server', root: 'docs/dist' },
  }
  const proxy: ComputeProxyConfig = { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'ops@stacksjs.com' }

  it('emits the same config it always emitted, key for key', () => {
    const config = buildRpxConfig(sites, { proxy, slug: 'stacks' })
    expect(config).toEqual({
      proxies: [
        { to: 'stacksjs.com', path: '/docs', static: { dir: '/var/www/stacks-docs/current', spa: false, pathRewriteStyle: 'directory' }, cleanUrls: true, id: 'stacksjs.com-docs' },
        { to: 'stacksjs.com', path: '/api', from: 'localhost:3000', id: 'stacksjs.com-api' },
        { to: 'www.stacksjs.com', redirect: { to: 'https://stacksjs.com' }, id: 'www.stacksjs.com' },
      ],
      productionCerts: { certsDir: '/etc/rpx/certs', certsDirServerNames: ['stacksjs.com', 'www.stacksjs.com'] },
      https: true,
      hostsManagement: false,
      cleanup: { hosts: false, certs: false },
      onDemandTls: {
        enabled: true,
        allowedSuffixes: ['stacksjs.com', 'www.stacksjs.com'],
        email: 'ops@stacksjs.com',
        certsDir: '/etc/rpx/certs',
        staging: false,
      },
      acmeChallengeWebroot: '/var/www/acme-challenge',
    })
  })

  it('writes a fragment with no LAN keys in it', () => {
    const fragment = JSON.stringify({ slug: 'stacks', ...buildRpxConfig(sites, { proxy, slug: 'stacks' }) })
    expect(fragment).not.toContain('localCa')
    expect(fragment).not.toContain('"https":false')
  })

  it('keeps the gateway unit at the cloud-box memory ceilings', () => {
    const script = buildRpxProvisionScript({
      proxy,
      config: buildRpxConfig(sites, { proxy, slug: 'stacks' }),
      slug: 'stacks',
    }).join('\n')
    expect(script).toContain('MemoryHigh=512M')
    expect(script).toContain('MemoryMax=768M')
  })
})

describe('the raspberry-pi profile bounds the gateway', () => {
  const config = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan })

  it('lowers the memory ceilings for a board with a fraction of a cloud box RAM', () => {
    const script = buildRpxProvisionScript({ proxy: rpxProxy, config, slug: 'pi-app', profile: 'raspberry-pi' }).join('\n')
    expect(script).toContain('MemoryHigh=256M')
    expect(script).toContain('MemoryMax=384M')
  })

  it('leaves the generic profile alone', () => {
    const script = buildRpxProvisionScript({ proxy: rpxProxy, config, slug: 'pi-app', profile: 'generic' }).join('\n')
    expect(script).toContain('MemoryHigh=512M')
    expect(script).toContain('MemoryMax=768M')
  })

  it('an explicit setting wins over the profile default', () => {
    const proxy: ComputeProxyConfig = { engine: 'rpx', memoryHigh: '1G', memoryMax: '2G' }
    const script = buildRpxProvisionScript({
      proxy,
      config: buildRpxConfig(lanSites, { proxy, slug: 'pi-app', lan }),
      slug: 'pi-app',
      profile: 'raspberry-pi',
    }).join('\n')
    expect(script).toContain('MemoryHigh=1G')
    expect(script).toContain('MemoryMax=2G')
    expect(script).not.toContain('MemoryHigh=256M')
  })
})

describe('fragments merge into one gateway-wide CA', () => {
  const piFragment = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan })
  const neighbour = buildRpxConfig(
    { wiki: { domain: 'wiki.local', port: 4000, root: '.output', start: 'bun run wiki.ts' } },
    { proxy: rpxProxy, slug: 'wiki', lan: { hostname: 'wiki.local', ip: '192.168.1.21' } },
  )

  it('unions the hosts and addresses of every tenant that wants one', () => {
    const merged = mergeRpxFragments([piFragment, neighbour])
    expect(merged.localCa?.dir).toBe(DEFAULT_LOCAL_CA_DIR)
    expect(merged.localCa?.hosts).toEqual(['pi-app.local', 'wiki.local'])
    expect(merged.localCa?.ips).toEqual(['192.168.1.20', '192.168.1.21'])
  })

  it('leaves a box with no LAN tenant exactly as it was', () => {
    const public_ = buildRpxConfig(
      { web: { domain: 'example.com', port: 3000, root: '.output', start: 'bun run server.ts' } },
      { proxy: rpxProxy, slug: 'public' },
    )
    const merged = mergeRpxFragments([public_])
    expect(merged.localCa).toBeUndefined()
    expect(merged.https).toBe(true)
  })

  it('keeps TLS bound while any tenant still needs it', () => {
    const plain = buildRpxConfig(lanSites, { proxy: rpxProxy, slug: 'pi-app', lan: { tls: 'off' } })
    expect(mergeRpxFragments([plain]).https).toBe(false)
    expect(mergeRpxFragments([plain, neighbour]).https).toBe(true)
  })

  it('the on-box assembler carries the same merge', () => {
    const assembler = renderRpxAssembler()
    expect(assembler).toContain('frag.localCa')
    expect(assembler).toContain('localCaHosts')
    expect(assembler).toContain('https: fragmentCount === 0 ? true : anyTls')
  })
})

const facts: Pick<SshPreflightFacts, 'arch' | 'lanIp'> = { arch: 'aarch64', lanIp: '192.168.1.20' }

const piConfig: CloudConfig = {
  project: { name: 'Pi App', slug: 'pi-app', region: 'home' },
  environments: { production: { type: 'production' } },
  cloud: { provider: 'ssh' },
  ssh: { hosts: [{ host: 'pi.local', user: 'pi' }], profile: 'raspberry-pi', lan: { hostname: 'pi-app.local' } },
  sites: lanSites,
  infrastructure: { compute: { runtime: 'bun', proxy: { engine: 'rpx' } } },
}

describe('buildSshBootstrapScript wires the LAN CA into the box', () => {
  const build = (overrides: Partial<Parameters<typeof buildSshBootstrapScript>[0]> = {}): string =>
    buildSshBootstrapScript({
      config: piConfig,
      environment: 'production',
      profile: 'raspberry-pi',
      facts,
      lan: piConfig.ssh!.lan,
      ...overrides,
    })

  it('writes localCa into the route fragment, not just the header comment', () => {
    const script = build()
    expect(script).toContain('"localCa"')
    expect(script).toContain('"dir": "/etc/rpx/local-ca"')
    expect(script).toContain('"pi-app.local"')
  })

  it('takes the box address from the preflight facts', () => {
    expect(build()).toContain('"192.168.1.20"')
  })

  it('prefers an explicitly supplied address over the preflight one', () => {
    expect(build({ lanIp: '10.0.0.5' })).toContain('"10.0.0.5"')
  })

  it('tunes the gateway unit for the board', () => {
    const script = build()
    expect(script).toContain('MemoryHigh=256M')
    expect(script).toContain('MemoryMax=384M')
  })

  it('tells the operator where the CA certificate will be', () => {
    expect(build()).toContain(localCaCertPath())
  })

  it('emits no local CA when the operator asked for plain HTTP', () => {
    const script = build({ lan: { hostname: 'pi-app.local', tls: 'off' } })
    expect(script).not.toContain('"localCa"')
    expect(script).toContain('"https": false')
  })

  it('emits no local CA for a host with no LAN configured at all', () => {
    // The assembler the script installs always MENTIONS localCa, because it is
    // the same file on every box; what must be absent is the JSON key in this
    // project's route fragment, which is what the assembler would read.
    const script = build({ lan: undefined })
    expect(script).not.toContain('"localCa"')
    expect(script).toContain('"https": true')
  })
})

describe('localCaCertPath', () => {
  it('names rpx own CA filename under the conventional directory', () => {
    expect(localCaCertPath()).toBe('/etc/rpx/local-ca/rpx-root-ca.crt')
    expect(localCaCertPath('/srv/ca/')).toBe('/srv/ca/rpx-root-ca.crt')
  })
})
