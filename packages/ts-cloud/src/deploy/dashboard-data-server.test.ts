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
})
