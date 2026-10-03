import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDiscardUploadScript,
  buildHostCleanupScript as buildHostCleanupScriptViaDeployScript,
  buildPublishUploadScript,
} from '../../src/drivers/shared/deploy-script'
import {
  buildHostCleanupDeployScript,
  buildHostCleanupExecutable,
  buildHostCleanupInstallScript,
  buildHostCleanupScript,
  DEFAULT_HOST_CLEANUP_RETENTION,
  HOST_ARTIFACT_CACHE_DIR,
  HOST_CLEANUP_SCRIPT_PATH,
  resolveHostCleanupConfig,
} from '../../src/drivers/shared/host-cleanup'

/** `bash -n`: the only check that sees a broken here-document or quoting. */
function bashParses(script: string): { ok: boolean, error: string } {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
  return { ok: result.status === 0, error: result.stderr }
}

function age(path: string, minutes: number): void {
  const when = new Date(Date.now() - minutes * 60_000)
  utimesSync(path, when, when)
}

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fake host under a temp root: every absolute path the cleanup touches is
 * rewritten into it, and `df`, `journalctl`, `docker`, `apt-get`, `systemctl`
 * and the notifier are stubs that log their arguments. The script text is
 * otherwise run exactly as generated.
 */
function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), 'ts-cloud-host-'))
  scratch.push(root)
  const bin = join(root, 'bin')
  for (const dir of ['bin', 'var/ts-cloud/staging', 'var/ts-cloud/artifacts', 'root/.bun/install/cache/pkg', 'tmp', 'etc/systemd/system', 'usr/local/bin', 'var/lib'])
    mkdirSync(join(root, dir), { recursive: true })
  const log = join(root, 'calls.log')
  const stub = (name: string, body = '') => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> ${log}\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  for (const name of ['journalctl', 'docker', 'apt-get', 'systemctl', 'ts-cloud-notify']) stub(name)
  const setDisk = (percent: number | string) =>
    stub('df', `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 100 ${percent} 0 ${percent}% /\\n'`)
  setDisk(60)

  const localize = (script: string) => script
    .replaceAll('/var/lib/ts-cloud', `${root}/var/lib/ts-cloud`)
    .replaceAll('/var/ts-cloud', `${root}/var/ts-cloud`)
    .replaceAll('/root/.bun', `${root}/root/.bun`)
    .replaceAll('find /tmp ', `find ${root}/tmp `)
    .replaceAll('/usr/local/bin/ts-cloud-notify', `${bin}/ts-cloud-notify`)
    .replaceAll('/usr/local/bin/ts-cloud-host-cleanup.sh', `${root}/usr/local/bin/ts-cloud-host-cleanup.sh`)
    .replaceAll('/etc/systemd/system', `${root}/etc/systemd/system`)

  const run = (lines: string[], strict = true) => {
    const script = `${strict ? 'set -euo pipefail\n' : ''}${localize(lines.join('\n'))}\n`
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '')
  const file = (relative: string, ageMinutes: number) => {
    const path = join(root, relative)
    writeFileSync(path, 'x')
    age(path, ageMinutes)
    return path
  }
  const summary = (stdout: string) => JSON.parse(stdout.split('\n').find(line => line.startsWith('[ts-cloud] host-cleanup {'))!.slice('[ts-cloud] host-cleanup '.length))
  return { root, run, calls, file, setDisk, summary, resetCalls: () => rmSync(log, { force: true }) }
}

const DAY = 24 * 60

/**
 * stacksjs/ts-cloud#194. Artifact retention used to live in the upload path,
 * which (1) never matched the `.tmp` names uploads are written under, so a
 * dropped transfer leaked forever, and (2) only ran on a cache miss.
 */
