import { describe, expect, it } from 'bun:test'
import {
  buildAwsArtifactFetch,
  buildLocalArtifactFetch,
  buildSiteDeployScript,
  buildStaticSiteDeployScript,
  releaseTarballTmpPath,
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

describe('buildSiteDeployScript (zero-downtime cutover, ported sites)', () => {
  const opts = {
    siteName: 'web',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch('/var/ts-cloud/staging/release.tar.gz', '/tmp/my-app-web-abc123-release.tar.gz'),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  it('unpacks into a release dir, links shared .env, and runs the release as its own templated instance', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(script[0]).toBe('set -euo pipefail')
    expect(joined).toContain('cp "/var/ts-cloud/staging/release.tar.gz" /tmp/my-app-web-abc123-release.tar.gz')
    // Tarball goes into THIS release dir, never the live one.
    expect(joined).toContain('tar xzf /tmp/my-app-web-abc123-release.tar.gz -C /var/www/web/releases/abc123')
    // .env persists in shared/ and is symlinked into the release.
    expect(joined).toContain('/var/www/web/shared/.env')
    expect(joined).toContain('ln -sfn /var/www/web/shared/.env /var/www/web/releases/abc123/.env')
    // Templated unit pinned to its release dir so old + new can overlap.
    expect(joined).toContain('/etc/systemd/system/my-app-web@.service')
    expect(joined).toContain('WorkingDirectory=/var/www/web/releases/%i')
    expect(joined).toContain('EnvironmentFile=/var/www/web/releases/%i/.env')
    expect(joined).toContain('Environment=PORT=3000')
    expect(joined).toContain('systemctl start my-app-web@abc123.service')
    // No blunt restart of a shared unit in the zero-downtime path.
    expect(joined).not.toContain('systemctl restart my-app-web.service')
  })

  it('health-gates the new instance BEFORE stopping the old one, and aborts without flipping current on failure', () => {
    const script = buildSiteDeployScript(opts)
    const startIdx = script.findIndex(l => l === 'systemctl start my-app-web@abc123.service')
    const gateIdx = script.findIndex(l => l.includes('failed its health gate'))
    const activateIdx = script.findIndex(l => l.includes('mv -Tf') && l.includes('/current'))
    const stopOldIdx = script.findIndex(l => l.includes('for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}'))
    expect(startIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(startIdx)
    // Old instances captured before the new one starts, stopped only after the gate + flip.
    const captureIdx = script.findIndex(l => l.startsWith('TS_CLOUD_OLD_UNITS='))
    expect(captureIdx).toBeLessThan(startIdx)
    expect(gateIdx).toBeLessThan(activateIdx)
    expect(activateIdx).toBeLessThan(stopOldIdx)
    // The failure path stops the NEW instance and exits nonzero (old keeps serving).
    expect(script.join('\n')).toContain('systemctl stop my-app-web@abc123.service 2>/dev/null || true; exit 1')
  })

  it('self-heals when the new release cannot overlap the old (app without SO_REUSEPORT)', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    // First gate records whether the overlap held instead of aborting outright.
    expect(joined).toContain('TS_CLOUD_GATE_OK=1')
    // On overlap failure: retire the old instances, restart the new one, re-gate.
    const healIdx = script.findIndex(l => l.includes('could not overlap the previous release'))
    expect(healIdx).toBeGreaterThan(-1)
    expect(script[healIdx]).toContain('systemctl restart my-app-web@abc123.service')
    // The retry still aborts (exit 1) if the release is genuinely broken.
    expect(script[healIdx]).toContain('exit 1')
    // The self-heal loop uses its own var so it does not shadow the post-flip
    // stop-old loop (which must still run only after `current` is promoted).
    const activateIdx = script.findIndex(l => l.includes('mv -Tf') && l.includes('/current'))
    const stopOldIdx = script.findIndex(l => l.includes('for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}'))
    expect(healIdx).toBeLessThan(activateIdx)
    expect(activateIdx).toBeLessThan(stopOldIdx)
  })

  it('polls the configured health path against the site port as part of the gate', () => {
    const script = buildSiteDeployScript({ ...opts, healthCheckPath: 'health' })
    const joined = script.join('\n')
    expect(joined).toContain('http://127.0.0.1:3000/health')
    const curlIdx = script.findIndex(l => l.includes('curl -sf'))
    const activateIdx = script.findIndex(l => l.includes('mv -Tf') && l.includes('/current'))
    expect(curlIdx).toBeGreaterThan(-1)
    expect(curlIdx).toBeLessThan(activateIdx)
  })

  it('migrates off the legacy single unit with a one-time cutover and removes it', () => {
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).toContain('retiring pre-zero-downtime unit my-app-web.service')
    expect(joined).toContain('rm -f /etc/systemd/system/my-app-web.service')
  })

  it('never wipes the live directory (no destructive find/rm of the docroot)', () => {
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).not.toContain('find /var/www/web -mindepth')
  })

  it('prunes old releases after promotion', () => {
    const script = buildSiteDeployScript(opts)
    expect(script.join('\n')).toContain('mv -Tf /var/www/web/current.tmp /var/www/web/current')
    expect(script.some(l => l.includes('rm -rf "$TS_CLOUD_OLD"'))).toBe(true)
  })

  it('guards the unit prune grep so an empty match list cannot fail the deploy under set -euo pipefail', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    // The prune pipeline wraps grep in a brace group so `|| true` guards only
    // the grep — without it, grep exits 1 on "nothing to prune" and kills the
    // script at the very last step, after the new release is already live.
    expect(joined).toContain('| { grep -v -e "^my-app-web@abc123.service$" -e "^my-app-web@\\.service$" || true; } | while read -r TS_CLOUD_U')
    // Every `grep -v` in the generated script is guarded against exit 1.
    for (const line of script) {
      if (line.includes('grep -v'))
        expect(line).toContain('|| true')
    }
  })

  it('runs preStart in the new release dir after extraction, before the new instance starts', () => {
    const script = buildSiteDeployScript({ ...opts, preStartCommands: ['bun install --frozen-lockfile', 'bun run build'] })
    const joined = script.join('\n')
    expect(joined).toContain('cd /var/www/web/releases/abc123')
    const extractIdx = script.findIndex(l => l.includes('tar xzf'))
    const installIdx = script.findIndex(l => l === 'bun install --frozen-lockfile')
    const startIdx = script.findIndex(l => l === 'systemctl start my-app-web@abc123.service')
    expect(extractIdx).toBeLessThan(installIdx)
    expect(installIdx).toBeLessThan(startIdx)
  })
})

