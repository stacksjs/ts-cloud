import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBoxSandboxConvergeScript, renderUsernsProfile } from './box-converge'

const box = {
  name: 'runner',
  size: 'cx43',
  resize: { whenUnavailable: 'keep-current' as const },
  packages: ['google.com/chrome@155.0.8059.84'],
  sandboxedPackageProjects: ['/tmp/reviewos-job-*'],
  user: { name: 'runner' },
  services: { runner: { exec: '%h/runner' } },
}
const previous = renderUsernsProfile('ts-cloud-pantry-chrome', '/opt/pantry/pantry/google.com/chrome/*/lib/chrome-for-testing/chrome')

// Run the actual generated bash against real owned files. Only identity,
// ownership installation and kernel loading are substituted; no /etc access.
function fixture(run: (state: ReturnType<typeof context>) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-sandbox-policy-'))
  try { run(context(directory)) }
  finally { rmSync(directory, { recursive: true, force: true }) }
}

function context(directory: string) {
  const profiles = join(directory, 'profiles')
  const bin = join(directory, 'bin')
  mkdirSync(profiles, { mode: 0o700 })
  mkdirSync(bin)
  const target = join(profiles, 'ts-cloud-pantry-chrome')
  writeFileSync(target, previous, { mode: 0o644 })
  writeFileSync(join(directory, 'loaded'), previous)
  writeFileSync(join(directory, 'profile-state'), 'ts-cloud-pantry-chrome (unconfined)\n')
  const stub = `#!/usr/bin/python3
import os,sys,pathlib,shutil,stat,json
root=pathlib.Path(os.environ['TEST_POLICY_ROOT'])
name=pathlib.Path(sys.argv[0]).name
if name=='id': print(os.environ.get('TEST_UID','0')); sys.exit(0)
if name=='stat':
 fmt=sys.argv[2]; path=pathlib.Path(sys.argv[3])
 if fmt=='%u': print(os.environ.get('TEST_OWNER','0'))
 elif fmt=='%u:%g': print('0:0')
 elif fmt=='%a': print(oct(stat.S_IMODE(path.stat().st_mode))[2:])
 else: sys.exit(4)
 sys.exit(0)
if name=='cat':
 if os.environ.get('TEST_STATE_READ_FAIL')=='partial':
  sys.stdout.write('unrelated (unconfined)\\n'); sys.exit(7)
 os.execv('/bin/cat',sys.argv)
if name=='install':
 if os.environ.get('TEST_INSTALL_FAIL')=='1': sys.exit(5)
 source,target=map(pathlib.Path,sys.argv[-2:])
 assert source.resolve().is_relative_to(root.resolve()) and target.parent.resolve().is_relative_to(root.resolve())
 shutil.copyfile(source,target); target.chmod(int(sys.argv[2],8)); sys.exit(0)
if name=='apparmor_parser':
 if '-K' not in sys.argv or not any(arg in sys.argv for arg in ['-Q','-r','-R']): sys.exit(8)
 operation='validate' if '-Q' in sys.argv else ('remove' if '-R' in sys.argv else 'reload')
 with (root/'calls').open('a') as out: out.write(operation+'\\n')
 if operation=='validate': sys.exit(1 if os.environ.get('TEST_VALIDATE_FAIL')=='1' else 0)
 if operation=='remove': (root/'loaded').unlink(missing_ok=True); sys.exit(0)
 fail=os.environ.get('TEST_RELOAD_FAIL')
 if fail=='always' or (fail=='once' and not (root/'failed-once').exists()):
  (root/'failed-once').touch(); sys.exit(1)
 shutil.copyfile(sys.argv[-1],root/'loaded'); sys.exit(0)
sys.exit(9)
`
  for (const name of ['id', 'stat', 'install', 'apparmor_parser', 'cat']) {
    writeFileSync(join(bin, name), stub)
    chmodSync(join(bin, name), 0o755)
  }
  return {
    directory, profiles, target,
    execute: (environment: Record<string, string> = {}, enabled = true) => {
      const script = buildBoxSandboxConvergeScript({ ...box, sandboxedPackageProjects: enabled ? box.sandboxedPackageProjects : [] })
        .replace('PROFILE_DIR=/etc/apparmor.d', `PROFILE_DIR='${profiles}'`)
        .replace('PROFILE_STATE=/sys/kernel/security/apparmor/profiles', `PROFILE_STATE='${join(directory, 'profile-state')}'`)
      return Bun.spawnSync(['bash', '-s'], {
        stdin: new TextEncoder().encode(script),
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: directory, TEST_POLICY_ROOT: directory, ...environment },
      })
    },
    calls: () => existsSync(join(directory, 'calls')) ? readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n') : [],
    retained: () => readdirSync(profiles).filter(name => name.startsWith('.ts-cloud-sandbox.')),
    loaded: () => readFileSync(join(directory, 'loaded'), 'utf8'),
  }
}

