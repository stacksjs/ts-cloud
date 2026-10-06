import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { BedrockAgentRuntimeClient, BedrockRuntimeClient } from '../src/aws/bedrock'
import { canonicalUriFor, signingNameFor } from '../src/aws/client'
import { crc32, decodeEventStream, decodeEventStreamMessage } from '../src/aws/event-stream'

/**
 * Bedrock's runtime APIs had never worked through ts-cloud: requests were
 * signed for service `bedrock-runtime` (AWS wants `bedrock`), a model id's
 * encoded `:` was signed verbatim (AWS re-encodes it), and the streaming
 * responses were scanned for braces instead of decoded.
 *
 * `fixtures/bedrock-nova-lite-stream.bin` is a real `invoke-with-response-stream`
 * body from `amazon.nova-lite-v1:0`, captured once the signing was fixed.
 */

const fixture = new Uint8Array(await Bun.file(new URL('./fixtures/bedrock-nova-lite-stream.bin', import.meta.url)).arrayBuffer())

const originalFetch = globalThis.fetch
const savedEnv = { ...process.env }

beforeEach(() => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE'
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  delete process.env.AWS_SESSION_TOKEN
  delete process.env.AWS_PROFILE
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv))
      delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

interface Captured { url: string, headers: Record<string, string> }

function respondWith(body: BodyInit, init: ResponseInit = {}): Captured[] {
  const seen: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, request?: RequestInit) => {
    seen.push({ url: String(input), headers: request?.headers as Record<string, string> })
    return new Response(body, init)
  }) as typeof fetch
  return seen
}

/** Encode one event stream message, the inverse of the decoder under test. */
function frame(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const encoder = new TextEncoder()
  const body = typeof payload === 'string' ? encoder.encode(payload) : payload
  const headerBytes: number[] = []
  for (const [name, value] of Object.entries(headers)) {
    const n = encoder.encode(name)
    const v = encoder.encode(value)
    headerBytes.push(n.length, ...n, 7, v.length >> 8, v.length & 0xFF, ...v)
  }
  const total = 12 + headerBytes.length + body.length + 4
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, total)
  view.setUint32(4, headerBytes.length)
  view.setUint32(8, crc32(out.subarray(0, 8)))
  out.set(headerBytes, 12)
  out.set(body, 12 + headerBytes.length)
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)))
  return out
}

