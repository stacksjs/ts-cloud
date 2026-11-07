import { expect, test } from 'bun:test'
import { S3Client } from '../src/aws/s3'

test('multipart streams exceed the old buffer ceiling without retaining the complete object', async () => {
  const client = new S3Client('fsn1', undefined, { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  let total = 0; let maximum = 0; const completed: number[] = []
  client.createMultipartUpload = async () => ({ UploadId: 'fixture' })
  client.uploadPart = async (_bucket, _key, _id, number, body) => { total += body.byteLength; maximum = Math.max(maximum, body.byteLength); completed.push(number); return { ETag: 'part' } }
  client.completeMultipartUpload = async () => {}
  const chunk = new Uint8Array(1024 * 1024)
  async function* input() { for (let index = 0; index < 270; index++) yield chunk }
  expect((await client.putObjectStream({ bucket: 'fixture', key: 'large.bundle', body: input() })).bytes).toBe(270 * chunk.byteLength)
  expect(total).toBe(270 * chunk.byteLength)
  expect(maximum).toBe(16 * 1024 * 1024)
  expect(completed).toEqual(Array.from({ length: 17 }, (_, index) => index + 1))
})

test('a failed multipart stream aborts its incomplete upload and never completes', async () => {
  const client = new S3Client('fsn1', undefined, { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  let aborted = false; let completed = false
  client.createMultipartUpload = async () => ({ UploadId: 'fixture' })
  client.uploadPart = async () => { throw new Error('provider unavailable') }
  client.abortMultipartUpload = async () => { aborted = true }
  client.completeMultipartUpload = async () => { completed = true }
  await expect(client.putObjectStream({ bucket: 'fixture', key: 'large.bundle', body: new Blob([new Uint8Array(20 * 1024 * 1024)]).stream() })).rejects.toThrow('provider unavailable')
  expect(aborted).toBe(true); expect(completed).toBe(false)
})

test('streaming GET keeps bytes unread and preserves provider failures', async () => {
  const previous = globalThis.fetch
  const client = new S3Client({ region: 'fsn1', endpoint: 'fsn1.your-objectstorage.com', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  let cancelled = false
  try {
    globalThis.fetch = Object.assign(async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { headers: { 'Content-Length': '999999999' } }), { preconnect: previous.preconnect })
    const result = await client.getObjectStream('fixture', 'data.bundle')
    expect(result.contentLength).toBe(999999999)
    expect(result.body.locked).toBe(false)
    await result.body.cancel(); expect(cancelled).toBe(true)
    globalThis.fetch = Object.assign(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }), { preconnect: previous.preconnect })
    await expect(client.getObjectStream('fixture', 'denied')).rejects.toMatchObject({ statusCode: 403 })
  } finally { globalThis.fetch = previous }
})
