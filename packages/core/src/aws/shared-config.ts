/**
 * AWS shared config and credentials files, including `credential_process`.
 *
 * The one implementation of "which credentials does this profile name":
 *   - the profile is the explicit one, then AWS_PROFILE, then
 *     AWS_DEFAULT_PROFILE, then `default`;
 *   - `~/.aws/credentials` (override: AWS_SHARED_CREDENTIALS_FILE) holds
 *     `[name]` sections, `~/.aws/config` (override: AWS_CONFIG_FILE) holds
 *     `[default]` and `[profile name]` sections; the two are merged, the
 *     credentials file winning on a clash;
 *   - static keys in the profile win over a `credential_process`;
 *   - a `credential_process` is split into argv like a shell would and spawned
 *     directly (no shell, so no injection), with a timeout, and its JSON is
 *     cached in memory until five minutes before `Expiration` (for the life of
 *     the process when there is none).
 *
 * Nothing here ever prints or logs a credential value, and no error message
 * includes any part of the process's stdout: a JSON parser's complaint can quote
 * the input it choked on.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ProfileCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Set when the credentials expire (a `credential_process` that reported one). */
  expiration?: Date
}

export interface SharedConfigOptions {
  /** Profile name; falls back to AWS_PROFILE, AWS_DEFAULT_PROFILE, then `default`. */
  profile?: string
  /** Credentials file path; falls back to AWS_SHARED_CREDENTIALS_FILE, then ~/.aws/credentials. */
  credentialsFile?: string
  /** Config file path; falls back to AWS_CONFIG_FILE, then ~/.aws/config. */
  configFile?: string
  /** How long a `credential_process` may run before it is killed (default 30 000 ms). */
  timeoutMs?: number
}

/** Default budget for a `credential_process`. */
export const CREDENTIAL_PROCESS_TIMEOUT_MS = 30_000

/** Refresh process-issued credentials this long before they expire. */
const REFRESH_EARLY_MS = 5 * 60 * 1000

/** A credential helper prints a few hundred bytes; anything near this is a runaway. */
const MAX_OUTPUT_BYTES = 1024 * 1024

/** Raised when a `credential_process` fails, times out or prints something unusable. */
export class CredentialProcessError extends Error {
  readonly code = 'CredentialProcessError'
  readonly profile: string
  readonly command: string

  constructor(profile: string, command: string, reason: string) {
    super(`AWS profile "${profile}": credential_process \`${command}\` ${reason}`)
    this.name = 'CredentialProcessError'
    this.profile = profile
    this.command = command
  }
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

/** The profile in effect: explicit, AWS_PROFILE, AWS_DEFAULT_PROFILE, `default`. */
export function resolveProfileName(explicit?: string): string {
  return explicit || process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || 'default'
}

export function sharedCredentialsPath(override?: string): string {
  return expandHome(override || process.env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), '.aws', 'credentials'))
}

export function sharedConfigPath(override?: string): string {
  return expandHome(override || process.env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config'))
}

type IniSections = Map<string, Record<string, string>>

/** Parse INI text into sections of lower-cased keys. Comment lines start with `#` or `;`. */
function parseIni(content: string): IniSections {
  const sections: IniSections = new Map()
  let current: Record<string, string> | null = null

  for (const raw of content.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';'))
      continue

    const header = line.match(/^\[([^\]]+)\]/)
    if (header) {
      const name = header[1].trim()
      current = sections.get(name) ?? {}
      sections.set(name, current)
      continue
    }

    const eq = line.indexOf('=')
    if (current && eq > 0)
      current[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
  }

  return sections
}

function readIni(path: string): IniSections {
  if (!existsSync(path))
    return new Map()
  try {
    return parseIni(readFileSync(path, 'utf-8'))
  }
  catch {
    return new Map()
  }
}

/** A profile's keys from ~/.aws/config: `[default]` or `[profile name]`. */
function configSection(sections: IniSections, profile: string): Record<string, string> | undefined {
  if (profile === 'default')
    return sections.get('default') ?? sections.get('profile default')
  for (const [name, values] of sections) {
    const match = name.match(/^profile\s+(.+)$/)
    if (match && match[1].trim() === profile)
      return values
  }
  return undefined
}

/**
 * Every setting of a profile, from the config and credentials files merged (the
 * credentials file wins). `undefined` when neither file defines the profile.
 */
export function readSharedProfile(options?: SharedConfigOptions): Record<string, string> | undefined {
  const profile = resolveProfileName(options?.profile)
  const fromConfig = configSection(readIni(sharedConfigPath(options?.configFile)), profile)
  const fromCredentials = readIni(sharedCredentialsPath(options?.credentialsFile)).get(profile)
  if (!fromConfig && !fromCredentials)
    return undefined
  return { ...fromConfig, ...fromCredentials }
}

