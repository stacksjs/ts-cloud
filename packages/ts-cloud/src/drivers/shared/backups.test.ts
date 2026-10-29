import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { buildBackupProvisionScript, buildBackupsConfigTs } from './backups'
it('keeps encrypted backup secrets root-only and generates valid shell and config', async () => {
  const password = "secret' with\nnewlines and $(printf should-not-run)"
  const backups = { enabled: true, version: '0.1.6', bucket: 'owned-backups', endpoint: 'https://fsn1.your-objectstorage.com', region: 'fsn1', encryptionKey: `${password} recovery key`, credentials: { accessKeyId: 'own-key', secretAccessKey: password }, files: [{ name: 'uploads', path: '/var/www/owned-shared/storage/app' }] }
  const database = { engine: 'postgres' as const, name: 'owned', username: 'owned', password }
  const code = buildBackupsConfigTs(database, backups)
  expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(code)).not.toThrow()
  expect(code).not.toContain(backups.encryptionKey)
  expect(code).not.toContain('own-key')
  expect(code).toContain('TS_CLOUD_BACKUP_ENCRYPTION_KEY')
  expect(code).toContain('"keepDays": 30')
  expect(code).toContain('"path": "/var/www/owned-shared/storage/app"')
  const script = buildBackupProvisionScript({ database, backups }).join('\n')
  expect(spawnSync('bash', ['-n'], { input: script }).status).toBe(0)
  expect(script).toContain('chmod 600 /etc/ts-cloud/backups.config.ts /etc/ts-cloud/backups.env')
  expect(script).toContain('flock -n 9')
  expect(script).toContain('ts-backups@0.1.6')
  expect(script).toContain('chmod 700 /var/backups/ts-cloud')
  expect(script).not.toContain('|| true\nbun')
})
it('fails before provisioning with incomplete secrets, unpinned tools or injected schedules', () => {
  for (const backups of [
    { enabled: true, encryptionKey: 'too short', bucket: 'owned' },
    { enabled: true, credentials: { accessKeyId: 'a', secretAccessKey: '' }, bucket: 'owned' },
    { enabled: true, version: 'latest' },
    { enabled: true, schedule: '* * * * *\nroot injected' },
  ]) expect(() => buildBackupProvisionScript({ backups })).toThrow()
  expect(buildBackupProvisionScript({ backups: { enabled: false } })).toEqual([])
})