describe('host cleanup covers the release artifact cache (#194)', () => {
  const script = buildHostCleanupScript()

  it('prunes completed artifacts and stranded `.tmp` uploads', () => {
    expect(script).toContain(`find ${HOST_ARTIFACT_CACHE_DIR} -xdev -maxdepth 1 -type f -name "*.tar.gz" -mtime +"$TS_CLOUD_HC_ARTIFACT_DAYS" -delete 2>/dev/null || true`)
    expect(script).toContain(`find ${HOST_ARTIFACT_CACHE_DIR} -xdev -maxdepth 1 -type f -name ".*.tmp" -mmin +"$TS_CLOUD_HC_UPLOAD_MIN" -delete 2>/dev/null || true`)
    expect(script.join('\n')).toContain('TS_CLOUD_HC_ARTIFACT_DAYS=2 ')
    expect(script.join('\n')).toContain('TS_CLOUD_HC_UPLOAD_MIN=60 ')
  })

  it('is still exported from deploy-script for existing callers', () => {
    expect(buildHostCleanupScriptViaDeployScript()).toEqual(script)
  })

  it('never touches active or rollback releases', () => {
    expect(script.join('\n')).not.toContain('/var/www')
    expect(script.join('\n')).not.toContain('releases/')
  })

  it('parses as bash', () => {
    expect(bashParses(`set -euo pipefail\n${script.join('\n')}\n`)).toEqual({ ok: true, error: '' })
  })

  it('deletes old artifacts and orphans and keeps fresh ones and in-flight uploads', () => {
    const host = fakeHost()
    const oldArtifact = host.file(`var/ts-cloud/artifacts/${'a'.repeat(64)}.tar.gz`, 5 * DAY)
    const freshArtifact = host.file(`var/ts-cloud/artifacts/${'b'.repeat(64)}.tar.gz`, 60)
    const orphan = host.file(`var/ts-cloud/artifacts/.${'c'.repeat(64)}-nonce.tmp`, 120)
    const inFlight = host.file(`var/ts-cloud/artifacts/.${'d'.repeat(64)}-nonce.tmp`, 5)
    const unrelated = host.file('var/ts-cloud/artifacts/notes.txt', 30 * DAY)

    expect(host.run(script).status).toBe(0)
    expect(existsSync(oldArtifact)).toBe(false)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(freshArtifact)).toBe(true)
    expect(existsSync(inFlight)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })
})

describe('upload publish and discard scripts', () => {
  it('publishes without pruning: retention is the cleanup script\'s job', () => {
    const script = buildPublishUploadScript('/var/ts-cloud/artifacts/.x-n.tmp', '/var/ts-cloud/artifacts/x.tar.gz', '/var/ts-cloud/staging/web.tar.gz')
    expect(script).toContain(`chmod 600 '/var/ts-cloud/artifacts/.x-n.tmp'`)
    expect(script).toContain(`mv -f -- '/var/ts-cloud/artifacts/.x-n.tmp' '/var/ts-cloud/artifacts/x.tar.gz'`)
    expect(script.indexOf('chmod 600')).toBeLessThan(script.indexOf('mv -f'))
    expect(script).not.toContain('find ')
    expect(bashParses(script).ok).toBe(true)
  })

  it('discards a temp upload without ever failing', () => {
    const script = buildDiscardUploadScript(`/var/ts-cloud/artifacts/.it's.tmp`)
    expect(script).toBe(`rm -f -- '/var/ts-cloud/artifacts/.it'"'"'s.tmp' 2>/dev/null || true`)
    expect(bashParses(script).ok).toBe(true)
  })
})

