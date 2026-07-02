import type { CloudConfig } from '@ts-cloud/core'
import { describe, expect, it } from 'bun:test'
import { ALARM_PRESETS, buildServerlessOperations, createAlarm, resolveAlarmPreset, resolveServerlessOperation, updateFunctionConfig } from './serverless-operations'

function config(app: Record<string, any> = {}): CloudConfig {
  return {
    project: { name: 'Acme', slug: 'acme', region: 'us-east-1' },
    environments: { production: { type: 'production', app } },
  } as unknown as CloudConfig
}

describe('buildServerlessOperations', () => {
  it('always offers redeploy + rollback', () => {
    const ids = buildServerlessOperations(config(), 'production', {}).map(o => o.id)
    expect(ids).toContain('redeploy')
    expect(ids).toContain('rollback')
    expect(buildServerlessOperations(config(), 'production', {}).find(o => o.id === 'rollback')?.danger).toBe(true)
  })

  it('offers the meaningful maintenance transition for the current state', () => {
    const live = buildServerlessOperations(config(), 'production', { maintenance: { enabled: false } }).map(o => o.id)
    expect(live).toContain('maintenance:on')
    expect(live).not.toContain('maintenance:off')

    const down = buildServerlessOperations(config(), 'production', { maintenance: { enabled: true } }).map(o => o.id)
    expect(down).toContain('maintenance:off')
    expect(down).not.toContain('maintenance:on')

    // Unknown state → offer both.
    const unknown = buildServerlessOperations(config(), 'production', {}).map(o => o.id)
    expect(unknown).toContain('maintenance:on')
    expect(unknown).toContain('maintenance:off')
  })

  it('offers db:scale only with an Aurora database, carrying min/max inputs', () => {
    expect(buildServerlessOperations(config(), 'production', {}).some(o => o.id === 'db:scale')).toBe(false)
    const scale = buildServerlessOperations(config({ database: { connection: 'aurora-serverless', minCapacity: 1, maxCapacity: 8 } }), 'production', {})
      .find(o => o.id === 'db:scale')
    expect(scale?.inputs?.map(i => i.name)).toEqual(['min', 'max'])
  })

  it('offers assets:invalidate only when the app ships assets', () => {
    expect(buildServerlessOperations(config(), 'production', {}).some(o => o.id === 'assets:invalidate')).toBe(false)
    expect(buildServerlessOperations(config({ assets: true }), 'production', {}).some(o => o.id === 'assets:invalidate')).toBe(true)
    expect(buildServerlessOperations(config(), 'production', { assetsInfo: { bucket: 'x' } }).some(o => o.id === 'assets:invalidate')).toBe(true)
  })

  it('offers a purge op per queue and drops unsafe names', () => {
    const ops = buildServerlessOperations(config(), 'production', { queues: [{ name: 'default' }, { name: 'emails' }, { name: 'bad; rm -rf /' }] })
    const ids = ops.map(o => o.id)
    expect(ids).toContain('queue:purge:default')
    expect(ids).toContain('queue:purge:emails')
    expect(ids.some(id => id.includes('rm -rf'))).toBe(false)
    expect(ops.find(o => o.id === 'queue:purge:default')?.confirm).toBe('default')
  })

  it('resolves an operation by id', () => {
    expect(resolveServerlessOperation('rollback', config(), 'production', {})?.target).toBe('app')
    expect(resolveServerlessOperation('nope', config(), 'production', {})).toBeUndefined()
  })
})

describe('updateFunctionConfig validation', () => {
  it('rejects unknown modes and out-of-range values before any AWS call', async () => {
    expect((await updateFunctionConfig(config(), 'production', 'bogus', { memory: 512 })).error).toMatch(/Unknown function mode/)
    expect((await updateFunctionConfig(config(), 'production', 'http', { memory: 64 })).error).toMatch(/128 and 10240/)
    expect((await updateFunctionConfig(config(), 'production', 'http', { timeout: 901 })).error).toMatch(/1 and 900/)
    expect((await updateFunctionConfig(config(), 'production', 'http', {})).error).toMatch(/memory and\/or timeout/)
  })
})

describe('alarm presets', () => {
  it('exposes stable preset keys and resolves them', () => {
    expect(ALARM_PRESETS.map(p => p.key)).toContain('http-errors')
    expect(resolveAlarmPreset('http-errors')?.metricName).toBe('Errors')
    expect(resolveAlarmPreset('nope')).toBeUndefined()
  })

  it('rejects an unknown preset or bad threshold before any AWS call', async () => {
    expect((await createAlarm(config(), 'production', 'nope', 1)).error).toMatch(/Unknown alarm metric/)
    expect((await createAlarm(config(), 'production', 'http-errors', -1)).error).toMatch(/non-negative threshold/)
  })
})
