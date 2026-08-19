import { describe, expect, it } from 'bun:test'
import { decodeBase32, encodeBase32, hotp, totpUri, verifyTotp } from './totp'

describe('TOTP', () => {
  it('matches the RFC 4226 HOTP vectors used by RFC 6238', () => {
    const secret = encodeBase32(Buffer.from('12345678901234567890'))
    expect(hotp(secret, 0)).toBe('755224')
    expect(hotp(secret, 1)).toBe('287082')
    expect(hotp(secret, 9)).toBe('520489')
    expect(decodeBase32(secret).toString()).toBe('12345678901234567890')
  })

  it('accepts only the configured time window and emits interoperable URIs', () => {
    const secret = encodeBase32(Buffer.from('12345678901234567890'))
    expect(verifyTotp(secret, hotp(secret, 100), 100 * 30_000)).toBe(true)
    expect(verifyTotp(secret, hotp(secret, 98), 100 * 30_000)).toBe(false)
    expect(totpUri({ secret, account: 'chris@example.com', issuer: 'Acme Cloud' })).toContain(
      'otpauth://totp/Acme%20Cloud%3Achris%40example.com',
    )
  })
})
