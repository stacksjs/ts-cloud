import type { CloudConfig, CloudProviderContract } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { buildAwsUserData } from '../../src/drivers/aws/provision'
import { generateUbuntuAppCloudInit } from '../../src/drivers/hetzner/cloud-init'

type ResilienceRenderer = (config: CloudConfig) => string

const renderers = {
  aws: buildAwsUserData,
  hetzner: (config) =>
    generateUbuntuAppCloudInit({
      runtime: config.infrastructure?.compute?.runtime,
      swapGb: config.infrastructure?.compute?.swapGb,
    }),
} satisfies CloudProviderContract<ResilienceRenderer>

describe('compute resilience provider contract', () => {
  it('provisions configured swap on every compute provider', () => {
    const config: CloudConfig = {
      project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
      environments: { production: { type: 'production' } },
      infrastructure: { compute: { runtime: 'bun', swapGb: 3 } },
    }

    for (const render of Object.values(renderers)) expect(render(config)).toContain('fallocate -l 3G /swapfile')
  })
})
