import { describe, expect, it } from 'bun:test'
import type { CloudConfig } from '../src/types'
import { resolveCloudProvider } from '../src/drivers/types'

describe('resolveCloudProvider', () => {
  const baseConfig: CloudConfig = {
    project: { name: 'App', slug: 'app', region: 'us-east-1' },
    environments: { production: { type: 'production' } },
  }

  it('defaults to aws when no provider is configured', () => {
    expect(resolveCloudProvider(baseConfig)).toBe('aws')
  })

  it('respects cloud.provider in config', () => {
    expect(
      resolveCloudProvider({
        ...baseConfig,
        cloud: { provider: 'hetzner' },
      }),
    ).toBe('hetzner')
  })

  it('auto-detects hetzner from hetzner.apiToken', () => {
    expect(
      resolveCloudProvider({
        ...baseConfig,
        hetzner: { apiToken: 'test-token' },
      }),
    ).toBe('hetzner')
  })
})
