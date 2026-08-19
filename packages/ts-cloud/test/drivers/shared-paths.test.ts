import type { SharedPathEntry } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import {
  buildEnsureReleaseLayout,
  buildLinkSharedPaths,
  buildRelinkSharedPaths,
  releasePaths,
  sharedPathsManifestPath,
} from '../../src/drivers/shared/releases'

const paths = releasePaths('/var/www/site', 'rel1')
const layout = (shared: SharedPathEntry[]): string => buildEnsureReleaseLayout(paths, shared).join('\n')

describe('shared path classification', () => {
  /**
   * A directory touched as a file is a quiet failure: the deploy reports
   * success and the app's first write fails on the box.
   */
  it('treats a dot-directory as a directory, not a file', () => {
    const out = layout(['.ts-cloud'])
    expect(out).toContain('mkdir -p /var/www/site/shared/.ts-cloud')
    expect(out).not.toContain('touch /var/www/site/shared/.ts-cloud')
  })

  it('still placeholds .env as a file', () => {
    const out = layout(['.env'])
    expect(out).toContain('touch /var/www/site/shared/.env')
    expect(out).not.toContain('mkdir -p /var/www/site/shared/.env\n')
  })

  it('placeholds env variants and extensioned files', () => {
    expect(layout(['.env.production'])).toContain('touch /var/www/site/shared/.env.production')
    expect(layout(['database.sqlite'])).toContain('touch /var/www/site/shared/database.sqlite')
  })

  it('treats plain and nested names as directories', () => {
    expect(layout(['uploads'])).toContain('mkdir -p /var/www/site/shared/uploads')
    expect(layout(['storage/app/media'])).toContain('mkdir -p /var/www/site/shared/storage/app/media')
  })

  it('keeps the Laravel storage skeleton', () => {
    const out = layout(['storage'])
    expect(out).toContain('mkdir -p /var/www/site/shared/storage/framework/cache/data')
    expect(out).toContain('mkdir -p /var/www/site/shared/storage/logs')
  })

  it('symlinks shared paths into the release', () => {
    const out = buildLinkSharedPaths(paths, ['.ts-cloud']).join('\n')
    expect(out).toContain('ln -sfn /var/www/site/shared/.ts-cloud /var/www/site/releases/rel1/.ts-cloud')
  })
})

describe('adopting live state into shared/', () => {
  /**
   * The deploy that STARTS sharing a path is the dangerous one: placehold first
   * and the live copy (every production row, for a database) dies with its
   * release. Adoption has to run before the placeholder is created.
   */
  it('adopts before placeholding, so the placeholder cannot win', () => {
    const out = buildEnsureReleaseLayout(paths, ['database/app.sqlite'])
    const adopt = out.findIndex(l => l.includes("ts_cloud_adopt_shared 'database/app.sqlite'"))
    const touch = out.findIndex(l => l.includes('touch /var/www/site/shared/database/app.sqlite'))
    expect(adopt).toBeGreaterThanOrEqual(0)
    expect(touch).toBeGreaterThan(adopt)
  })

  it('only adopts when shared/ has nothing and the live copy is a real file', () => {
    const out = layout(['database/app.sqlite'])
    // Already shared → never overwrite it with a release's copy.
    expect(out).toContain('if [ -e "$TS_CLOUD_DST" ]; then return 0; fi')
    // A symlink is a previous deploy's link into shared/, not orphaned state.
    expect(out).toContain('if [ -L "$TS_CLOUD_SRC" ] || [ ! -e "$TS_CLOUD_SRC" ]; then return 0; fi')
  })

  it('carries the SQLite sidecars across, so no committed transaction is lost', () => {
    expect(layout(['database/app.sqlite'])).toContain('for TS_CLOUD_SIDECAR in -wal -shm; do')
  })

  it('records each shared path WITH its target, outside releases/ so pruning cannot take the manifest', () => {
    const out = layout(['.env', 'database/app.sqlite'])
    expect(sharedPathsManifestPath('/var/www/site')).toBe('/var/www/site/.ts-cloud/shared-paths')
    expect(out).toContain('cat > /var/www/site/.ts-cloud/shared-paths')
    expect(out).toContain('database/app.sqlite\t/var/www/site/shared/database/app.sqlite')
  })
})

describe('buildRelinkSharedPaths', () => {
  it('relinks each recorded path at its recorded target', () => {
    const out = buildRelinkSharedPaths(paths, '"$TS_CLOUD_PREV"').join('\n')
    expect(out).toContain('done < /var/www/site/.ts-cloud/shared-paths')
    expect(out).toContain('ln -sfn "$TS_CLOUD_TGT" "$TS_CLOUD_PREV"/"$TS_CLOUD_SP"')
  })

  /** A box deployed before targets existed has a one-column manifest. */
  it('falls back to this site\'s shared/ for a manifest with no target column', () => {
    const out = buildRelinkSharedPaths(paths, '/x').join('\n')
    expect(out).toContain('[ -n "$TS_CLOUD_TGT" ] || TS_CLOUD_TGT="/var/www/site/shared/$TS_CLOUD_SP"')
  })

  it('is a no-op on a box that has never deployed shared paths', () => {
    expect(buildRelinkSharedPaths(paths, '/x')[0]).toBe('if [ -f /var/www/site/.ts-cloud/shared-paths ]; then')
  })
})