describe('resolveHostCleanupConfig (#195)', () => {
  it('defaults to the windows ts-cloud always used, plus a daily timer and 50/85 thresholds', () => {
    const resolved = resolveHostCleanupConfig()
    expect(resolved.retention).toEqual({
      stagingMaxAgeMinutes: 60,
      artifactMaxAgeDays: 2,
      artifactUploadMaxAgeMinutes: 60,
      bunCacheMaxAgeDays: 7,
      journalMaxAgeDays: 14,
      journalMaxSizeMb: 512,
      containerImageMaxAgeHours: 168,
    })
    expect(resolved).toMatchObject({ enabled: true, timer: true, schedule: 'daily', paths: [] })
    expect(resolved.pressure).toEqual({
      lowWaterPercent: 50,
      highWaterPercent: 85,
      escalated: { ...DEFAULT_HOST_CLEANUP_RETENTION, artifactMaxAgeDays: 0, bunCacheMaxAgeDays: 1, journalMaxAgeDays: 3, journalMaxSizeMb: 256, containerImageMaxAgeHours: 24 },
    })
    expect(resolveHostCleanupConfig(true)).toEqual(resolved)
    expect(resolveHostCleanupConfig({})).toEqual(resolved)
  })

  it('takes per-field overrides and keeps the rest', () => {
    const resolved = resolveHostCleanupConfig({ retention: { bunCacheMaxAgeDays: 3, artifactMaxAgeDays: undefined }, schedule: 'hourly' })
    expect(resolved.retention.bunCacheMaxAgeDays).toBe(3)
    expect(resolved.retention.artifactMaxAgeDays).toBe(2)
    expect(resolved.schedule).toBe('hourly')
  })

  it('never lets escalation loosen a window', () => {
    const resolved = resolveHostCleanupConfig({
      retention: { containerImageMaxAgeHours: 12 },
      pressure: { escalated: { artifactMaxAgeDays: 5 } },
    })
    expect(resolved.pressure!.escalated.containerImageMaxAgeHours).toBe(12)
    expect(resolved.pressure!.escalated.artifactMaxAgeDays).toBe(2)
  })

  it('turns off: `false` disables everything, `timer: false` only the timer, `pressure: false` the tiers', () => {
    expect(resolveHostCleanupConfig(false)).toMatchObject({ enabled: false, timer: false })
    expect(resolveHostCleanupConfig({ timer: false })).toMatchObject({ enabled: true, timer: false })
    expect(resolveHostCleanupConfig({ pressure: false }).pressure).toBeNull()
  })

  it.each([
    [{ retention: { stagingMaxAgeMinutes: 5 } }, 'stagingMaxAgeMinutes'],
    [{ retention: { artifactUploadMaxAgeMinutes: 1 } }, 'artifactUploadMaxAgeMinutes'],
    [{ retention: { bunCacheMaxAgeDays: 1.5 } }, 'bunCacheMaxAgeDays'],
    [{ retention: { artifactMaxAgeDays: -1 } }, 'artifactMaxAgeDays'],
    [{ pressure: { escalated: { stagingMaxAgeMinutes: 10 } } }, 'stagingMaxAgeMinutes'],
    [{ pressure: { lowWaterPercent: 90, highWaterPercent: 80 } }, 'lowWaterPercent < highWaterPercent'],
    [{ pressure: { highWaterPercent: 120 } }, 'highWaterPercent'],
    [{ schedule: 'daily\nExecStart=/bin/evil' }, 'OnCalendar'],
    [{ paths: [{ path: 'relative', pattern: 'x-*', maxAgeDays: 1 }] }, 'absolute'],
    [{ paths: [{ path: '/', pattern: 'x-*', maxAgeDays: 1 }] }, 'absolute'],
    [{ paths: [{ path: '/root/../etc', pattern: 'x-*', maxAgeDays: 1 }] }, '..'],
    [{ paths: [{ path: '/var/www/app', pattern: 'x-*', maxAgeDays: 1 }] }, 'keepReleases'],
    [{ paths: [{ path: '/root', pattern: '*', maxAgeDays: 1 }] }, 'bare wildcard'],
    [{ paths: [{ path: '/root', pattern: 'a/b', maxAgeDays: 1 }] }, 'glob'],
  ] as const)('rejects %j', (config, message) => {
    expect(() => resolveHostCleanupConfig(config as any)).toThrow(message)
  })
})

