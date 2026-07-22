import { describe, expect, it } from 'bun:test'
import { buildUfwScript, UFW_BASE_PORTS } from '../../src/drivers/shared/ufw'
import { buildAutoUpdatesScript } from '../../src/drivers/shared/maintenance'
import { buildMonitoringScript } from '../../src/drivers/shared/monitoring'
import { buildBackupProvisionScript, buildBackupsConfigTs } from '../../src/drivers/shared/backups'

describe('buildUfwScript', () => {
  it('allows SSH + 80/443 and extra ports, then enables', () => {
    const script = buildUfwScript({ allowedPorts: [8080] }).join('\n')
    expect(script).toContain('ufw allow OpenSSH')
    expect(script).toContain('ufw allow 80/tcp')
    expect(script).toContain('ufw allow 443/tcp')
    expect(script).toContain('ufw allow 8080/tcp')
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
})

describe('buildMonitoringScript', () => {
  it('installs a metrics collector + minute timer', () => {
    const script = buildMonitoringScript(true).join('\n')
    expect(script).toContain('/usr/local/bin/ts-cloud-metrics.sh')
    expect(script).toContain('ts-cloud-metrics.timer')
    expect(script).toContain('OnUnitActiveSec=60')
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
    expect(cfg).toContain("type: 'mysql'")
    expect(cfg).toContain("database: 'forge'")
    expect(cfg).toContain('count: 7')
  })

  it('configures a native S3 destination (no aws-cli sync) when a bucket is set', () => {
    const cfg = buildBackupsConfigTs(database, {
      enabled: true,
      bucket: 'my-backups',
      endpoint: 'https://hel1.your-objectstorage.com',
    })
    expect(cfg).toContain('destinations: [')
    expect(cfg).toContain("type: 's3'")
    expect(cfg).toContain("bucket: 'my-backups'")
    expect(cfg).toContain("endpoint: 'https://hel1.your-objectstorage.com'")
    expect(cfg).toContain('optional: false')
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
    expect(script).toContain('bun.sh/install')
    expect(script).toContain('bun add -g ts-backups')
    expect(script).toContain('ts-backups backup --config')
    expect(script).not.toContain('aws s3 sync')
    expect(script).toContain('0 3 * * * root /usr/local/bin/ts-cloud-backup.sh')
  })

  it('is empty when disabled', () => {
    expect(buildBackupProvisionScript({ backups: { enabled: false } })).toEqual([])
  })
})