describe('buildSiteDeployScript (restart cutover: portless sites / zeroDowntime off)', () => {
  const portless = {
    siteName: 'worker',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch('/tmp/staging.tar.gz', '/tmp/my-app-worker-abc123-release.tar.gz'),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run worker.ts',
    envEntries: {},
  }

  it('portless sites keep the single-unit restart flow (no overlap: double workers double-process)', () => {
    const script = buildSiteDeployScript(portless)
    const joined = script.join('\n')
    expect(joined).toContain('WorkingDirectory=/var/www/worker/current')
    expect(joined).toContain('systemctl restart my-app-worker.service')
    expect(joined).not.toContain('my-app-worker@')
    // Promote atomically BEFORE restarting.
    const activateIdx = script.findIndex(l => l.includes('mv -Tf') && l.includes('/current'))
    const restartIdx = script.findIndex(l => l === 'systemctl restart my-app-worker.service')
    expect(activateIdx).toBeLessThan(restartIdx)
  })

  it('zeroDowntime: false opts a ported site back into the restart flow', () => {
    const joined = buildSiteDeployScript({ ...portless, siteName: 'web', port: 3000, zeroDowntime: false }).join('\n')
    expect(joined).toContain('systemctl restart my-app-web.service')
    expect(joined).not.toContain('my-app-web@')
  })

  it('portless sites ignore zeroDowntime: true (overlap would double-process)', () => {
    const joined = buildSiteDeployScript({ ...portless, zeroDowntime: true }).join('\n')
    expect(joined).toContain('systemctl restart my-app-worker.service')
    expect(joined).not.toContain('my-app-worker@')
  })
})

describe('buildStaticSiteDeployScript (zero-downtime atomic release)', () => {
  const opts = {
    siteName: 'docs',
    artifactFetch: buildLocalArtifactFetch('/tmp/staging.tar.gz', '/tmp/docs-rel9-release.tar.gz'),
    releaseId: 'rel9',
  }

  it('unpacks into a release dir and swaps current atomically — no empty-docroot window, no restart', () => {
    const script = buildStaticSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(joined).toContain('tar xzf /tmp/docs-rel9-release.tar.gz -C /var/www/docs/releases/rel9')
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
    expect(buildAwsArtifactFetch('my-app-production-deploy', 'releases/web/abc.tar.gz', 'us-east-1', '/tmp/my-app-web-abc-release.tar.gz'))
      .toEqual([
        'aws s3 cp "s3://my-app-production-deploy/releases/web/abc.tar.gz" /tmp/my-app-web-abc-release.tar.gz --region us-east-1',
      ])
  })
})

describe('releaseTarballTmpPath', () => {
  it('namespaces the staged tarball by slug, site, and release id (shared-box safe)', () => {
    expect(releaseTarballTmpPath('my-app', 'web', 'abc123')).toBe('/tmp/my-app-web-abc123-release.tar.gz')
    expect(releaseTarballTmpPath(undefined, 'docs', 'rel9')).toBe('/tmp/docs-rel9-release.tar.gz')
  })
})
