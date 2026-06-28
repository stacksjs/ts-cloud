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
  const separator = before.endsWith('{') ? '\n' : '\n\n'

  return `${before}${separator}${snippet}\n  ${after}`
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

  lines.push('    },')
  return lines.join('\n')
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
