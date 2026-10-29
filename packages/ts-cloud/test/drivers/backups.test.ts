import { describe, expect, it } from 'bun:test'
import { buildBackupProvisionScript, buildBackupRestoreScript, buildBackupsConfigTs } from '../../src/drivers/shared/backups'
import { readBackupConfig } from './backup-config-fixture'

describe('buildBackupsConfigTs', () => {
  it('maps a mysql database + S3 destination', () => {
    const cfg = buildBackupsConfigTs(
      { engine: 'mysql', name: 'acme', username: 'acme', password: 'pw' },
      { enabled: true, bucket: 'acme-backups' },
    )
    const config = readBackupConfig(cfg)
    expect(config.databases[0]).toMatchObject({ type: 'mysql', name: 'acme', connection: { database: 'acme' } })
    expect(config.destinations[0]).toMatchObject({ type: 's3', bucket: 'acme-backups', optional: false })
  })
  it('verifies a published archive before installing its pinned version', () => {
    const archive = { url: 'https://github.com/stacksjs/ts-backups/releases/download/v0.1.6/ts-backups-0.1.6.tgz', sha256: 'a'.repeat(64) }
    const script = buildBackupProvisionScript({ backups: { enabled: true, version: '0.1.6', archive } }).join('\n')
    expect(script.indexOf('sha256sum --check --status')).toBeLessThan(script.indexOf('bun add'))
    expect(script).toContain(archive.sha256)
    expect(script).toContain('package.json").json()).version')
    for (const url of ['http://example.test/tool.tgz', 'https://user:secret@example.test/tool.tgz'])
      expect(() => buildBackupProvisionScript({ backups: { enabled: true, archive: { ...archive, url } } })).toThrow()
    expect(() => buildBackupProvisionScript({ backups: { enabled: true, archive: { ...archive, sha256: 'bad' } } })).toThrow()
  })
})

describe('buildBackupRestoreScript', () => {
  it('restores mysql from the newest matching dump over the root socket', () => {
    const s = buildBackupRestoreScript({ engine: 'mysql', name: 'acme' }).join('\n')
    expect(s).toContain('find /var/backups/ts-cloud')
    expect(s).toContain('*acme*.sql')
    expect(s).toContain('| mysql --socket=/var/lib/pantry/mysql/mysqld.sock -u root "acme"')
    expect(s).toContain('gunzip -c "$TS_CLOUD_DUMP"') // handles .gz
    expect(s).toContain('no backup dump found to restore')
  })

  it('uses the mariadb socket for mariadb', () => {
    expect(buildBackupRestoreScript({ engine: 'mariadb', name: 'app' }).join('\n')).toContain(
      'mysql --socket=/var/lib/pantry/mariadb/mariadbd.sock',
    )
  })

  it('restores postgres via psql over the local unix socket (pg_hba trust; TCP demands md5)', () => {
    const s = buildBackupRestoreScript({ engine: 'postgres', name: 'app' }).join('\n')
    expect(s).toContain('psql -p 5432 -U postgres -d "app"')
    expect(s).not.toContain('psql -h')
  })

  it('restores an external postgres host over TCP with credentials', () => {
    const s = buildBackupRestoreScript({
      engine: 'postgres',
      name: 'app',
      host: 'db.example.com',
      username: 'admin',
      password: 's3cret',
    }).join('\n')
    expect(s).toContain(`PGPASSWORD='s3cret' psql -h db.example.com -p 5432 -U admin -w -d "app"`)
  })

  it('restores a specific dump file when given', () => {
    const s = buildBackupRestoreScript(
      { engine: 'mysql', name: 'acme' },
      { from: '/var/backups/ts-cloud/acme_2024.sql' },
    ).join('\n')
    expect(s).toContain('TS_CLOUD_DUMP="/var/backups/ts-cloud/acme_2024.sql"')
    expect(s).not.toContain('find /var/backups')
  })

  it('emits nothing without a database name', () => {
    expect(buildBackupRestoreScript(undefined)).toEqual([])
    expect(buildBackupRestoreScript({ engine: 'mysql' })).toEqual([])
  })
})
