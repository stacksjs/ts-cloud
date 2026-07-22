import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const AUTH_ENCRYPTION_KEY_FILE: string = join('.ts-cloud', 'auth-encryption-key')

/** Keep MFA encryption independent from legacy session-signing-key rotation. */
export function resolveAuthEncryptionKey(cwd: string): string {
  const configured = process.env.TS_CLOUD_AUTH_ENCRYPTION_KEY?.trim()
  if (configured) return configured
  const file = join(cwd, AUTH_ENCRYPTION_KEY_FILE)
  try {
    if (existsSync(file)) {
      const saved = readFileSync(file, 'utf8').trim()
      if (saved) return saved
    }
  } catch {}
  const key = randomBytes(32).toString('base64url')
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${key}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch {}
  return key
}
