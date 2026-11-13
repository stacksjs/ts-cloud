import type { ComputeProxyConfig, SiteConfig } from '@ts-cloud/core'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { certCoverageReport, renderCertCoverageCheck, RPX_CERT_COVERAGE_WARN_DAYS } from '../../src/drivers/shared/cert-coverage'
import { buildCertManagementCommands, buildRpxConfig, certDomainsForConfig, gatewayHostnames } from '../../src/drivers/shared/rpx-gateway'

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 10, 13)
const tlsProxy: ComputeProxyConfig = { engine: 'rpx', onDemandTls: true, onDemandTlsEmail: 'admin@example.org' }

function renewScriptFor(sites: Record<string, SiteConfig>, slug: string): { file: string, content: string, fragment: any } {
  const config = buildRpxConfig(sites, { proxy: tlsProxy, slug })
  const commands = buildCertManagementCommands({ config, proxy: tlsProxy, slug }).join('\n')
  const start = commands.indexOf('#!/bin/sh')
  const content = commands.slice(start, commands.indexOf('\nTS_CLOUD_RENEW_EOF', start))
  return { file: `renew-certs-${slug}.sh`, content, fragment: { ...config, file: `${slug}.json` } }
}

// The shape of the outage this guards against: the project was renamed, its
// new site file names one domain family, and the site file written under the
// old slug still routes the other family with no renewal script behind it.
const current = renewScriptFor({
  main: { root: '.', domain: 'uptime-status.org', port: 3000, start: 'bun serve' },
  panel: { root: '.', domain: 'dashboard.uptime-status.org', port: 30036, start: 'bun panel' },
}, 'statushq')
const stale = {
  file: 'uptime-status.json',
  https: true,
  proxies: [
    { to: 'uptime-status.org' },
    { to: 'statushq.org' },
    { to: 'www.statushq.org' },
    { to: 'dashboard.statushq.org' },
  ],
}
const healthy = { 'uptime-status.org': now + 80 * DAY, 'www.uptime-status.org': now + 80 * DAY, 'dashboard.uptime-status.org': now + 80 * DAY }

describe('certCoverageReport', () => {
  it('reports every hostname the gateway serves that no renewal script covers', () => {
    const report = certCoverageReport({
      fragments: [current.fragment, stale],
      renewScripts: [current],
      certExpiry: { ...healthy, 'statushq.org': now + 90 * DAY, 'www.statushq.org': now - 15 * DAY },
      ownScript: current.file,
      now,
    })
    expect(report.uncovered.map(entry => entry.host)).toEqual(['dashboard.statushq.org', 'statushq.org', 'www.statushq.org'])
    expect(report.uncovered[1]).toEqual({ host: 'statushq.org', files: ['uptime-status.json'], daysLeft: 90 })
    expect(report.lines).toHaveLength(3)
    expect(report.lines[0]).toContain('dashboard.statushq.org is served by the gateway (uptime-status.json) but no renewal script covers it. It has no certificate on disk.')
    expect(report.lines[1]).toContain('Its certificate expires in 90 days and will not renew.')
    expect(report.lines[2]).toContain('Its certificate expired 15 days ago and will not renew.')
  })

  it('is silent when every served hostname is covered and no certificate is close to expiry', () => {
    const report = certCoverageReport({ fragments: [current.fragment], renewScripts: [current], certExpiry: healthy, ownScript: current.file, now })
    expect(report).toEqual({ uncovered: [], expiring: [], missing: [], lines: [] })
  })

  it('reports a certificate inside the warning window, and one that already expired', () => {
    const report = certCoverageReport({
      fragments: [current.fragment],
      renewScripts: [current],
      certExpiry: { ...healthy, 'uptime-status.org': now + RPX_CERT_COVERAGE_WARN_DAYS * DAY, 'www.uptime-status.org': now - 2 * DAY },
      ownScript: current.file,
      now,
    })
    expect(report.expiring).toEqual([{ host: 'uptime-status.org', daysLeft: 14 }, { host: 'www.uptime-status.org', daysLeft: -2 }])
    expect(report.lines[0]).toContain('the certificate for uptime-status.org expires in 14 days')
    expect(report.lines[1]).toContain('the certificate for www.uptime-status.org expired 2 days ago')
    // One day outside the window is not a finding: renewal has until then.
    const fine = certCoverageReport({ fragments: [current.fragment], renewScripts: [current], certExpiry: { ...healthy, 'uptime-status.org': now + 15 * DAY }, ownScript: current.file, now })
    expect(fine.lines).toEqual([])
  })

  it('reports a renewed hostname with no certificate on disk', () => {
    const { 'www.uptime-status.org': _gone, ...rest } = healthy
    const report = certCoverageReport({ fragments: [current.fragment], renewScripts: [current], certExpiry: rest, ownScript: current.file, now })
    expect(report.missing).toEqual(['www.uptime-status.org'])
  })

  it('leaves another project\'s certificates to that project\'s own run', () => {
    const other = renewScriptFor({ main: { root: '.', domain: 'bughq.org', port: 3022, start: 'bun serve' } }, 'bughq')
    const report = certCoverageReport({
      fragments: [current.fragment, other.fragment],
      renewScripts: [current, other],
      certExpiry: { ...healthy, 'bughq.org': now + 3 * DAY },
      ownScript: current.file,
      now,
    })
    expect(report.lines).toEqual([])
    // Its own run does report it.
    const theirs = certCoverageReport({ fragments: [other.fragment], renewScripts: [other], certExpiry: { 'bughq.org': now + 3 * DAY, 'www.bughq.org': now + 80 * DAY }, ownScript: other.file, now })
    expect(theirs.expiring).toEqual([{ host: 'bughq.org', daysLeft: 3 }])
  })

  it('counts a wildcard renewal as cover for the wildcard and the names under it', () => {
    const wild = renewScriptFor({ main: { domain: 'hq.training', aliases: ['*.hq.training'], root: '.', start: 'bun serve', port: 3032 } }, 'training')
    const report = certCoverageReport({
      fragments: [wild.fragment, { file: 'tenant.json', proxies: [{ to: 'acme.hq.training' }] }],
      renewScripts: [wild],
      certExpiry: { 'hq.training': now + 60 * DAY, 'www.hq.training': now + 60 * DAY, '_wildcard.hq.training': now + 5 * DAY },
      ownScript: wild.file,
      now,
    })
    expect(report.uncovered).toEqual([])
    expect(report.expiring.map(entry => entry.host)).toEqual(['*.hq.training', 'acme.hq.training'])
  })

  it('ignores hostnames that never take a public certificate', () => {
    const report = certCoverageReport({
      fragments: [
        { file: 'lan.json', proxies: [{ to: 'pi-app.local' }, { to: 'localhost:3000' }, { to: 'intranet' }], localCa: { hosts: ['pi-app.local'] } },
        { file: 'plain.json', https: false, proxies: [{ to: 'plain.example.org' }] },
      ],
      renewScripts: [],
      certExpiry: {},
      now,
    })
    expect(report.lines).toEqual([])
  })
})

