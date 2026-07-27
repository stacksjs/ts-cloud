import { describe, expect, it } from 'bun:test'
import type { CloudConfig } from '@ts-cloud/core'
import {
  buildHetznerHostOptimizationScript,
  resolveHetznerHostOptimizationPlan,
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
})
