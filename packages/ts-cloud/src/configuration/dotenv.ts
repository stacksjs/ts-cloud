export interface DotenvDiagnostic {
  line: number
  key?: string
  severity: 'warning' | 'error'
  code: 'invalid_line' | 'invalid_key' | 'duplicate' | 'conflict' | 'unterminated_quote'
  message: string
}

export interface DotenvDocument {
  values: Record<string, string>
  diagnostics: DotenvDiagnostic[]
  valid: boolean
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/

function decodeDoubleQuoted(value: string): string {
  const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', '$': '$' }
  return value.replace(/\\(n|r|t|\\|"|\$)/g, (_, escaped: string) => escapes[escaped]!)
}

export function parseDotenv(source: string): DotenvDocument {
  const values: Record<string, string> = {}, diagnostics: DotenvDiagnostic[] = [], lines = source.replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1
    let line = lines[index]!
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\s*export\s+/.test(line)) line = line.replace(/^\s*export\s+/, '')
    const match = line.match(/^\s*([^=\s]+)\s*=\s*(.*)$/)
    if (!match) { diagnostics.push({ line: lineNumber, severity: 'error', code: 'invalid_line', message: 'Expected KEY=VALUE.' }); continue }
    const key = match[1]!, raw = match[2]!
    if (!KEY.test(key)) { diagnostics.push({ line: lineNumber, key, severity: 'error', code: 'invalid_key', message: `Invalid environment variable name: ${key}` }); continue }
    let value = raw
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0]!, chunks = [raw.slice(1)]; let closed = false
      while (true) {
        const current = chunks[chunks.length - 1]!
        let escaped = false, closing = -1
        for (let i = 0; i < current.length; i++) {
          if (quote === '"' && current[i] === '\\' && !escaped) { escaped = true; continue }
          if (current[i] === quote && !escaped) { closing = i; break }
          escaped = false
        }
        if (closing >= 0) { chunks[chunks.length - 1] = current.slice(0, closing); closed = true; break }
        if (++index >= lines.length) break
        chunks.push(lines[index]!)
      }
      if (!closed) { diagnostics.push({ line: lineNumber, key, severity: 'error', code: 'unterminated_quote', message: `Unterminated quoted value for ${key}.` }); continue }
      value = chunks.join('\n')
      if (quote === '"') value = decodeDoubleQuoted(value)
    }
    else value = raw.replace(/\s+#.*$/, '').trim()

    if (Object.hasOwn(values, key)) {
      const conflict = values[key] !== value
      diagnostics.push({ line: lineNumber, key, severity: conflict ? 'error' : 'warning', code: conflict ? 'conflict' : 'duplicate', message: conflict ? `${key} has conflicting values.` : `${key} is duplicated with the same value.` })
      if (conflict) continue
    }
    values[key] = value
  }
  return { values, diagnostics, valid: !diagnostics.some(item => item.severity === 'error') }
}

export function serializeDotenv(values: Record<string, string>): string {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    if (!KEY.test(key)) throw new Error(`Invalid environment variable name: ${key}`)
    return `${key}=${JSON.stringify(value)}`
  }).join('\n') + (Object.keys(values).length ? '\n' : '')
}
