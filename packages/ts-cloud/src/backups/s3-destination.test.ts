import { describe, expect, it } from 'bun:test'
import type { BackupDestination } from './model'
import type { BackupObjectClient, MultipartCheckpoint } from './s3-destination'
import { S3BackupDestinationAdapter } from './s3-destination'

class MemoryClient implements BackupObjectClient {
  objects = new Map<string, Buffer>()
  uploads = new Map<string, Map<number, Buffer>>()
  uploadedParts: number[] = []
  aborted: string[] = []
  async putObject(input: { bucket: string; key: string; body: string | Buffer | Uint8Array }) {
    this.objects.set(`${input.bucket}/${input.key}`, Buffer.from(input.body))
  }
  async getObjectBytes(bucket: string, key: string) {
    const body = this.objects.get(`${bucket}/${key}`)
    if (!body) throw new Error('not found')
    return { body }
  }
  async deleteObject(bucket: string, key: string) { this.objects.delete(`${bucket}/${key}`) }
  async createMultipartUpload() { this.uploads.set('upload-1', new Map()); return { UploadId: 'upload-1' } }
  async uploadPart(_bucket: string, _key: string, uploadId: string, partNumber: number, body: Uint8Array | Buffer) {
    this.uploadedParts.push(partNumber); this.uploads.get(uploadId)!.set(partNumber, Buffer.from(body)); return { ETag: `etag-${partNumber}` }
  }
  async completeMultipartUpload(bucket: string, key: string, uploadId: string, parts: Array<{ PartNumber: number }>) {
    const upload = this.uploads.get(uploadId)!
    this.objects.set(`${bucket}/${key}`, Buffer.concat(parts.map(part => upload.get(part.PartNumber)!)))
  }
  async abortMultipartUpload(_bucket: string, _key: string, uploadId: string) { this.aborted.push(uploadId); this.uploads.delete(uploadId) }
}

const destination = (encryption: BackupDestination['encryption'] = 'provider'): BackupDestination => ({
  id: 'destination', organizationId: 'org', projectId: 'project', name: 'offsite', provider: 's3_compatible', endpoint: 'https://objects.example.com/', endpointPolicy: 'public_https', bucket: 'backups', prefix: 'production', region: 'us-east-1', forcePathStyle: true, credentialRef: 'secret://credentials', encryption, encryptionKeyRef: encryption === 'provider' ? undefined : 'secret://encryption', immutability: {}, status: 'healthy', version: 1, createdAt: '', updatedAt: '',
})

describe('S3 backup destination adapter', () => {
  it('uses referenced credentials and health-tests custom endpoints without leaking keys', async () => {
    const client = new MemoryClient(), seen: unknown[] = [], adapter = new S3BackupDestinationAdapter(
      { resolve: async ref => ref === 'secret://credentials' ? JSON.stringify({ accessKeyId: 'access', secretAccessKey: 'secret' }) : 'encryption-key' },
      (_destination, credentials) => { seen.push(credentials); return client },
    )
    await adapter.test(destination())
    expect(seen[0]).toEqual({ accessKeyId: 'access', secretAccessKey: 'secret' })
    expect(client.objects.size).toBe(0)
  })

  it('encrypts client-side, checks ciphertext and plaintext integrity, and detects corruption', async () => {
    const client = new MemoryClient(), adapter = new S3BackupDestinationAdapter(
      { resolve: async ref => ref === 'secret://credentials' ? JSON.stringify({ accessKeyId: 'access', secretAccessKey: 'secret' }) : 'strong-backup-key' },
      () => client,
    ), body = Buffer.from('critical recovery data'), stored = await adapter.upload(destination('both'), { key: 'point.bin', body })
    expect(stored.manifest).toMatchObject({ encrypted: true, format: 'ts-cloud-backup-v1' })
    expect(client.objects.get('backups/production/point.bin')?.includes(body)).toBe(false)
    expect(await adapter.download(destination('both'), stored)).toEqual(body)
    client.objects.get('backups/production/point.bin')![40] ^= 1
    await expect(adapter.download(destination('both'), stored)).rejects.toThrow('corrupt')
  })

  it('resumes multipart uploads from persisted checkpoints and cleans abandoned uploads', async () => {
    const client = new MemoryClient(), adapter = new S3BackupDestinationAdapter(
      { resolve: async () => JSON.stringify({ accessKeyId: 'access', secretAccessKey: 'secret' }) },
      () => client, 4, 4,
    ), resume: MultipartCheckpoint = { uploadId: 'upload-1', key: 'production/large.bin', parts: [{ PartNumber: 1, ETag: 'etag-1' }], bytesUploaded: 4 }
    client.uploads.set('upload-1', new Map([[1, Buffer.from('abcd')]]))
    const checkpoints: MultipartCheckpoint[] = [], stored = await adapter.upload(destination(), { key: 'large.bin', body: Buffer.from('abcdefghij'), resume, checkpoint: value => checkpoints.push(structuredClone(value)) })
    expect(client.uploadedParts).toEqual([2, 3])
    expect(checkpoints.at(-1)).toMatchObject({ uploadId: 'upload-1', bytesUploaded: 10, parts: [{ PartNumber: 1 }, { PartNumber: 2 }, { PartNumber: 3 }] })
    expect(await adapter.download(destination(), stored)).toEqual(Buffer.from('abcdefghij'))
    client.uploads.set('abandoned', new Map())
    await adapter.abortPartial(destination(), { uploadId: 'abandoned', key: 'production/partial', parts: [], bytesUploaded: 0 })
    expect(client.aborted).toEqual(['abandoned'])
  })
})