describe('the cleanup script under disk pressure (#195)', () => {
  it('below the low-water mark runs only the cheap rules', () => {
    const host = fakeHost()
    host.setDisk(30)
    const oldBun = host.file('root/.bun/install/cache/pkg/old.tgz', 30 * DAY)
    const oldArtifact = host.file(`var/ts-cloud/artifacts/${'a'.repeat(64)}.tar.gz`, 5 * DAY)

    const result = host.run(buildHostCleanupScript())
    expect(result.status).toBe(0)
    expect(host.summary(result.stdout)).toEqual({ event: 'host-cleanup', tier: 'light', diskBeforePercent: 30, diskAfterPercent: 30, lowWaterPercent: 50, highWaterPercent: 85 })
    expect(existsSync(oldArtifact)).toBe(false)
    expect(existsSync(oldBun)).toBe(true)
    expect(host.calls()).toContain('journalctl --vacuum-time=14d --vacuum-size=512M')
    expect(host.calls()).not.toContain('docker')
    expect(host.calls()).not.toContain('apt-get')
  })

  it('between the marks runs every rule with the normal windows', () => {
    const host = fakeHost()
    host.setDisk(60)
    const oldBun = host.file('root/.bun/install/cache/pkg/old.tgz', 30 * DAY)
    const recentArtifact = host.file(`var/ts-cloud/artifacts/${'a'.repeat(64)}.tar.gz`, 1.5 * DAY)

    const result = host.run(buildHostCleanupScript())
    expect(host.summary(result.stdout).tier).toBe('normal')
    expect(existsSync(oldBun)).toBe(false)
    expect(existsSync(recentArtifact)).toBe(true)
    expect(host.calls()).toContain('docker image prune --all --force --filter until=168h')
    expect(host.calls()).toContain('apt-get clean')
    expect(result.stderr).not.toContain('warning')
  })

  it('at the high-water mark escalates, warns, and notifies once per transition', () => {
    const host = fakeHost()
    host.setDisk(91)
    const recentArtifact = host.file(`var/ts-cloud/artifacts/${'a'.repeat(64)}.tar.gz`, 1.5 * DAY)
    const inFlight = host.file(`var/ts-cloud/artifacts/.${'b'.repeat(64)}-n.tmp`, 30)

    const first = host.run(buildHostCleanupScript())
    expect(first.status).toBe(0)
    expect(host.summary(first.stdout)).toMatchObject({ tier: 'pressure', diskBeforePercent: 91 })
    expect(first.stderr).toContain('/ at 91% (at or above 85%), host cleanup is using shortened retention windows')
    expect(first.stderr).toContain('/ still at 91% after host cleanup')
    expect(existsSync(recentArtifact)).toBe(false)
    // In-flight bounds are never shortened by pressure.
    expect(existsSync(inFlight)).toBe(true)
    expect(host.calls()).toContain('docker image prune --all --force --filter until=24h')
    expect(host.calls()).toContain('journalctl --vacuum-time=3d --vacuum-size=256M')
    expect(host.calls().match(/ts-cloud-notify/g)).toHaveLength(1)

    host.resetCalls()
    host.run(buildHostCleanupScript())
    expect(host.calls()).not.toContain('ts-cloud-notify')

    host.setDisk(40)
    host.resetCalls()
    host.run(buildHostCleanupScript())
    expect(host.calls()).toContain('ts-cloud-notify ✅')
  })

  it('treats unreadable usage as normal rather than skipping or escalating', () => {
    const host = fakeHost()
    host.setDisk('garbage')
    const result = host.run(buildHostCleanupScript())
    expect(result.status).toBe(0)
    expect(host.summary(result.stdout)).toMatchObject({ tier: 'normal', diskBeforePercent: -1 })
  })

  it('with `pressure: false` runs every rule regardless of usage, as before', () => {
    const host = fakeHost()
    host.setDisk(10)
    const script = buildHostCleanupScript({ pressure: false })
    expect(script.join('\n')).not.toContain('TS_CLOUD_HC_TIER')
    expect(host.run(script).status).toBe(0)
    expect(host.calls()).toContain('docker image prune --all --force --filter until=168h')
  })

  it('honours configured windows', () => {
    const script = buildHostCleanupScript({ retention: { artifactMaxAgeDays: 1, journalMaxSizeMb: 128 } }).join('\n')
    expect(script).toContain('TS_CLOUD_HC_ARTIFACT_DAYS=1 ')
    expect(script).toContain('TS_CLOUD_HC_JOURNAL_MB=128 ')
  })

  it('prunes registered paths: matching files or directories, old enough, nothing else', () => {
    const host = fakeHost()
    mkdirSync(join(host.root, 'backups/rpx-rollback-1'), { recursive: true })
    mkdirSync(join(host.root, 'backups/rpx-rollback-2'), { recursive: true })
    mkdirSync(join(host.root, 'backups/keep-me'), { recursive: true })
    age(join(host.root, 'backups/rpx-rollback-1'), 20 * DAY)
    age(join(host.root, 'backups/keep-me'), 20 * DAY)
    const oldDump = host.file('backups/cert-backup-old.tar', 20 * DAY)
    const newDump = host.file('backups/cert-backup-new.tar', DAY)

    const script = buildHostCleanupScript({
      paths: [
        { path: join(host.root, 'backups'), pattern: 'rpx-rollback-*', maxAgeDays: 14, type: 'directory' },
        { path: `${join(host.root, 'backups')}/`, pattern: 'cert-backup-*', maxAgeDays: 14 },
      ],
    })
    expect(bashParses(script.join('\n')).ok).toBe(true)
    expect(host.run(script).status).toBe(0)
    expect(existsSync(join(host.root, 'backups/rpx-rollback-1'))).toBe(false)
    expect(existsSync(join(host.root, 'backups/rpx-rollback-2'))).toBe(true)
    expect(existsSync(join(host.root, 'backups/keep-me'))).toBe(true)
    expect(existsSync(oldDump)).toBe(false)
    expect(existsSync(newDump)).toBe(true)
  })
})

