export interface ArchiveInspectionOptions { maxBytes?: number, maxEntries?: number, maxExpandedBytes?: number }
export interface ArchiveInspection { format: 'zip' | 'tar', entries: number, expandedBytes: number, paths: string[] }

function safePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return !!normalized && !normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized) && !normalized.split('/').includes('..') && !/[\0\r\n]/.test(normalized)
}

export function inspectApplicationArchive(bytes: Uint8Array, filename: string, options: ArchiveInspectionOptions = {}): ArchiveInspection {
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024; const maxEntries = options.maxEntries ?? 10_000; const maxExpanded = options.maxExpandedBytes ?? 500 * 1024 * 1024
  if (bytes.byteLength > maxBytes) throw new Error('Archive exceeds the compressed size limit')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const paths: string[] = []; let expandedBytes = 0
  if (filename.toLowerCase().endsWith('.zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    let offset = 0
    while (offset + 30 <= bytes.length) {
      const signature = view.getUint32(offset, true)
      if (signature === 0x02014b50 || signature === 0x06054b50) break
      if (signature !== 0x04034b50) throw new Error('Malformed ZIP local header')
      const flags = view.getUint16(offset + 6, true); const compressed = view.getUint32(offset + 18, true); const expanded = view.getUint32(offset + 22, true); const nameLength = view.getUint16(offset + 26, true); const extraLength = view.getUint16(offset + 28, true)
      if (flags & 0x08) throw new Error('ZIP data descriptors are not accepted for uploaded artifacts')
      const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength))
      if (!safePath(name)) throw new Error(`Unsafe archive path: ${name}`)
      paths.push(name); expandedBytes += expanded
      if (paths.length > maxEntries || expandedBytes > maxExpanded) throw new Error('Archive expansion limit exceeded')
      offset += 30 + nameLength + extraLength + compressed
    }
    return { format: 'zip', entries: paths.length, expandedBytes, paths }
  }
  if (!filename.toLowerCase().match(/\.(?:tar|tar\.gz|tgz)$/)) throw new Error('Only ZIP and uncompressed TAR artifacts are supported')
  let offset = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) break
    const text = (start: number, length: number) => new TextDecoder().decode(header.subarray(start, start + length)).replace(/\0.*$/, '')
    const name = `${text(345, 155)}${text(345, 155) ? '/' : ''}${text(0, 100)}`
    const size = Number.parseInt(text(124, 12).trim() || '0', 8); const kind = String.fromCharCode(header[156] ?? 0)
    if (!safePath(name)) throw new Error(`Unsafe archive path: ${name}`)
    if (kind === '1' || kind === '2') throw new Error(`Archive links are not accepted: ${name}`)
    if (!Number.isFinite(size) || size < 0) throw new Error('Malformed TAR entry size')
    paths.push(name); expandedBytes += size
    if (paths.length > maxEntries || expandedBytes > maxExpanded) throw new Error('Archive expansion limit exceeded')
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return { format: 'tar', entries: paths.length, expandedBytes, paths }
}
