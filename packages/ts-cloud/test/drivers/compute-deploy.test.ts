import { describe, expect, it, mock } from 'bun:test'
import type { CloudConfig, CloudDriver } from '@ts-cloud/core'
import { deploySiteRelease } from '../../src/drivers/shared/compute-deploy'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
