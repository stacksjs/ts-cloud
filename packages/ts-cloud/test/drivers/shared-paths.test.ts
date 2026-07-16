import { describe, expect, it } from 'bun:test'
import { buildEnsureReleaseLayout, buildLinkSharedPaths, releasePaths } from '../../src/drivers/shared/releases'

const paths = releasePaths('/var/www/site', 'rel1')
const layout = (shared: string[]): string => buildEnsureReleaseLayout(paths, shared).join('\n')

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
