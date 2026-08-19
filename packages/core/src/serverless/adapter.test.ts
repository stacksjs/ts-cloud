import type { ApiGatewayProxyEventV2, SqsEvent } from './runtime/adapter'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  createCliHandler,
  createHttpHandler,
  createQueueHandler,
  eventToRequest,
  resolveApp,
  responseToResult,
} from './runtime/adapter'

function httpEvent(overrides: Partial<ApiGatewayProxyEventV2> = {}): ApiGatewayProxyEventV2 {
  return {
    version: '2.0',
    rawPath: '/hello',
    rawQueryString: 'name=ada',
    headers: { 'content-type': 'application/json', host: 'api.example.com' },
    requestContext: { domainName: 'api.example.com', http: { method: 'GET', path: '/hello' } },
    isBase64Encoded: false,
    ...overrides,
  }
}

afterEach(() => {
  delete process.env.MAINTENANCE_MODE
  delete process.env.MAINTENANCE_BYPASS_SECRET
})

describe('HTTP adapter', () => {
  it('translates an API Gateway v2 event into a Request', () => {
    const req = eventToRequest(httpEvent())
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://api.example.com/hello?name=ada')
    expect(req.headers.get('content-type')).toBe('application/json')
  })

  it('decodes a base64 POST body', async () => {
    const event = httpEvent({
      requestContext: { domainName: 'api.example.com', http: { method: 'POST', path: '/x' } },
      body: Buffer.from('{"a":1}').toString('base64'),
      isBase64Encoded: true,
      rawQueryString: '',
    })
    const req = eventToRequest(event)
    expect(await req.text()).toBe('{"a":1}')
  })

  it('joins cookies into the cookie header', () => {
    const req = eventToRequest(httpEvent({ cookies: ['a=1', 'b=2'] }))
    expect(req.headers.get('cookie')).toBe('a=1; b=2')
  })

  it('serializes a text Response as plain body', async () => {
    const result = await responseToResult(
      new Response('hello', { status: 201, headers: { 'content-type': 'text/plain' } }),
    )
    expect(result.statusCode).toBe(201)
    expect(result.body).toBe('hello')
    expect(result.isBase64Encoded).toBe(false)
  })

  it('base64-encodes a binary Response', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255])
    const result = await responseToResult(
      new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    )
    expect(result.isBase64Encoded).toBe(true)
    expect(Buffer.from(result.body!, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('end-to-end invokes the fetch handler', async () => {
    const handler = createHttpHandler(async (req) => new Response(`hi ${new URL(req.url).searchParams.get('name')}`))
    const result = await handler(httpEvent())
    expect(result.statusCode).toBe(200)
    expect(result.body).toBe('hi ada')
  })

  it('short-circuits warmer pings without invoking the handler', async () => {
    let called = false
    const handler = createHttpHandler(async () => {
      called = true
      return new Response('x')
    })
    const result = await handler({ warmer: true } as any)
    expect(result.statusCode).toBe(200)
    expect(result.body).toBe('warm')
    expect(called).toBe(false)
  })

  it('returns 503 in maintenance mode without a bypass', async () => {
    process.env.MAINTENANCE_MODE = '1'
    process.env.MAINTENANCE_BYPASS_SECRET = 'sesame'
    const handler = createHttpHandler(async () => new Response('ok'))
    const blocked = await handler(httpEvent())
    expect(blocked.statusCode).toBe(503)

    const allowed = await handler(httpEvent({ headers: { 'x-maintenance-bypass': 'sesame' } }))
    expect(allowed.statusCode).toBe(200)
  })
})

describe('Queue adapter', () => {
  it('processes records and reports only failures', async () => {
    const seen: unknown[] = []
    const handler = createQueueHandler(async (payload: any) => {
      seen.push(payload)
      if (payload.fail) throw new Error('boom')
    })
    const event: SqsEvent = {
      Records: [
        { messageId: 'a', body: JSON.stringify({ ok: true }) },
        { messageId: 'b', body: JSON.stringify({ fail: true }) },
      ],
    }
    const res = await handler(event)
    expect(seen).toHaveLength(2)
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'b' }])
  })

  it('short-circuits warmer pings without invoking the handler', async () => {
    let called = false
    const handler = createQueueHandler(async () => {
      called = true
    })
    const res = await handler({ warmer: true } as any)
    expect(called).toBe(false)
    expect(res.batchItemFailures).toEqual([])
  })
})

describe('CLI adapter', () => {
  it('dispatches commands to the handler', async () => {
    const handler = createCliHandler(async ({ command }) => ({ statusCode: 0, output: `ran ${command}` }))
    const res = await handler({ command: 'schedule:run' })
    expect(res.output).toBe('ran schedule:run')
  })

  it('short-circuits warmer pings without invoking the handler', async () => {
    let called = false
    const handler = createCliHandler(async () => {
      called = true
      return { statusCode: 0, output: '' }
    })
    const res = await handler({ warmer: true } as any)
    expect(called).toBe(false)
    expect(res.output).toBe('warm')
  })
})

describe('resolveApp', () => {
  it('accepts a bare fetch function default export', () => {
    const app = resolveApp({ default: (_req: Request) => new Response('x') })
    expect(typeof app.fetch).toBe('function')
  })

  it('accepts an object with fetch/queue/cli', () => {
    const app = resolveApp({
      fetch: () => new Response('x'),
      queue: () => {},
      cli: () => ({ statusCode: 0, output: '' }),
    })
    expect(typeof app.fetch).toBe('function')
    expect(typeof app.queue).toBe('function')
    expect(typeof app.cli).toBe('function')
  })
})
