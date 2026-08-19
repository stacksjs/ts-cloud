import { describe, expect, it } from 'bun:test'
import type { RuntimeWorkload } from '../../src/runtime'
import { capabilities } from '../../src/runtime'
import { runtimeRows } from './runtime'

describe('runtime CLI rows', () => {
  it('renders provider-neutral inventory without secret config values', () => {
    const workload = {
      id: 'docker:box:abc',
      provider: 'docker',
      kind: 'container',
      name: 'api',
      status: 'running',
      desiredReplicas: 2,
      runningReplicas: 1,
      image: 'acme/api@sha256:1',
      ageSeconds: 3600,
      tags: {},
      links: {},
      resources: { memoryBytes: 1024 },
      replicas: [],
      networks: [],
      mounts: [],
      capabilities: capabilities([], 'none'),
      config: { password: '[REDACTED]' },
      discoveredAt: '',
      sourceId: 'docker:box',
    } as RuntimeWorkload
    expect(runtimeRows([workload])).toEqual([
      ['docker:box:abc', 'api', 'docker', 'container', 'running', '1/2', 'acme/api@sha256:1', '1 KB', '1h'],
    ])
    expect(JSON.stringify(runtimeRows([workload]))).not.toContain('password')
  })
})
