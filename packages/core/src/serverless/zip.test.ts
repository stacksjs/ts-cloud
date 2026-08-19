import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'bun:test'
import { createZip } from './zip'

/** Minimal central-directory reader to verify archive integrity in tests. */
function readZip(buf: Buffer): Array<{ name: string; mode: number; data: Buffer }> {
  // Find End Of Central Directory record.
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('no EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)

  const out: Array<{ name: string; mode: number; data: Buffer }> = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central header')
    const compSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const externalAttrs = buf.readUInt32LE(ptr + 38)
    const localOffset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf-8', ptr + 46, ptr + 46 + nameLen)
    const mode = (externalAttrs >>> 16) & 0xffff

    // Read the local header to locate the compressed payload.
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const compressed = buf.subarray(dataStart, dataStart + compSize)
    out.push({ name, mode, data: inflateRawSync(compressed) })

    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('createZip', () => {
  it('produces a valid PK archive', () => {
    const zip = createZip([{ name: 'index.mjs', data: 'export const x = 1\n' }])
    expect(zip.readUInt32LE(0)).toBe(0x04034b50) // local file header signature
  })

  it('round-trips multiple files with contents and modes', () => {
    const zip = createZip([
      { name: 'index.mjs', data: 'console.log("hi")' },
      { name: 'bootstrap', data: '#!/bin/sh\nexec php\n', mode: 0o755 },
    ])
    const entries = readZip(zip)
    expect(entries.map((e) => e.name).sort()).toEqual(['bootstrap', 'index.mjs'])

    const bootstrap = entries.find((e) => e.name === 'bootstrap')!
    expect(bootstrap.data.toString('utf-8')).toBe('#!/bin/sh\nexec php\n')
    expect(bootstrap.mode).toBe(0o755)
  })

  it('is reproducible for identical input', () => {
    const a = createZip([{ name: 'index.mjs', data: 'same' }])
    const b = createZip([{ name: 'index.mjs', data: 'same' }])
    expect(a.equals(b)).toBe(true)
  })
})
