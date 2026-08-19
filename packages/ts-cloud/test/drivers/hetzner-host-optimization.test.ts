import { describe, expect, it } from 'bun:test'
import type { CloudConfig } from '@ts-cloud/core'
import {
  buildHetznerHostOptimizationScript,
  resolveHetznerHostOptimizationPlan,
  verifyHetznerHostContinuity,
  verifyHetznerHostOptimization,
} from '../../src/drivers/hetzner/host-optimization'

const config: CloudConfig = {
  project: { name: 'App', slug: 'app', region: 'fsn1' },
  environments: { production: { type: 'production' } },
  infrastructure: {
    compute: {
      swapGb: 4,
      autoUpdates: true,
      monitoring: { enabled: true },
      firewall: { enabled: true, allowedPorts: [25, 587, 25] },
    },
  },
}

describe('Hetzner host optimization', () => {
  it('resolves one declarative production plan', () => {
    expect(resolveHetznerHostOptimizationPlan(config)).toEqual({
      firewallPorts: [22, 25, 80, 443, 587],
      monitoring: true,
      autoUpdates: true,
      swapGb: 4,
      sshPasswordAuthentication: false,
      journalMaxUse: '256M',
      journalRetention: '14day',
    })
  })

  it('builds security, telemetry, resource, and firewall reconciliation', () => {
    const script = buildHetznerHostOptimizationScript(config).join('\n')
    expect(script).toContain('PasswordAuthentication no')
    expect(script).toContain('PermitRootLogin prohibit-password')
    expect(script).toContain('SystemMaxUse=256M')
    expect(script).toContain('net.ipv4.tcp_max_syn_backlog=4096')
    expect(script).toContain('ts-cloud-metrics.timer')
    expect(script).toContain('unattended-upgrades')
    expect(script).toContain('fail2ban')
    expect(script).toContain('ufw --force reset')
    expect(script).toContain('ufw allow 587/tcp')
  })

  it('retires legacy proxy units when rpx owns ports 80 and 443', () => {
    const rpxConfig: CloudConfig = {
      ...config,
      infrastructure: {
        compute: {
          ...config.infrastructure!.compute,
          webServer: 'rpx',
          proxy: { engine: 'rpx' },
        },
      },
    }
    const script = buildHetznerHostOptimizationScript(rpxConfig).join('\n')
    expect(script).toContain('systemctl disable --now nginx.service')
    expect(script).toContain('systemctl reset-failed nginx.service')
  })

  it('reports no failures for a reconciled host', () => {
    const plan = resolveHetznerHostOptimizationPlan(config)
    expect(
      verifyHetznerHostOptimization(plan, {
        firewallActive: true,
        firewallPorts: plan.firewallPorts,
        passwordAuthentication: false,
        rootPasswordLogin: false,
        fail2banActive: true,
        unattendedUpgradesActive: true,
        metricsTimerActive: true,
        metricsSnapshotFresh: true,
        swapBytes: 4 * 1024 ** 3,
        journalBytes: 128 * 1024 ** 2,
        failedUnits: [],
        publicTcpPorts: [22, 80, 443],
      }),
    ).toEqual([])
  })

  it('reports drift instead of hiding partial hardening', () => {
    const plan = resolveHetznerHostOptimizationPlan(config)
    const failures = verifyHetznerHostOptimization(plan, {
      firewallActive: false,
      firewallPorts: [22, 80, 443, 3000],
      passwordAuthentication: true,
      rootPasswordLogin: true,
      fail2banActive: false,
      unattendedUpgradesActive: false,
      metricsTimerActive: false,
      metricsSnapshotFresh: false,
      swapBytes: 0,
      journalBytes: 0,
      failedUnits: ['app.service'],
      publicTcpPorts: [22, 80, 443, 3000],
    })
    expect(failures).toContain('UFW is not active')
    expect(failures.some(failure => failure.includes('unexpected ports'))).toBe(true)
    expect(failures).toContain('SSH password authentication remains enabled')
    expect(failures.some(failure => failure.includes('app.service'))).toBe(true)
  })

  it('accepts a healthy release rollover during host optimization', () => {
    const manifest = {
      capturedAt: '2026-07-27T00:00:00.000Z',
      hostname: 'app',
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
      rootSource: '/dev/sda1',
      rootFsType: 'ext4',
      rootDiskBytes: 40 * 1024 ** 3,
      rootFilesystemBytes: 40 * 1024 ** 3,
      failedUnits: [],
      runningServices: ['app-api@old.service', 'rpx-gateway.service'],
      releaseLinks: ['/var/www/app-api/current=/var/www/app-api/releases/old'],
      routeFragments: ['/etc/rpx/sites.d/app.json=old-digest'],
      routeIds: ['/etc/rpx/sites.d/app.json:app.test:/'],
      routeDomains: ['app.test'],
      persistentData: [],
      dataCatalog: ['postgres:app'],
      routeProbes: [{ domain: 'app.test', ok: true, status: 200 }],
    }
    const after = {
      ...manifest,
      runningServices: ['app-api@new.service', 'rpx-gateway.service'],
      releaseLinks: ['/var/www/app-api/current=/var/www/app-api/releases/new'],
      routeFragments: ['/etc/rpx/sites.d/app.json=new-digest'],
    }

    expect(verifyHetznerHostContinuity(manifest, after)).toEqual({
      stoppedServices: [],
      changedRouteFragments: [],
      missingRouteIds: [],
      changedReleaseLinks: [],
      missingData: [],
    })
  })

  it('still rejects a workload, route, link, or database that disappears', () => {
    const before = {
      capturedAt: '2026-07-27T00:00:00.000Z',
      hostname: 'app',
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
      rootSource: '/dev/sda1',
      rootFsType: 'ext4',
      rootDiskBytes: 40 * 1024 ** 3,
      rootFilesystemBytes: 40 * 1024 ** 3,
      failedUnits: [],
      runningServices: ['app-api@old.service'],
      releaseLinks: ['/var/www/app-api/current=/var/www/app-api/releases/old'],
      routeFragments: ['/etc/rpx/sites.d/app.json=old-digest'],
      routeIds: ['/etc/rpx/sites.d/app.json:app.test:/'],
      routeDomains: ['app.test'],
      persistentData: [],
      dataCatalog: ['postgres:app'],
      routeProbes: [{ domain: 'app.test', ok: true, status: 200 }],
    }
    const after = {
      ...before,
      runningServices: [],
      releaseLinks: [],
      routeFragments: [],
      routeIds: [],
      dataCatalog: [],
    }

    const failures = verifyHetznerHostContinuity(before, after)
    expect(failures.stoppedServices).toEqual(['app-api@old.service'])
    expect(failures.changedRouteFragments).toEqual(['/etc/rpx/sites.d/app.json=old-digest'])
    expect(failures.missingRouteIds).toEqual(['/etc/rpx/sites.d/app.json:app.test:/'])
    expect(failures.changedReleaseLinks).toEqual(['/var/www/app-api/current=/var/www/app-api/releases/old'])
    expect(failures.missingData).toEqual(['postgres:app'])
  })
})
