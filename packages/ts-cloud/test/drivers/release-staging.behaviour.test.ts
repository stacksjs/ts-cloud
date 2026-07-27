import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { buildIsReleaseLive, buildPromoteStagedRelease, buildResetReleaseDir, buildStrandedReleaseTrap, releasePaths } from '../../src/drivers/shared/releases'

/**
 * These run the emitted shell instead of asserting on its text.
 *
 * The string assertions elsewhere in this suite passed against a version of
 * `buildResetReleaseDir` that deleted the live release: it compared a
 * `readlink -f`'d `current` against the *literal* release path, and on any
 * machine where an ancestor is a symlink (macOS `/tmp` → `/private/tmp`, or a
 * `/var/www` moved onto a data volume) the two spellings differ, so the guard
 * missed and the else-branch wiped the directory the site was served from.
 * Only executing it catches that.
 */
const dirs: string[] = []

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ts-cloud-release-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

/** Run a deploy's stage-extract-promote sequence against a real directory. */
async function stageRelease(base: string, releaseId: string, contents: string): Promise<{ live: string, staged: string }> {
  const paths = releasePaths(base, releaseId)

  const script = [
    'set -euo pipefail',
    ...buildResetReleaseDir(paths),
    'echo "$TS_CLOUD_STAGED" > /dev/null',
    `printf '%s' ${JSON.stringify(contents)} > "$TS_CLOUD_STAGED/marker.txt"`,
    // What the live tree looks like while the new one is being written.
    `cat ${paths.current}/marker.txt > ${base}/during.txt 2>/dev/null || printf '<missing>' > ${base}/during.txt`,
    ...buildPromoteStagedRelease(paths),
    'printf %s "$TS_CLOUD_STAGED" > ' + `${base}/staged.txt`,
  ].join('\n')

  const proc = Bun.spawnSync(['bash', '-c', script], { stderr: 'pipe', stdout: 'pipe' })
  if (proc.exitCode !== 0)
    throw new Error(`script failed: ${proc.stderr.toString()}`)

  return {
    live: readFileSync(join(base, 'during.txt'), 'utf8'),
    staged: readFileSync(join(base, 'staged.txt'), 'utf8'),
  }
}

describe('release staging, executed', () => {
  it('keeps serving the old tree while re-deploying the release that is live', async () => {
    const base = sandbox()
    const release = join(base, 'releases', 'abc123')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, 'marker.txt'), 'OLD')
    symlinkSync(release, join(base, 'current'))

    const result = await stageRelease(base, 'abc123', 'NEW')

    // The live tree was intact for the whole extraction...
    expect(result.live).toBe('OLD')
    expect(result.staged).toBe(`${release}.incoming`)
    // ...and the swap put the new content in place.
    expect(readFileSync(join(base, 'current', 'marker.txt'), 'utf8')).toBe('NEW')
  })

  it('holds the guard when an ancestor directory is a symlink', async () => {
    // The exact shape that defeated the first version of this fix.
    const real = sandbox()
    const link = `${real}-link`
    symlinkSync(real, link)
    dirs.push(link)

    const release = join(real, 'releases', 'abc123')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, 'marker.txt'), 'OLD')
    symlinkSync(release, join(real, 'current'))

    // Deploy addressing the site through the symlinked path.
    const result = await stageRelease(link, 'abc123', 'NEW')

    expect(result.live).toBe('OLD')
    expect(result.staged).toBe(join(link, 'releases', 'abc123.incoming'))
  })

  it('extracts in place when the release is not the live one', async () => {
    const base = sandbox()
    const live = join(base, 'releases', 'old999')
    mkdirSync(live, { recursive: true })
    writeFileSync(join(live, 'marker.txt'), 'LIVE')
    symlinkSync(live, join(base, 'current'))

    const result = await stageRelease(base, 'abc123', 'NEW')

    // No staging dance needed, and the live release was left alone.
    expect(result.staged).toBe(join(base, 'releases', 'abc123'))
    expect(result.live).toBe('LIVE')
    expect(readFileSync(join(live, 'marker.txt'), 'utf8')).toBe('LIVE')
  })

  it('reports not-live when there is no current symlink at all', () => {
    const base = sandbox()
    const paths = releasePaths(base, 'abc123')

    const script = ['set -euo pipefail', ...buildIsReleaseLive(paths), 'printf %s "$TS_CLOUD_IS_LIVE"'].join('\n')
    const proc = Bun.spawnSync(['bash', '-c', script], { stdout: 'pipe', stderr: 'pipe' })

    expect(proc.stdout.toString()).toBe('no')
  })
})

/**
 * The trap that cleans up a half-built release has to decide "is this release
 * live?" when it fires, not when it is armed. A deploy arms it at the top and
 * activates the release much later; a value computed up front says "not live"
 * for the rest of the script, so a failure in any step after activation would
 * delete the release the site had just started serving.
 */
describe('stranded-release trap, executed', () => {
  async function runDeploy(base: string, releaseId: string, options: { activate: boolean, fail: boolean }): Promise<void> {
    const paths = releasePaths(base, releaseId)

    const script = [
      'set -euo pipefail',
      buildStrandedReleaseTrap(paths),
      `mkdir -p ${paths.release}`,
      `printf NEW > ${paths.release}/marker.txt`,
      ...(options.activate ? [`ln -sfn ${paths.release} ${paths.current}`] : []),
      ...(options.fail ? ['false'] : []),
    ].join('\n')

    Bun.spawnSync(['bash', '-c', script], { stderr: 'pipe', stdout: 'pipe' })
  }

  it('keeps a release that had already gone live when a later step fails', async () => {
    const base = sandbox()
    mkdirSync(join(base, 'releases'), { recursive: true })

    await runDeploy(base, 'abc123', { activate: true, fail: true })

    // The site is serving this release; the failure must not have taken it away.
    expect(existsSync(join(base, 'releases', 'abc123', 'marker.txt'))).toBe(true)
    expect(readFileSync(join(base, 'current', 'marker.txt'), 'utf8')).toBe('NEW')
  })

  it('removes a release that failed before it went live', async () => {
    const base = sandbox()
    mkdirSync(join(base, 'releases'), { recursive: true })

    await runDeploy(base, 'abc123', { activate: false, fail: true })

    // Nothing points at it and it never served: rollback must not find it.
    expect(existsSync(join(base, 'releases', 'abc123'))).toBe(false)
  })

  it('leaves a successful deploy alone', async () => {
    const base = sandbox()
    mkdirSync(join(base, 'releases'), { recursive: true })

    await runDeploy(base, 'abc123', { activate: true, fail: false })

    expect(readFileSync(join(base, 'releases', 'abc123', 'marker.txt'), 'utf8')).toBe('NEW')
  })
})
