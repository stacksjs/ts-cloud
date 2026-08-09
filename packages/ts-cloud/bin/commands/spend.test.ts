import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseActions, parseMoneyToCents } from './spend'

describe('money parsing', () => {
  it('reads dollars, because that is what an operator types', () => {
    expect(parseMoneyToCents('200')).toBe(20_000)
    expect(parseMoneyToCents('$1,250.50')).toBe(125_050)
    expect(parseMoneyToCents(49.99)).toBe(4_999)
  })

  it('accepts an explicit cents suffix for exactness', () => {
    expect(parseMoneyToCents('1c')).toBe(1)
    expect(parseMoneyToCents('12345c')).toBe(12_345)
  })

  it('rounds to whole cents rather than storing a float', () => {
    expect(parseMoneyToCents('0.005')).toBe(1)
    expect(parseMoneyToCents('10.004')).toBe(1_000)
  })

  it('treats a missing or empty value as unset, not as zero', () => {
    expect(parseMoneyToCents(undefined)).toBeUndefined()
    expect(parseMoneyToCents('')).toBeUndefined()
    expect(parseMoneyToCents('   ')).toBeUndefined()
  })

  it('rejects a negative or nonsense amount', () => {
    expect(() => parseMoneyToCents('-5')).toThrow('Invalid amount')
    expect(() => parseMoneyToCents('abc')).toThrow('Invalid amount')
  })
})

describe('action parsing', () => {
  it('parses a comma-separated ladder', () => {
    expect(parseActions('notify,block_builds')).toEqual(['notify', 'block_builds'])
    expect(parseActions(' notify , block_deployments ')).toEqual(['notify', 'block_deployments'])
  })

  it('rejects an unknown action and names the valid ones', () => {
    expect(() => parseActions('delete_everything')).toThrow('Unknown enforcement action')
    expect(() => parseActions('delete_everything')).toThrow('block_builds')
  })

  it('treats a missing value as unset', () => {
    expect(parseActions(undefined)).toBeUndefined()
  })
})

describe('command registration', () => {
  const source = readFileSync(join(import.meta.dir, 'spend.ts'), 'utf8')

  it('registers the documented commands', () => {
    for (const command of [
      'usage',
      'budget:list',
      'budget:create',
      'budget:update',
      'budget:delete',
      'spend:check',
      'spend:status',
      'spend:release',
      'spend:anomalies',
      'spend:work',
    ])
      expect(source).toContain(`.command('${command}`)
  })

  it('is wired into the CLI', () => {
    const cli = readFileSync(join(import.meta.dir, '..', 'cli.ts'), 'utf8')
    expect(cli).toContain('registerSpendCommands(app)')
  })

  it('previews by default and only enforces behind --apply', () => {
    expect(source).toContain("'--apply'")
    expect(source).toContain('preview — nothing was applied')
  })

  it('lifts the gate before deleting a budget, so nothing is blocked by a ghost', () => {
    const deleteBlock = source.slice(source.indexOf("command('budget:delete"))
    expect(deleteBlock.indexOf('gate.closeBudget')).toBeLessThan(deleteBlock.indexOf('store.deleteBudget'))
  })

  it('warns that a manual release is re-applied by the next cycle', () => {
    expect(source).toContain('will re-apply this if spend is still over the threshold')
  })

  it('takes a lease in the worker, so it cannot double-run with the dashboard', () => {
    const worker = source.slice(source.indexOf("command('spend:work"), source.indexOf("command('spend:status"))
    expect(worker).toContain('new SpendLoopLease')
    expect(worker).toContain('onSkip')
  })

  it('releases the lease on shutdown rather than waiting out the TTL', () => {
    const worker = source.slice(source.indexOf("command('spend:work"), source.indexOf("command('spend:status"))
    expect(worker).toContain("process.on('SIGINT'")
    expect(worker).toContain("process.on('SIGTERM'")
    expect(worker).toContain('stop()')
  })
})
