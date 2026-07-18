import { describe, expect, it } from 'bun:test'
import { buildBackupRestoreScript, buildBackupsConfigTs } from '../../src/drivers/shared/backups'

describe('buildBackupsConfigTs', () => {
  it('maps a mysql database + S3 destination', () => {
    const cfg = buildBackupsConfigTs(
      { engine: 'mysql', name: 'acme', username: 'acme', password: 'pw' },
      { enabled: true, bucket: 'acme-backups' },
    )
    expect(cfg).toContain("type: 'mysql'")
    expect(cfg).toContain("name: 'acme'")
    expect(cfg).toContain("bucket: 'acme-backups'")
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
    expect(buildBackupRestoreScript({ engine: 'mariadb', name: 'app' }).join('\n'))
      .toContain('mysql --socket=/var/lib/pantry/mariadb/mariadbd.sock')
  })

  it('restores postgres via psql over the local unix socket (pg_hba trust; TCP demands md5)', () => {
    const s = buildBackupRestoreScript({ engine: 'postgres', name: 'app' }).join('\n')
    expect(s).toContain('psql -p 5432 -U postgres -d "app"')
    expect(s).not.toContain('psql -h')
  })

  it('restores an external postgres host over TCP with credentials', () => {
    const s = buildBackupRestoreScript({ engine: 'postgres', name: 'app', host: 'db.example.com', username: 'admin', password: 's3cret' }).join('\n')
    expect(s).toContain(`PGPASSWORD='s3cret' psql -h db.example.com -p 5432 -U admin -w -d "app"`)
  })

  it('restores a specific dump file when given', () => {
    const s = buildBackupRestoreScript({ engine: 'mysql', name: 'acme' }, { from: '/var/backups/ts-cloud/acme_2024.sql' }).join('\n')
    expect(s).toContain('TS_CLOUD_DUMP="/var/backups/ts-cloud/acme_2024.sql"')
    expect(s).not.toContain('find /var/backups')
  })

  it('emits nothing without a database name', () => {
    expect(buildBackupRestoreScript(undefined)).toEqual([])
    expect(buildBackupRestoreScript({ engine: 'mysql' })).toEqual([])
  })
})
