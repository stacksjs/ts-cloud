import type { CloudConfig, ServerlessAppConfig } from '../types'
import { describe, expect, it } from 'bun:test'
import {
  resolveServerlessAppStackName,
  resolveServerlessArtifactBucketName,
  resolveServerlessAssetBucketName,
} from '../stack-naming'

const config = { project: { name: 'Demo', slug: 'demo' } } as Pick<CloudConfig, 'project'>

describe('serverless stack/bucket naming', () => {
  it('derives the app stack name per environment', () => {
    expect(resolveServerlessAppStackName(config, 'production')).toBe('demo-production-app')
    expect(resolveServerlessAppStackName(config, 'staging')).toBe('demo-staging-app')
  })

  it('derives artifact + asset bucket names', () => {
    expect(resolveServerlessArtifactBucketName('demo', 'production')).toBe('demo-production-deployments')
    expect(resolveServerlessAssetBucketName('demo', 'staging')).toBe('demo-staging-assets')
  })
})

describe('ServerlessAppConfig typing', () => {
  it('accepts a Vapor-style manifest on an environment', () => {
    const app: ServerlessAppConfig = {
      runtime: 'nodejs20.x',
      kind: 'node',
      entry: 'src/server.ts',
      memory: 1024,
      timeout: 28,
      gatewayVersion: 2,
      queues: true,
      scheduler: 'on',
      build: ['bun install', 'bun run build'],
      deploy: ['migrate'],
      warm: 2,
    }

    expect(app.entry).toBe('src/server.ts')
    expect(app.queues).toBe(true)
  })

  it('accepts a PHP/Laravel manifest', () => {
    const app: ServerlessAppConfig = {
      runtime: 'provided.al2023',
      kind: 'php',
      phpVersion: '8.3',
      architecture: 'x86_64',
      octane: false,
      queues: [{ emails: 10 }, 'invoices'],
      scheduler: 'sub-minute',
    }

    expect(app.kind).toBe('php')
    expect(Array.isArray(app.queues)).toBe(true)
  })
})
