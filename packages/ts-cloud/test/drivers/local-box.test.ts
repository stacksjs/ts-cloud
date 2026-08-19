import type { CloudConfig } from '@ts-cloud/core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCloudDriver } from '../../src/drivers/factory'
import { isBoxMode, LocalBoxDriver } from '../../src/drivers/local-box/driver'

// `TS_CLOUD_DASHBOARD_BOX` is process-global. Clear it BEFORE and after each test
// so a value leaked by another test file (order varies across CI runs) can never
// flip the box-mode gate under us.
beforeEach(() => {
  delete process.env.TS_CLOUD_DASHBOARD_BOX
})
afterEach(() => {
  delete process.env.TS_CLOUD_DASHBOARD_BOX
})

// `hetzner.apiToken` is required by HetznerDriver's constructor. Set it here
// rather than relying on an ambient HCLOUD_TOKEN/HETZNER_API_TOKEN env var,
// which isn't present in CI and made this config unusable for constructing a
// real provider driver.
const config = {
  project: { name: 'a', slug: 'acme', region: 'us-east-1' },
  cloud: { provider: 'hetzner' },
  hetzner: { apiToken: 'test-token' },
} as unknown as CloudConfig

describe('LocalBoxDriver', () => {
  const driver = new LocalBoxDriver()

  it('reports a single localhost target', async () => {
    const targets = await driver.findComputeTargets({ slug: 'acme', environment: 'production' as any })
    expect(targets).toHaveLength(1)
    expect(targets[0].id).toBe('localhost')
    expect(targets[0].publicIp).toBe('127.0.0.1')
  })

  it('answers only app-role target queries — a local box has no separate lb/services box', async () => {
    // The rpx fleet-LB reload first probes for 'lb' targets; localhost must not
    // pose as one, or the gateway reload would take the fleet path on a plain box.
    expect(
      await driver.findComputeTargets({ slug: 'acme', environment: 'production' as any, role: 'app' }),
    ).toHaveLength(1)
    expect(await driver.findComputeTargets({ slug: 'acme', environment: 'production' as any, role: 'lb' })).toEqual([])
    expect(
      await driver.findComputeTargets({ slug: 'acme', environment: 'production' as any, role: 'services' }),
    ).toEqual([])
  })

  it('runs commands on the local machine and captures stdout + success', async () => {
    const result = await driver.runRemoteDeploy({ targets: [], commands: ['echo TS_CLOUD_LOCAL_OK', 'echo second'] })
    expect(result.success).toBe(true)
    expect(result.instanceCount).toBe(1)
    expect(result.perInstance[0].status).toBe('Success')
    expect(result.perInstance[0].output).toContain('TS_CLOUD_LOCAL_OK')
    expect(result.perInstance[0].output).toContain('second')
  })

  it('reports failure and stderr for a failing command', async () => {
    const result = await driver.runRemoteDeploy({ targets: [], commands: ['echo to-stderr 1>&2', 'exit 3'] })
    expect(result.success).toBe(false)
    expect(result.perInstance[0].status).toBe('Failed')
    expect(result.perInstance[0].error).toContain('to-stderr')
  })
})

describe('box mode gate', () => {
  it('isBoxMode reflects the env flag', () => {
    expect(isBoxMode()).toBe(false)
    process.env.TS_CLOUD_DASHBOARD_BOX = '1'
    expect(isBoxMode()).toBe(true)
    process.env.TS_CLOUD_DASHBOARD_BOX = '0'
    expect(isBoxMode()).toBe(false)
  })

  it('createCloudDriver returns the LocalBoxDriver in box mode regardless of provider', () => {
    process.env.TS_CLOUD_DASHBOARD_BOX = '1'
    expect(createCloudDriver({ config })).toBeInstanceOf(LocalBoxDriver)
  })

  it('createCloudDriver returns the configured provider driver otherwise', () => {
    expect(createCloudDriver({ config })).not.toBeInstanceOf(LocalBoxDriver)
  })
})
