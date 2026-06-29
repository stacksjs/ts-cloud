import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { CloudConfig, CloudDriver } from '@ts-cloud/core'
import { deployAllComputeSites, deploySiteRelease, reloadRpxGateway } from '../../src/drivers/shared/compute-deploy'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const config: CloudConfig = {
  project: { name: 'App', slug: 'my-app', region: 'us-east-1' },
  environments: { production: { type: 'production' } },
  sites: {
    web: {
      domain: 'my-app.example.com',
      port: 3000,
      root: '.output',
      start: 'bun run server.ts',
      env: { NODE_ENV: 'production' },
    },
  },
}

function createMockDriver(overrides: Partial<CloudDriver> = {}): CloudDriver {
  return {
    name: 'aws',
    usesCloudFormation: true,
    getComputeOutputs: mock(async () => ({
      deployBucketName: 'my-app-production-deploy',
      appPublicIp: '203.0.113.1',
    })),
    uploadRelease: mock(async () => ({ artifactRef: 's3://my-app-production-deploy/releases/web/abc.tar.gz' })),
    findComputeTargets: mock(async () => [{
      id: 'i-abc123',
      publicIp: '203.0.113.1',
      status: 'running',
    }]),
    runRemoteDeploy: mock(async () => ({
      success: true,
      instanceCount: 1,
      perInstance: [{ instanceId: 'i-abc123', status: 'Success' }],
    })),
    ...overrides,
  } as CloudDriver
}

