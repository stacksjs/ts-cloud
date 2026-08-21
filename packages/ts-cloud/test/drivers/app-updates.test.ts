import { describe, expect, it } from 'bun:test'
import { appUpdateEnvPath, appUpdateUnitBase, buildAppUpdatesScript } from '../../src/drivers/shared/app-updates'

describe('buildAppUpdatesScript', () => {
  it('is empty when nothing is configured', () => {
    expect(buildAppUpdatesScript()).toEqual([])
    expect(buildAppUpdatesScript([])).toEqual([])
  })

  it('is empty when every target is disabled', () => {
    expect(buildAppUpdatesScript([
      { service: 'mail', binary: '/opt/mail/mail-server', enabled: false },
    ])).toEqual([])
  })

  it('renders a service, a timer and a pause switch from two facts', () => {
    const script = buildAppUpdatesScript([
      { service: 'mail', binary: '/opt/mail/mail-server' },
    ]).join('\n')

    expect(script).toContain('/etc/systemd/system/mail-upgrade.service')
    expect(script).toContain('/etc/systemd/system/mail-upgrade.timer')
    expect(script).toContain('/etc/ts-cloud/mail-upgrade.env')
    // The tool is told what to replace and what to restart, so the same binary
    // invoked from anywhere still acts on this install.
    expect(script).toContain('/opt/mail/mail-server upgrade --path /opt/mail/mail-server --service mail')
    expect(script).toContain('systemctl enable --now mail-upgrade.timer')
  })

  it('defaults to a daily stable check with a randomized spread', () => {
    const script = buildAppUpdatesScript([
      { service: 'mail', binary: '/opt/mail/mail-server' },
    ]).join('\n')

    expect(script).toContain('OnCalendar=daily')
    expect(script).toContain('RandomizedDelaySec=4h')
    expect(script).toContain('Persistent=true')
    // Stable is the absence of --canary, not a flag of its own.
    expect(script).not.toContain('--canary')
  })

  it('honours channel, schedule, spread and extra flags', () => {
    const script = buildAppUpdatesScript([{
      service: 'mail',
      binary: '/opt/mail/mail-server',
      channel: 'canary',
      schedule: 'hourly',
      randomizedDelay: '15m',
      args: ['--repo owner/fork'],
    }]).join('\n')

    expect(script).toContain('--canary')
    expect(script).toContain('OnCalendar=hourly')
    expect(script).toContain('RandomizedDelaySec=15m')
    expect(script).toContain('--repo owner/fork')
  })

  it('reloads systemd after writing units, never before', () => {
    const lines = buildAppUpdatesScript([
      { service: 'mail', binary: '/opt/mail/mail-server' },
    ])
    const unitWrite = lines.findIndex(l => l.includes('/etc/systemd/system/mail-upgrade.timer'))
    const reload = lines.indexOf('systemctl daemon-reload')
    const enable = lines.indexOf('systemctl enable --now mail-upgrade.timer')

    // Enabling a unit systemd has not read yet fails; ordering is the contract.
    expect(unitWrite).toBeGreaterThanOrEqual(0)
    expect(reload).toBeGreaterThan(unitWrite)
    expect(enable).toBeGreaterThan(reload)
  })

  it('handles several tools with a single reload', () => {
    const lines = buildAppUpdatesScript([
      { service: 'mail', binary: '/opt/mail/mail-server' },
      { service: 'pantry-registry', binary: '/usr/local/bin/pantry' },
    ])
    const script = lines.join('\n')

    expect(script).toContain('systemctl enable --now mail-upgrade.timer')
    expect(script).toContain('systemctl enable --now pantry-registry-upgrade.timer')
    expect(lines.filter(l => l === 'systemctl daemon-reload')).toHaveLength(1)
  })

  it('skips a target missing the facts it cannot invent', () => {
    expect(buildAppUpdatesScript([
      { service: 'mail', binary: '' },
      { service: '', binary: '/opt/mail/mail-server' },
    ])).toEqual([])
  })

  it('does not clobber an operator pause on reprovision', () => {
    const script = buildAppUpdatesScript([
      { service: 'mail', binary: '/opt/mail/mail-server' },
    ]).join('\n')

    // The env file is only written when absent — otherwise a redeploy would
    // silently switch updates back on for a box someone deliberately pinned.
    expect(script).toContain('if [ ! -f /etc/ts-cloud/mail-upgrade.env ]; then')
    expect(script).toContain('ENABLED=true')
  })
})

describe('naming helpers', () => {
  it('derives unit and env paths from the service name', () => {
    expect(appUpdateUnitBase('mail')).toBe('mail-upgrade')
    expect(appUpdateEnvPath('mail')).toBe('/etc/ts-cloud/mail-upgrade.env')
  })
})
