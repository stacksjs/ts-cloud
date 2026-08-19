import { describe, expect, test } from 'bun:test'
import type { ConfigurationMetadata } from '../../src/configuration'
import { configurationRows, secretValueFromOptions } from './config'

describe('configuration CLI safety', () => {
  test('renders secret metadata without references or values', () => {
    const rows = configurationRows([
      {
        id: 'entry-1',
        key: 'TOKEN',
        kind: 'secret',
        scope: { type: 'project', id: 'project-1' },
        inherited: false,
        overridden: false,
        required: true,
        backend: 'aws_secrets_manager',
        backendVersion: 'version-2',
        reference: 'aws-sm://region/sensitive-reference',
        version: 2,
        updatedAt: '2026-07-21T12:00:00.000Z',
      } as ConfigurationMetadata,
    ])
    expect(rows).toEqual([
      [
        'TOKEN',
        'secret',
        'project',
        'direct',
        'aws_secrets_manager',
        'version-2',
        'required',
        '2026-07-21T12:00:00.000Z',
      ],
    ])
    expect(JSON.stringify(rows)).not.toContain('sensitive-reference')
  })

  test('refuses secret values in argv and resolves named environment input', () => {
    expect(() => secretValueFromOptions({ value: 'leaked-argument' }, {})).toThrow('not accepted in command arguments')
    expect(secretValueFromOptions({ fromEnv: 'DEPLOY_TOKEN' }, { DEPLOY_TOKEN: 'write-only-value' })).toBe(
      'write-only-value',
    )
    expect(() => secretValueFromOptions({ fromEnv: 'MISSING' }, {})).toThrow('MISSING is empty')
  })
})
