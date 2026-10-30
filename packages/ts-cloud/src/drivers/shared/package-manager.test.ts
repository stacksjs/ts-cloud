import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPantryInstallScript, PANTRY_PROJECT_DIR } from './package-manager'

it('repairs public package ancestors without changing private files or the caller umask', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantry-service-permissions-'))
  try {
    const project = join(root, 'project')
    const packagePath = join(project, 'pantry/github.com/mail-os/mail')
    mkdirSync(packagePath, { recursive: true, mode: 0o700 })
    const secret = join(project, 'private-key')
    writeFileSync(secret, 'private fixture', { mode: 0o600 })
    const pantry = join(root, 'pantry')
    writeFileSync(pantry, '#!/bin/sh\nmkdir -p pantry/github.com/mail-os/mail/v1/bin\nprintf executable > pantry/github.com/mail-os/mail/v1/bin/mail\n')
    chmodSync(pantry, 0o700)
    const script = buildPantryInstallScript(['github.com/mail-os/mail@1.0.0']).join('\n').replaceAll(PANTRY_PROJECT_DIR, project)
    const result = spawnSync('bash', ['-c', `umask 077\n${script}\numask`], { env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('0077')
    expect(statSync(packagePath).mode & 0o777).toBe(0o755)
    expect(statSync(join(packagePath, 'v1/bin')).mode & 0o777).toBe(0o755)
    expect(statSync(join(packagePath, 'v1/bin/mail')).mode & 0o777).toBe(0o644)
    expect(statSync(secret).mode & 0o777).toBe(0o600)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