describe('deploySiteRelease', () => {
  it('uploads artifact and runs remote deploy script on targets', async () => {
    const driver = createMockDriver()
    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const tarball = join(tempDir, 'release.tar.gz')
    writeFileSync(tarball, 'fake tarball')

    const result = await deploySiteRelease(driver, {
      config,
      environment: 'production',
      siteName: 'web',
      site: config.sites!.web,
      slug: 'my-app',
      sha: 'abc123',
      runtime: 'bun',
      localTarballPath: tarball,
    })

    expect(result.success).toBe(true)
    expect(result.instanceCount).toBe(1)
    expect(driver.uploadRelease).toHaveBeenCalled()
    expect(driver.runRemoteDeploy).toHaveBeenCalled()

    const deployCall = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls[0][0]
    expect(deployCall.tags).toEqual({
      Project: 'my-app',
      Environment: 'production',
      Role: 'app',
    })
    expect(deployCall.commands.join('\n')).toContain('aws s3 cp "s3://my-app-production-deploy/releases/web/abc123.tar.gz"')
    expect(deployCall.commands.join('\n')).toContain('systemctl restart my-app-web.service')
    expect(deployCall.commands.join('\n')).toContain('/var/www/web/.ts-cloud/deploy-history.log')
    expect(deployCall.commands.join('\n')).toContain('ts_cloud_record_deploy')
  })

  it('uses local artifact fetch for hetzner driver', async () => {
    const driver = createMockDriver({
      name: 'hetzner',
      usesCloudFormation: false,
      getComputeOutputs: mock(async () => ({
        deployStoragePath: '/var/ts-cloud/staging',
      })),
      uploadRelease: mock(async () => ({ artifactRef: '/var/ts-cloud/staging/web-abc.tar.gz' })),
    })

    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const tarball = join(tempDir, 'release.tar.gz')
    writeFileSync(tarball, 'fake tarball')

    await deploySiteRelease(driver, {
      config,
      environment: 'production',
      siteName: 'web',
      site: config.sites!.web,
      slug: 'my-app',
      sha: 'abc123',
      runtime: 'bun',
      localTarballPath: tarball,
    })

    const deployCall = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls[0][0]
    expect(deployCall.commands.join('\n')).toContain('cp "/var/ts-cloud/staging/web-abc.tar.gz" /tmp/web-release.tar.gz')
    expect(deployCall.commands.join('\n')).not.toContain('aws s3 cp')
  })

  it('serves a static site (e.g. the UI) behind nginx + htpasswd', async () => {
    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const tarball = join(tempDir, 'release.tar.gz')
    writeFileSync(tarball, 'fake tarball')

    const uiConfig: CloudConfig = {
      project: { name: 'App', slug: 'my-app', region: 'us-east-1' },
      environments: { production: { type: 'production' } },
      infrastructure: { compute: { webServer: 'nginx' } },
      sites: {
        dashboard: {
          root: 'packages/ui/dist',
          deploy: 'server',
          type: 'static',
          domain: 'dashboard.example.com',
          auth: { username: 'admin', password: 's3cret' },
        },
      },
    }

    await deploySiteRelease(driver, {
      config: uiConfig,
      environment: 'production',
      siteName: 'dashboard',
      site: uiConfig.sites!.dashboard,
      slug: 'my-app',
      sha: 'abc123',
      runtime: 'bun',
      localTarballPath: tarball,
    })

    const commands = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls[0][0].commands.join('\n')
    expect(commands).toContain('/etc/nginx/sites-available/dashboard')
    expect(commands).toContain('auth_basic_user_file /etc/nginx/.htpasswd-dashboard;')
    expect(commands).toContain("openssl passwd -apr1 's3cret'")
    expect(commands).toContain('--nginx')
  })

  it('returns failure when no compute targets exist', async () => {
    const driver = createMockDriver({
      findComputeTargets: mock(async () => []),
    })

    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const tarball = join(tempDir, 'release.tar.gz')
    writeFileSync(tarball, 'fake tarball')

    const result = await deploySiteRelease(driver, {
      config,
      environment: 'production',
      siteName: 'web',
      site: config.sites!.web,
      slug: 'my-app',
      sha: 'abc123',
      runtime: 'bun',
      localTarballPath: tarball,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('no EC2 instances tagged')
  })
})

describe('reloadRpxGateway', () => {
  const rpxConfig: CloudConfig = {
    project: { name: 'App', slug: 'my-app', region: 'fsn1' },
    environments: { production: { type: 'production' } },
    sites: {
      web: { domain: 'my-app.example.com', port: 3000, root: '.output', start: 'bun run server.ts' },
    },
    infrastructure: {
      compute: { runtime: 'bun', proxy: { engine: 'rpx' } },
    },
  }

  it('is a no-op when no proxy engine is configured', async () => {
    const driver = createMockDriver()
    const ok = await reloadRpxGateway({
      config,
      environment: 'production',
      driver,
      sha: 'abc',
      runtime: 'bun',
      tarballForSite: () => '/tmp/x.tar.gz',
    })
    expect(ok).toBe(true)
    expect(driver.runRemoteDeploy).not.toHaveBeenCalled()
  })

  it('regenerates and reloads the rpx gateway when engine is rpx', async () => {
    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    const ok = await reloadRpxGateway({
      config: rpxConfig,
      environment: 'production',
      driver,
      sha: 'abc',
      runtime: 'bun',
      tarballForSite: () => '/tmp/x.tar.gz',
    })
    expect(ok).toBe(true)
    expect(driver.runRemoteDeploy).toHaveBeenCalled()
    const call = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls[0][0]
    expect(call.commands.join('\n')).toContain('bun add @stacksjs/rpx')
    expect(call.commands.join('\n')).toContain('rpx-gateway.service')
    expect(call.commands.join('\n')).toContain('localhost:3000')
  })
})

describe('deployAllComputeSites with rpx gateway', () => {
  const rpxConfig: CloudConfig = {
    project: { name: 'App', slug: 'my-app', region: 'fsn1' },
    environments: { production: { type: 'production' } },
    sites: {
      web: { domain: 'my-app.example.com', port: 3000, root: '.output', start: 'bun run server.ts' },
    },
    infrastructure: {
      compute: { runtime: 'bun', proxy: { engine: 'rpx' } },
    },
  }

  it('reloads the gateway after shipping sites', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const tarball = join(tempDir, 'release.tar.gz')
    writeFileSync(tarball, 'fake tarball')

    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    // Keep this test focused on the gateway reload — opt out of the auto-injected
    // management dashboard so the call count stays deterministic.
    process.env.TS_CLOUD_UI_DISABLE = '1'
    let ok: boolean
    try {
      ok = await deployAllComputeSites({
        config: rpxConfig,
        environment: 'production',
        driver,
        sha: 'abc',
        runtime: 'bun',
        tarballForSite: () => tarball,
      })
    }
    finally { delete process.env.TS_CLOUD_UI_DISABLE }
    expect(ok).toBe(true)
    // One deploy call for the site + one for the gateway reload.
    const calls = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls
    expect(calls.length).toBe(2)
    expect(calls[1][0].commands.join('\n')).toContain('rpx-gateway.service')
  })
})

describe('deployAllComputeSites auto-injects the management dashboard', () => {
  function baseConfig(): CloudConfig {
    return {
      project: { name: 'App', slug: 'my-app', region: 'fsn1' },
      environments: { production: { type: 'production' } },
      sites: { web: { domain: 'my-app.example.com', port: 3000, root: '.output', start: 'bun run server.ts' } },
      infrastructure: { compute: { runtime: 'bun', webServer: 'rpx', proxy: { engine: 'rpx' } } },
    }
  }

  afterEach(() => { delete process.env.TS_CLOUD_UI_DISABLE })

  it('injects, builds, and ships the dashboard for a driver-API consumer (e.g. Stacks)', async () => {
    // The repo root has packages/ui, so resolveUiSource finds + builds it. The
    // consumer never injects nor builds the dashboard — the shared path must.
    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const webTar = join(tempDir, 'web.tar.gz')
    writeFileSync(webTar, 'fake tarball')

    const config = baseConfig()
    const ok = await deployAllComputeSites({
      config,
      environment: 'production',
      driver,
      sha: 'abc',
      runtime: 'bun',
      cwd: process.cwd(),
      // The consumer only knows about its own sites — not the dashboard.
      tarballForSite: (name) => { if (name === 'web') return webTar; throw new Error(`Missing tarball for site '${name}'`) },
    })

    expect(ok).toBe(true)
    expect((config.sites as any).dashboard?.domain).toBe('dashboard.example.com')
    const allCommands = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls.map(c => c[0].commands.join('\n'))
    expect(allCommands.some(c => c.includes('/var/www/dashboard'))).toBe(true)
  }, 60_000)

  it('is a no-op when TS_CLOUD_UI_DISABLE is set', async () => {
    process.env.TS_CLOUD_UI_DISABLE = '1'
    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const webTar = join(tempDir, 'web.tar.gz')
    writeFileSync(webTar, 'fake tarball')

    const config = baseConfig()
    const ok = await deployAllComputeSites({
      config, environment: 'production', driver, sha: 'abc', runtime: 'bun', cwd: process.cwd(),
      tarballForSite: () => webTar,
    })

    expect(ok).toBe(true)
    expect((config.sites as any).dashboard).toBeUndefined()
  })

  it('skips the dashboard gracefully (deploy still succeeds) when its UI cannot be built', async () => {
    // A fake packages/ui (no real stx/deps) so injection happens but the build
    // fails — the dashboard must be dropped without failing the app deploy.
    const fakeRepo = mkdtempSync(join(tmpdir(), 'ts-cloud-fakeui-'))
    mkdirSync(join(fakeRepo, 'packages', 'ui', 'pages'), { recursive: true })
    writeFileSync(join(fakeRepo, 'packages', 'ui', 'package.json'), '{"name":"@ts-cloud/ui"}')
    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const webTar = join(tempDir, 'web.tar.gz')
    writeFileSync(webTar, 'fake tarball')

    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    const config = baseConfig()
    const ok = await deployAllComputeSites({
      config, environment: 'production', driver, sha: 'abc', runtime: 'bun', cwd: fakeRepo,
      tarballForSite: (name) => { if (name === 'web') return webTar; throw new Error(`Missing tarball for site '${name}'`) },
    })

    expect(ok).toBe(true)
    // Injected then dropped because the build failed → no dashboard left behind.
    expect((config.sites as any).dashboard).toBeUndefined()
    const allCommands = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls.map(c => c[0].commands.join('\n'))
    expect(allCommands.some(c => c.includes('/var/www/dashboard'))).toBe(false)
    rmSync(fakeRepo, { recursive: true, force: true })
  }, 60_000)
})
