import type { BackupDestination } from './model'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { S3Client } from '../aws/s3'

export interface BackupSecretBackend {
  resolve(reference: string): Promise<string>
}

export interface BackupObjectClient {
  putObject(input: {
    bucket: string
    key: string
    body: string | Buffer | Uint8Array
    contentType?: string
    metadata?: Record<string, string>
  }): Promise<void>
  getObjectBytes(
    bucket: string,
    key: string,
  ): Promise<{ body: Uint8Array; contentLength?: number }>
  deleteObject(bucket: string, key: string): Promise<void>
  createMultipartUpload(
    bucket: string,
    key: string,
    options?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<{ UploadId: string }>
  uploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array | Buffer,
  ): Promise<{ ETag: string }>
  completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>,
  ): Promise<void>
  abortMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
  ): Promise<void>
}

export interface MultipartCheckpoint {
  uploadId: string
  key: string
  parts: Array<{ PartNumber: number; ETag: string }>
  bytesUploaded: number
  encryptionIv?: string
  plaintextChecksum?: string
}

export interface StoredBackup {
  uri: string
  key: string
  sizeBytes: number
  checksum: string
  manifest: {
    format: 'ts-cloud-backup-v1'
    encrypted: boolean
    plaintextChecksum: string
    storageChecksum: string
    contentType: string
  }
}

const MAGIC = Buffer.from('TSCB1')
const checksum = (value: Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

function encryptionKey(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function encryptBackup(value: Uint8Array, secret: string, suppliedIv?: Uint8Array): Buffer {
  const iv = suppliedIv ? Buffer.from(suppliedIv) : randomBytes(12)
  if (iv.length !== 12) throw new Error('Backup encryption IV must contain 12 bytes.')
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv),
    encrypted = Buffer.concat([cipher.update(value), cipher.final()]),
    tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, iv, tag, encrypted])
}

