import { createHash } from 'node:crypto'
import type { SshKeyConfig } from '@ts-cloud/core'

export interface AddSshKeyInput {
  configText: string
  name: string
  publicKey: string
  existingKeys?: SshKeyConfig[]
}

export interface RemoveSshKeyInput {
  configText: string
  name: string
  existingKeys?: SshKeyConfig[]
}

export interface ManagedSshKey {
  name: string
  publicKey: string
  type: string
  fingerprint: string
  added: string
}

export function addSshKeyToCloudConfig(input: AddSshKeyInput): string {
  const name = normalizeKeyName(input.name)
  const publicKey = normalizePublicKey(input.publicKey)
  const keys = dedupeKeys([...(input.existingKeys ?? []), { name, publicKey }])
  return updateComputeSshKeys(input.configText, keys)
}

export function removeSshKeyFromCloudConfig(input: RemoveSshKeyInput): string {
  const name = normalizeKeyName(input.name)
  const keys = (input.existingKeys ?? []).filter(key => key.name !== name)
  if ((input.existingKeys ?? []).length === keys.length)
    throw new Error(`SSH key '${name}' does not exist in compute.sshKeys`)
  return updateComputeSshKeys(input.configText, keys)
}

export function describeSshKeys(keys: SshKeyConfig[] = []): ManagedSshKey[] {
  return keys.map(key => ({
    name: key.name,
    publicKey: key.publicKey,
    type: sshKeyType(key.publicKey),
    fingerprint: sshFingerprint(key.publicKey),
    added: 'configured',
  }))
}

function updateComputeSshKeys(configText: string, keys: SshKeyConfig[]): string {
  const compute = findPropertyObject(configText, 'compute')
  const rendered = renderSshKeys(keys)
  const existing = findPropertyArray(configText, compute.start, compute.end, 'sshKeys')

  if (existing) {
    // Replace from the `sshKeys` keyword through its closing `]` (existing.end,
    // inclusive). Everything AFTER the `]` — the property's own trailing comma
    // and newline — is preserved verbatim, so `rendered` must NOT carry its own
    // trailing comma, otherwise each edit would accumulate one (`],` → `],,`).
    //
    // Back the start up over the line's leading whitespace so the renderer's own
    // indentation replaces it rather than stacking on top of it each edit.
    let lineStart = existing.propertyStart
    while (lineStart > 0 && configText[lineStart - 1] !== '\n' && /\s/.test(configText[lineStart - 1]!))
      lineStart--
    return `${configText.slice(0, lineStart)}${rendered}${configText.slice(existing.end + 1)}`
  }

  // Insert a new sshKeys array as the last property of the compute object.
  // Ensure the preceding property is comma-terminated and add a trailing comma
  // after the inserted array so the object stays valid regardless of style.
  const before = configText.slice(0, compute.end).trimEnd()
  const after = configText.slice(compute.end)
  const sep = before.endsWith(',') || before.endsWith('{') ? '' : ','
  return `${before}${sep}\n${rendered},\n    ${after}`
}

function renderSshKeys(keys: SshKeyConfig[]): string {
  // No trailing comma: callers preserve or add the separating comma themselves.
  if (keys.length === 0)
    return '      sshKeys: []'

  const body = keys.map(key => [
    '        {',
    `          name: '${escapeString(key.name)}',`,
    `          publicKey: '${escapeString(normalizePublicKey(key.publicKey))}',`,
    '        },',
  ].join('\n')).join('\n')

  return `      sshKeys: [\n${body}\n      ]`
}

function dedupeKeys(keys: SshKeyConfig[]): SshKeyConfig[] {
  const seen = new Map<string, SshKeyConfig>()
  for (const key of keys) {
    const name = normalizeKeyName(key.name)
    if (seen.has(name))
      throw new Error(`SSH key '${name}' already exists in compute.sshKeys`)
    seen.set(name, { name, publicKey: normalizePublicKey(key.publicKey) })
  }
  return [...seen.values()]
}

function normalizeKeyName(name: string): string {
  const normalized = name.trim()
  if (!/^[\w@.+-]{2,80}$/.test(normalized))
    throw new Error('SSH key name must be 2-80 characters and use letters, numbers, @, ., +, _, or -.')
  return normalized
}

function normalizePublicKey(publicKey: string): string {
  const normalized = publicKey.trim().replace(/\s+/g, ' ')
  const [type, body] = normalized.split(' ')
  if (!/^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521))$/.test(type ?? '') || !body)
    throw new Error('Public key must be an OpenSSH public key, e.g. ssh-ed25519 AAAA... name@host.')
  return normalized
}

function sshKeyType(publicKey: string): string {
  return publicKey.trim().split(/\s+/)[0] || 'ssh'
}

function sshFingerprint(publicKey: string): string {
  const body = publicKey.trim().split(/\s+/)[1]
  if (!body)
    return '-'
  try {
    return `SHA256:${createHash('sha256').update(Buffer.from(body, 'base64')).digest('base64').replace(/=+$/, '')}`
  }
  catch {
    return '-'
  }
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replaceAll(String.fromCharCode(39), '\\\'')
}

interface ObjectBounds {
  start: number
  end: number
  propertyStart: number
}

function findPropertyObject(configText: string, property: string): ObjectBounds {
  const match = new RegExp(`\\b${property}\\s*:\\s*{`, 'g').exec(configText)
  if (!match)
    throw new Error(`Could not find ${property}: { ... } in cloud config.`)
  const start = configText.indexOf('{', match.index)
  return { propertyStart: match.index, start, end: findMatching(configText, start, '{', '}') }
}

function findPropertyArray(configText: string, start: number, end: number, property: string): ObjectBounds | null {
  const body = configText.slice(start + 1, end)
  const match = new RegExp(`\\b${property}\\s*:\\s*\\[`, 'g').exec(body)
  if (!match)
    return null
  const propertyStart = start + 1 + match.index
  const arrayStart = configText.indexOf('[', propertyStart)
  return { propertyStart, start: arrayStart, end: findMatching(configText, arrayStart, '[', ']') }
}

export function findMatching(text: string, start: number, open: string, close: string): number {
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

    if (char === open) depth++
    if (char === close) {
      depth--
      if (depth === 0) return index
    }
  }

  throw new Error(`Could not find matching ${close} in cloud config.`)
}
