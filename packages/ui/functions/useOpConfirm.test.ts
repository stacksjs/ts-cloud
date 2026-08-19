import { describe, expect, it } from 'bun:test'
import { operationIsDangerous } from './useOpConfirm'

describe('operation confirmation presentation', () => {
  it('uses a danger treatment for destructive operations', () => {
    for (const operation of ['rollback', 'backup:restore', 'queue:purge:emails', 'stop:nginx', 'disable:scheduler'])
      expect(operationIsDangerous({ operation })).toBe(true)
  })

  it('allows an explicit severity override', () => {
    expect(operationIsDangerous({ operation: 'custom', danger: true })).toBe(true)
    expect(operationIsDangerous({ operation: 'rollback', danger: false })).toBe(false)
    expect(operationIsDangerous({ operation: 'restart:nginx' })).toBe(false)
  })
})
