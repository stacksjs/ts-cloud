import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildActivateRelease,
  buildDeployHistoryHeader,
  buildEnsureReleaseLayout,
  buildLinkSharedPaths,
  buildPruneReleases,
  buildRollbackScript,
  buildSiteOwnerGuard,
  DEFAULT_SHARED_PATHS,
  deployHistoryPath,
  deployLogPath,
  releasePaths,
  siteOwnerPath,
} from '../../src/drivers/shared/releases'
import { buildGitCheckoutScript } from '../../src/drivers/shared/git-deploy'

const paths = releasePaths('/var/www/app', '20240601120000')

describe('buildRollbackScript', () => {
  it('rolls back to the previous release atomically when no target given', () => {
    const s = buildRollbackScript(paths).join('\n')
    expect(s).toContain('readlink -f /var/www/app/current')
    expect(s).toContain('no previous release to roll back to')
    expect(s).toContain('mv -Tf /var/www/app/current.tmp /var/www/app/current')
  })

  it('rolls back to a specific release id, guarding for existence', () => {
    const s = buildRollbackScript(paths, { to: 'r-old' }).join('\n')
    expect(s).toContain('[ -d /var/www/app/releases/r-old ]')
    expect(s).toContain('ln -sfn /var/www/app/releases/r-old /var/www/app/current.tmp')
    expect(s).toContain('mv -Tf /var/www/app/current.tmp /var/www/app/current')
  })

  it('guards the retire-instances grep so an empty match list cannot fail the rollback under set -euo pipefail', () => {
    const script = buildRollbackScript(paths, { unitBase: 'myapp-web' })
    const joined = script.join('\n')
    // The instance-retire pipeline wraps grep in a brace group so `|| true`
    // guards only the grep — otherwise grep exits 1 when there is nothing to
    // retire and fails the rollback after current has already flipped.
    expect(joined).toContain('| { grep -v "^myapp-web@${TS_CLOUD_RB_ID}.service$" || true; } | while read -r TS_CLOUD_U')
    for (const line of script) {
      if (line.includes('grep -v'))
        expect(line).toContain('|| true')
    }
  })
})

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
    expect(script).toContain('git clone -q --depth 1 --branch \'main\' \'git@github.com:acme/app.git\' /var/www/app/releases/20240601120000')
    expect(script).toContain('rev-parse HEAD > /var/www/app/releases/20240601120000/.ts-cloud-sha')
  })

  it('fetches a pinned commit reproducibly', () => {
    const script = buildGitCheckoutScript({
      repository: { url: 'https://github.com/acme/app.git' },
      releaseDir: paths.release,
      commit: 'abc1234',
    }).join('\n')
    expect(script).toContain('fetch -q --depth 1 origin \'abc1234\'')
    expect(script).toContain('checkout -q FETCH_HEAD')
    expect(script).not.toContain('git clone')
  })

  it('clones an explicit version tag', () => {
    const script = buildGitCheckoutScript({
      repository: { url: 'git@github.com:acme/app.git', strategy: 'tag', tag: 'v1.4.2' },
      releaseDir: paths.release,
    }).join('\n')
    expect(script).toContain('git clone -q --depth 1 --branch \'v1.4.2\' \'git@github.com:acme/app.git\'')
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

describe('buildDeployHistoryHeader', () => {
  it('captures output + records success/failure via an EXIT trap', () => {
    const script = buildDeployHistoryHeader('/var/www/app', { releaseId: 'abc123', commit: 'abc123', branch: 'main' }).join('\n')
    // Per-deploy output is teed to a log under the site's .ts-cloud dir.
    expect(script).toContain(`exec > >(tee -a ${deployLogPath('/var/www/app', 'abc123')}) 2>&1`)
    // History line appended on exit, for both success and failure.
    expect(script).toContain('trap ts_cloud_record_deploy EXIT')
    expect(script).toContain('TS_CLOUD_RC=$?')
    expect(script).toContain(deployHistoryPath('/var/www/app'))
    expect(script).toContain('branch=main')
    expect(script).toContain('commit=abc123')
  })

  it('prunes old per-deploy logs to the keep count', () => {
    const script = buildDeployHistoryHeader('/var/www/app', { releaseId: 'r', keepLogs: 3 }).join('\n')
    expect(script).toContain('tail -n +4')
  })

  it('paths live outside releases/ so they survive pruning', () => {
    expect(deployHistoryPath('/var/www/app/')).toBe('/var/www/app/.ts-cloud/deploy-history.log')
    expect(deployLogPath('/var/www/app', '20240601')).toBe('/var/www/app/.ts-cloud/deploys/20240601.log')
  })
})

describe('buildSiteOwnerGuard', () => {
  /** Run the generated guard script with bash against a real temp dir. */
  function runGuard(base: string, slug: string): { status: number | null, stderr: string } {
    const r = spawnSync('bash', ['-c', buildSiteOwnerGuard(base, slug).join('\n')], { encoding: 'utf8' })
    return { status: r.status, stderr: r.stderr }
  }

  it('first deploy claims the dir by stamping the project slug', () => {
    const base = mkdtempSync(join(tmpdir(), 'tscloud-owner-'))
    try {
      expect(runGuard(base, 'acme').status).toBe(0)
      expect(readFileSync(siteOwnerPath(base), 'utf8').trim()).toBe('acme')
    }
    finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('same project deploys again without friction', () => {
    const base = mkdtempSync(join(tmpdir(), 'tscloud-owner-'))
    try {
      expect(runGuard(base, 'acme').status).toBe(0)
      expect(runGuard(base, 'acme').status).toBe(0)
    }
    finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('a DIFFERENT project is refused loudly instead of overwriting releases', () => {
    const base = mkdtempSync(join(tmpdir(), 'tscloud-owner-'))
    try {
      expect(runGuard(base, 'acme').status).toBe(0)
      const other = runGuard(base, 'intruder')
      expect(other.status).toBe(1)
      expect(other.stderr).toContain('REFUSING deploy')
      expect(other.stderr).toContain(`belongs to project 'acme'`)
      // The original owner marker is untouched.
      expect(readFileSync(siteOwnerPath(base), 'utf8').trim()).toBe('acme')
    }
    finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('stamps the marker under the site meta dir', () => {
    expect(siteOwnerPath('/var/www/dashboard-acme-com')).toBe('/var/www/dashboard-acme-com/.ts-cloud/owner')
  })
})
