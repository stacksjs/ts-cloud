import { describe, expect, it } from 'bun:test'
import { buildUfwScript, UFW_BASE_PORTS } from '../../src/drivers/shared/ufw'
import { buildAutoUpdatesScript, buildStaggeredRestartExecutable, buildStaggeredRestartInstallScript } from '../../src/drivers/shared/maintenance'
import { buildMonitoringScript } from '../../src/drivers/shared/monitoring'
import { buildBackupProvisionScript, buildBackupsConfigTs } from '../../src/drivers/shared/backups'
import { readBackupConfig } from './backup-config-fixture'

describe('buildUfwScript', () => {
  it('allows SSH + 80/443 and extra ports, then enables', () => {
    const script = buildUfwScript({ allowedPorts: [8080] }).join('\n')
    expect(script).toContain('ufw allow OpenSSH')
    expect(script).toContain('ufw allow 80/tcp')
    expect(script).toContain('ufw allow 443/tcp')
    expect(script).toContain('ufw allow 8080/tcp')
    expect(script).toContain('ufw --force reset')
    expect(script).toContain('ufw --force enable')
  })

  it('is empty when disabled', () => {
    expect(buildUfwScript({ enabled: false })).toEqual([])
  })

  it('always includes the base web ports', () => {
    expect(UFW_BASE_PORTS).toEqual([80, 443])
  })
})

describe('buildAutoUpdatesScript', () => {
  it('installs and enables unattended-upgrades', () => {
    const script = buildAutoUpdatesScript(true).join('\n')
    expect(script).toContain('apt-get install -y unattended-upgrades')
    expect(script).toContain('APT::Periodic::Unattended-Upgrade "1";')
  })
  it('is empty when disabled', () => {
    expect(buildAutoUpdatesScript(false)).toEqual([])
  })

  // needrestart restarts every service mapping an upgraded library in one
  // command. On a box hosting many apps that takes them all down together.
  it('stops the package run restarting services and staggers them instead', () => {
    const script = buildAutoUpdatesScript(true).join('\n')
    expect(script).toContain('/etc/needrestart/conf.d/50-ts-cloud-staggered.conf')
    expect(script).toContain(`$nrconf{restart} = 'l';`)
    expect(script).toContain('systemctl enable --now ts-cloud-staggered-restart.timer')
    expect(script).toContain('OnCalendar=*-*-* 07:30:00')
  })

  it('restarts one service per command and waits for it to come up', () => {
    const lines = buildStaggeredRestartExecutable()
    const restarts = lines.filter(line => line.includes('systemctl restart'))
    expect(restarts).toEqual(['  if ! systemctl restart "$svc"; then'])
    expect(lines.join('\n')).toContain('systemctl is-active --quiet "$svc"')
    expect(lines.join('\n')).toContain('flock -n 9')
  })

  it('never restarts what would cut the box or the operator off', () => {
    const skip = buildStaggeredRestartExecutable().find(line => line.startsWith('SKIP='))!
    const pattern = new RegExp(skip.slice(`SKIP='`.length, -1))
    for (const unit of ['dbus.service', 'docker.service', 'containerd.service', 'systemd-logind.service', 'serial-getty@ttyS0.service', 'user@0.service', 'unattended-upgrades.service', 'networkd-dispatcher.service', 'ts-cloud-staggered-restart.service'])
      expect(pattern.test(unit)).toBe(true)
    for (const unit of ['cursio-main@e9cda38.service', 'rpx-gateway.service', 'postgresql@18-main.service', 'ssh.service'])
      expect(pattern.test(unit)).toBe(false)
  })

  it('emits scripts bash accepts, with every here-document terminator at column 0', () => {
    for (const lines of [buildStaggeredRestartExecutable(), buildStaggeredRestartInstallScript()]) {
      const check = Bun.spawnSync(['bash', '-n'], { stdin: Buffer.from(`${lines.join('\n')}\n`) })
      expect(check.stderr.toString()).toBe('')
      expect(check.exitCode).toBe(0)
    }
    const install = buildStaggeredRestartInstallScript()
    for (const delimiter of ['TS_CLOUD_NEEDRESTART_EOF', 'TS_CLOUD_STAGGERED_EOF', 'TS_CLOUD_STAGGERED_UNIT_EOF', 'TS_CLOUD_STAGGERED_TIMER_EOF'])
      expect(install).toContain(delimiter)
  })
})

describe('buildMonitoringScript', () => {
  it('installs a metrics collector + minute timer', () => {
    const script = buildMonitoringScript(true).join('\n')
    expect(script).toContain('/usr/local/bin/ts-cloud-metrics.sh')
    expect(script).toContain('ts-cloud-metrics.timer')
    expect(script).toContain('OnCalendar=*-*-* *:*:00')
    expect(script).toContain('Persistent=true')
  })
  it('is empty when disabled', () => {
    expect(buildMonitoringScript(false)).toEqual([])
  })
})

describe('backups (ts-backups integration)', () => {
  const database = { engine: 'mysql' as const, name: 'forge', username: 'forge', password: 'pw' }

  it('generates a ts-backups config from the database', () => {
    const cfg = buildBackupsConfigTs(database, { enabled: true, retentionCount: 7 })
    expect(cfg).toContain("import type { BackupConfig } from 'ts-backups'")
    const config = readBackupConfig(cfg)
    expect(config.databases[0]).toMatchObject({ type: 'mysql', connection: { database: 'forge' } })
    expect(config.retention.count).toBe(7)
  })

  it('configures a native S3 destination (no aws-cli sync) when a bucket is set', () => {
    const cfg = buildBackupsConfigTs(database, {
      enabled: true,
      bucket: 'my-backups',
      endpoint: 'https://hel1.your-objectstorage.com',
    })
    expect(readBackupConfig(cfg).destinations).toEqual([expect.objectContaining({ type: 's3', bucket: 'my-backups', endpoint: 'https://hel1.your-objectstorage.com', optional: false })])
  })

  it('installs Bun + ts-backups and schedules a cron (native upload, no aws-cli)', () => {
    const script = buildBackupProvisionScript({
      database,
      backups: {
        enabled: true,
        bucket: 'my-backups',
        endpoint: 'https://hel1.your-objectstorage.com',
        schedule: '0 3 * * *',
      },
    }).join('\n')
    expect(script).toContain('https://github.com/stacksjs/ts-backups/releases/download/v0.1.6/ts-backups-0.1.6.tgz')
    expect(script).toContain('sha256sum --check --status')
    expect(script).toContain('bun add --cwd /opt/ts-cloud/backups --no-save /opt/ts-cloud/backups/release.tgz')
    expect(script).toContain('chmod 600 /etc/ts-cloud/backups.config.ts /etc/ts-cloud/backups.env')
    expect(script).toContain('ts-backups start --config /etc/ts-cloud/backups.config.ts')
    expect(script).not.toContain('aws s3 sync')
    expect(script).toContain('0 3 * * * root /usr/local/bin/ts-cloud-backup.sh')
  })

  it('is empty when disabled', () => {
    expect(buildBackupProvisionScript({ backups: { enabled: false } })).toEqual([])
  })
})