describe('policy-only sandbox convergence', () => {
  test('has no provisioning, package, account or service operations', () => {
    const script = buildBoxSandboxConvergeScript(box)
    for (const forbidden of ['curl', 'apt-get', 'PANTRY=', 'WANTED_PACKAGES', 'systemctl', 'useradd', 'usermod', 'loginctl', '/etc/rpx', 'resize', 'scp', 'ssh ']) expect(script).not.toContain(forbidden)
    expect(Bun.spawnSync(['bash', '-n'], { stdin: new TextEncoder().encode(script) }).exitCode).toBe(0)
    expect(buildBoxSandboxConvergeScript({ ...box, packages: [], sandboxedPackageProjects: [] })).not.toContain('apparmor_parser')
  })

  test('keeps identical file bytes, reloads desired policy and reconciles opt-out', () => fixture(f => {
    expect(f.execute().exitCode).toBe(0)
    expect(readFileSync(f.target, 'utf8')).toContain('profile ts-cloud-pantry-chrome /{opt/pantry/pantry/google.com/chrome/*/lib/chrome-for-testing/chrome,tmp/reviewos-job-*/pantry/google.com/chrome/*/lib/chrome-for-testing/chrome} flags=(unconfined) {')
    expect(f.loaded()).toBe(readFileSync(f.target, 'utf8'))
    expect(f.calls()).toEqual(['validate', 'reload'])
    expect(f.execute().exitCode).toBe(0)
    expect(f.calls()).toEqual(['validate', 'reload', 'validate', 'reload'])
    expect(f.execute({}, false).exitCode).toBe(0)
    expect(readFileSync(f.target, 'utf8')).toBe(previous)
    expect(f.loaded()).toBe(previous)
    expect(f.retained()).toEqual([])
  }))

  test('reconciles stale or missing loaded state even when the file is unchanged', () => fixture(f => {
    expect(f.execute().exitCode).toBe(0)
    const wanted = readFileSync(f.target, 'utf8')
    writeFileSync(join(f.directory, 'loaded'), previous)
    expect(f.execute().exitCode).toBe(0)
    expect(f.loaded()).toBe(wanted)
    rmSync(join(f.directory, 'loaded'))
    expect(f.execute().exitCode).toBe(0)
    expect(f.loaded()).toBe(wanted)
    expect(f.calls()).toEqual(['validate', 'reload', 'validate', 'reload', 'validate', 'reload'])
  }))

  test('refuses an orphaned loaded profile without an on-disk recovery definition', () => fixture(f => {
    rmSync(f.target)
    expect(f.execute().exitCode).not.toBe(0)
    expect(f.loaded()).toBe(previous)
    expect(f.calls()).toEqual([])
    expect(f.retained()).toEqual([])
  }))

  test('refuses a first installation when the loaded state cannot be inspected', () => fixture(f => {
    rmSync(f.target)
    rmSync(join(f.directory, 'profile-state'))
    expect(f.execute().exitCode).not.toBe(0)
    expect(f.calls()).toEqual([])
    expect(f.retained()).toEqual([])
  }))

  test('refuses a readable state stream whose actual read fails', () => fixture(f => {
    rmSync(f.target)
    rmSync(join(f.directory, 'profile-state'))
    mkdirSync(join(f.directory, 'profile-state'))
    expect(f.execute().exitCode).not.toBe(0)
    expect(existsSync(f.target)).toBe(false)
    expect(f.loaded()).toBe(previous)
    expect(f.calls()).toEqual([])
    expect(f.retained()).toEqual([])
  }))

  test('never uses a partial state snapshot after its reader reports failure', () => fixture(f => {
    rmSync(f.target)
    writeFileSync(join(f.directory, 'profile-state'), '')
    expect(f.execute({ TEST_STATE_READ_FAIL: 'partial' }).exitCode).not.toBe(0)
    expect(existsSync(f.target)).toBe(false)
    expect(f.calls()).toEqual([])
    expect(f.retained()).toEqual([])
  }))

  test('a rejected candidate leaves the old file and loaded policy intact', () => fixture(f => {
    expect(f.execute({ TEST_VALIDATE_FAIL: '1' }).exitCode).not.toBe(0)
    expect(readFileSync(f.target, 'utf8')).toBe(previous)
    expect(f.loaded()).toBe(previous)
    expect(f.calls()).toEqual(['validate'])
    expect(f.retained()).toEqual([])
  }))

  test('restores the previous file and loaded policy after a reload failure', () => fixture(f => {
    expect(f.execute({ TEST_RELOAD_FAIL: 'once' }).exitCode).not.toBe(0)
    expect(readFileSync(f.target, 'utf8')).toBe(previous)
    expect(f.loaded()).toBe(previous)
    expect(f.calls()).toEqual(['validate', 'reload', 'reload'])
    expect(f.retained()).toEqual([])
  }))

  test('rollback preserves the prior policy file permissions', () => fixture(f => {
    chmodSync(f.target, 0o600)
    expect(f.execute({ TEST_RELOAD_FAIL: 'once' }).exitCode).not.toBe(0)
    expect(readFileSync(f.target, 'utf8')).toBe(previous)
    expect(statSync(f.target).mode & 0o777).toBe(0o600)
    expect(f.retained()).toEqual([])
  }))

  test('retains a recovery copy when rollback cannot reload the previous policy', () => fixture(f => {
    expect(f.execute({ TEST_RELOAD_FAIL: 'always' }).exitCode).not.toBe(0)
    expect(f.retained()).toHaveLength(1)
    expect(readFileSync(join(f.profiles, f.retained()[0]!, 'previous'), 'utf8')).toBe(previous)
  }))

  test('a failed first load removes only the newly introduced policy', () => fixture(f => {
    rmSync(f.target)
    rmSync(join(f.directory, 'loaded'))
    writeFileSync(join(f.directory, 'profile-state'), '')
    expect(f.execute({ TEST_RELOAD_FAIL: 'once' }).exitCode).not.toBe(0)
    expect(existsSync(f.target)).toBe(false)
    expect(existsSync(join(f.directory, 'loaded'))).toBe(false)
    expect(f.calls()).toEqual(['validate', 'reload', 'remove'])
    expect(f.retained()).toEqual([])
  }))

  test('an installation failure preserves the original file and recovery copy', () => fixture(f => {
    expect(f.execute({ TEST_INSTALL_FAIL: '1' }).exitCode).not.toBe(0)
    expect(readFileSync(f.target, 'utf8')).toBe(previous)
    expect(f.loaded()).toBe(previous)
    expect(f.retained()).toHaveLength(1)
  }))

  test('rejects a writable or non-root-owned policy directory before any write', () => fixture(f => {
    expect(f.execute({ TEST_OWNER: '1000' }).exitCode).not.toBe(0)
    chmodSync(f.profiles, 0o777)
    expect(f.execute().exitCode).not.toBe(0)
    expect(f.calls()).toEqual([])
    expect(readFileSync(f.target, 'utf8')).toBe(previous)
    expect(f.retained()).toEqual([])
  }))

  test('rejects non-root execution and writable existing profiles before loading', () => fixture(f => {
    expect(f.execute({ TEST_UID: '1000' }).exitCode).not.toBe(0)
    chmodSync(f.target, 0o666)
    expect(f.execute().exitCode).not.toBe(0)
    expect(f.calls()).toEqual([])
    expect(readFileSync(f.target, 'utf8')).toBe(previous)
  }))

  test('refuses a symlink target without changing its destination', () => fixture(f => {
    const other = join(f.directory, 'unrelated')
    writeFileSync(other, 'unrelated')
    rmSync(f.target)
    symlinkSync(other, f.target)
    expect(f.execute().exitCode).not.toBe(0)
    expect(readFileSync(other, 'utf8')).toBe('unrelated')
    expect(f.calls()).toEqual([])
    expect(f.retained()).toEqual([])
  }))
})
