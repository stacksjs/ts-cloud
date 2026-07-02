import type { CloudConfig } from '../src/types'
import { describe, expect, it } from 'bun:test'
import { deploymentCoexistenceError, detectDeploymentTargets, resolveDeploymentMode } from '../src/deployment-mode'

const serverConfig = {
  project: { name: 'A', slug: 'a', region: 'us-east-1' },
  infrastructure: { compute: { mode: 'server' } },
} as unknown as CloudConfig

const serverlessConfig = {
  project: { name: 'A', slug: 'a', region: 'us-east-1' },
  environments: { production: { type: 'production', app: { kind: 'bun' } } },
} as unknown as CloudConfig

const coexistConfig = {
  project: { name: 'A', slug: 'a', region: 'us-east-1' },
  infrastructure: { compute: { mode: 'server' } },
  environments: { production: { type: 'production', app: { kind: 'bun' } } },
} as unknown as CloudConfig

const staticOnly = {
  project: { name: 'A', slug: 'a', region: 'us-east-1' },
  sites: { web: { root: 'dist', domain: 'a.com', deploy: 'bucket' } },
} as unknown as CloudConfig

describe('detectDeploymentTargets', () => {
  it('reports server for a compute block and serverless for an app', () => {
    expect(detectDeploymentTargets(serverConfig)).toEqual({ server: true, serverless: false })
    expect(detectDeploymentTargets(serverlessConfig)).toEqual({ server: false, serverless: true })
    expect(detectDeploymentTargets(coexistConfig)).toEqual({ server: true, serverless: true })
    expect(detectDeploymentTargets(staticOnly)).toEqual({ server: false, serverless: false })
  })
})

describe('resolveDeploymentMode', () => {
  it('auto-detects serverless from an app, server otherwise', () => {
    expect(resolveDeploymentMode(serverlessConfig)).toBe('serverless')
    expect(resolveDeploymentMode(serverConfig)).toBe('server')
    expect(resolveDeploymentMode(staticOnly)).toBe('server')
  })

  it('honors an explicit mode', () => {
    expect(resolveDeploymentMode({ ...serverConfig, mode: 'serverless' } as any)).toBe('serverless')
    expect(resolveDeploymentMode({ ...serverlessConfig, mode: 'server' } as any)).toBe('server')
  })
})

describe('deploymentCoexistenceError', () => {
  it('flags a project that declares both a server and a serverless app', () => {
    expect(deploymentCoexistenceError(coexistConfig)).toMatch(/cannot be both a server and a serverless/i)
  })

  it('is null for a consistent server-only or serverless-only config', () => {
    expect(deploymentCoexistenceError(serverConfig)).toBeNull()
    expect(deploymentCoexistenceError(serverlessConfig)).toBeNull()
    expect(deploymentCoexistenceError(staticOnly)).toBeNull()
  })

  it('flags an explicit mode that contradicts the configured resources', () => {
    expect(deploymentCoexistenceError({ ...serverlessConfig, mode: 'server' } as any)).toMatch(/mode: 'server'/)
    expect(deploymentCoexistenceError({ ...serverConfig, mode: 'serverless' } as any)).toMatch(/mode: 'serverless'/)
  })
})
