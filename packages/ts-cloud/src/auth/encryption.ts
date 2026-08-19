import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveStatePath, statePath } from '@ts-cloud/core'

/** Project-relative location of the MFA encryption key, for messages and docs. */
export function authEncryptionKeyFile(): string {
  return statePath('auth-encryption-key')
}

/** Keep MFA encryption independent from legacy session-signing-key rotation. */
export function resolveAuthEncryptionKey(cwd: string): string {
  const configured = process.env.TS_CLOUD_AUTH_ENCRYPTION_KEY?.trim()
  if (configured) return configured
  const file = resolveStatePath(cwd, 'auth-encryption-key')
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
