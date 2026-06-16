import { describe, expect, it } from 'bun:test'
import {
  buildActivateRelease,
  buildEnsureReleaseLayout,
  buildLinkSharedPaths,
  buildPruneReleases,
  DEFAULT_SHARED_PATHS,
  releasePaths,
} from '../../src/drivers/shared/releases'
import { buildGitCheckoutScript } from '../../src/drivers/shared/git-deploy'

const paths = releasePaths('/var/www/app', '20240601120000')

describe('releasePaths', () => {
  it('derives the standard layout', () => {
    expect(paths.releases).toBe('/var/www/app/releases')
    expect(paths.shared).toBe('/var/www/app/shared')
    expect(paths.current).toBe('/var/www/app/current')
    expect(paths.release).toBe('/var/www/app/releases/20240601120000')
  })

  it('strips a trailing slash from the base', () => {
    expect(releasePaths('/var/www/app/', 'r1').release).toBe('/var/www/app/releases/r1')
  })
})

describe('buildEnsureReleaseLayout', () => {
  it('creates the Laravel storage skeleton and a shared .env placeholder', () => {
    const script = buildEnsureReleaseLayout(paths, DEFAULT_SHARED_PATHS).join('\n')
    expect(script).toContain('mkdir -p /var/www/app/releases /var/www/app/shared')
    expect(script).toContain('/var/www/app/shared/storage/framework/views')
    expect(script).toContain('touch /var/www/app/shared/.env')
  })
})

describe('buildLinkSharedPaths', () => {
  it('symlinks shared storage and .env into the release', () => {
    const script = buildLinkSharedPaths(paths, DEFAULT_SHARED_PATHS).join('\n')
    expect(script).toContain('ln -sfn /var/www/app/shared/storage /var/www/app/releases/20240601120000/storage')
    expect(script).toContain('ln -sfn /var/www/app/shared/.env /var/www/app/releases/20240601120000/.env')
    expect(script).toContain('rm -rf /var/www/app/releases/20240601120000/storage')
  })
})

describe('buildActivateRelease', () => {
  it('flips current atomically via a temp symlink + mv -T', () => {
    const script = buildActivateRelease(paths)
    expect(script[0]).toBe('ln -sfn /var/www/app/releases/20240601120000 /var/www/app/current.tmp')
    expect(script[1]).toBe('mv -Tf /var/www/app/current.tmp /var/www/app/current')
  })
})

describe('buildPruneReleases', () => {
  it('keeps the newest N releases and never deletes the live one', () => {
    expect(buildPruneReleases(paths, 4).join('\n')).toContain('tail -n +5')
    expect(buildPruneReleases(paths, 2).join('\n')).toContain('tail -n +3')
    expect(buildPruneReleases(paths, 4).join('\n')).toContain('readlink -f /var/www/app/current')
  })
})

describe('buildGitCheckoutScript', () => {
  it('shallow-clones the branch tip when no commit is pinned', () => {
    const script = buildGitCheckoutScript({
      repository: { url: 'git@github.com:acme/app.git', branch: 'main' },
      releaseDir: paths.release,
    }).join('\n')
    expect(script).toContain('git clone -q --depth 1 --branch main git@github.com:acme/app.git /var/www/app/releases/20240601120000')
    expect(script).toContain('rev-parse HEAD > /var/www/app/releases/20240601120000/.ts-cloud-sha')
  })

  it('fetches a pinned commit reproducibly', () => {
    const script = buildGitCheckoutScript({
      repository: { url: 'https://github.com/acme/app.git' },
      releaseDir: paths.release,
      commit: 'abc1234',
    }).join('\n')
    expect(script).toContain('fetch -q --depth 1 origin abc1234')
    expect(script).toContain('checkout -q FETCH_HEAD')
    expect(script).not.toContain('git clone')
  })

  it('clones an explicit version tag', () => {
    const script = buildGitCheckoutScript({
      repository: { url: 'git@github.com:acme/app.git', strategy: 'tag', tag: 'v1.4.2' },
      releaseDir: paths.release,
    }).join('\n')
    expect(script).toContain('git clone -q --depth 1 --branch v1.4.2 git@github.com:acme/app.git')
    expect(script).toContain('.ts-cloud-tag')
  })

  it('resolves the latest tag matching a pattern on the remote', () => {
    const script = buildGitCheckoutScript({
      repository: { url: 'git@github.com:acme/app.git', strategy: 'tag', tagPattern: 'v*' },
      releaseDir: paths.release,
    }).join('\n')
    expect(script).toContain('git ls-remote --tags --refs --sort=-v:refname')
    expect(script).toContain("'refs/tags/v*'")
    expect(script).toContain('git clone -q --depth 1 --branch "$TS_CLOUD_TAG"')
  })

  it('defaults the tag pattern to v* when none is given', () => {
    const script = buildGitCheckoutScript({
      repository: { url: 'git@github.com:acme/app.git', strategy: 'tag' },
      releaseDir: paths.release,
    }).join('\n')
    expect(script).toContain("'refs/tags/v*'")
  })
})
