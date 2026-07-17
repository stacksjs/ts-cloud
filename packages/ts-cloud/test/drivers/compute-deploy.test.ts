import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { CloudConfig, CloudDriver } from '@ts-cloud/core'
import { deriveManagementDashboardPort } from '@ts-cloud/core'
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
    // Role-aware like a real single-box driver: only the app role resolves —
    // there is no dedicated lb box for the gateway-reload fleet probe to find.
    findComputeTargets: mock(async (options?: { role?: string }) => {
      if (options?.role && options.role !== 'app')
        return []
      return [{
        id: 'i-abc123',
        publicIp: '203.0.113.1',
        status: 'running',
      }]
    }),
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
    expect(deployCall.commands.join('\n')).toContain('systemctl start my-app-web@abc123.service')
    expect(deployCall.commands.join('\n')).toContain('/var/www/my-app-web/.ts-cloud/deploy-history.log')
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
    expect(deployCall.commands.join('\n')).toContain('cp "/var/ts-cloud/staging/web-abc.tar.gz" /tmp/my-app-web-abc123-release.tar.gz')
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
          domain: 'dashboard.my-app.example.com',
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

  // Production-incident regression: a single-site deploy passes a `config`
  // narrowed to that one site, but the rpx gateway MUST be regenerated from the
  // FULL site model (`rpxConfig`) or it drops every other site's route.
  it('regenerates the gateway from the full rpxConfig, never the narrowed config', async () => {
    const full: CloudConfig = {
      ...rpxConfig,
      sites: {
        web: rpxConfig.sites!.web,
        api: { domain: 'api.example.com', port: 3008, root: '.output', start: 'bun run api.ts' },
        docs: { domain: 'docs.example.com', port: 3001, root: '.output', start: 'bun run docs.ts' },
      },
    }
    // Simulate `--site web`: config carries only the one site being shipped.
    const narrowed: CloudConfig = { ...full, sites: { web: full.sites!.web } }
    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    const ok = await reloadRpxGateway({
      config: narrowed,
      rpxConfig: full,
      environment: 'production',
      driver,
      sha: 'abc',
      runtime: 'bun',
      tarballForSite: () => '/tmp/x.tar.gz',
    })
    expect(ok).toBe(true)
    const script = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls[0][0].commands.join('\n')
    // All three upstreams present — the other sites' routes are NOT dropped.
    expect(script).toContain('localhost:3000')
    expect(script).toContain('localhost:3008')
    expect(script).toContain('localhost:3001')
  })

  // Fleet regression: the reload used to run the single-box provision script on
  // the APP targets — installing a pointless gateway on boxes designed to run
  // none — while the dedicated LB box kept its first-boot routes forever.
  it('refreshes the dedicated load balancer with the multi-upstream fragment when an lb target exists', async () => {
    const driver = createMockDriver({
      name: 'hetzner',
      usesCloudFormation: false,
      findComputeTargets: mock(async (options?: { role?: string }) => {
        if (options?.role === 'lb') {
          return [{
            id: '55',
            name: 'my-app-production-lb',
            publicIp: '203.0.113.55',
            privateIp: '10.0.0.55',
            status: 'running',
          }]
        }
        return [
          { id: '51', name: 'my-app-production-app-1', publicIp: '203.0.113.51', privateIp: '10.0.0.51', status: 'running' },
          { id: '52', name: 'my-app-production-app-2', publicIp: '203.0.113.52', privateIp: '10.0.0.52', status: 'running' },
        ]
      }),
    })

    const ok = await reloadRpxGateway({
      config: rpxConfig,
      environment: 'production',
      driver,
      sha: 'abc',
      runtime: 'bun',
      tarballForSite: () => '/tmp/x.tar.gz',
    })

    expect(ok).toBe(true)
    expect(driver.runRemoteDeploy).toHaveBeenCalledTimes(1)
    const call = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls[0][0]
    // Only the LB box is targeted — never the app boxes.
    expect(call.targets).toHaveLength(1)
    expect(call.targets[0].id).toBe('55')
    expect(call.tags).toEqual({ Project: 'my-app', Environment: 'production', Role: 'lb' })
    const script = call.commands.join('\n')
    // The LB's fragment is rewritten with one upstream per app box (private IPs).
    expect(script).toContain('/etc/rpx/sites.d/my-app.json')
    expect(script).toContain('10.0.0.51:3000')
    expect(script).toContain('10.0.0.52:3000')
    expect(script).not.toContain('localhost:3000')
    expect(script).toContain('systemctl restart rpx-gateway.service')
    // A reload, not a reinstall: the gateway stack itself is left untouched.
    expect(script).not.toContain('bun add @stacksjs/rpx')
    expect(script).not.toContain('/etc/systemd/system/rpx-gateway.service')
  })

  it('falls back to the single-box app-target reload when no lb target exists', async () => {
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
    // The lb probe ran first (and found nothing on a single-box driver)…
    const findCalls = (driver.findComputeTargets as ReturnType<typeof mock>).mock.calls.map(c => c[0])
    expect(findCalls[0]).toMatchObject({ role: 'lb' })
    expect(findCalls.some(c => c?.role === 'app')).toBe(true)
    // …then the full provision script ran on the app targets, as before.
    const call = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls[0][0]
    expect(call.targets[0].id).toBe('i-abc123')
    expect(call.tags.Role).toBe('app')
    expect(call.commands.join('\n')).toContain('bun add @stacksjs/rpx')
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
    // Domain-keyed site key — never the bare `dashboard`, which would collide
    // across tenants sharing a box via attachTo.
    expect((config.sites as any)['dashboard-my-app-example-com']?.domain).toBe('dashboard.my-app.example.com')
    expect((config.sites as any).dashboard).toBeUndefined()
    const allCommands = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls.map(c => c[0].commands.join('\n'))
    expect(allCommands.some(c => c.includes('/var/www/my-app-dashboard-my-app-example-com'))).toBe(true)
    // Every site deploy is ownership-guarded so another attachTo tenant deriving
    // the same site key is refused instead of overwriting releases.
    expect(allCommands.some(c => c.includes('/var/www/my-app-web/.ts-cloud/owner'))).toBe(true)
    expect(allCommands.some(c => c.includes('/var/www/my-app-dashboard-my-app-example-com/.ts-cloud/owner'))).toBe(true)
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
    expect((config.sites as any)['dashboard-my-app-example-com']).toBeUndefined()
  })

  it('deploys the dashboard as a live service by default', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ts-cloud-liveui-'))
    const tempDir = mkdtempSync(join(tmpdir(), 'ts-cloud-deploy-'))
    const webTar = join(tempDir, 'web.tar.gz')
    writeFileSync(webTar, 'fake tarball')

    const driver = createMockDriver({ name: 'hetzner', usesCloudFormation: false })
    const config = baseConfig()
    const ok = await deployAllComputeSites({
      config, environment: 'production', driver, sha: 'abc', runtime: 'bun', cwd: repo,
      tarballForSite: () => webTar,
    })

    expect(ok).toBe(true)
    const dashboard = (config.sites as any)['dashboard-my-app-example-com']
    expect(dashboard).toBeTruthy()
    // A service, not static files behind htpasswd. Port is derived per dashboard
    // host so two apps on one box never collide.
    expect(dashboard.port).toBe(deriveManagementDashboardPort(dashboard.domain))
    expect(dashboard.auth).toBeUndefined()

    const allCommands = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls.map(c => c[0].commands.join('\n'))
    const dashboardCommands = allCommands.filter(c => c.includes('dashboard-my-app-example-com'))
    expect(dashboardCommands.length).toBeGreaterThan(0)
    const text = dashboardCommands.join('\n')
    // Installs the CLI, runs it by module path, and keeps its state in shared/.
    expect(text).toContain('bun install --production --no-save')
    expect(text).toContain('node_modules/@stacksjs/ts-cloud/dist/bin/cli.js dashboard:serve --box')
    expect(text).toContain('shared/.ts-cloud')
    rmSync(repo, { recursive: true, force: true })
  }, 60_000)

  it('skips the dashboard gracefully (deploy still succeeds) when its UI cannot be built (static mode)', async () => {
    // A fake packages/ui (no real stx/deps) so injection happens but the build
    // fails — the dashboard must be dropped without failing the app deploy.
    process.env.TS_CLOUD_UI_STATIC = '1'
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
    expect((config.sites as any)['dashboard-my-app-example-com']).toBeUndefined()
    const allCommands = (driver.runRemoteDeploy as ReturnType<typeof mock>).mock.calls.map(c => c[0].commands.join('\n'))
    expect(allCommands.some(c => c.includes('/var/www/dashboard'))).toBe(false)
    rmSync(fakeRepo, { recursive: true, force: true })
    delete process.env.TS_CLOUD_UI_STATIC
  }, 60_000)
})
