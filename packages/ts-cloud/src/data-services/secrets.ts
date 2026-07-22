import type { ControlPlaneStore } from '../control-plane'
import type { SecretBackend } from './service'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

export class EncryptedDataSecretStore implements SecretBackend {
  private readonly key: Buffer
  constructor(
    private readonly controlPlane: ControlPlaneStore,
    encryptionKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!encryptionKey)
      throw new Error('Data-service encryption key is required.')
    this.key = createHash('sha256')
      .update(`ts-cloud:data-services:${encryptionKey}`)
      .digest()
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv),
      ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
  }
  private decrypt(value: string): string {
    const [version, ivRaw, tagRaw, ciphertextRaw] = value.split('.')
    if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw)
      throw new Error('Encrypted data-service secret is unavailable.')
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivRaw, 'base64url'),
      )
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new Error('Encrypted data-service secret could not be decrypted.')
    }
  }
  async put(reference: string, value: string): Promise<void> {
    if (!/^secret:\/\/data-services\/[A-Za-z0-9._/-]+$/.test(reference))
      throw new Error('Invalid data-service secret reference.')
    if (!value) throw new Error('Data-service secret cannot be empty.')
    const now = this.now().toISOString()
    this.controlPlane.database.run(
      `INSERT INTO data_service_secrets (reference,ciphertext,fingerprint,created_at,updated_at)
       VALUES (?,?,?,?,?) ON CONFLICT(reference) DO UPDATE SET ciphertext=excluded.ciphertext,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`,
      [
        reference,
        this.encrypt(value),
        createHash('sha256').update(value).digest('hex'),
        now,
        now,
      ],
    )
  }
  async resolve(reference: string): Promise<string> {
    const row = this.controlPlane.database
      .query<{ ciphertext: string }, [string]>(
        'SELECT ciphertext FROM data_service_secrets WHERE reference = ?',
      )
      .get(reference)
    if (!row) throw new Error('Data-service secret was not found.')
    return this.decrypt(row.ciphertext)
  }
  async remove(reference: string): Promise<void> {
    this.controlPlane.database.run(
      'DELETE FROM data_service_secrets WHERE reference = ?',
      [reference],
    )
  }
}
