export interface AddSiteConfigInput {
  configText: string
  name: string
  root: string
  domain?: string
  path?: string
  deploy?: 'bucket' | 'server'
  build?: string
  start?: string
  port?: number
  type?: string
  pathRewriteStyle?: 'directory' | 'flat'
  /** Per-site environment variables. */
  env?: Record<string, string>
  /** TLS: `false` to disable, or `{ provider }` (e.g. letsencrypt). */
  ssl?: boolean | { provider?: string }
}

export function addSiteToCloudConfig(input: AddSiteConfigInput): string {
  const siteName = normalizeSiteName(input.name)
  const sitesObject = findSitesObject(input.configText)

  if (hasSite(input.configText, sitesObject.start, sitesObject.end, siteName)) {
    throw new Error(`Site '${siteName}' already exists in cloud.config.ts`)
  }

  const snippet = renderSiteSnippet({
    ...input,
    name: siteName,
  })
  const before = input.configText.slice(0, sitesObject.end).trimEnd()
  const after = input.configText.slice(sitesObject.end)
  // Keep the object valid whether or not the preceding site ended with a comma:
  // empty block → newline only; comma-terminated → blank line; otherwise insert
  // the missing separating comma before the new entry.
  const separator = before.endsWith('{')
    ? '\n'
    : before.endsWith(',') ? '\n\n' : ',\n\n'

  return `${before}${separator}${snippet}\n  ${after}`
}

export interface RemoveSiteInput {
  configText: string
  name: string
}

/** Remove a site (its whole `name: { ... }` entry) from the sites block. */
export function removeSiteFromCloudConfig(input: RemoveSiteInput): string {
  const name = normalizeSiteName(input.name)
  const sites = findSitesObject(input.configText)
  const span = findSiteSpan(input.configText, sites.start, sites.end, name)
  if (!span)
    throw new Error(`Site '${name}' does not exist in cloud.config.ts`)

  const text = input.configText
  // Expand start back over the entry's leading indentation to the line start.
  let start = span.nameStart
  while (start > 0 && text[start - 1] !== '\n' && /\s/.test(text[start - 1]!)) start--
  // Expand end over a trailing comma and the rest of that line (incl newline).
  let end = span.end + 1
  if (text[end] === ',') end++
  while (end < text.length && text[end] !== '\n' && /\s/.test(text[end]!)) end++
  if (text[end] === '\n') end++
  return text.slice(0, start) + text.slice(end)
}

export interface UpdateSiteInput extends Omit<AddSiteConfigInput, 'configText'> {
  configText: string
}

/**
 * Replace a site's definition with a regenerated one carrying the merged fields.
 * Implemented as remove + add so it reuses the validated insert path (the site
 * moves to the end of the sites block, which keeps the config valid).
 */
export function updateSiteInCloudConfig(input: UpdateSiteInput): string {
  const { configText, ...site } = input
  const removed = removeSiteFromCloudConfig({ configText, name: site.name })
  return addSiteToCloudConfig({ configText: removed, ...site })
}

/**
 * Set (or insert) a single property on a site, preserving every other field —
 * the safe path for editing `ssl`/`env` on a site that may also carry queues,
 * auth, etc. `valueText` is raw TS (use {@link renderSslValue}/{@link renderEnvValue}).
 */
export function setSitePropertyInCloudConfig(input: { configText: string, siteName: string, key: string, valueText: string }): string {
  const name = normalizeSiteName(input.siteName)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.key))
    throw new Error(`Invalid property key '${input.key}'`)
  const sites = findSitesObject(input.configText)
  const span = findSiteSpan(input.configText, sites.start, sites.end, name)
  if (!span)
    throw new Error(`Site '${name}' does not exist in cloud.config.ts`)

  const text = input.configText
  const braceStart = text.indexOf('{', span.nameStart)
  const braceEnd = span.end
  const body = text.slice(braceStart + 1, braceEnd)
  const propMatch = new RegExp(`(^|[\\s,{])(${escapeRegExp(input.key)})\\s*:`, 'm').exec(body)

  if (propMatch) {
    const keyStart = braceStart + 1 + propMatch.index + propMatch[1].length
    const colon = text.indexOf(':', keyStart)
    const valueEnd = scanValueEnd(text, colon + 1, braceEnd)
    return `${text.slice(0, keyStart)}${input.key}: ${input.valueText}${text.slice(valueEnd)}`
  }

  // Insert as the last property, keeping the object comma-valid.
  const before = text.slice(0, braceEnd).trimEnd()
  const sep = before.endsWith('{') || before.endsWith(',') ? '' : ','
  return `${before}${sep}\n      ${input.key}: ${input.valueText},\n    ${text.slice(braceEnd)}`
}

export function renderSslValue(ssl: boolean | { provider?: string }): string {
  if (ssl === false)
    return 'false'
  if (ssl === true)
    return 'true'
  return `{ provider: '${escapeSingle(ssl.provider || 'letsencrypt')}' }`
}

export function renderStringValue(value: string): string {
  return `'${escapeSingle(value)}'`
}

export function renderEnvValue(env: Record<string, string>): string {
  const entries = Object.entries(env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  if (entries.length === 0)
    return '{}'
  return `{\n${entries.map(([key, value]) => `        ${key}: '${escapeSingle(String(value))}',`).join('\n')}\n      }`
}

/** A validated hostname (letters, digits, dots, hyphens; at least one dot). */
export function isValidHostname(value: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value.trim())
}