describe('the renewal script runs the coverage check', () => {
  it('ends with the check, so a gap fails the renewal unit', () => {
    const lines = current.content.trim().split('\n')
    expect(lines.at(-1)).toBe(`$BUN /etc/rpx/cert-coverage-statushq.js '/etc/rpx/sites.d' '/etc/rpx' "$CERTS" 'renew-certs-statushq.sh' '14' || exit 1`)
  })

  it('ships the check beside the renewal script, before the first run', () => {
    const config = buildRpxConfig({ main: { root: '.', domain: 'example.org', port: 3000, start: 'bun serve' } }, { proxy: tlsProxy, slug: 'demo' })
    const commands = buildCertManagementCommands({ config, proxy: tlsProxy, slug: 'demo' }).join('\n')
    const written = commands.indexOf('mv -f "$__tsc_tmp" /etc/rpx/cert-coverage-demo.js')
    expect(written).toBeGreaterThan(-1)
    expect(written).toBeLessThan(commands.lastIndexOf('/etc/rpx/renew-certs-demo.sh || true'))
  })

  it('the shipped check finds an uncovered hostname on a real directory layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-cloud-cert-coverage-'))
    try {
      mkdirSync(join(root, 'sites.d'))
      mkdirSync(join(root, 'certs'))
      writeFileSync(join(root, 'cert-coverage.js'), renderCertCoverageCheck())
      writeFileSync(join(root, current.file), current.content)
      writeFileSync(join(root, 'sites.d', 'statushq.json'), JSON.stringify(current.fragment))
      writeFileSync(join(root, 'sites.d', 'uptime-status.json'), JSON.stringify(stale))
      writeFileSync(join(root, 'sites.d', 'broken.json'), '{ not json')
      const run = () => Bun.spawnSync([process.execPath, join(root, 'cert-coverage.js'), join(root, 'sites.d'), root, join(root, 'certs'), current.file, '14'])

      const gap = run()
      expect(gap.exitCode).toBe(1)
      const output = gap.stderr.toString()
      for (const host of ['statushq.org', 'www.statushq.org', 'dashboard.statushq.org'])
        expect(output).toContain(`rpx-cert-coverage: ${host} is served by the gateway (uptime-status.json) but no renewal script covers it.`)

      // Declaring the hostnames is the fix: the next renewal script covers them.
      const fixed = renewScriptFor({
        main: { root: '.', domain: 'uptime-status.org', aliases: ['statushq.org'], port: 3000, start: 'bun serve' },
        panel: { root: '.', domain: 'dashboard.uptime-status.org', port: 30036, start: 'bun panel' },
        panelAlias: { domain: 'dashboard.statushq.org', redirect: 'https://dashboard.uptime-status.org' },
      }, 'statushq')
      writeFileSync(join(root, fixed.file), fixed.content)
      expect(run().stderr.toString()).not.toContain('no renewal script covers it')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('an apex alias and its www', () => {
  const sites: Record<string, SiteConfig> = {
    main: { root: '.', domain: 'uptime-status.org', aliases: ['statushq.org'], port: 3000, start: 'bun serve' },
  }

  it('publishes exactly the hostnames the gateway routes and renews', () => {
    const config = buildRpxConfig(sites, { proxy: tlsProxy })
    expect(certDomainsForConfig(config)).toContain('www.statushq.org')
    expect(gatewayHostnames(sites).sort()).toEqual(certDomainsForConfig(config).sort())
  })

  it('adds no www when autoWww is off', () => {
    expect(gatewayHostnames(sites, { autoWww: false }).sort()).toEqual(['statushq.org', 'uptime-status.org'])
  })
})
