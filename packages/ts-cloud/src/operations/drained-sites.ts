/**
 * Detect sites whose files are still on a box that no longer serves them.
 *
 * `site:move` deliberately never deletes anything on the source: it stops the
 * units, drops the gateway route, and leaves the whole tree in place. That
 * leftover tree IS the rollback — the one thing that makes a bad cutover
 * recoverable, and the reason the operation can promise reversibility "until the
 * source server is destroyed".
 *
 * Which makes destroying that server the moment the promise expires, and nothing
 * about the box says so. It has no running units for the site, so it looks idle;
 * the config has moved on; the operator is tidying up. Terminating it is exactly
 * the right thing to do once the move is verified, and exactly the wrong thing
 * to do before — and those two look identical from outside.
 *
 * So: before a teardown, ask the box whether it is holding anyone's rollback.
 *
 * @see https://github.com/stacksjs/ts-cloud/issues/167
 */

/** Escape a value for safe use inside a POSIX ERE. */
function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Single-quote a value for safe embedding in the generated shell. */
function sh(value: string): string {
  return `'${value.split('\'').join('\'\\\'\'')}'`
}

/**
 * Report every one of this project's site trees on the box and whether anything
 * is still running for it.
 *
 * Read-only by construction — it lists and queries, and that is all. A scan that
 * could change the box would be a poor thing to run immediately before deciding
 * whether to keep it.
 *
 * A directory is only counted when it holds `releases/`, so a stray folder under
 * `/var/www` is not mistaken for a deployed site and does not block a teardown
 * the operator genuinely wants.
 */
export function buildDrainedSiteScanScript(slug: string, wwwRoot = '/var/www'): string[] {
  const prefix = `${wwwRoot}/${slug}-`
  return [
    'set -u',
    `for TS_CLOUD_DIR in ${prefix}*; do`,
    '  [ -d "$TS_CLOUD_DIR" ] || continue',
    // Only a real release tree counts as a deployed site.
    '  [ -d "$TS_CLOUD_DIR/releases" ] || continue',
    `  TS_CLOUD_SITE="\${TS_CLOUD_DIR#${prefix}}"`,
    '  TS_CLOUD_ACTIVE=no',
    `  for TS_CLOUD_UNIT in $(ls /etc/systemd/system/ 2>/dev/null | grep -E "^${reEscape(slug)}-$TS_CLOUD_SITE[-@.]" || true); do`,
    '    systemctl is-active "$TS_CLOUD_UNIT" >/dev/null 2>&1 && TS_CLOUD_ACTIVE=yes',
    '  done',
    // Size is reported so the refusal can say how much is at stake.
    '  TS_CLOUD_SIZE="$(du -sh "$TS_CLOUD_DIR" 2>/dev/null | cut -f1)"',
    '  echo "site:$TS_CLOUD_SITE:$TS_CLOUD_ACTIVE:${TS_CLOUD_SIZE:-?}"',
    'done',
    'exit 0',
  ]
}

export interface DrainedSite {
  name: string
  /** Human-readable size of the tree left behind, e.g. `1.2G`. */
  size: string
}

/**
 * Sites the box still holds but no longer runs.
 *
 * A site with something active is NOT drained — it is simply a site on a box
 * being torn down, which is ordinary and already covered by the teardown's own
 * confirmation. The interesting case is files with nothing running: either a
 * completed `site:move` whose rollback this is, or a site that has been stopped
 * and forgotten. Both are worth a sentence before the disk goes away.
 */
export function parseDrainedSites(output: string | undefined): DrainedSite[] {
  if (!output) return []
  const drained: DrainedSite[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('site:')) continue
    const [, name, active, size] = trimmed.split(':')
    if (!name || active !== 'no') continue
    drained.push({ name, size: size || '?' })
  }
  return drained
}

/**
 * What the operator sees instead of a teardown.
 *
 * Names the sites, says what the files are FOR, and gives the two ways forward.
 * The flag is deliberately its own thing rather than `--force`: `--force` exists
 * so a teardown can run unattended, and a CI job that skips a prompt must not
 * also silently discard the only copy of a rollback.
 */
export function formatDrainedSiteRefusal(sites: readonly DrainedSite[], slug: string, flag: string): string {
  const list = sites.map(site => `  ${slug}-${site.name} (${site.size})`).join('\n')
  const them = sites.length === 1 ? 'it' : 'them'
  return (
    `This server still holds ${sites.length} site tree${sites.length === 1 ? '' : 's'} with nothing running for `
    + `${them}:\n${list}\n`
    + 'A site moved off this box keeps its files here on purpose — they are the rollback, and they are what makes '
    + 'the move reversible until this server is destroyed. Destroying it now discards that.\n'
    + `Verify the site is serving from its new home first, then re-run with ${flag} to destroy it anyway.`
  )
}
