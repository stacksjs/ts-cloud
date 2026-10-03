import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildDiscardUploadScript,
  buildHostCleanupScript,
  buildPublishUploadScript,
  HOST_ARTIFACT_CACHE_DIR,
} from '../../src/drivers/shared/deploy-script'

/** `bash -n`: the only check that sees a broken here-document or quoting. */
function bashParses(script: string): { ok: boolean, error: string } {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
  return { ok: result.status === 0, error: result.stderr }
}

function age(path: string, minutes: number): void {
  const when = new Date(Date.now() - minutes * 60_000)
  utimesSync(path, when, when)
}

/**
 * stacksjs/ts-cloud#194. Artifact retention used to live in the upload path,
 * which (1) never matched the `.tmp` names uploads are written under, so a
 * dropped transfer leaked forever, and (2) only ran on a cache miss.
 */
describe('host cleanup covers the release artifact cache (#194)', () => {
  const script = buildHostCleanupScript()
  const artifactRules = script.filter(line => line.includes(HOST_ARTIFACT_CACHE_DIR))

  it('prunes completed artifacts past their window', () => {
    expect(artifactRules).toContain(
      `find ${HOST_ARTIFACT_CACHE_DIR} -xdev -maxdepth 1 -type f -name "*.tar.gz" -mtime +2 -delete 2>/dev/null || true`,
    )
  })

  it('prunes stranded `.tmp` uploads, but only after an in-flight bound', () => {
    expect(artifactRules).toContain(
      `find ${HOST_ARTIFACT_CACHE_DIR} -xdev -maxdepth 1 -type f -name ".*.tmp" -mmin +60 -delete 2>/dev/null || true`,
    )
  })

  it('never fails the deploy it runs inside', () => {
    for (const rule of artifactRules) expect(rule).toEndWith('|| true')
  })

  it('parses as bash', () => {
    expect(bashParses(`set -euo pipefail\n${script.join('\n')}\n`)).toEqual({ ok: true, error: '' })
  })

  it('deletes old artifacts and orphans and keeps fresh ones and in-flight uploads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-cloud-artifacts-'))
    try {
      const files = {
        oldArtifact: join(dir, `${'a'.repeat(64)}.tar.gz`),
        freshArtifact: join(dir, `${'b'.repeat(64)}.tar.gz`),
        orphan: join(dir, `.${'c'.repeat(64)}-nonce.tmp`),
        inFlight: join(dir, `.${'d'.repeat(64)}-nonce.tmp`),
        unrelated: join(dir, 'notes.txt'),
      }
      for (const file of Object.values(files)) writeFileSync(file, 'x')
      age(files.oldArtifact, 5 * 24 * 60)
      age(files.orphan, 2 * 60)
      age(files.inFlight, 5)
      age(files.unrelated, 30 * 24 * 60)

      // `-xdev` and `-delete` behave the same under GNU and BSD find, so the
      // rules run as generated with only the directory swapped.
      const rules = artifactRules.map(rule => rule.replaceAll(HOST_ARTIFACT_CACHE_DIR, dir)).join('\n')
      const run = spawnSync('bash', ['-c', `set -euo pipefail\n${rules}`], { encoding: 'utf8' })
      expect(run.status).toBe(0)

      expect(existsSync(files.oldArtifact)).toBe(false)
      expect(existsSync(files.orphan)).toBe(false)
      expect(existsSync(files.freshArtifact)).toBe(true)
      expect(existsSync(files.inFlight)).toBe(true)
      expect(existsSync(files.unrelated)).toBe(true)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
