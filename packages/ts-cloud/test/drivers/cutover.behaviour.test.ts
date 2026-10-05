import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { buildOnlyIfLiveGuard } from '../../src/drivers/shared/compute-ops'
import { buildZeroDowntimeCutover } from '../../src/drivers/shared/deploy-script'
import { buildRollbackPlanScript, buildRollbackScript, previousReleasePath, releasePaths } from '../../src/drivers/shared/releases'

/**
 * These run the zero-downtime cutover instead of asserting on its text.
 *
 * The rule under test is the one that matters to whoever is visiting the site
 * during a deploy: **a deploy never leaves the site with nothing serving it.**
 * The text of the old cutover looked careful and still did exactly that. A
 * wildloop API release that crashed on start was read as one that could not
 * share the port; the script stopped the previous release to make room,
 * retried, crashed again, and exited with neither running. Every `/api` route
 * answered 502 until somebody started the old instance by hand.
 *
 * The box is a temp dir. `systemctl`, `ss`, `curl`, `journalctl`, `sleep` and
 * `date` are shims on PATH that keep unit state in files, and each release is
 * given a behaviour:
 *
 * - `ok`              starts, binds the port with SO_REUSEPORT, answers.
 * - `crash`           dies on start, whatever else is running.
 * - `reuseport-less`  dies with EADDRINUSE while another release holds the
 *                     port, and is fine on a free one.
 * - `reuseport-less-then-crash`  the same, but also dies on a free port.
 * - `errors`          starts and binds, but its health path fails.
 * - `no-bind`         stays active and never listens.
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

type Behaviour = 'ok' | 'crash' | 'reuseport-less' | 'reuseport-less-then-crash' | 'errors' | 'no-bind'

const UNIT_BASE = 'acme-web'
const PORT = 3000

function shim(bin: string, name: string, body: string): void {
  const path = join(bin, name)
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

interface Box {
  dir: string
  base: string
  state: (unit: string) => string
  stopped: () => string[]
  current: () => string
  run: (releaseId: string, healthCheckPath?: string) => { code: number, stderr: string }
  exec: (lines: string[]) => { code: number, stdout: string, stderr: string }
}

function box(serving: Array<{ releaseId: string, behaviour: Behaviour }>, incoming: { releaseId: string, behaviour: Behaviour }): Box {
  const dir = mkdtempSync(join(tmpdir(), 'ts-cloud-cutover-'))
  dirs.push(dir)
  const base = join(dir, 'www')
  const units = join(dir, 'units')
  const bin = join(dir, 'bin')
  for (const d of [units, bin, join(dir, 'journal'), join(dir, 'behaviour')])
    mkdirSync(d, { recursive: true })

  for (const release of [...serving, incoming]) {
    mkdirSync(join(base, 'releases', release.releaseId), { recursive: true })
    writeFileSync(join(dir, 'behaviour', `${UNIT_BASE}@${release.releaseId}.service`), release.behaviour)
  }
  for (const release of serving)
    writeFileSync(join(units, `${UNIT_BASE}@${release.releaseId}.service`), 'active')
  if (serving.length > 0)
    symlinkSync(join(base, 'releases', serving[serving.length - 1].releaseId), join(base, 'current'))

  // State lives in files: units/<unit> holds active|inactive|failed.
  shim(bin, 'systemctl', `
U="$DIR/units"; B="$DIR/behaviour"; J="$DIR/journal"
others_bound() { for f in "$U"/*; do [ -e "$f" ] || continue; n=$(basename "$f"); [ "$n" = "$1" ] && continue; [ "$(cat "$f")" = active ] && [ "$(cat "$B/$n" 2>/dev/null)" != no-bind ] && return 0; done; return 1; }
start() {
  b=$(cat "$B/$1" 2>/dev/null || echo ok)
  case "$b" in
    crash) echo failed > "$U/$1"; echo "Error: Cannot find module './boot'" >> "$J/$1" ;;
    reuseport-less) if others_bound "$1"; then echo failed > "$U/$1"; echo "error: Failed to start server. Is port ${PORT} in use? EADDRINUSE" >> "$J/$1"; else echo active > "$U/$1"; fi ;;
    reuseport-less-then-crash) if others_bound "$1"; then echo failed > "$U/$1"; echo "EADDRINUSE: address already in use :${PORT}" >> "$J/$1"; else echo failed > "$U/$1"; echo "Error: boot failed" >> "$J/$1"; fi ;;
    *) echo active > "$U/$1" ;;
  esac
}
cmd="$1"; shift
case "$cmd" in
  is-active) [ "$1" = --quiet ] && shift; [ "$(cat "$U/$1" 2>/dev/null)" = active ] ;;
  restart|start) start "$1" ;;
  stop) [ -e "$U/$1" ] && echo inactive > "$U/$1"; echo "$1" >> "$DIR/stopped" ;;
  show) unit="\${@: -1}"; if [ "$(cat "$U/$unit" 2>/dev/null)" = active ]; then echo $(( $(printf '%s' "$unit" | cksum | cut -d' ' -f1) % 30000 + 1000 )); else echo 0; fi ;;
  list-units) for f in "$U"/*; do [ -e "$f" ] || continue; [ "$(cat "$f")" = active ] && echo "$(basename "$f") loaded active running"; done; true ;;
  *) true ;;
esac
`)
  // A listener is any active release that binds; ss prints a pid only with -p.
  shim(bin, 'ss', `
U="$DIR/units"; B="$DIR/behaviour"; withpid=0; case "$1" in *p*) withpid=1 ;; esac
for f in "$U"/*; do [ -e "$f" ] || continue; n=$(basename "$f")
  [ "$(cat "$f")" = active ] || continue; [ "$(cat "$B/$n" 2>/dev/null)" = no-bind ] && continue
  pid=$(( $(printf '%s' "$n" | cksum | cut -d' ' -f1) % 30000 + 1000 ))
  if [ $withpid = 1 ]; then echo "LISTEN 0 512 *:${PORT} *:* users:((\\"bun\\",pid=$pid,fd=12))"; else echo "LISTEN 0 512 *:${PORT} *:*"; fi
done; true
`)
  // During an overlap a request can land on either release, so it succeeds if
  // any listener is healthy: that is the hole gate 4 exists for.
  shim(bin, 'curl', `
U="$DIR/units"; B="$DIR/behaviour"
for f in "$U"/*; do [ -e "$f" ] || continue; n=$(basename "$f")
  [ "$(cat "$f")" = active ] || continue; b=$(cat "$B/$n" 2>/dev/null); [ "$b" = no-bind ] && continue
  [ "$b" != errors ] && exit 0
done; exit 22
`)
  shim(bin, 'journalctl', `
unit=""; while [ $# -gt 0 ]; do [ "$1" = -u ] && { unit="$2"; shift; }; shift; done
cat "$DIR/journal/$unit" 2>/dev/null; true
`)
  // The boxes are Ubuntu: GNU `mv -T` replaces a symlink rather than moving
  // into the directory it points at. BSD mv on a developer's Mac has no -T.
  shim(bin, 'mv', `
if [ "$1" = -Tf ] || [ "$1" = -fT ]; then rm -f "$3"; exec /bin/mv "$2" "$3"; fi
exec /bin/mv "$@"
`)
  shim(bin, 'sleep', 'true')
  shim(bin, 'date', 'echo 1000')

  const paths = (releaseId: string) => releasePaths(base, releaseId)
  return {
    dir,
    base,
    state: unit => (existsSync(join(units, unit)) ? readFileSync(join(units, unit), 'utf8').trim() : 'none'),
    stopped: () => (existsSync(join(dir, 'stopped')) ? readFileSync(join(dir, 'stopped'), 'utf8').trim().split('\n') : []),
    current: () => (existsSync(join(base, 'current')) ? readlinkSync(join(base, 'current')).split('/').pop() as string : 'none'),
    exec(lines) {
      const proc = Bun.spawnSync(['bash', '-c', ['set -uo pipefail', ...lines].join('\n')], {
        env: { ...process.env, DIR: dir, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
    },
    run(releaseId, healthCheckPath) {
      const script = ['set -euo pipefail', ...buildZeroDowntimeCutover({ paths: paths(releaseId), unitBase: UNIT_BASE, releaseId, port: PORT, healthCheckPath })].join('\n')
      const proc = Bun.spawnSync(['bash', '-c', script], {
        env: { ...process.env, DIR: dir, PATH: `${bin}:${process.env.PATH}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return { code: proc.exitCode ?? -1, stderr: proc.stderr.toString() }
    },
  }
}

const OLD = `${UNIT_BASE}@old111.service`
const NEW = `${UNIT_BASE}@new222.service`

describe('zero-downtime cutover, executed', () => {
  setDefaultTimeout(60_000)

  it('promotes a healthy release and retires the old one', () => {
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'ok' })
    const result = b.run('new222', '/health')
    expect(result.code).toBe(0)
    expect(b.state(NEW)).toBe('active')
    expect(b.state(OLD)).toBe('inactive')
    expect(b.current()).toBe('new222')
  })

  it('never stops the old release for a release that crashes on start', () => {
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'crash' })
    const result = b.run('new222', '/health')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('crashed on start — the previous release was never stopped')
    // The previous release served throughout: it was never stopped, not
    // stopped and started again.
    expect(b.stopped()).not.toContain(OLD)
    expect(b.state(OLD)).toBe('active')
    expect(b.state(NEW)).not.toBe('active')
    expect(b.current()).toBe('old111')
  })

  it('makes room for a release that could not share the port, and promotes it', () => {
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'reuseport-less' })
    const result = b.run('new222', '/health')
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('could not share :3000')
    expect(b.state(NEW)).toBe('active')
    expect(b.state(OLD)).toBe('inactive')
    expect(b.current()).toBe('new222')
  })

  it('puts the old release back when making room did not help', () => {
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'reuseport-less-then-crash' })
    const result = b.run('new222', '/health')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('previous release restored and serving')
    expect(b.state(OLD)).toBe('active')
    expect(b.state(NEW)).not.toBe('active')
    expect(b.current()).toBe('old111')
  })

  it('restores the old release when the new one fails its health path once it serves alone', () => {
    // During the overlap the old release answers the probe; only the second
    // probe, after the old one is retired, can see the new one's errors.
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'errors' })
    const result = b.run('new222', '/health')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('stopped answering /health once it served alone')
    expect(b.state(OLD)).toBe('active')
    expect(b.state(NEW)).toBe('inactive')
    expect(b.current()).toBe('old111')
  })

  it('keeps the old release when the new one never takes the port', () => {
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'no-bind' })
    const result = b.run('new222', '/health')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('never took :3000')
    expect(b.stopped()).not.toContain(OLD)
    expect(b.state(OLD)).toBe('active')
    expect(b.current()).toBe('old111')
  })

  it('without a health path, still restores when the new release cannot bind on a free port', () => {
    // No probe to lean on: the listen check after retirement is the last word.
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'no-bind' })
    const result = b.run('new222')
    expect(result.code).toBe(1)
    expect(b.state(OLD)).toBe('active')
    expect(b.current()).toBe('old111')
  })

  it('says so when a first deploy fails and there is nothing to restore', () => {
    const b = box([], { releaseId: 'new222', behaviour: 'crash' })
    const result = b.run('new222', '/health')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('there was no previous release to restore')
    expect(b.current()).toBe('none')
  })
})

describe('rollback, executed', () => {
  setDefaultTimeout(60_000)

  function deployed(next: Behaviour = 'ok') {
    const b = box([{ releaseId: 'old111', behaviour: 'ok' }], { releaseId: 'new222', behaviour: 'ok' })
    expect(b.run('new222', '/health').code).toBe(0)
    writeFileSync(join(b.dir, 'behaviour', OLD), next)
    // The unit template, where the rollback looks for it.
    mkdirSync(join(b.dir, 'systemd'), { recursive: true })
    writeFileSync(join(b.dir, 'systemd', `${UNIT_BASE}@.service`), '')
    return b
  }
  const rollback = (b: Box) => buildRollbackScript(releasePaths(b.base, 'unused'), { unitBase: UNIT_BASE, systemdDir: join(b.dir, 'systemd') })

  it('the deploy records exactly which release it replaced', () => {
    const b = deployed()
    expect(readFileSync(previousReleasePath(b.base), 'utf8').trim()).toBe('old111')
  })

  it('goes back to the recorded release, not to the most recently touched one', () => {
    const b = deployed()
    // An older release dir touched after the deploy: newest by mtime, wrong.
    mkdirSync(join(b.base, 'releases', 'zzz999'), { recursive: true })
    writeFileSync(join(b.dir, 'behaviour', `${UNIT_BASE}@zzz999.service`), 'ok')
    const result = b.exec(rollback(b))
    expect(result.code).toBe(0)
    expect(b.current()).toBe('old111')
    expect(b.state(OLD)).toBe('active')
    expect(b.state(NEW)).toBe('inactive')
    expect(existsSync(previousReleasePath(b.base))).toBe(false)
  })

  it('keeps the current release serving when the release rolled back to will not start', () => {
    const b = deployed('crash')
    const result = b.exec(rollback(b))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('did not stay up; the current release keeps serving')
    expect(b.current()).toBe('new222')
    expect(b.state(NEW)).toBe('active')
  })

  it('a dry run says where it would go and changes nothing', () => {
    const b = deployed()
    const result = b.exec(buildRollbackPlanScript(releasePaths(b.base, 'unused')))
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('would roll back from new222 to old111')
    expect(b.current()).toBe('new222')
    expect(b.state(NEW)).toBe('active')
    expect(b.state(OLD)).toBe('inactive')
  })

  it('--only-if-live rolls back the release this commit made live', () => {
    const b = deployed()
    const guard = buildOnlyIfLiveGuard(join(b.base, 'current'), 'web', 'new222f00dfeed')
    const result = b.exec([...guard, ...rollback(b)])
    expect(result.code).toBe(0)
    expect(b.current()).toBe('old111')
    expect(b.state(OLD)).toBe('active')
  })

  it('--only-if-live leaves alone a site this commit never switched', () => {
    const b = deployed()
    const guard = buildOnlyIfLiveGuard(join(b.base, 'current'), 'web', 'abc999f00dfeed')
    const result = b.exec([...guard, ...rollback(b)])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('web serves new222, not abc999f00dfeed; left alone')
    expect(b.current()).toBe('new222')
    expect(b.state(NEW)).toBe('active')
    expect(b.state(OLD)).toBe('inactive')
  })
})