function staticKeys(settings: Record<string, string> | undefined): ProfileCredentials | null {
  const accessKeyId = settings?.aws_access_key_id
  const secretAccessKey = settings?.aws_secret_access_key
  if (!accessKeyId || !secretAccessKey)
    return null
  return { accessKeyId, secretAccessKey, sessionToken: settings?.aws_session_token || undefined }
}

/** Static keys from the profile, without running anything. */
export function loadStaticProfileCredentials(options?: SharedConfigOptions): ProfileCredentials | null {
  return staticKeys(readSharedProfile(options))
}

/** The profile's `credential_process` command line, if it has one. */
export function profileCredentialProcess(options?: SharedConfigOptions): string | null {
  return readSharedProfile(options)?.credential_process || null
}

/**
 * Split a command line into argv the way a POSIX shell would: whitespace
 * separates words, single quotes are literal, double quotes allow `\"` and `\\`,
 * and a backslash outside quotes escapes the next character. No variable,
 * glob, tilde or command expansion happens: the result is spawned directly.
 * On Windows a backslash outside quotes stays literal, so paths survive.
 */
export function splitCommandLine(command: string, platform: string = process.platform): string[] {
  const args: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | '\'' | null = null

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (quote === '\'') {
      if (ch === '\'')
        quote = null
      else
        word += ch
      continue
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null
      }
      else if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\' || (platform !== 'win32' && (command[i + 1] === '$' || command[i + 1] === '`')))) {
        word += command[++i]
      }
      else {
        word += ch
      }
      continue
    }

    if (ch === '\'' || ch === '"') {
      quote = ch
      inWord = true
    }
    else if (ch === '\\' && platform !== 'win32' && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    }
    else if (/\s/.test(ch)) {
      if (inWord) {
        args.push(word)
        word = ''
        inWord = false
      }
    }
    else {
      word += ch
      inWord = true
    }
  }

  if (quote)
    throw new Error('unterminated quote')
  if (inWord)
    args.push(word)
  return args
}

/** Short, single-line, bounded: enough to say why a helper failed. */
function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat
}

/** Validate a process's stdout. Never echoes any of it back. */
function parseProcessOutput(stdout: string, profile: string, command: string): ProfileCredentials {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  }
  catch {
    throw new CredentialProcessError(profile, command, 'printed output that is not valid JSON')
  }

  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new CredentialProcessError(profile, command, 'printed JSON that is not an object')

  const record = data as Record<string, unknown>
  if (record.Version !== 1)
    throw new CredentialProcessError(profile, command, 'printed JSON without "Version": 1')

  const { AccessKeyId, SecretAccessKey, SessionToken, Expiration } = record
  if (typeof AccessKeyId !== 'string' || !AccessKeyId || typeof SecretAccessKey !== 'string' || !SecretAccessKey)
    throw new CredentialProcessError(profile, command, 'printed JSON without AccessKeyId and SecretAccessKey')
  if (SessionToken !== undefined && SessionToken !== null && typeof SessionToken !== 'string')
    throw new CredentialProcessError(profile, command, 'printed a SessionToken that is not a string')

  let expiration: Date | undefined
  if (Expiration !== undefined && Expiration !== null) {
    expiration = typeof Expiration === 'string' ? new Date(Expiration) : undefined
    if (!expiration || Number.isNaN(expiration.getTime()))
      throw new CredentialProcessError(profile, command, 'printed an Expiration that is not a date')
  }

  return {
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
    sessionToken: typeof SessionToken === 'string' && SessionToken ? SessionToken : undefined,
    expiration,
  }
}

function describeTimeout(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

function argvFor(profile: string, command: string): string[] {
  let argv: string[]
  try {
    argv = splitCommandLine(command)
  }
  catch (error) {
    throw new CredentialProcessError(profile, command, `could not be parsed (${(error as Error).message})`)
  }
  if (argv.length === 0)
    throw new CredentialProcessError(profile, command, 'is empty')
  return argv
}

/** Kill the child and anything it started, so a hung helper leaves nothing behind. */
function killTree(pid: number | undefined, fallback: () => void): void {
  try {
    if (pid && process.platform !== 'win32')
      process.kill(-pid, 'SIGKILL')
    else
      fallback()
  }
  catch {
    try {
      fallback()
    }
    catch {}
  }
}

function runProcessAsync(profile: string, command: string, timeoutMs: number): Promise<string> {
  const argv = argvFor(profile, command)

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''

    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout can take the helper's children too.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })

    const finish = (action: () => void): void => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      child.stdout?.destroy()
      child.stderr?.destroy()
      action()
    }

    const timer = setTimeout(() => {
      killTree(child.pid, () => child.kill('SIGKILL'))
      finish(() => reject(new CredentialProcessError(profile, command, `timed out after ${describeTimeout(timeoutMs)} and was killed`)))
    }, timeoutMs)

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(new CredentialProcessError(profile, command, `could not be started (${error.code ?? 'spawn error'})`)))
    })

    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        killTree(child.pid, () => child.kill('SIGKILL'))
        finish(() => reject(new CredentialProcessError(profile, command, 'printed more than 1 MiB')))
        return
      }
      chunks.push(chunk)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000)
        stderr += chunk.toString('utf-8')
    })

    child.on('close', (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const why = snippet(stderr)
          const how = code === null ? `was stopped by ${signal}` : `exited with code ${code}`
          reject(new CredentialProcessError(profile, command, why ? `${how}: ${why}` : how))
          return
        }
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })
    })
  })
}

function runProcessSync(profile: string, command: string, timeoutMs: number): string {
  const argv = argvFor(profile, command)
  const result = spawnSync(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  })

  const code = (result.error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT')
    throw new CredentialProcessError(profile, command, `timed out after ${describeTimeout(timeoutMs)} and was killed`)
  if (code === 'ENOBUFS')
    throw new CredentialProcessError(profile, command, 'printed more than 1 MiB')
  if (result.error)
    throw new CredentialProcessError(profile, command, `could not be started (${code ?? 'spawn error'})`)
  if (result.status !== 0) {
    const why = snippet(result.stderr?.toString('utf-8') ?? '')
    const how = result.status === null ? `was stopped by ${result.signal}` : `exited with code ${result.status}`
    throw new CredentialProcessError(profile, command, why ? `${how}: ${why}` : how)
  }
  return result.stdout.toString('utf-8')
}

interface CacheEntry {
  credentials: ProfileCredentials
  /** Epoch ms after which the entry must be refreshed; Infinity when it never expires. */
  refreshAt: number
}

const processCache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<ProfileCredentials>>()

function cacheKey(profile: string, command: string): string {
  return `${profile}\0${command}`
}

function cached(key: string): ProfileCredentials | null {
  const entry = processCache.get(key)
  return entry && Date.now() < entry.refreshAt ? entry.credentials : null
}

function remember(key: string, credentials: ProfileCredentials): void {
  processCache.set(key, {
    credentials,
    refreshAt: credentials.expiration ? credentials.expiration.getTime() - REFRESH_EARLY_MS : Number.POSITIVE_INFINITY,
  })
}

/** Forget every credential a `credential_process` issued (for tests and sign-out). */
export function clearCredentialProcessCache(): void {
  processCache.clear()
  inFlight.clear()
}

/**
 * Credentials for the profile, running its `credential_process` when it has one
 * and no static keys. `null` when the profile defines neither. A failing helper
 * throws a CredentialProcessError rather than returning null: it was configured,
 * so falling through to some other source would hide the real problem.
 */
export async function loadProfileCredentials(options?: SharedConfigOptions): Promise<ProfileCredentials | null> {
  const profile = resolveProfileName(options?.profile)
  const settings = readSharedProfile({ ...options, profile })
  const keys = staticKeys(settings)
  if (keys)
    return keys

  const command = settings?.credential_process
  if (!command)
    return null

  const key = cacheKey(profile, command)
  const hit = cached(key)
  if (hit)
    return hit

  const pending = inFlight.get(key)
  if (pending)
    return pending

  const run = runProcessAsync(profile, command, options?.timeoutMs ?? CREDENTIAL_PROCESS_TIMEOUT_MS)
    .then((stdout) => {
      const credentials = parseProcessOutput(stdout, profile, command)
      remember(key, credentials)
      return credentials
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, run)
  return run
}

/** Synchronous twin of loadProfileCredentials, for the callers that cannot await. */
export function loadProfileCredentialsSync(options?: SharedConfigOptions): ProfileCredentials | null {
  const profile = resolveProfileName(options?.profile)
  const settings = readSharedProfile({ ...options, profile })
  const keys = staticKeys(settings)
  if (keys)
    return keys

  const command = settings?.credential_process
  if (!command)
    return null

  const key = cacheKey(profile, command)
  const hit = cached(key)
  if (hit)
    return hit

  const credentials = parseProcessOutput(
    runProcessSync(profile, command, options?.timeoutMs ?? CREDENTIAL_PROCESS_TIMEOUT_MS),
    profile,
    command,
  )
  remember(key, credentials)
  return credentials
}
