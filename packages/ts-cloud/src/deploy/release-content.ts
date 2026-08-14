import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pre-flight check on what a site is about to ship.
 *
 * `existsSync(site.root)` was the only gate before this, and a directory
 * existing says nothing about whether it holds a servable site. The failure it
 * missed is specific and expensive: a static-site generator that renders into a
 * SUBDIRECTORY of its output directory (BunPress writes `<outdir>/.bunpress`,
 * and it is far from alone) leaves the configured `root` existing but holding
 * only that one child. The tarball then ships `current/.bunpress/index.html`,
 * the gateway serves `current/`, and every URL 404s while the deploy prints
 * success and exits 0.
 *
 * So the check looks at the content, and when the content says the root is one
 * level too high it says so by name instead of leaving it to be found in
 * production.
 */

export interface ReleaseContentIssue {
  level: 'error' | 'warning'
  message: string
}

export interface CheckReleaseContentOptions {
  /** The site's resolved `root`, as configured. */
  root: string
  /** Site key, for messages. */
  siteName: string
  /**
   * Static sites are served by path from the release root, so a missing
   * top-level `index.html` means the domain root 404s. An app site ships a
   * source tree and has no such expectation.
   */
  expectIndex: boolean
}

/** Files that carry no site content, so a root holding only these is empty. */
const IGNORED_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep', '.keep'])

function isIgnored(name: string): boolean {
  return IGNORED_ENTRIES.has(name)
}

/** Does this directory hold at least one file, at any depth? */
function hasAnyFile(dir: string, depth = 0): boolean {
  if (depth > 8) return true
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return false
  }
  for (const entry of entries) {
    if (isIgnored(entry)) continue
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isFile()) return true
    if (stat.isDirectory() && hasAnyFile(full, depth + 1)) return true
  }
  return false
}

/**
 * Subdirectories of `root` that contain an `index.html` at their own top level.
 * A single hit is the generator-wrote-one-level-down signature.
 */
function childDirsWithIndex(root: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const hits: string[] = []
  for (const entry of entries) {
    if (isIgnored(entry)) continue
    const full = join(root, entry)
    try {
      if (statSync(full).isDirectory() && existsSync(join(full, 'index.html'))) hits.push(entry)
    } catch {
      // Unreadable child: not a candidate, and not worth failing the deploy over.
    }
  }
  return hits
}

/**
 * Inspect what a site is about to package. Returns every issue found; the
 * caller fails the deploy when any of them is an `error`.
 */
export function checkReleaseContent(options: CheckReleaseContentOptions): ReleaseContentIssue[] {
  const { root, siteName, expectIndex } = options
  const issues: ReleaseContentIssue[] = []

  if (!existsSync(root)) {
    issues.push({
      level: 'error',
      message: `Build output not found at ${root} for site '${siteName}'`,
    })
    return issues
  }

  if (!statSync(root).isDirectory()) {
    issues.push({
      level: 'error',
      message: `Site '${siteName}' has root ${root}, which is a file, not a directory`,
    })
    return issues
  }

  if (!hasAnyFile(root)) {
    issues.push({
      level: 'error',
      message:
        `Site '${siteName}' would ship an empty release: ${root} contains no files. ` +
        `Check that the build ran and wrote where 'root' points.`,
    })
    return issues
  }

  if (!expectIndex) return issues

  if (existsSync(join(root, 'index.html'))) return issues

  // No index at the top. If exactly one child directory has one, the root is
  // almost certainly one level too high — name the fix rather than describe it.
  const candidates = childDirsWithIndex(root)
  if (candidates.length === 1) {
    const suggestion = `${root.replace(/\/+$/, '')}/${candidates[0]}`
    issues.push({
      level: 'error',
      message:
        `Site '${siteName}' has no index.html at the top of ${root}, but ${suggestion} has one. ` +
        `The generator wrote one level down, so this release would serve 404s at the domain root. ` +
        `Set root: '${suggestion}'.`,
    })
    return issues
  }

  if (candidates.length > 1) {
    issues.push({
      level: 'warning',
      message:
        `Site '${siteName}' has no index.html at the top of ${root}. ` +
        `These subdirectories have one: ${candidates.join(', ')}. The domain root will 404.`,
    })
    return issues
  }

  issues.push({
    level: 'warning',
    message: `Site '${siteName}' has no index.html anywhere under ${root}. The domain root will 404.`,
  })
  return issues
}
