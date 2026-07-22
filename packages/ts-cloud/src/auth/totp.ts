import { createHmac, timingSafeEqual } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function encodeBase32(value: Uint8Array): string {
  let bits = 0
  let buffer = 0
  let result = ''
  for (const byte of value) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      result += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) result += BASE32[(buffer << (5 - bits)) & 31]
  return result
}

export function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let buffer = 0
  const bytes: number[] = []
  for (const character of normalized) {
    const index = BASE32.indexOf(character)
    if (index < 0) throw new Error('Invalid base32 secret')
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const value = Buffer.alloc(8)
  value.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(secret)).update(value).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export function totp(secret: string, timeMs: number = Date.now(), stepSeconds = 30): string {
  return hotp(secret, Math.floor(timeMs / 1000 / stepSeconds))
}

export function verifyTotp(secret: string, code: string, timeMs: number = Date.now(), window = 1): boolean {
  return matchTotpCounter(secret, code, timeMs, window) !== undefined
}

export function matchTotpCounter(
  secret: string,
  code: string,
  timeMs: number = Date.now(),
  window = 1,
): number | undefined {
  const normalized = code.replace(/[\s-]/g, '')
  if (!/^\d{6}$/.test(normalized)) return undefined
  const provided = Buffer.from(normalized)
  const counter = Math.floor(timeMs / 1000 / 30)
  for (let offset = -window; offset <= window; offset++) {
    if (counter + offset < 0) continue
    const expected = Buffer.from(hotp(secret, counter + offset))
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return counter + offset
  }
  return undefined
}

export function totpUri(input: { secret: string; account: string; issuer?: string }): string {
  const issuer = input.issuer?.trim() || 'ts-cloud'
  const label = `${issuer}:${input.account}`
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(input.secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
