import { expect, test } from 'bun:test'
import { S3Client, uploadDeadlineMs } from '../src/aws/s3'

function client() {
  const store = new S3Client({ region: 'fsn1', endpoint: 'fsn1.your-objectstorage.com', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  ;(store as any).client.config.maxRetries = 0
  return store
}

test('an upload deadline grows with the body, from a one minute base', () => {
  expect(uploadDeadlineMs(0)).toBe(60_000)
  expect(uploadDeadlineMs(32 * 1024)).toBe(61_000)
  // 7 MB at 150 KB/s takes about 47 seconds, which a flat minute barely covered.
  expect(uploadDeadlineMs(7 * 1024 * 1024)).toBe(60_000 + 224_000)
})

test('putObject and uploadPart give a large body the time it needs to leave the machine', async () => {
  const store = client(); const deadlines: number[] = []
  ;(store as any).client.request = async (options: any) => { deadlines.push(options.timeoutMs); return { headers: { etag: '"part"' } } }
  await store.putObject({ bucket: 'fixture', key: 'small.txt', body: 'hello' })
  await store.putObject({ bucket: 'fixture', key: 'app.zip', body: new Uint8Array(7 * 1024 * 1024) })
  await store.uploadPart('fixture', 'app.zip', 'upload', 1, new Uint8Array(8 * 1024 * 1024))
  expect(deadlines).toEqual([61_000, 284_000, 316_000])
})
