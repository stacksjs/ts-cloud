import { expect, test } from 'bun:test'
import { S3Client } from '../src/aws/s3'

function client() {
  const store = new S3Client({ region: 'hel1', endpoint: 'hel1.your-objectstorage.com', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  ;(store as any).client.config.maxRetries = 0
  return store
}

test('HEAD keeps its default deadline and permits a bounded bulk-operation override', async () => {
  const store = client(); const calls: number[] = []
  ;(store as any).client.request = async (options: any) => { calls.push(options.timeoutMs); return { headers: { 'content-length': '12', etag: '"verified"' } } }
  expect((await store.headObject('fixture', 'object'))?.ContentLength).toBe(12)
  expect((await store.headObject('fixture', 'object', { timeoutMs: 120_000 }))?.ETag).toBe('"verified"')
  expect(calls).toEqual([30_000, 120_000])
  for (const timeoutMs of [0, -1, Infinity, NaN]) await expect(store.headObject('fixture', 'object', { timeoutMs })).rejects.toThrow('positive finite')
  expect(calls).toHaveLength(2)
})

test('the selected HEAD deadline aborts a slow response while a sufficient budget returns authoritative absence', async () => {
  const previous = fetch
  const store = client()
  try {
    globalThis.fetch = Object.assign(async (_input: any, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(null, { status: 404 })), 50)
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason) }, { once: true })
    }), { preconnect: previous.preconnect })
    await expect(store.headObject('fixture', 'missing', { timeoutMs: 10 })).rejects.toMatchObject({ name: 'TimeoutError' })
    await expect(store.headObject('fixture', 'missing', { timeoutMs: 250 })).resolves.toBeNull()
  } finally { globalThis.fetch = previous }
})
