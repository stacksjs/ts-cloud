import { describe, expect, test } from 'bun:test'
import { parseDotenv, serializeDotenv } from './dotenv'

describe('dotenv workflows', () => {
  test('parses comments, exports, quotes, multiline values, and escapes', () => {
    const document = parseDotenv(
      `# comment\nexport API_URL=https://example.test # inline\nJSON="{\\n  \\"ok\\": true\\n}"\nPRIVATE_KEY='first\nsecond'\nEMPTY=`,
    )
    expect(document.valid).toBe(true)
    expect(document.values).toEqual({
      API_URL: 'https://example.test',
      JSON: '{\n  "ok": true\n}',
      PRIVATE_KEY: 'first\nsecond',
      EMPTY: '',
    })
  })

  test('reports duplicates separately from conflicting assignments', () => {
    const document = parseDotenv('A=one\nA=one\nB=one\nB=two\nINVALID LINE')
    expect(document.valid).toBe(false)
    expect(document.diagnostics.map((item) => item.code)).toEqual(['duplicate', 'conflict', 'invalid_line'])
    expect(document.values).toEqual({ A: 'one', B: 'one' })
  })

  test('exports stable quoted variable-only content', () => {
    expect(serializeDotenv({ MULTILINE: 'one\ntwo', A: 'plain' })).toBe('A="plain"\nMULTILINE="one\\ntwo"\n')
  })
})
