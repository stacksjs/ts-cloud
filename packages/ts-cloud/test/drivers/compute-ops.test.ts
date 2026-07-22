import type { CloudDriver } from '@ts-cloud/core'
import { describe, expect, it, mock } from 'bun:test'
import { getComputeDeployHistory, rollbackComputeSite, runComputeRecipe } from '../../src/drivers/shared/compute-ops'

function mockDriver(targets = [{ id: 'srv-1', publicIp: '203.0.113.1', status: 'running' }]) {
  return {
    name: 'hetzner',
    usesCloudFormation: false,
    getComputeOutputs: mock(async () => ({})),
    uploadRelease: mock(async () => ({ artifactRef: '' })),
    findComputeTargets: mock(async () => targets),
    runRemoteDeploy: mock(async () => ({
      success: true,
      instanceCount: targets.length,
      perInstance: targets.map((t) => ({ instanceId: t.id, status: 'Success', output: 'ok' })),
    })),
  } as unknown as CloudDriver
}

const ctx = (driver: CloudDriver) => ({ driver, slug: 'acme', environment: 'production' as const })

describe('rollbackComputeSite', () => {
  it('rolls back to the previous release and reloads php-fpm + queues', async () => {
    const driver = mockDriver()
    const res = await rollbackComputeSite(ctx(driver), { siteName: 'main' })
    expect(res.success).toBe(true)
    const cmd = (driver.runRemoteDeploy as any).mock.calls[0][0].commands.join('\n')
    expect(cmd).toContain('no previous release to roll back to')
    expect(cmd).toContain('pantry restart php-fpm')
    expect(cmd).toContain('php artisan queue:restart')
  })

  it('targets a specific release id when --to is given', async () => {
    const driver = mockDriver()
    await rollbackComputeSite(ctx(driver), { siteName: 'main', to: 'r-42' })
    const cmd = (driver.runRemoteDeploy as any).mock.calls[0][0].commands.join('\n')
    expect(cmd).toContain('[ -d /var/www/acme-main/releases/r-42 ]')
    expect(cmd).toContain('mv -Tf /var/www/acme-main/current.tmp /var/www/acme-main/current')
  })

  it('errors clearly when no servers are found', async () => {
    const driver = mockDriver([])
    const res = await rollbackComputeSite(ctx(driver), { siteName: 'main' })
    expect(res.success).toBe(false)
    expect(res.error).toContain("No 'app' servers found")
  })
})

describe('getComputeDeployHistory', () => {
  it('tails the on-box deploy history log', async () => {
    const driver = mockDriver()
    const res = await getComputeDeployHistory(ctx(driver), { siteName: 'main', limit: 5 })
    expect(res.success).toBe(true)
    const cmd = (driver.runRemoteDeploy as any).mock.calls[0][0].commands.join('\n')
    expect(cmd).toContain('tail -n 5 /var/www/acme-main/.ts-cloud/deploy-history.log')
  })
})

describe('runComputeRecipe', () => {
  it('runs the recipe body across servers with markers', async () => {
    const driver = mockDriver()
    const res = await runComputeRecipe(ctx(driver), {
      name: 'clear-cache',
      script: ['php artisan cache:clear'],
      user: 'www-data',
    })
    expect(res.success).toBe(true)
    const cmd = (driver.runRemoteDeploy as any).mock.calls[0][0].commands.join('\n')
    expect(cmd).toContain('__TS_CLOUD_RECIPE_BEGIN__ clear-cache (user=www-data)')
    expect(cmd).toContain('php artisan cache:clear')
  })
})
