import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

/**
 * Guards the `// @bun` pragma out of the shipped CLI bundles.
 *
 * Bun.build writes that pragma into shebang entry bundles. The runtime reads it
 * as "already transpiled" and loads the file down a path that decodes it as
 * latin-1 instead of UTF-8, so every non-ASCII character in every string
 * literal is corrupted into its own UTF-8 bytes — `—` becomes `â€"`, and a
 * customer's `Käufer` becomes `KÃ¤ufer` on the box. `build.ts` strips it; this
 * fails the suite if a future build stops doing so.
 *
 * Skipped when dist has not been built, so a plain `bun test` on a fresh clone
 * does not fail for the wrong reason.
 */
const distBin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'bin')
const built = existsSync(distBin)

describe.skipIf(!built)('shipped CLI bundles', () => {
  const bundles = built ? readdirSync(distBin).filter((entry) => entry.endsWith('.js')) : []

  it('ships at least one executable bundle to check', () => {
    expect(bundles.length).toBeGreaterThan(0)
  })

  it('carries no `// @bun` pragma, which would make Bun read them as latin-1', () => {
    const offenders = bundles.filter((entry) =>
      /^(?:#![^\n]*\n)?\/\/ @bun\n/.test(readFileSync(join(distBin, entry), 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('keeps non-ASCII literals as real UTF-8, not per-byte escapes', () => {
    // A per-byte escape (\xE2\x80\x94) round-trips to the same corruption the
    // pragma causes, so reject that spelling too.
    for (const entry of bundles) {
      const source = readFileSync(join(distBin, entry), 'utf8')
      expect(source).not.toContain('\\xE2\\x80\\x94')
      expect(source).not.toContain('\\xC2\\xB7')
    }
  })
})
