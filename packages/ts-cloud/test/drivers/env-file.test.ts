import { describe, expect, it } from 'bun:test'
import { formatEnvFile, quoteEnvValue } from '../../src/drivers/shared/env-file'

describe('formatEnvFile', () => {
  it('double-quotes values so special chars survive', () => {
    const out = formatEnvFile({ APP_KEY: 'base64:aB+/=', APP_NAME: 'My App' })
    expect(out).toContain('APP_KEY="base64:aB+/="')
    expect(out).toContain('APP_NAME="My App"')
  })

  it('escapes backslashes, quotes, and newlines', () => {
    expect(quoteEnvValue('a"b')).toBe('"a\\"b"')
    expect(quoteEnvValue('a\\b')).toBe('"a\\\\b"')
    expect(quoteEnvValue('line1\nline2')).toBe('"line1\\nline2"')
  })

  it('handles a value with # and = (would break unquoted)', () => {
    expect(quoteEnvValue('p@ss#word=1')).toBe('"p@ss#word=1"')
  })
})