describe('the installed cleanup and its timer (#195)', () => {
  it.each([
    ['defaults', undefined],
    ['timer off', { timer: false }],
    ['pressure off', { pressure: false }],
    ['disabled', false],
    ['with paths', { paths: [{ path: '/root', pattern: 'cert-backup-*', maxAgeDays: 14 }] }],
  ] as const)('every generated script parses as bash (%s)', (_name, config) => {
    for (const lines of [
      buildHostCleanupScript(config as any),
      buildHostCleanupExecutable(config as any),
      buildHostCleanupInstallScript(config as any),
      buildHostCleanupDeployScript(config as any),
    ])
      expect(bashParses(`set -euo pipefail\n${lines.join('\n')}\n`)).toEqual({ ok: true, error: '' })
  })

  it('embeds the executable verbatim in the install here-document', () => {
    const install = buildHostCleanupInstallScript().join('\n')
    const body = install.split(`<<'TS_CLOUD_HOST_CLEANUP_EOF' || true\n`)[1].split('\nTS_CLOUD_HOST_CLEANUP_EOF\n')[0]
    expect(body).toBe(buildHostCleanupExecutable().join('\n'))
  })

  it('renders a daily timer and a low-priority oneshot service', () => {
    const install = buildHostCleanupInstallScript().join('\n')
    expect(install).toContain('OnCalendar=daily')
    expect(install).toContain('Persistent=true')
    expect(install).toContain(`ExecStart=${HOST_CLEANUP_SCRIPT_PATH}`)
    expect(install).toContain('Type=oneshot')
    expect(install).toContain('IOSchedulingClass=idle')
    expect(install).toContain('systemctl enable --now ts-cloud-host-cleanup.timer')
    expect(buildHostCleanupInstallScript({ schedule: '*-*-* 03:30:00' }).join('\n')).toContain('OnCalendar=*-*-* 03:30:00')
  })

  it('installs idempotently: an unchanged second run rewrites nothing and reloads nothing', () => {
    const host = fakeHost()
    const install = buildHostCleanupInstallScript()

    expect(host.run(install).status).toBe(0)
    expect(host.calls()).toContain('systemctl daemon-reload')
    expect(host.calls()).toContain('systemctl enable --now ts-cloud-host-cleanup.timer')
    const timer = join(host.root, 'etc/systemd/system/ts-cloud-host-cleanup.timer')
    const executable = join(host.root, 'usr/local/bin/ts-cloud-host-cleanup.sh')
    expect(readFileSync(timer, 'utf8')).toContain('OnCalendar=daily')
    const before = [timer, executable].map(path => readFileSync(path, 'utf8'))

    host.resetCalls()
    expect(host.run(install).status).toBe(0)
    expect(host.calls()).not.toContain('daemon-reload')
    expect([timer, executable].map(path => readFileSync(path, 'utf8'))).toEqual(before)

    // A config change rewrites the unit and reloads.
    host.resetCalls()
    host.run(buildHostCleanupInstallScript({ schedule: 'hourly' }))
    expect(readFileSync(timer, 'utf8')).toContain('OnCalendar=hourly')
    expect(host.calls()).toContain('systemctl daemon-reload')
  })

  it('removes the timer when it is turned off, and everything when cleanup is', () => {
    const host = fakeHost()
    host.run(buildHostCleanupInstallScript())
    const timer = join(host.root, 'etc/systemd/system/ts-cloud-host-cleanup.timer')
    const executable = join(host.root, 'usr/local/bin/ts-cloud-host-cleanup.sh')

    host.resetCalls()
    host.run(buildHostCleanupInstallScript({ timer: false }))
    expect(existsSync(timer)).toBe(false)
    expect(existsSync(executable)).toBe(true)
    expect(host.calls()).toContain('systemctl disable --now ts-cloud-host-cleanup.timer')

    host.run(buildHostCleanupInstallScript())
    host.run(buildHostCleanupInstallScript(false))
    expect(existsSync(timer)).toBe(false)
    expect(existsSync(executable)).toBe(false)
  })

  it('a deploy installs, then runs the installed script once', () => {
    const host = fakeHost()
    const orphan = host.file(`var/ts-cloud/artifacts/.${'c'.repeat(64)}-nonce.tmp`, 120)
    const result = host.run(buildHostCleanupDeployScript())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[ts-cloud] host-cleanup {')
    expect(existsSync(orphan)).toBe(false)
    expect(buildHostCleanupDeployScript(false).join('\n')).not.toContain(`then ${HOST_CLEANUP_SCRIPT_PATH}`)
  })

  it('the installed script skips rather than waits when another run holds the lock', () => {
    if (spawnSync('bash', ['-c', 'command -v flock']).status !== 0) return
    const host = fakeHost()
    host.run(buildHostCleanupInstallScript())
    const lock = existsSync('/run/lock') ? '/run/lock/ts-cloud-host-cleanup.lock' : '/tmp/ts-cloud-host-cleanup.lock'
    const result = spawnSync('flock', [lock, join(host.root, 'usr/local/bin/ts-cloud-host-cleanup.sh')], { encoding: 'utf8' })
    expect(result.stdout).toContain('host cleanup already running; skipping')
  })
})
