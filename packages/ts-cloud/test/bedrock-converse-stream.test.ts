import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ConverseStreamEvent } from '../src/aws/bedrock'
import { BedrockRuntimeClient } from '../src/aws/bedrock'
import { crc32 } from '../src/aws/event-stream'

/**
 * `converseStream()`, against real `converse-stream` bodies from
 * `amazon.nova-lite-v1:0` captured in us-east-1: one answering in text, one
 * calling a `get_weather` tool it was required to use.
 */

const load = async (name: string) => new Uint8Array(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer())
const textStream = await load('bedrock-nova-lite-converse-stream.bin')
const toolStream = await load('bedrock-nova-lite-converse-stream-tool.bin')

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

interface Captured { url: string, headers: Record<string, string>, body: string }

function respondWith(body: Uint8Array): Captured[] {
  const seen: Captured[] = []
  globalThis.fetch = (async (input: string | URL | Request, request?: RequestInit) => {
    seen.push({ url: String(input), headers: request?.headers as Record<string, string>, body: String(request?.body) })
    return new Response(body, { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
  }) as typeof fetch
  return seen
}

/** One event stream frame, string headers only. */
function frame(headers: Record<string, string>, payload: string): Uint8Array {
  const encoder = new TextEncoder()
  const body = encoder.encode(payload)
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

const event = (type: string, fields: unknown) => frame({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, JSON.stringify(fields))

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function collect(stream: AsyncIterable<ConverseStreamEvent>): Promise<ConverseStreamEvent[]> {
  const events: ConverseStreamEvent[] = []
  for await (const next of stream)
    events.push(next)
  return events
}

const ask = { modelId: 'amazon.nova-lite-v1:0', messages: [{ role: 'user' as const, content: [{ text: 'hi' }] }] }

describe('converseStream', () => {
  it('sends the converse request to converse-stream, asking for an event stream', async () => {
    const seen = respondWith(textStream)
    const { stream } = await new BedrockRuntimeClient('us-east-1').converseStream({
      ...ask,
      inferenceConfig: { maxTokens: 50 },
      toolConfig: { tools: [{ toolSpec: { name: 'get_weather', inputSchema: { json: { type: 'object' } } } }] },
    })
    await collect(stream)

    expect(seen[0]!.url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse-stream')
    expect(seen[0]!.headers.Accept).toBe('application/vnd.amazon.eventstream')
    expect(seen[0]!.headers.Authorization).toContain('/us-east-1/bedrock/aws4_request')
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ inferenceConfig: { maxTokens: 50 }, toolConfig: { tools: [{ toolSpec: { name: 'get_weather' } }] } })
  })

  it('yields a text answer as its events, padding stripped', async () => {
    respondWith(textStream)
    const { stream } = await new BedrockRuntimeClient('us-east-1').converseStream(ask)

    expect(await collect(stream)).toEqual([
      { messageStart: { role: 'assistant' } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hello' } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: ' from the stream.' } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { metrics: { latencyMs: 315 }, usage: { inputTokens: 9, outputTokens: 6, serverToolUsage: {}, totalTokens: 15 } } },
    ])
  })

  it('yields a tool call: its id and name at the block start, its arguments as deltas', async () => {
    respondWith(toolStream)
    const { stream } = await new BedrockRuntimeClient('us-east-1').converseStream(ask)
    const events = await collect(stream)

    expect(events[1]).toEqual({ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { name: 'get_weather', toolUseId: 'tooluse_CStN2FyjgRcFZjEnvg7ppN' } } } })
    expect(events[2]).toEqual({ contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":"Paris"}' } } } })
    expect(events.find(e => 'messageStop' in e)).toEqual({ messageStop: { stopReason: 'tool_use' } })
  })

  it('throws a mid-stream exception rather than ending as if the model had finished', async () => {
    respondWith(concat(
      event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'partial' }, p: 'abc' }),
      frame({ ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' }, '{"message":"Too many requests"}'),
    ))
    const { stream } = await new BedrockRuntimeClient('us-east-1').converseStream(ask)

    const seen: ConverseStreamEvent[] = []
    const drain = async () => {
      for await (const next of stream)
        seen.push(next)
    }
    await expect(drain()).rejects.toThrow('throttlingException: Too many requests')
    expect(seen).toEqual([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'partial' } } }])
  })

  it('skips an event type it does not know, so a new one cannot break a caller', async () => {
    respondWith(concat(
      event('messageStart', { role: 'assistant', p: 'x' }),
      event('somethingAwsAddsLater', { p: 'y' }),
      event('messageStop', { stopReason: 'end_turn', p: 'z' }),
    ))
    const { stream } = await new BedrockRuntimeClient('us-east-1').converseStream(ask)

    expect(await collect(stream)).toEqual([{ messageStart: { role: 'assistant' } }, { messageStop: { stopReason: 'end_turn' } }])
  })
})
