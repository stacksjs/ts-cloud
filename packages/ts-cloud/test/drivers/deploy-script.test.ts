import { describe, expect, it } from 'bun:test'
import {
  buildAwsArtifactFetch,
  buildHostCleanupScript,
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
    artifactFetch: buildLocalArtifactFetch(
      '/var/ts-cloud/staging/release.tar.gz',
      '/tmp/my-app-web-abc123-release.tar.gz',
    ),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  it('unpacks into a release dir, links shared .env, and runs the release as its own templated instance', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    expect(script[0]).toBe('set -euo pipefail')
    expect(joined).toContain('mv "/var/ts-cloud/staging/release.tar.gz" /tmp/my-app-web-abc123-release.tar.gz')
    // Tarball goes into THIS release dir, never the live one.
    // Extraction goes to $TS_CLOUD_STAGED, which is the release dir itself
    // unless that dir is the one currently being served (see buildResetReleaseDir).
    expect(joined).toContain('tar xzf /tmp/my-app-web-abc123-release.tar.gz -C "$TS_CLOUD_STAGED"')
    expect(joined).toContain('rm -rf /var/www/web/releases/abc123.incoming')
    // .env persists in shared/ and is symlinked into the release.
    expect(joined).toContain('/var/www/web/shared/.env')
    expect(joined).toContain('ln -sfn /var/www/web/shared/.env /var/www/web/releases/abc123/.env')
    // Templated unit pinned to its release dir so old + new can overlap.
    expect(joined).toContain('/etc/systemd/system/my-app-web@.service')
    expect(joined).toContain('WorkingDirectory=/var/www/web/releases/%i')
    expect(joined).toContain('EnvironmentFile=/var/www/web/releases/%i/.env')
    expect(joined).toContain('Environment=PORT=3000')
    expect(joined).toContain('systemctl restart my-app-web@abc123.service')
    // Only the release-scoped instance is restarted. The shared legacy unit is
    // never bluntly restarted in the zero-downtime path.
    expect(joined).not.toContain('systemctl restart my-app-web.service')
  })

  it('contains an app leak inside its own cgroup instead of the whole box', () => {
    // A shared box runs many tenants. Unbounded, one that leaks fills memory
    // and swap and the kernel starts OOM-killing arbitrary victims, so a leak
    // in one app takes every other tenant down with it.
    const joined = buildSiteDeployScript(opts).join('\n')
    expect(joined).toContain('MemoryAccounting=true')
    expect(joined).toContain('MemoryHigh=2G')
    // Soft by default: a hard cap would turn a heavy-but-healthy app into a
    // restart loop, and the default has to be safe for unmeasured workloads.
    expect(joined).not.toContain('MemoryMax=')

    const tuned = buildSiteDeployScript({ ...opts, memoryHigh: '512M', memoryMax: '768M' }).join('\n')
    expect(tuned).toContain('MemoryHigh=512M')
    expect(tuned).toContain('MemoryMax=768M')
  })

  it('lets a site opt out of the memory ceiling', () => {
    const joined = buildSiteDeployScript({ ...opts, memoryHigh: 'infinity' }).join('\n')
    expect(joined).toContain('MemoryHigh=infinity')
  })

  it('health-gates the new instance BEFORE stopping the old one, and aborts without flipping current on failure', () => {
    const script = buildSiteDeployScript(opts)
    const startIdx = script.findIndex((l) => l === 'systemctl restart my-app-web@abc123.service')
    const gateIdx = script.findIndex((l) => l.includes('failed its health gate'))
    const activateIdx = script.findIndex((l) => l.includes('mv -Tf') && l.includes('/current'))
    const stopOldIdx = script.findIndex((l) => l.includes('for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}'))
    expect(startIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeGreaterThan(startIdx)
    // Old instances captured before the new one starts, stopped only after the gate + flip.
    const captureIdx = script.findIndex((l) => l.startsWith('TS_CLOUD_OLD_UNITS='))
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
    const healIdx = script.findIndex((l) => l.includes('could not overlap the previous release'))
    expect(healIdx).toBeGreaterThan(-1)
    expect(script[healIdx]).toContain('systemctl restart my-app-web@abc123.service')
    // The retry still aborts (exit 1) if the release is genuinely broken.
    expect(script[healIdx]).toContain('exit 1')
    // The self-heal loop uses its own var so it does not shadow the post-flip
    // stop-old loop (which must still run only after `current` is promoted).
    const activateIdx = script.findIndex((l) => l.includes('mv -Tf') && l.includes('/current'))
    const stopOldIdx = script.findIndex((l) => l.includes('for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}'))
    expect(healIdx).toBeLessThan(activateIdx)
    expect(activateIdx).toBeLessThan(stopOldIdx)
  })

  it('verifies the port is actually listening once the old instances are retired', () => {
    const script = buildSiteDeployScript(opts)
    const stopOldIdx = script.findIndex(l => l.includes('for TS_CLOUD_U in ${TS_CLOUD_OLD_UNITS}'))
    const listenIdx = script.findIndex(l => l.includes('TS_CLOUD_LISTENING=0'))

    // `is-active` reports a live process, not a bound socket. A server that
    // swallows its bind error stays active with nothing listening, and while
    // the old instance still holds the port every earlier check passes — so
    // the socket can only be trusted after the old instances are gone.
    expect(listenIdx).toBeGreaterThan(stopOldIdx)
    expect(script[listenIdx]).toContain('ss -ltnH "sport = :3000"')

    // Self-heal: the port is free now, so a restart binds it.
    const healIdx = script.findIndex(l => l.includes('nothing is listening on 3000'))
    expect(healIdx).toBeGreaterThan(listenIdx)
    expect(script[healIdx]).toContain('systemctl restart my-app-web@abc123.service')

    // A release that cannot bind an uncontended port still fails the deploy.
    const failIdx = script.findIndex(l => l.includes('never bound 3000'))
    expect(failIdx).toBeGreaterThan(healIdx)
    expect(script[failIdx]).toContain('exit 1')
  })

  it('polls the configured health path against the site port as part of the gate', () => {
    const script = buildSiteDeployScript({ ...opts, healthCheckPath: 'health' })
    const joined = script.join('\n')
    expect(joined).toContain('http://127.0.0.1:3000/health')
    const curlIdx = script.findIndex((l) => l.includes('curl -sf'))
    const activateIdx = script.findIndex((l) => l.includes('mv -Tf') && l.includes('/current'))
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
    expect(script.some((l) => l.includes('rm -rf "$TS_CLOUD_OLD"'))).toBe(true)
  })

  it('guards the unit prune grep so an empty match list cannot fail the deploy under set -euo pipefail', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')
    // The prune pipeline wraps grep in a brace group so `|| true` guards only
    // the grep — without it, grep exits 1 on "nothing to prune" and kills the
    // script at the very last step, after the new release is already live.
    expect(joined).toContain(
      '| { grep -v -e "^my-app-web@abc123.service$" -e "^my-app-web@\\.service$" || true; } | while read -r TS_CLOUD_U',
    )
    // Every `grep -v` in the generated script is guarded against exit 1.
    for (const line of script) {
      if (line.includes('grep -v')) expect(line).toContain('|| true')
    }
  })

  it('runs preStart in the new release dir after extraction, before the new instance starts', () => {
    const script = buildSiteDeployScript({
      ...opts,
      preStartCommands: ['bun install --frozen-lockfile', 'bun run build'],
    })
    const joined = script.join('\n')
    expect(joined).toContain('cd /var/www/web/releases/abc123')
    const extractIdx = script.findIndex((l) => l.includes('tar xzf'))
    const installIdx = script.findIndex((l) => l === 'bun install --frozen-lockfile')
    const startIdx = script.findIndex((l) => l === 'systemctl restart my-app-web@abc123.service')
    expect(extractIdx).toBeLessThan(installIdx)
    expect(installIdx).toBeLessThan(startIdx)
  })

  it('removes artifact env files before linking the resolved runtime env', () => {
    const script = buildSiteDeployScript(opts)
    const removeIdx = script.findIndex(line => line.startsWith('find /var/www/web/releases/abc123 '))
    const linkIdx = script.findIndex(line => line.includes('ln -sfn /var/www/web/shared/.env'))

    expect(removeIdx).toBeGreaterThan(-1)
    expect(script[removeIdx]).toContain("-name '.env*'")
    expect(script[removeIdx]).toContain("! -name '.env.example'")
    expect(removeIdx).toBeLessThan(linkIdx)
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
    const activateIdx = script.findIndex((l) => l.includes('mv -Tf') && l.includes('/current'))
    const restartIdx = script.findIndex((l) => l === 'systemctl restart my-app-worker.service')
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
    expect(joined).toContain('tar xzf /tmp/docs-rel9-release.tar.gz -C "$TS_CLOUD_STAGED"')
    expect(joined).toContain('rm -rf /var/www/docs/releases/rel9.incoming')
    expect(joined).toContain('mv -Tf /var/www/docs/current.tmp /var/www/docs/current')
    // No destructive wipe of the live docroot, and no systemd (static).
    expect(joined).not.toContain('find /var/www/docs -mindepth')
    expect(joined).not.toContain('systemctl')
    // Old releases pruned.
    expect(script.some((l) => l.includes('rm -rf "$TS_CLOUD_OLD"'))).toBe(true)
  })

  it('runs preStart (on-box build) in the release dir before the swap', () => {
    const script = buildStaticSiteDeployScript({ ...opts, preStartCommands: ['bun run docs:build'] })
    const buildIdx = script.findIndex((l) => l === 'bun run docs:build')
    const activateIdx = script.findIndex((l) => l.includes('mv -Tf') && l.includes('/current'))
    expect(buildIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeLessThan(activateIdx)
  })
})

