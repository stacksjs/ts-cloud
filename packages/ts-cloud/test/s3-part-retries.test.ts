import { expect, test } from 'bun:test'
import { S3Client } from '../src/aws/s3'

function client() {
  const store = new S3Client({ region: 'hel1', endpoint: 'hel1.your-objectstorage.com', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  const waits: number[] = []
  ;(store as any).client.sleep = async (ms: number) => { waits.push(ms) }
  ;(store as any).client.config.retryDelay = 0
  return { store, waits }
}

test('multipart retries transient failures with exact bytes, stable identity and provider Retry-After', async () => {
  const previous = fetch
  const { store, waits } = client()
  const bytes = new Uint8Array([0, 255, 7, 200])
  const requests: Array<{ url: string, bytes: number[], hash: string | null }> = []
  try {
    globalThis.fetch = Object.assign(async (input: any, init?: RequestInit) => {
      requests.push({ url: String(input), bytes: [...new Uint8Array(await new Response(init?.body).arrayBuffer())], hash: new Headers(init?.headers).get('x-amz-content-sha256') })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      if (requests.length === 1) return new Response('<Error><Code>GatewayTimeout</Code></Error>', { status: 504 })
      if (requests.length === 2) return new Response('<Error><Code>SlowDown</Code></Error>', { status: 429, headers: { 'Retry-After': '2' } })
      return new Response('', { headers: { ETag: '"confirmed"' } })
    }, { preconnect: previous.preconnect })
    expect(await store.uploadPart('fixture', 'large file.bundle', 'upload+id/value', 3, bytes)).toEqual({ ETag: '"confirmed"' })
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map(item => item.url)).size).toBe(1)
    expect(new URL(requests[0]!.url).searchParams.get('uploadId')).toBe('upload+id/value')
    for (const request of requests) {
      expect(request.bytes).toEqual([...bytes])
      expect(request.hash).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'))
    }
    expect(waits).toEqual([0, 2000])
  } finally { globalThis.fetch = previous }
})

test('multipart rejects permission failures immediately and bounds exhausted transient retries', async () => {
  const previous = fetch
  const { store } = client(); let calls = 0
  try {
    globalThis.fetch = Object.assign(async () => { calls++; return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }) }, { preconnect: previous.preconnect })
    await expect(store.uploadPart('fixture', 'object', 'upload', 1, new Uint8Array([255]))).rejects.toMatchObject({ statusCode: 403 })
    expect(calls).toBe(1); calls = 0
    globalThis.fetch = Object.assign(async () => { calls++; return new Response('<Error><Code>GatewayTimeout</Code></Error>', { status: 504 }) }, { preconnect: previous.preconnect })
    await expect(store.uploadPart('fixture', 'object', 'upload', 1, new Uint8Array([255]))).rejects.toMatchObject({ statusCode: 504 })
    expect(calls).toBe(4)
  } finally { globalThis.fetch = previous }
})