/**
 * Every site installs under its own base, so two sites of one project that both
 * list `database/app.sqlite` get two separate databases — each surviving its own
 * deploys and drifting apart forever. An explicit target is what makes them one
 * file.
 */
describe('shared paths pointed at a project-level target', () => {
  const spec = { path: 'database/app.sqlite', target: '/var/www/acme-shared/database/app.sqlite' }

  it('links the release at the target instead of the site\'s own shared/', () => {
    const out = buildLinkSharedPaths(paths, [spec]).join('\n')
    expect(out).toContain('ln -sfn /var/www/acme-shared/database/app.sqlite /var/www/site/releases/rel1/database/app.sqlite')
    expect(out).not.toContain('/var/www/site/shared/database/app.sqlite')
  })

  it('creates and seeds the target when the site owns it', () => {
    const out = layout([spec])
    expect(out).toContain('ts_cloud_adopt_shared \'database/app.sqlite\' \'/var/www/acme-shared/database/app.sqlite\'')
    expect(out).toContain('touch /var/www/acme-shared/database/app.sqlite')
  })

  /**
   * The whole point of `seed: false`. A non-owner that placeholded the target
   * would create an empty file, and the site actually holding the data would
   * then find the target present and never seed it — the same silent wipe,
   * decided by deploy order.
   */
  it('neither creates nor seeds a target it does not own', () => {
    const out = layout([{ ...spec, seed: false }])
    expect(out).not.toContain('ts_cloud_adopt_shared \'database/app.sqlite\'')
    expect(out).not.toContain('touch /var/www/acme-shared/database/app.sqlite')
  })

  it('still records a non-owned target, so rollback relinks it', () => {
    expect(layout([{ ...spec, seed: false }]))
      .toContain('database/app.sqlite\t/var/www/acme-shared/database/app.sqlite')
  })

  /**
   * A dangling symlink is not inert: an app that opens it CREATES the file, so
   * a non-owner deploying before the owner would plant an empty database right
   * where the owner was about to seed the real one.
   */
  it('waits for the target to exist before linking a site at it', () => {
    const out = buildLinkSharedPaths(paths, [{ ...spec, seed: false }]).join('\n')
    expect(out).toContain('if [ -e /var/www/acme-shared/database/app.sqlite ]; then')
  })

  it('links unconditionally when the site owns the target', () => {
    expect(buildLinkSharedPaths(paths, [spec]).join('\n')).not.toContain('if [ -e ')
  })
})

/**
 * Adoption rescues state from the LIVE release, which covers a path that
 * becomes shared on an existing site. A site's FIRST deploy has no live release
 * to adopt from, so without this the empty placeholder would replace whatever
 * the artifact shipped — an app shipping a seeded SQLite database would come up
 * empty on the very deploy that created it.
 */
describe('seeding a shared file from the incoming release', () => {
  const link = (shared: SharedPathEntry[]): string => buildLinkSharedPaths(paths, shared).join('\n')

  it('copies the release copy in when the shared file is still a placeholder', () => {
    const out = link(['database/app.sqlite'])
    expect(out).toContain('if [ -f /var/www/site/releases/rel1/database/app.sqlite ]')
    expect(out).toContain('[ ! -s /var/www/site/shared/database/app.sqlite ]')
    expect(out).toContain('cp -a /var/www/site/releases/rel1/database/app.sqlite /var/www/site/shared/database/app.sqlite')
  })

  it('still links the shared file afterwards', () => {
    const out = link(['database/app.sqlite'])
    const seed = out.indexOf('cp -a /var/www/site/releases/rel1/database/app.sqlite')
    const ln = out.indexOf('ln -sfn /var/www/site/shared/database/app.sqlite')
    expect(seed).toBeGreaterThan(-1)
    expect(ln).toBeGreaterThan(seed)
  })

  it('leaves .env alone — the deploy writes the shared one itself', () => {
    expect(link(['.env'])).not.toContain('cp -a')
  })

  it('leaves directories alone', () => {
    expect(link(['storage'])).not.toContain('cp -a')
  })

  /**
   * A site that does not own the target must not seed it: the owner's own
   * deploy adopts or writes it, and a copy from here would make that a no-op.
   */
  it('leaves a target this site does not own alone', () => {
    expect(link([{ path: 'database/app.sqlite', target: '/var/www/api/shared/app.sqlite', seed: false }]))
      .not.toContain('cp -a')
  })
})