/** Render a site's `aliases` array (additional nginx `server_name` hostnames). */
export function renderAliasesValue(aliases: string[]): string {
  const list = [...new Set(aliases.map(a => a.trim().toLowerCase()).filter(Boolean))]
  for (const host of list) {
    if (!isValidHostname(host))
      throw new Error(`Alias '${host}' is not a valid hostname.`)
  }
  if (list.length === 0)
    return '[]'
  return `[${list.map(a => `'${escapeSingle(a)}'`).join(', ')}]`
}

/** Render a site's `redirects` map (`from` path/host → `to` URL). Both are quoted strings. */
export function renderRedirectsValue(redirects: Record<string, string>): string {
  const entries = Object.entries(redirects)
    .map(([from, to]) => [from.trim(), String(to).trim()] as const)
    .filter(([from, to]) => from && to)
  if (entries.length === 0)
    return '{}'
  return `{\n${entries.map(([from, to]) => `        '${escapeSingle(from)}': '${escapeSingle(to)}',`).join('\n')}\n      }`
}

/**
 * Index just past a property value, starting after its colon: the terminating
 * top-level comma, or the site's closing brace. Quote- and nesting-aware so
 * object/array/string values are skipped whole.
 */
function scanValueEnd(text: string, start: number, limit: number): number {
  let i = start
  while (i < limit && /\s/.test(text[i]!)) i++
  let depth = 0
  let quote: string | undefined
  let escaped = false
  for (; i < limit; i++) {
    const c = text[i]!
    if (quote) {
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === '\'' || c === '`') { quote = c; continue }
    if (c === '{' || c === '[' || c === '(') { depth++; continue }
    if (c === '}' || c === ']' || c === ')') {
      if (depth === 0) return i
      depth--
      continue
    }
    if (c === ',' && depth === 0) return i
  }
  return limit
}

/** Locate a site's `name: { ... }` span within the sites object. */
function findSiteSpan(configText: string, start: number, end: number, siteName: string): { nameStart: number, end: number } | null {
  const body = configText.slice(start + 1, end)
  const match = new RegExp(`(^|[\\s,{])(${escapeRegExp(siteName)})\\s*:\\s*\\{`, 'm').exec(body)
  if (!match)
    return null
  const nameStart = start + 1 + match.index + match[1].length
  const braceStart = configText.indexOf('{', nameStart)
  return { nameStart, end: findMatchingBrace(configText, braceStart) }
}

export function renderSiteSnippet(input: Omit<AddSiteConfigInput, 'configText'>): string {
  const siteName = normalizeSiteName(input.name)
  const lines = [`    ${siteName}: {`]

  pushString(lines, 'deploy', input.deploy)
  pushString(lines, 'root', input.root)
  pushString(lines, 'path', input.path)
  pushString(lines, 'domain', input.domain)
  pushString(lines, 'type', input.type)
  pushString(lines, 'build', input.build)
  pushString(lines, 'start', input.start)
  if (input.port !== undefined) lines.push(`      port: ${input.port},`)
  pushString(lines, 'pathRewriteStyle', input.pathRewriteStyle)
  if (input.ssl !== undefined) {
    if (input.ssl === false)
      lines.push('      ssl: false,')
    else if (input.ssl === true)
      lines.push('      ssl: true,')
    else
      lines.push(`      ssl: { provider: '${escapeSingle(input.ssl.provider || 'letsencrypt')}' },`)
  }
  if (input.env && Object.keys(input.env).length > 0) {
    lines.push('      env: {')
    for (const [key, value] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      lines.push(`        ${key}: '${escapeSingle(String(value))}',`)
    }
    lines.push('      },')
  }

  lines.push('    },')
  return lines.join('\n')
}

function escapeSingle(value: string): string {
  // Newlines matter as much as quotes here: these values land in single-quoted
  // TS string literals in the shared, box-wide cloud.config.ts. A raw newline
  // terminates the literal and leaves the file syntactically broken for every
  // tenant that loads it. It also keeps line-oriented sinks downstream (heredoc
  // delimiters in the deploy script) safe from values that span lines.
  return value
    .replace(/\\/g, '\\\\')
    .replaceAll(String.fromCharCode(39), '\\\'')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

function normalizeSiteName(name: string): string {
  const normalized = name.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(normalized)) {
    throw new Error(`Invalid site name '${name}'. Use a valid JavaScript object key, e.g. docs or marketingSite.`)
  }

  return normalized
}

function pushString(lines: string[], key: string, value: string | undefined): void {
  if (value === undefined || value === '') return
  const escaped = value.replace(/\\/g, '\\\\').replaceAll(String.fromCharCode(39), '\\\'')
  lines.push(`      ${key}: '${escaped}',`)
}

interface ObjectBounds {
  start: number
  end: number
}

function findSitesObject(configText: string): ObjectBounds {
  const sitesMatch = /\bsites\s*:\s*{/g.exec(configText)
  if (!sitesMatch) {
    throw new Error('Could not find a top-level sites: { ... } block in cloud.config.ts')
  }

  const start = configText.indexOf('{', sitesMatch.index)
  const end = findMatchingBrace(configText, start)
  return { start, end }
}

function hasSite(configText: string, start: number, end: number, siteName: string): boolean {
  const body = configText.slice(start + 1, end)
  return new RegExp(`(^|[\\s,{])${escapeRegExp(siteName)}\\s*:`, 'm').test(body)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0
  let quote: '"' | '\'' | '`' | undefined
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]

    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }

    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }

    if (char === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char
      continue
    }

    if (char === '{') depth++
    if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }

  throw new Error('Could not find the closing brace for sites: { ... } in cloud.config.ts')
}
