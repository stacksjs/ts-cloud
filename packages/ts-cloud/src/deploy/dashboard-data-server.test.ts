import { describe, expect, it } from 'bun:test'
import { parseBlock, parseDeployHistory, parseServerLogs, parseServerSecurity, resolveConfigOnlyServerDashboardData } from './dashboard-data-server'

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
      'SVC=nginx=active=41943040=enabled=Sun 2026-06-28 10:00:00 UTC',
      'SVC=php8.3-fpm=active',
      'SVC=redis=failed',
    ].join('\n')
    const r = parseBlock(out)
    expect(r.CPUS).toBe('8')
    expect(r.LOAD).toBe('1.5')
    expect(r.UPTIME).toBe('99 days')
    expect(r.OS).toBe('Ubuntu 24.04 LTS')
    expect(r.services).toEqual([
      { name: 'nginx', status: 'active', memBytes: 41943040, enabled: 'enabled', since: 'Sun 2026-06-28 10:00:00 UTC' },
      { name: 'php8.3-fpm', status: 'active', memBytes: 0, enabled: '-', since: '-' },
      { name: 'redis', status: 'failed', memBytes: 0, enabled: '-', since: '-' },
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
    expect(data.server.region).toBe('fsn1')
    expect(data._serverReachable).toBe(false)
    expect(data.metricsUnavailable).toBe(true)
    expect(data._metricsStatus).toBe('unavailable')
    expect(data.systemMetrics.memTotalMb).toBe(0)
    expect(data.services).toEqual([{ name: 'rpx-gateway', status: 'configured' }])
    expect(data.servicesDetail[0].name).toBe('rpx-gateway')
    expect(data.backup).toMatchObject({ enabled: false, destination: 'off', retention: 0 })
    expect(data.backupHistory).toEqual([])
    expect(data.serverDeployments).toEqual([])
    expect(data.serverLogs).toEqual([])
    expect(data.security.firewall.status).toBe('configured')
    expect(data.diagnostics.some((check: any) => check.name === 'Live server probe')).toBe(true)
    expect(data.activity).toEqual([])
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

describe('parseServerSecurity', () => {
  it('parses ports, ufw output, auth events, and certificate expiry', () => {
    const output = [
      'PORT=tcp\t0.0.0.0:443\tusers:(("rpx",pid=123,fd=7))',
      'PORT=tcp\t127.0.0.1:3000\tusers:(("bun",pid=456,fd=12))',
      'FIREWALL=Status: active',
      'FIREWALL=[ 1] 22/tcp ALLOW IN Anywhere',
      'AUTH=2026-06-28T21:00:00+0000 stacks sshd[999]: Accepted publickey for root',
      'CERT=verygoodadblock.org\tJun 28 12:00:00 2099 GMT',
    ].join('\n')

    const security = parseServerSecurity(output)

    expect(security.ports).toHaveLength(2)
    expect(security.ports[0]).toMatchObject({ proto: 'tcp', listen: '0.0.0.0:443', processName: 'users:(("rpx",pid=123,fd=7))', exposure: 'public', tone: 'ok' })
    expect(security.ports[1]).toMatchObject({ listen: '127.0.0.1:3000', exposure: 'loopback', tone: 'ok' })
    expect(security.firewall).toMatchObject({ status: 'active', summary: 'ufw active' })
    expect(security.firewall.rules[0]).toContain('22/tcp')
    expect(security.authEvents[0]).toMatchObject({ level: 'info' })
    expect(security.tlsCertificates[0]).toMatchObject({ domain: 'verygoodadblock.org', status: 'ok' })
  })
})

describe('parseDeployHistory', () => {
  it('parses newest-first deploy history records by site', () => {
    const output = [
      'DEPLOY=docs\t2026-06-28T19:00:00Z\tabc1234\tabc1234\tsuccess\trc=0',
      'noise',
      'DEPLOY=main\t2026-06-28T20:00:00Z\tdef5678\tdef5678\tfailed\trc=1',
    ].join('\n')

    const records = parseDeployHistory(output, {
      docs: { deploy: 'server', root: 'dist/docs' },
      main: { start: 'bun server.ts', port: 3000 },
    } as any)

    expect(records.map(record => record.site)).toEqual(['main', 'docs'])
    expect(records[0]).toMatchObject({ sha: 'def5678', status: 'failed', rc: '1', branch: 'main' })
    expect(records[1]).toMatchObject({ sha: 'abc1234', status: 'success', branch: 'build artifact' })
  })
})

describe('parseServerLogs', () => {
  it('parses journalctl-prefixed log lines newest first with inferred levels', () => {
    const output = [
      'LOG=rpx-gateway\t2026-06-28T19:00:00+0000 stacks rpx[123]: route loaded',
      'LOG=stacks-main\t2026-06-28T20:00:00+0000 stacks app[456]: failed to bind port',
      'LOG=nginx\t2026-06-28T19:30:00+0000 stacks nginx[789]: warning duplicate server name',
      'noise',
    ].join('\n')

    const records = parseServerLogs(output)

    expect(records.map(record => record.source)).toEqual(['stacks-main', 'nginx', 'rpx-gateway'])
    expect(records[0]).toMatchObject({ level: 'error', message: 'app[456]: failed to bind port' })
    expect(records[1]).toMatchObject({ level: 'warn', message: 'nginx[789]: warning duplicate server name' })
    expect(records[2]).toMatchObject({ level: 'info', message: 'rpx[123]: route loaded' })
  })
})
