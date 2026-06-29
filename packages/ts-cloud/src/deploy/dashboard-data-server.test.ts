import { describe, expect, it } from 'bun:test'
import { parseBlock, resolveConfigOnlyServerDashboardData } from './dashboard-data-server'

describe('parseBlock (server metrics probe output)', () => {
  it('parses KEY=VALUE lines and SVC=name=status into services', () => {
    const out = [
      'CPUS=8',
      'LOAD=1.5',
      'MEMTOTAL=16000',
      'MEMUSED=3000',
      'DISKPCT=55',
      'UPTIME=99 days',
      'OS=Ubuntu 24.04 LTS',
      'SVC=nginx=active',
      'SVC=php8.3-fpm=active',
      'SVC=redis=failed',
    ].join('\n')
    const r = parseBlock(out)
    expect(r.CPUS).toBe('8')
    expect(r.LOAD).toBe('1.5')
    expect(r.UPTIME).toBe('99 days')
    expect(r.OS).toBe('Ubuntu 24.04 LTS')
    expect(r.services).toEqual([
      { name: 'nginx', status: 'active' },
      { name: 'php8.3-fpm', status: 'active' },
      { name: 'redis', status: 'failed' },
    ])
  })

  it('tolerates blank lines and noise without throwing', () => {
    const r = parseBlock('\n  \nGARBAGE LINE\nCPUS=2\n')
    expect(r.CPUS).toBe('2')
    expect(r.services).toEqual([])
  })

  it('keeps values containing = (only splits on the first)', () => {
    const r = parseBlock('OS=Name=With=Equals')
    expect(r.OS).toBe('Name=With=Equals')
  })
})

describe('resolveConfigOnlyServerDashboardData', () => {
  it('derives rpx services and disabled backups from config instead of sample data', () => {
    const data = resolveConfigOnlyServerDashboardData({
      project: { name: 'Stacks', slug: 'stacks', region: 'us-east-1' },
      cloud: { provider: 'hetzner' },
      infrastructure: {
        compute: {
          instances: 1,
          disk: { size: 20 },
          webServer: 'rpx',
          proxy: { engine: 'rpx' },
        },
      },
      sites: {
        verygoodadblock: { deploy: 'server', domain: 'verygoodadblock.org', root: '../adblock/dist/site' },
      },
    } as any, 'production' as any)

    expect(data.server.name).toBe('stacks-production-app')
    expect(data.server.provider).toBe('hetzner')
    expect(data.services).toEqual([{ name: 'rpx-gateway', status: 'configured' }])
    expect(data.servicesDetail[0].name).toBe('rpx-gateway')
    expect(data.backup).toMatchObject({ enabled: false, destination: 'off', retention: 0 })
    expect(data.backupHistory).toEqual([])
    expect(data.serverDeployments).toEqual([])
    expect(data.sites[0]).toMatchObject({ name: 'verygoodadblock', domain: 'verygoodadblock.org', type: 'static' })
    expect(JSON.stringify(data)).not.toContain('acme')
    expect(JSON.stringify(data)).not.toContain('nginx')
  })

  it('labels Stacks, BunPress, internal API, and shadowed routes without PHP defaults', () => {
    const data = resolveConfigOnlyServerDashboardData({
      project: { name: 'Stacks', slug: 'stacks', region: 'us-east-1' },
      cloud: { provider: 'hetzner' },
      infrastructure: {
        compute: {
          webServer: 'rpx',
          proxy: { engine: 'rpx' },
        },
      },
      sites: {
        main: { root: '.', domain: 'stacksjs.com', path: '/', start: 'bun storage/framework/core/buddy/src/cli.ts serve', port: 3000 },
        api: { root: '.', start: 'bun storage/framework/core/actions/src/serve/api.ts', port: 3008 },
        docs: { deploy: 'server', root: 'dist/docs/.bunpress', path: '/docs', domain: 'stacksjs.com', build: 'bunx @stacksjs/bunpress build --dir ./docs --outdir ./dist/docs' },
        blog: { deploy: 'server', root: 'dist/blog', path: '/blog', domain: 'stacksjs.com', build: 'bun -e "const {buildBlog}=await import(\'./blog\')"' },
        public: { deploy: 'server', root: 'storage/framework/frontend-dist', path: '/', domain: 'stacksjs.com', build: 'bun storage/framework/core/buddy/src/cli.ts build:frontend-static' },
      },
    } as any, 'production' as any)

    expect(data.sites.map((site: any) => ({
      name: site.name,
      route: site.route,
      kind: site.kind,
      runtime: site.runtime,
      deploy: site.deploy,
      tls: site.tls,
      status: site.status,
      shadowedBy: site.shadowedBy,
    }))).toEqual([
      { name: 'main', route: 'stacksjs.com', kind: 'stacks', runtime: 'bun', deploy: 'service', tls: 'https', status: 'live', shadowedBy: undefined },
      { name: 'api', route: 'internal', kind: 'api', runtime: 'bun', deploy: 'service', tls: 'loopback', status: 'live', shadowedBy: undefined },
      { name: 'docs', route: 'stacksjs.com/docs', kind: 'bunpress', runtime: 'static/bun', deploy: 'server static', tls: 'https', status: 'live', shadowedBy: undefined },
      { name: 'blog', route: 'stacksjs.com/blog', kind: 'bunpress blog', runtime: 'static/bun', deploy: 'server static', tls: 'https', status: 'live', shadowedBy: undefined },
      { name: 'public', route: 'stacksjs.com', kind: 'static', runtime: 'static/bun', deploy: 'server static', tls: 'https', status: 'shadowed', shadowedBy: 'main' },
    ])
    expect(JSON.stringify(data.sites)).not.toContain('laravel')
    expect(JSON.stringify(data.sites)).not.toContain('"php"')
  })
})
