import { describe, expect, it } from 'bun:test'
import { buildDrainedSiteScanScript, formatDrainedSiteRefusal, parseDrainedSites } from './drained-sites'

describe('buildDrainedSiteScanScript', () => {
  it('scans this project\'s trees only', () => {
    const script = buildDrainedSiteScanScript('hq').join('\n')
    expect(script).toContain('/var/www/hq-*')
    expect(script).toContain('^hq-$TS_CLOUD_SITE[-@.]')
  })

  /** A stray folder under /var/www must not block a teardown. */
  it('counts only directories that hold a release tree', () => {
    expect(buildDrainedSiteScanScript('hq').join('\n')).toContain('[ -d "$TS_CLOUD_DIR/releases" ] || continue')
  })

  /**
   * A scan that could change the box would be a poor thing to run immediately
   * before deciding whether to keep it.
   */
  it('only reads', () => {
    const script = buildDrainedSiteScanScript('hq').join('\n')
    for (const mutation of ['rm ', 'systemctl stop', 'systemctl start', 'systemctl disable', 'systemctl enable', 'mv ', 'tar ']) {
      expect(script.includes(mutation)).toBe(false)
    }
    // Every redirect to a FILE goes to /dev/null (`>&1` duplicates a descriptor
    // rather than writing anywhere), so nothing lands on disk.
    for (const redirect of script.match(/>(?!&)\s*\S+/g) ?? []) {
      expect(redirect.replace(/^>\s*/, '')).toBe('/dev/null')
    }
  })

  it('escapes a slug with regex metacharacters', () => {
    expect(buildDrainedSiteScanScript('my.app').join('\n')).toContain('^my\\.app-')
  })

  it('always exits 0, so a scan is never mistaken for a failure', () => {
    expect(buildDrainedSiteScanScript('hq').at(-1)).toBe('exit 0')
  })
})

describe('parseDrainedSites', () => {
  it('reports the trees with nothing running for them', () => {
    const drained = parseDrainedSites('site:bughq:no:1.2G\nsite:loghq:yes:800M')
    expect(drained).toEqual([{ name: 'bughq', size: '1.2G' }])
  })

  /**
   * A site with something active is a site on a box being torn down — ordinary,
   * and already covered by the teardown's own confirmation.
   */
  it('ignores a site that is still running', () => {
    expect(parseDrainedSites('site:bughq:yes:1.2G')).toEqual([])
  })

  it('is empty for a box with no trees, or no output at all', () => {
    expect(parseDrainedSites('')).toEqual([])
    expect(parseDrainedSites(undefined)).toEqual([])
    expect(parseDrainedSites('some unrelated chatter')).toEqual([])
  })

  it('survives a missing size', () => {
    expect(parseDrainedSites('site:bughq:no:')).toEqual([{ name: 'bughq', size: '?' }])
  })
})

describe('formatDrainedSiteRefusal', () => {
  it('names the sites, what the files are for, and the way forward', () => {
    const message = formatDrainedSiteRefusal([{ name: 'bughq', size: '1.2G' }], 'hq', '--discard-drained-sites')
    expect(message).toContain('hq-bughq (1.2G)')
    expect(message).toContain('they are the rollback')
    expect(message).toContain('--discard-drained-sites')
  })

  it('reads correctly for several', () => {
    const message = formatDrainedSiteRefusal(
      [{ name: 'a', size: '1G' }, { name: 'b', size: '2G' }],
      'hq',
      '--discard-drained-sites',
    )
    expect(message).toContain('2 site trees')
    expect(message).toContain('for them')
  })
})
