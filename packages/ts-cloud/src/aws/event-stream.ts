/**
 * Decoder for the AWS event stream encoding (`application/vnd.amazon.eventstream`),
 * the binary framing Bedrock uses for `invoke-with-response-stream`,
 * `converse-stream` and Agents' `InvokeAgent`.
 *
 * Each message is:
 *
 *   total length (u32) | headers length (u32) | prelude CRC32 (u32)
 *   headers | payload | message CRC32 (u32)
 *
 * all big-endian. Both checksums are verified, so a truncated or corrupted
 * frame is an error rather than a silently wrong chunk.
 */

export type EventStreamHeaderValue = string | number | boolean | bigint | Uint8Array | Date

export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>
  payload: Uint8Array
}

const PRELUDE_LENGTH = 12
const CHECKSUM_LENGTH = 4
const MINIMUM_MESSAGE_LENGTH = PRELUDE_LENGTH + CHECKSUM_LENGTH

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++)
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++)
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function decodeHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const headers: Record<string, EventStreamHeaderValue> = {}
  let offset = 0

  while (offset < bytes.length) {
    const nameLength = view.getUint8(offset)
    offset += 1
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength))
    offset += nameLength
    const type = view.getUint8(offset)
    offset += 1

    switch (type) {
      case 0: headers[name] = true; break
      case 1: headers[name] = false; break
      case 2: headers[name] = view.getInt8(offset); offset += 1; break
      case 3: headers[name] = view.getInt16(offset); offset += 2; break
      case 4: headers[name] = view.getInt32(offset); offset += 4; break
      case 5: headers[name] = view.getBigInt64(offset); offset += 8; break
      case 6:
      case 7: {
        const length = view.getUint16(offset)
        offset += 2
        const value = bytes.slice(offset, offset + length)
        headers[name] = type === 7 ? decoder.decode(value) : value
        offset += length
        break
      }
      case 8: headers[name] = new Date(Number(view.getBigInt64(offset))); offset += 8; break
      case 9: headers[name] = bytes.slice(offset, offset + 16); offset += 16; break
      default:
        throw new Error(`Event stream header "${name}" has unknown value type ${type}`)
    }
  }

  return headers
}

/**
 * Decode one complete message. `frame` must be exactly one message long.
 */
export function decodeEventStreamMessage(frame: Uint8Array): EventStreamMessage {
  if (frame.length < MINIMUM_MESSAGE_LENGTH)
    throw new Error(`Event stream message is ${frame.length} bytes, shorter than the ${MINIMUM_MESSAGE_LENGTH}-byte minimum`)

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const totalLength = view.getUint32(0)
  const headersLength = view.getUint32(4)

  if (totalLength !== frame.length)
    throw new Error(`Event stream message declares ${totalLength} bytes but ${frame.length} were given`)
  if (view.getUint32(8) !== crc32(frame.subarray(0, 8)))
    throw new Error('Event stream prelude checksum mismatch')
  if (view.getUint32(totalLength - CHECKSUM_LENGTH) !== crc32(frame.subarray(0, totalLength - CHECKSUM_LENGTH)))
    throw new Error('Event stream message checksum mismatch')

  const headersEnd = PRELUDE_LENGTH + headersLength
  if (headersEnd > totalLength - CHECKSUM_LENGTH)
    throw new Error('Event stream headers overrun the message')

  return {
    headers: decodeHeaders(frame.subarray(PRELUDE_LENGTH, headersEnd)),
    payload: frame.slice(headersEnd, totalLength - CHECKSUM_LENGTH),
  }
}

/**
 * Split a byte stream into event stream messages, however the transport
 * happened to chunk it. A stream that ends partway through a message throws.
 */
export async function* decodeEventStream(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  let buffer = new Uint8Array(0)

  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    const next = new Uint8Array(buffer.length + chunk.length)
    next.set(buffer)
    next.set(chunk, buffer.length)
    buffer = next

    while (buffer.length >= PRELUDE_LENGTH) {
      const totalLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0)
      if (totalLength < MINIMUM_MESSAGE_LENGTH)
        throw new Error(`Event stream message declares ${totalLength} bytes, shorter than the ${MINIMUM_MESSAGE_LENGTH}-byte minimum`)
      if (buffer.length < totalLength)
        break
      yield decodeEventStreamMessage(buffer.subarray(0, totalLength))
      buffer = buffer.slice(totalLength)
    }
  }

  if (buffer.length > 0)
    throw new Error(`Event stream ended ${buffer.length} bytes into an incomplete message`)
}

/**
 * The error an `exception` (or `error`) message stands for.
 *
 * Bedrock sends a mid-stream failure - throttling, a model timeout, a
 * validation error - as a message rather than an HTTP status, so a decoder
 * that skipped these ended the stream early and reported success.
 */
export function eventStreamError(message: EventStreamMessage): Error | null {
  const type = message.headers[':message-type']
  if (type !== 'exception' && type !== 'error')
    return null

  const name = String(message.headers[':exception-type'] ?? message.headers[':error-code'] ?? 'EventStreamError')
  let text = String(message.headers[':error-message'] ?? '')
  if (!text && message.payload.length > 0) {
    const raw = new TextDecoder().decode(message.payload)
    try {
      const parsed = JSON.parse(raw) as { message?: string, Message?: string }
      text = parsed.message ?? parsed.Message ?? raw
    }
    catch {
      text = raw
    }
  }

  const error = new Error(text ? `${name}: ${text}` : name)
  error.name = name
  return error
}