describe('buildAwsArtifactFetch', () => {
  it('pulls tarball from S3 before extraction', () => {
    expect(
      buildAwsArtifactFetch(
        'my-app-production-deploy',
        'releases/web/abc.tar.gz',
        'us-east-1',
        '/tmp/my-app-web-abc-release.tar.gz',
      ),
    ).toEqual([
      'aws s3 cp "s3://my-app-production-deploy/releases/web/abc.tar.gz" /tmp/my-app-web-abc-release.tar.gz --region us-east-1',
    ])
  })
})

describe('buildHostCleanupScript', () => {
  it('bounds stale deploy data without touching active or rollback releases', () => {
    const joined = buildHostCleanupScript().join('\n')
    expect(joined).toContain('/var/ts-cloud/staging')
    expect(joined).toContain('-mmin +60')
    expect(joined).toContain('journalctl --vacuum-time=14d --vacuum-size=512M')
    expect(joined).toContain('docker image prune --all --force --filter "until=168h"')
    expect(joined).not.toContain('/var/www')
    expect(joined).not.toContain('releases/')
  })
})

describe('releaseTarballTmpPath', () => {
  it('namespaces the staged tarball by slug, site, and release id (shared-box safe)', () => {
    expect(releaseTarballTmpPath('my-app', 'web', 'abc123')).toBe('/tmp/my-app-web-abc123-release.tar.gz')
    expect(releaseTarballTmpPath(undefined, 'docs', 'rel9')).toBe('/tmp/docs-rel9-release.tar.gz')
  })
})

