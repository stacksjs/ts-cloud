import { describe, expect, it } from 'bun:test'
import { encodeDashboardPayload } from './dashboard-payload'

/** What a POSIX-locale child does to a UTF-8 env var: read as latin-1, re-encode. */
function throughPosixLocale(value: string): string {
  return new TextDecoder('utf-8').decode(
    new TextEncoder().encode(
      [...new TextEncoder().encode(value)].map((byte) => String.fromCharCode(byte)).join(''),
    ),
  )
}

describe('dashboard payload encoding', () => {
  it('round-trips through JSON.parse unchanged', () => {
    const data = { note: 'co-location on the box — not a binding', group: 'acme · hetzner · fsn1' }
    expect(JSON.parse(encodeDashboardPayload(data))).toEqual(data)
  })

  it('emits pure ASCII, so no locale can misread it', () => {
    const encoded = encodeDashboardPayload({ note: 'em — dash', dot: '·', accent: 'Köln', emoji: '🚀' })
    // eslint-disable-next-line no-control-regex
    expect(/^[ -~]*$/.test(encoded)).toBe(true)
  })

  it('survives the mangling that produced mojibake on a POSIX-locale box', () => {
    const data = { note: 'the box — every process', group: 'hetzner · fsn1' }

    // The old wire form is corrupted in transit...
    const naive = JSON.stringify(data)
    expect(throughPosixLocale(naive)).not.toBe(naive)
    expect(throughPosixLocale(naive)).toContain('â')

    // ...the ASCII-safe one cannot be, because there are no high bytes to mangle.
    const safe = encodeDashboardPayload(data)
    expect(throughPosixLocale(safe)).toBe(safe)
    expect(JSON.parse(throughPosixLocale(safe))).toEqual(data)
  })

  it('keeps surrogate pairs intact', () => {
    expect(JSON.parse(encodeDashboardPayload({ rocket: '🚀' }))).toEqual({ rocket: '🚀' })
  })

  it('handles the shapes a real payload carries', () => {
    const data = { nodes: [], nested: { deep: [1, 'two', null, true] }, absent: undefined }
    expect(JSON.parse(encodeDashboardPayload(data))).toEqual({ nodes: [], nested: { deep: [1, 'two', null, true] } })
  })
})
