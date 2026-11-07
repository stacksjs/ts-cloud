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

test('small unknown-length binary streams use one retryable PUT with exact metadata and bytes', async () => {
  const previous = fetch
  const client = new S3Client({ region: 'hel1', endpoint: 'hel1.your-objectstorage.com', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  ;(client as any).client.sleep = async () => {}
  let calls = 0
  const bytes = new Uint8Array([0, 255, 128, 7])
  try {
    globalThis.fetch = Object.assign(async (input: any, init?: RequestInit) => {
      calls++
      expect(new URL(String(input)).search).toBe('')
      expect(init?.method).toBe('PUT')
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes)
      expect(new Headers(init?.headers).get('x-amz-meta-user')).toBe('retained')
      if (calls === 1) return new Response('<Error><Code>GatewayTimeout</Code></Error>', { status: 504 })
      return new Response('')
    }, { preconnect: previous.preconnect })
    expect(await client.putObjectStream({ bucket: 'fixture', key: 'small', body: new Blob([bytes]).stream(), metadata: { user: 'retained' } })).toEqual({ bytes: 4 })
    expect(calls).toBe(2)
  } finally { globalThis.fetch = previous }
})

test('an ambiguous completion accepts only this attempt and exact length, never an older object', async () => {
  const client = new S3Client('hel1', undefined, { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  let token = ''; let heads = 0; let sleeps = 0; let aborted = false
  const bytes = 17 * 1024 * 1024
  client.createMultipartUpload = async (_bucket, _key, options) => { token = options!.metadata!['ts-cloud-stream-token']!; return { UploadId: 'fixture' } }
  client.uploadPart = async () => ({ ETag: 'part' })
  client.completeMultipartUpload = async () => { throw Object.assign(new Error('completion already in progress'), { code: 'InternalError', statusCode: 500 }) }
  client.headObject = async () => { heads++; return { ContentLength: heads === 2 ? bytes - 1 : bytes, Metadata: { 'ts-cloud-stream-token': heads === 1 ? 'older-attempt' : token } } }
  client.abortMultipartUpload = async () => { aborted = true }
  ;(client as any).sleep = async () => { sleeps++ }
  expect(await client.putObjectStream({ bucket: 'fixture', key: 'large', body: new Blob([new Uint8Array(bytes)]).stream() })).toEqual({ bytes })
  expect(token.length).toBeGreaterThan(20); expect(heads).toBe(3); expect(sleeps).toBe(2); expect(aborted).toBe(false)
})

test('unconfirmed completion is bounded and permission failures never become success', async () => {
  const client = new S3Client('hel1', undefined, { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  let heads = 0; let aborted = 0
  client.createMultipartUpload = async () => ({ UploadId: 'fixture' })
  client.uploadPart = async () => ({ ETag: 'part' })
  client.completeMultipartUpload = async () => { throw Object.assign(new Error('in progress'), { code: 'InternalError', statusCode: 500 }) }
  client.headObject = async () => { heads++; return { ContentLength: 17 * 1024 * 1024, Metadata: { 'ts-cloud-stream-token': 'older-attempt' } } }
  client.abortMultipartUpload = async () => { aborted++ }
  ;(client as any).sleep = async () => {}
  const body = () => new Blob([new Uint8Array(17 * 1024 * 1024)]).stream()
  await expect(client.putObjectStream({ bucket: 'fixture', key: 'large', body: body() })).rejects.toThrow('in progress')
  expect(heads).toBe(60); expect(aborted).toBe(1)
  client.completeMultipartUpload = async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }) }
  heads = 0
  await expect(client.putObjectStream({ bucket: 'fixture', key: 'large', body: body() })).rejects.toThrow('denied')
  expect(heads).toBe(0); expect(aborted).toBe(2)
})

test('HTTP 200 multipart responses containing XML errors, including leading whitespace, are retried and rejected', async () => {
  const previous = fetch
  const client = new S3Client({ region: 'hel1', endpoint: 'hel1.your-objectstorage.com', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  ;(client as any).client.sleep = async () => {}
  let calls = 0
  try {
    globalThis.fetch = Object.assign(async () => { calls++; return new Response(' \n<Error><Code>InternalError</Code><Message>still committing</Message></Error>') }, { preconnect: previous.preconnect })
    await expect(client.completeMultipartUpload('fixture', 'large', 'upload', [{ PartNumber: 1, ETag: 'part' }])).rejects.toMatchObject({ code: 'InternalError' })
    expect(calls).toBe(4)
  } finally { globalThis.fetch = previous }
})