/**
 * Two deploys of one site used to be free to run at once, and the second one's
 * `rm -rf releases/<id>` ran against a tree the first was still extracting
 * into — which fails with "Directory not empty", an error that reads like a
 * permissions problem and is really a race. It is easy to hit: a deploy whose
 * client is interrupted keeps running on the box, the operator sees a dead
 * terminal and re-runs.
 */
describe('deploy concurrency and re-deploys of a live release', () => {
  const opts = {
    siteName: 'web',
    slug: 'my-app',
    artifactFetch: buildLocalArtifactFetch(
      '/var/ts-cloud/staging/release.tar.gz',
      '/tmp/my-app-web-abc123-release.tar.gz',
    ),
    releaseId: 'abc123',
    execStart: '/usr/local/bin/bun run server.ts',
    envEntries: { NODE_ENV: 'production' },
    port: 3000,
  }

  const opts2 = {
    siteName: 'docs',
    artifactFetch: buildLocalArtifactFetch('/tmp/staging.tar.gz', '/tmp/docs-rel9-release.tar.gz'),
    releaseId: 'rel9',
  }

  it('takes the site lock before touching anything', () => {
    const script = buildSiteDeployScript(opts)
    const joined = script.join('\n')

    expect(joined).toContain('/var/www/web/.ts-cloud/deploy.lock')
    expect(joined).toContain('flock -w 900 9')

    // Before the first destructive step, or it is not a guard.
    const lockIdx = script.findIndex(line => line.includes('flock -w'))
    const destructiveIdx = script.findIndex(line => line.includes('rm -rf /var/www/web/releases/abc123'))
    expect(lockIdx).toBeGreaterThanOrEqual(0)
    expect(destructiveIdx).toBeGreaterThan(lockIdx)
  })

  it('never deletes the release the site is currently serving', () => {
    const joined = buildSiteDeployScript(opts).join('\n')

    // The unconditional wipe is gone: the delete is now inside the branch that
    // runs only when `current` points somewhere else.
    // Both sides resolved before comparing — see the behaviour test for why a
    // literal comparison here silently deleted the live release.
    expect(joined).toContain('TS_CLOUD_LIVE_PATH="$(readlink -f /var/www/web/current 2>/dev/null || true)"')
    expect(joined).toContain('if [ "$TS_CLOUD_IS_LIVE" = "yes" ]; then')
    expect(joined).toContain('TS_CLOUD_STAGED=/var/www/web/releases/abc123.incoming')
    expect(joined).toMatch(/else\n\s*rm -rf \/var\/www\/web\/releases\/abc123/)
  })

  it('swaps a staged release into place with renames, not a delete-then-extract', () => {
    const joined = buildSiteDeployScript(opts).join('\n')

    expect(joined).toContain('mv /var/www/web/releases/abc123 /var/www/web/releases/abc123.previous')
    expect(joined).toContain('mv /var/www/web/releases/abc123.incoming /var/www/web/releases/abc123')
    expect(joined).toContain('rm -rf /var/www/web/releases/abc123.previous')
  })

  it('locks the static-site path too', () => {
    const joined = buildStaticSiteDeployScript(opts2).join('\n')

    expect(joined).toContain('/var/www/docs/.ts-cloud/deploy.lock')
    expect(joined).toContain('flock -w 900 9')
  })
})
