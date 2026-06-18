import { describe, expect, it } from 'bun:test'
import { parseBlock } from './dashboard-data-server'

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
