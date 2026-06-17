import type { ServerlessAppConfig } from '../types'
import { describe, expect, it } from 'bun:test'
import { resolveServerlessRuntime } from './runtime-resolve'

describe('resolveServerlessRuntime', () => {
  it('uses a managed runtime for common Node versions (no layer)', () => {
    const r = resolveServerlessRuntime({ kind: 'node', runtimeVersion: '22' })
    expect(r.lambdaRuntime).toBe('nodejs22.x')
    expect(r.usesLayer).toBe(false)
    expect(r.layerKind).toBeUndefined()
  })

  it('defaults Node to managed nodejs22.x', () => {
    const r = resolveServerlessRuntime({ kind: 'node' })
    expect(r.lambdaRuntime).toBe('nodejs22.x')
    expect(r.usesLayer).toBe(false)
  })

  it('uses a custom provided.al2023 layer for newer Node (24)', () => {
    const r = resolveServerlessRuntime({ kind: 'node', runtimeVersion: '24' })
    expect(r.lambdaRuntime).toBe('provided.al2023')
    expect(r.usesLayer).toBe(true)
    expect(r.layerKind).toBe('node')
    expect(r.layerEnvVar).toBe('TSCLOUD_NODE_LAYER_ARN')
  })

  it('forces a custom layer when runtime is explicitly provided.al2023', () => {
    const r = resolveServerlessRuntime({ kind: 'node', runtimeVersion: '20', runtime: 'provided.al2023' } as ServerlessAppConfig)
    expect(r.usesLayer).toBe(true)
    expect(r.layerKind).toBe('node')
  })

  it('always uses a custom layer for Bun', () => {
    const r = resolveServerlessRuntime({ kind: 'bun' })
    expect(r.lambdaRuntime).toBe('provided.al2023')
    expect(r.usesLayer).toBe(true)
    expect(r.layerKind).toBe('bun')
    expect(r.layerEnvVar).toBe('TSCLOUD_BUN_LAYER_ARN')
  })

  it('always uses a custom layer for PHP and honors phpVersion', () => {
    const r = resolveServerlessRuntime({ kind: 'php', phpVersion: '8.4' })
    expect(r.lambdaRuntime).toBe('provided.al2023')
    expect(r.usesLayer).toBe(true)
    expect(r.layerKind).toBe('php')
    expect(r.version).toBe('8.4')
    expect(r.layerEnvVar).toBe('TSCLOUD_PHP_LAYER_ARN')
  })

  it('normalizes Node version strings to a major', () => {
    expect(resolveServerlessRuntime({ kind: 'node', runtimeVersion: 'nodejs20.x' }).lambdaRuntime).toBe('nodejs20.x')
    expect(resolveServerlessRuntime({ kind: 'node', runtimeVersion: '18.19.1' }).lambdaRuntime).toBe('nodejs18.x')
  })
})