function chunkEvent(json: unknown): Uint8Array {
  return frame(
    { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' },
    JSON.stringify({ bytes: Buffer.from(JSON.stringify(json)).toString('base64') }),
  )
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

describe('SigV4 for the Bedrock runtime', () => {
  it('signs each endpoint prefix with the name AWS scopes its credentials to', () => {
    expect(signingNameFor('bedrock-runtime')).toBe('bedrock')
    expect(signingNameFor('bedrock-agent')).toBe('bedrock')
    expect(signingNameFor('bedrock-agent-runtime')).toBe('bedrock')
    expect(signingNameFor('personalize-runtime')).toBe('personalize')
    expect(signingNameFor('personalize-events')).toBe('personalize')
    expect(signingNameFor('email')).toBe('ses')
    expect(signingNameFor('lambda')).toBe('lambda')
  })

  it('re-encodes the path for every service but S3', () => {
    // The canonical URI AWS reported it expected for this exact request.
    expect(canonicalUriFor('bedrock-runtime', '/model/amazon.nova-lite-v1%3A0/converse'))
      .toBe('/model/amazon.nova-lite-v1%253A0/converse')
    expect(canonicalUriFor('lambda', '/2015-03-31/functions/my-fn/invocations'))
      .toBe('/2015-03-31/functions/my-fn/invocations')
    expect(canonicalUriFor('s3', '/bucket/a%20b.txt')).toBe('/bucket/a%20b.txt')
  })

  it('scopes a converse request to bedrock while sending it to bedrock-runtime', async () => {
    const seen = respondWith(JSON.stringify({ output: { message: { content: [{ text: 'ok' }] } } }))
    await new BedrockRuntimeClient('us-east-1').converse({
      modelId: 'amazon.nova-lite-v1:0',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    })

    expect(seen[0]!.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse')
    expect(seen[0]!.headers.Authorization).toContain('/us-east-1/bedrock/aws4_request')
  })
})

describe('the event stream decoder', () => {
  it('decodes a real Bedrock stream into its messages', async () => {
    const messages = []
    for await (const message of decodeEventStream([fixture] as unknown as AsyncIterable<Uint8Array>))
      messages.push(message)

    expect(messages.length).toBe(11)
    expect(messages.every(m => m.headers[':event-type'] === 'chunk' && m.headers[':message-type'] === 'event')).toBe(true)
  })

  it('yields the same messages however the transport splits the bytes', async () => {
    async function* oneByteAtATime() {
      for (const byte of fixture)
        yield new Uint8Array([byte])
    }

    const whole = []
    for await (const m of decodeEventStream([fixture] as unknown as AsyncIterable<Uint8Array>))
      whole.push(new TextDecoder().decode(m.payload))
    const split = []
    for await (const m of decodeEventStream(oneByteAtATime()))
      split.push(new TextDecoder().decode(m.payload))

    expect(split).toEqual(whole)
  })

  it('refuses a corrupted frame instead of yielding a wrong chunk', () => {
    const corrupted = fixture.slice(0, new DataView(fixture.buffer).getUint32(0))
    corrupted[20] = corrupted[20]! ^ 0xFF
    expect(() => decodeEventStreamMessage(corrupted)).toThrow('checksum mismatch')
  })

  it('refuses a stream that ends partway through a message', async () => {
    const truncated = fixture.slice(0, fixture.length - 3)
    const drain = async () => {
      for await (const _ of decodeEventStream([truncated] as unknown as AsyncIterable<Uint8Array>)) {
        // drain
      }
    }
    await expect(drain()).rejects.toThrow('incomplete message')
  })
})

describe('invokeModelWithResponseStream', () => {
  it('yields the model output in each chunk, not the base64 envelope around it', async () => {
    respondWith(fixture, { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
    const response = await new BedrockRuntimeClient('us-east-1').invokeModelWithResponseStream({
      modelId: 'amazon.nova-lite-v1:0',
      body: '{}',
    })

    let text = ''
    for await (const event of response.body) {
      const output = JSON.parse(new TextDecoder().decode(event.chunk!.bytes))
      expect(output.bytes).toBeUndefined()
      text += output.contentBlockDelta?.delta?.text ?? ''
    }
    expect(text).toBe('1,2,3,4,5')
  })

  it('throws a mid-stream exception rather than ending as if the model had finished', async () => {
    respondWith(concat(
      chunkEvent({ contentBlockDelta: { delta: { text: 'partial' } } }),
      frame({ ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' }, '{"message":"Too many requests"}'),
    ))
    const response = await new BedrockRuntimeClient('us-east-1').invokeModelWithResponseStream({ modelId: 'm', body: '{}' })

    const chunks: unknown[] = []
    const drain = async () => {
      for await (const event of response.body)
        chunks.push(event)
    }
    await expect(drain()).rejects.toThrow('throttlingException: Too many requests')
    expect(chunks.length).toBe(1)
  })

  it('reports an error status through the client, with its parsed message', async () => {
    respondWith('{"message":"This model version has reached the end of its life."}', { status: 404 })
    await expect(new BedrockRuntimeClient('us-east-1').invokeModelWithResponseStream({ modelId: 'amazon.titan-text-express-v1', body: '{}' }))
      .rejects
      .toThrow('end of its life')
  })
})

describe('invokeAgent', () => {
  it('assembles the completion and citations from the chunk events', async () => {
    const encode = (text: string) => Buffer.from(text).toString('base64')
    const chunk = (text: string, citations?: unknown[]) => frame(
      { ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' },
      JSON.stringify({ bytes: encode(text), ...(citations ? { attribution: { citations } } : {}) }),
    )
    const citation = { retrievedReferences: [{ content: { text: 'source' } }] }
    const seen = respondWith(
      concat(
        chunk('Hello, '),
        frame({ ':event-type': 'trace', ':content-type': 'application/json', ':message-type': 'event' }, '{"trace":{}}'),
        chunk('world.', [citation]),
      ),
      { headers: { 'x-amz-bedrock-agent-session-id': 'session-1', 'x-amz-bedrock-agent-memory-id': 'memory-1' } },
    )

    const result = await new BedrockAgentRuntimeClient('us-east-1').invokeAgent({
      agentId: 'AGENT',
      agentAliasId: 'ALIAS',
      sessionId: 'session-1',
      inputText: 'hi',
    })

    expect(result).toEqual({ completion: 'Hello, world.', sessionId: 'session-1', memoryId: 'memory-1', citations: [citation] })
    expect(seen[0]!.headers.Authorization).toContain('/us-east-1/bedrock/aws4_request')
  })
})