export function decryptBackup(value: Uint8Array, secret: string): Buffer {
  const body = Buffer.from(value)
  if (!body.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('Backup does not contain a valid encrypted envelope.')
  const iv = body.subarray(5, 17),
    tag = body.subarray(17, 33),
    ciphertext = body.subarray(33),
    decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function credentials(value: string): {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
} {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(
      'Backup destination credential must be a JSON object with accessKeyId and secretAccessKey.',
    )
  }
  if (!parsed.accessKeyId || !parsed.secretAccessKey)
    throw new Error(
      'Backup destination credential requires accessKeyId and secretAccessKey.',
    )
  if (parsed.expiresAt) {
    const expiresAt = new Date(String(parsed.expiresAt))
    if (!Number.isFinite(expiresAt.getTime()))
      throw new Error('Backup destination credential expiresAt must be an ISO timestamp.')
    if (expiresAt.getTime() <= Date.now())
      throw new Error('Backup destination credential has expired.')
  }
  return {
    accessKeyId: String(parsed.accessKeyId),
    secretAccessKey: String(parsed.secretAccessKey),
    sessionToken: parsed.sessionToken
      ? String(parsed.sessionToken)
      : undefined,
  }
}

// pickier-disable-next-line no-unused-vars
export async function backupCredentialStatus(
  _destination: BackupDestination,
  secrets: BackupSecretBackend,
  now: Date = new Date(),
): Promise<{
  status: 'default' | 'static' | 'valid' | 'expiring' | 'expired' | 'invalid'
  expiresAt?: string
}> {
  if (!_destination.credentialRef) return { status: 'default' }
  try {
    const parsed = JSON.parse(await secrets.resolve(_destination.credentialRef)) as Record<string, unknown>
    if (!parsed.accessKeyId || !parsed.secretAccessKey) return { status: 'invalid' }
    if (!parsed.expiresAt) return { status: 'static' }
    const expiresAt = new Date(String(parsed.expiresAt))
    if (!Number.isFinite(expiresAt.getTime())) return { status: 'invalid' }
    const remaining = expiresAt.getTime() - now.getTime()
    return {
      status:
        remaining <= 0
          ? 'expired'
          : remaining <= 7 * 86_400_000
            ? 'expiring'
            : 'valid',
      expiresAt: expiresAt.toISOString(),
    }
  } catch {
    return { status: 'invalid' }
  }
}

export class S3BackupDestinationAdapter {
  constructor(
    private readonly secrets: BackupSecretBackend,
    private readonly clientFactory: (
      destination: BackupDestination,
      credentials?: {
        accessKeyId: string
        secretAccessKey: string
        sessionToken?: string
      },
    ) => BackupObjectClient = (destination, explicit) =>
      new S3Client(destination.region ?? 'us-east-1', undefined, {
        endpoint: destination.endpoint
          ? new URL(destination.endpoint).host
          : undefined,
        forcePathStyle: destination.forcePathStyle,
        credentials: explicit,
      }),
    private readonly multipartThreshold: number = 8 * 1024 * 1024,
    private readonly partSize: number = 8 * 1024 * 1024,
  ) {}

  private async client(
    destination: BackupDestination,
  ): Promise<BackupObjectClient> {
    const explicit = destination.credentialRef
      ? credentials(await this.secrets.resolve(destination.credentialRef))
      : undefined
    return this.clientFactory(destination, explicit)
  }

  async test(destination: BackupDestination): Promise<void> {
    if (!destination.bucket)
      throw new Error('S3 destination has no configured bucket.')
    const client = await this.client(destination),
      key = `${destination.prefix ? `${destination.prefix.replace(/\/$/, '')}/` : ''}.ts-cloud-health/${crypto.randomUUID()}`
    await client.putObject({
      bucket: destination.bucket,
      key,
      body: 'ts-cloud backup destination health check',
      contentType: 'text/plain',
    })
    try {
      const downloaded = await client.getObjectBytes(destination.bucket, key)
      if (
        Buffer.from(downloaded.body).toString() !==
        'ts-cloud backup destination health check'
      )
        throw new Error('Backup destination health object was corrupted.')
    } finally {
      await client.deleteObject(destination.bucket, key)
    }
  }

  async upload(
    destination: BackupDestination,
    input: {
      key: string
      body: Uint8Array
      contentType?: string
      resume?: MultipartCheckpoint
      checkpoint?: (value: MultipartCheckpoint) => void
    },
  ): Promise<StoredBackup> {
    if (!destination.bucket)
      throw new Error('S3 destination has no configured bucket.')
    const client = await this.client(destination),
      plaintextChecksum = checksum(input.body),
      encryptionSecret =
        destination.encryption !== 'provider'
          ? await this.secrets.resolve(destination.encryptionKeyRef!)
          : undefined,
      encryptionIv = encryptionSecret
        ? input.resume?.encryptionIv
          ? Buffer.from(input.resume.encryptionIv, 'base64url')
          : randomBytes(12)
        : undefined,
      body = encryptionSecret
        ? encryptBackup(input.body, encryptionSecret, encryptionIv)
        : Buffer.from(input.body),
      storageChecksum = checksum(body),
      key = `${destination.prefix ? `${destination.prefix.replace(/\/$/, '')}/` : ''}${input.key.replace(/^\/+/, '')}`,
      contentType = input.contentType ?? 'application/octet-stream',
      metadata = {
        'ts-cloud-format': 'v1',
        'ts-cloud-sha256': storageChecksum.slice(7),
        'ts-cloud-encrypted': encryptionSecret ? 'true' : 'false',
      }
    if (input.resume && input.resume.key !== key)
      throw new Error('Multipart checkpoint does not match the requested backup key.')
    if (input.resume && encryptionSecret && !input.resume.encryptionIv)
      throw new Error('Encrypted multipart checkpoint has no resumable envelope state.')
    if (
      input.resume &&
      encryptionSecret &&
      input.resume.plaintextChecksum !== plaintextChecksum
    )
      throw new Error('Encrypted multipart checkpoint does not match the backup payload.')
    if (body.length < this.multipartThreshold) {
      await client.putObject({
        bucket: destination.bucket,
        key,
        body,
        contentType,
        metadata,
      })
    } else {
      const created = input.resume
          ? undefined
          : await client.createMultipartUpload(destination.bucket, key, {
              contentType,
              metadata,
            }),
        state = input.resume ?? {
          uploadId: created!.UploadId,
          key,
          parts: [],
          bytesUploaded: 0,
          encryptionIv: encryptionIv?.toString('base64url'),
          plaintextChecksum,
        },
        completed = new Map(
          state.parts.map((part) => [part.PartNumber, part]),
        ),
        partCount = Math.ceil(body.length / this.partSize)
      for (let index = 0; index < partCount; index++) {
        const partNumber = index + 1
        if (!completed.has(partNumber)) {
          const start = index * this.partSize,
            result = await client.uploadPart(
              destination.bucket,
              key,
              state.uploadId,
              partNumber,
              body.subarray(start, Math.min(body.length, start + this.partSize)),
            )
          completed.set(partNumber, { PartNumber: partNumber, ETag: result.ETag })
        }
        state.parts = [...completed.values()].sort(
          (a, b) => a.PartNumber - b.PartNumber,
        )
        state.bytesUploaded = Math.min(body.length, partNumber * this.partSize)
        input.checkpoint?.(state)
      }
      await client.completeMultipartUpload(
        destination.bucket,
        key,
        state.uploadId,
        state.parts,
      )
    }
    return {
      uri: `s3://${destination.bucket}/${key}`,
      key,
      sizeBytes: body.length,
      checksum: storageChecksum,
      manifest: {
        format: 'ts-cloud-backup-v1',
        encrypted: !!encryptionSecret,
        plaintextChecksum,
        storageChecksum,
        contentType,
      },
    }
  }

  async download(
    destination: BackupDestination,
    stored: Pick<StoredBackup, 'key' | 'checksum' | 'manifest'>,
  ): Promise<Buffer> {
    if (!destination.bucket)
      throw new Error('S3 destination has no configured bucket.')
    const client = await this.client(destination),
      result = await client.getObjectBytes(destination.bucket, stored.key),
      body = Buffer.from(result.body)
    if (checksum(body) !== stored.checksum)
      throw new Error('Backup checksum verification failed; object is corrupt.')
    const plaintext = stored.manifest.encrypted
      ? decryptBackup(
          body,
          await this.secrets.resolve(destination.encryptionKeyRef!),
        )
      : body
    if (checksum(plaintext) !== stored.manifest.plaintextChecksum)
      throw new Error('Backup plaintext checksum verification failed.')
    return plaintext
  }

  async abortPartial(
    destination: BackupDestination,
    checkpoint: MultipartCheckpoint,
  ): Promise<void> {
    if (!destination.bucket)
      throw new Error('S3 destination has no configured bucket.')
    await (
      await this.client(destination)
    ).abortMultipartUpload(
      destination.bucket,
      checkpoint.key,
      checkpoint.uploadId,
    )
  }

  async delete(destination: BackupDestination, key: string): Promise<void> {
    if (!destination.bucket)
      throw new Error('S3 destination has no configured bucket.')
    await (await this.client(destination)).deleteObject(destination.bucket, key)
  }
}
