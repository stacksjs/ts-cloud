/**
 * Minimal, dependency-free ZIP writer for Lambda deployment artifacts.
 *
 * Lambda deployment packages must be ZIP archives. This generalizes the
 * single-file writer in `ts-cloud/src/aws/lambda.ts` to multiple files so the
 * same code path serves a bundled Node/Bun handler (one file) and a full
 * PHP/Laravel application tree (many files). Uses Node's `zlib` only — no
 * third-party zip dependency, in keeping with the zero-dependency ethos.
 */

import { deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** POSIX path inside the archive (forward slashes). */
  name: string
  /** File contents. */
  data: Buffer | Uint8Array | string
  /** Unix file mode (e.g. 0o755 for an executable `bootstrap`). @default 0o644 */
  mode?: number
  /** Last-modified date; defaults to the Unix epoch for reproducible artifacts. */
  date?: Date
}

const CRC_TABLE: number[] = (() => {
  const table: number[] = []
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf-8')
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data)
}

function dosTimeDate(date: Date): { time: number, date: number } {
  // ZIP/DOS timestamps can't represent dates before 1980; clamp to keep it valid.
  const year = Math.max(1980, date.getFullYear())
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xFFFF
  const d = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF
  return { time, date: d }
}

/**
 * Build a ZIP archive from a set of entries. Files are deflate-compressed.
 * External attributes encode the Unix mode so executables stay executable on
 * extraction (required for a custom-runtime `bootstrap`).
 */
export function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = toBuffer(entry.data)
    const compressed = deflateRawSync(raw)
    const crc = crc32(raw)
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf-8')
    const { time, date } = dosTimeDate(entry.date ?? new Date(0))
    const mode = entry.mode ?? 0o644

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(0x031E, 4) // version made by: 0x03 = Unix, 30 = 3.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    // External attributes: Unix mode in the high 16 bits.
    central.writeUInt32LE((mode & 0xFFFF) << 16, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)

    localParts.push(local, compressed)
    centralParts.push(central)
    offset += local.length + compressed.length
  }

  const centralDir = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDir, end])
}
