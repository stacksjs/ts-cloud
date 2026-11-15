import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPantryInstallScript, PANTRY_PROJECT_DIR, PANTRY_REAL_BIN_FUNCTION } from './package-manager'

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

// Pantry replaced the `.bin` symlinks with launcher scripts. `readlink -f` on a
// launcher returns the launcher, so a package root derived from it was
// `/opt/pantry/pantry` and Vitess could not find mysqld after its next restart.
it('resolves the real binary behind a .bin entry, symlink or launcher script', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pantry-real-bin-')))
  try {
    const bin = join(root, 'pantry/.bin')
    const real = join(root, 'pantry/mysql.com/v8.0.43/bin/mysqld')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(root, 'pantry/mysql.com/v8.0.43/bin'), { recursive: true })
    writeFileSync(real, '\x7fELF binary', { mode: 0o755 })
    symlinkSync('../mysql.com/v8.0.43/bin/mysqld', join(bin, 'linked'))
    // Byte for byte what pantry 0.11.145 writes.
    writeFileSync(join(bin, 'launcher'), [
      '#!/bin/sh',
      's=$0',
      'while [ -h "$s" ]; do',
      '  l=$(readlink "$s")',
      '  case $l in',
      '    /*) s=$l ;;',
      '    *) case $s in */*) s=${s%/*}/$l ;; *) s=$l ;; esac ;;',
      '  esac',
      'done',
      'case $s in */*) d=${s%/*} ;; *) d=. ;; esac',
      'exec "$d/../mysql.com/v8.0.43/bin/mysqld" "$@"',
      '',
    ].join('\n'), { mode: 0o755 })
    writeFileSync(join(bin, 'other-script'), '#!/bin/sh\necho hello\n', { mode: 0o755 })

    const resolve = (name: string) => {
      const result = spawnSync('sh', ['-c', `set -e\n${PANTRY_REAL_BIN_FUNCTION.join('\n')}\nts_cloud_pantry_real "$1"`, 'sh', join(bin, name)], { encoding: 'utf8' })
      expect(result.status).toBe(0)
      return result.stdout.trim()
    }
    expect(resolve('linked')).toBe(real)
    expect(resolve('launcher')).toBe(real)
    // A script that is not a pantry launcher is left as it is.
    expect(resolve('other-script')).toBe(join(bin, 'other-script'))
    // GNU `readlink -f` echoes a path whose last component is missing; BSD
    // prints nothing. Either way it never names a real binary.
    expect(['', join(bin, 'missing')]).toContain(resolve('missing'))
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
