import type { CloudConfig, CloudDriver } from '@ts-cloud/core'
import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deployAllComputeSites } from '../../src/drivers/shared/compute-deploy'

function driver(): CloudDriver {
  return {
    name: 'hetzner',
    usesCloudFormation: false,
    getComputeOutputs: mock(async () => ({ deployStoragePath: '/var/ts-cloud/staging' })),
    uploadRelease: mock(async () => ({ artifactRef: '/var/ts-cloud/staging/x.tar.gz' })),
    findComputeTargets: mock(async () => [{ id: 'i-1', publicIp: '203.0.113.1', status: 'running' }]),
    runRemoteDeploy: mock(async () => ({ success: true, instanceCount: 1, perInstance: [{ instanceId: 'i-1', status: 'Success' }] })),
  } as unknown as CloudDriver
}

/** Full site list — what the proxy must keep routing. */
function fullConfig(): CloudConfig {
  return {
    project: { name: 'App', slug: 'app', region: 'fsn1' },
    environments: { production: { type: 'production' } },
    infrastructure: { compute: { runtime: 'bun', proxy: { engine: 'rpx' } } },
    sites: {
      web: { domain: 'app.com', port: 3000, root: '.output', start: 'bun run server.ts' },
      docs: { domain: 'app.com', path: '/docs', root: 'dist/docs', deploy: 'server', type: 'static' },
      blog: { domain: 'blog.app.com', root: 'dist/blog', deploy: 'server', type: 'static' },
    },
  } as unknown as CloudConfig
}

describe('single-site deploy keeps every route', () => {
  /**
   * A --site deploy narrows what is SHIPPED, never what is ROUTED. Regenerating
   * the gateway from the narrowed config would silently drop the other sites'
   * routes and take them offline.
   */
  it('regenerates the proxy from the FULL site list while shipping one site', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ts-cloud-onesite-'))
    const tar = join(repo, 'r.tar.gz')
    writeFileSync(tar, 'fake')

    const full = fullConfig()
    const narrowed = { ...full, sites: { web: full.sites!.web } } as CloudConfig

    const d = driver()
    const ok = await deployAllComputeSites({
      config: narrowed,
      rpxConfig: full,
      environment: 'production',
      driver: d,
      sha: 'abc',
      runtime: 'bun',
      cwd: repo,
      tarballForSite: () => tar,
    })
    expect(ok).toBe(true)

    const all = (d.runRemoteDeploy as ReturnType<typeof mock>).mock.calls.map(c => c[0].commands.join('\n')).join('\n')
    // The gateway config still carries the sites we did NOT deploy.
    expect(all).toContain('blog.app.com')
    expect(all).toContain('/docs')
  }, 60_000)
})
