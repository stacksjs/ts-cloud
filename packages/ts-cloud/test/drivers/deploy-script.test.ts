import { describe, expect, it } from 'bun:test'
import {
  buildAwsArtifactFetch,
  buildLocalArtifactFetch,
  buildSiteDeployScript,
  buildStaticSiteDeployScript,
  resolveExecStart,
} from '../../src/drivers/shared/deploy-script'

describe('resolveExecStart', () => {
  it('rewrites bun start commands to absolute binary path', () => {
    expect(resolveExecStart('bun run server.ts', 'bun')).toBe('/usr/local/bin/bun run server.ts')
  })

  it('rewrites node start commands', () => {
    expect(resolveExecStart('node dist/index.js', 'node')).toBe('/usr/local/bin/node dist/index.js')
  })
})

describe('buildSiteDeployScript (zero-downtime atomic release)', () => {
  const opts = {
    siteName: 'web',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch('/var/ts-cloud/staging/release.tar.gz', 'web'),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  it('unpacks into a release dir, links shared .env, and runs the service from current', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(script[0]).toBe('set -euo pipefail')
    expect(joined).toContain('cp "/var/ts-cloud/staging/release.tar.gz" /tmp/web-release.tar.gz')
    // Tarball goes into THIS release dir, never the live one.
    expect(joined).toContain('tar xzf /tmp/web-release.tar.gz -C /var/www/web/releases/abc123')
    // .env persists in shared/ and is symlinked into the release.
    expect(joined).toContain('/var/www/web/shared/.env')
    expect(joined).toContain('ln -sfn /var/www/web/shared/.env /var/www/web/releases/abc123/.env')
    // The unit references the stable `current` symlink (identical every deploy).
    expect(joined).toContain('WorkingDirectory=/var/www/web/current')
    expect(joined).toContain('EnvironmentFile=/var/www/web/current/.env')
    expect(joined).toContain('Environment=PORT=3000')
    expect(joined).toContain('systemctl restart my-app-web.service')
  })

  it('never wipes the live directory (no destructive find/rm of the docroot)', () => {
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).not.toContain('find /var/www/web -mindepth')
  })

  it('promotes the release atomically (mv -Tf) BEFORE restarting, and prunes old releases', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(joined).toContain('mv -Tf /var/www/web/current.tmp /var/www/web/current')
    const activateIdx = script.findIndex(l => l.includes('mv -Tf') && l.includes('/current'))
    const restartIdx = script.findIndex(l => l === 'systemctl restart my-app-web.service')
    expect(activateIdx).toBeLessThan(restartIdx)
    // Old releases pruned for rollback.
    expect(joined).toContain('/var/www/web/releases/')
    expect(script.some(l => l.includes('rm -rf "$TS_CLOUD_OLD"'))).toBe(true)
  })

  it('runs preStart in the new release dir after extraction, before activation', () => {
    const script = buildSiteDeployScript({ ...opts, preStartCommands: ['bun install --frozen-lockfile', 'bun run build'] })
    const joined = script.join('\n')
    expect(joined).toContain('cd /var/www/web/releases/abc123')
    const extractIdx = script.findIndex(l => l.includes('tar xzf'))
    const installIdx = script.findIndex(l => l === 'bun install --frozen-lockfile')
    const activateIdx = script.findIndex(l => l.includes('mv -Tf') && l.includes('/current'))
    expect(extractIdx).toBeLessThan(installIdx)
    expect(installIdx).toBeLessThan(activateIdx)
  })
})

describe('buildStaticSiteDeployScript (zero-downtime atomic release)', () => {
  const opts = {
    siteName: 'docs',
    artifactFetch: buildLocalArtifactFetch('/tmp/staging.tar.gz', 'docs'),
    releaseId: 'rel9',
  }

  it('unpacks into a release dir and swaps current atomically — no empty-docroot window, no restart', () => {
    const script = buildStaticSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(joined).toContain('tar xzf /tmp/docs-release.tar.gz -C /var/www/docs/releases/rel9')
    expect(joined).toContain('mv -Tf /var/www/docs/current.tmp /var/www/docs/current')
    // No destructive wipe of the live docroot, and no systemd (static).
    expect(joined).not.toContain('find /var/www/docs -mindepth')
    expect(joined).not.toContain('systemctl')
    // Old releases pruned.
    expect(script.some(l => l.includes('rm -rf "$TS_CLOUD_OLD"'))).toBe(true)
  })

  it('runs preStart (on-box build) in the release dir before the swap', () => {
    const script = buildStaticSiteDeployScript({ ...opts, preStartCommands: ['bun run docs:build'] })
    const buildIdx = script.findIndex(l => l === 'bun run docs:build')
    const activateIdx = script.findIndex(l => l.includes('mv -Tf') && l.includes('/current'))
    expect(buildIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeLessThan(activateIdx)
  })
})

describe('buildAwsArtifactFetch', () => {
  it('pulls tarball from S3 before extraction', () => {
    expect(buildAwsArtifactFetch('my-app-production-deploy', 'releases/web/abc.tar.gz', 'us-east-1', 'web'))
      .toEqual([
        'aws s3 cp "s3://my-app-production-deploy/releases/web/abc.tar.gz" /tmp/web-release.tar.gz --region us-east-1',
      ])
  })
})
