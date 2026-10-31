/**
 * `AWS_PROFILE=ts-cloud` (a profile defined with `credential_process` in
 * ~/.aws/config) hung or failed through the Bedrock driver while the aws CLI
 * worked: AWSClient read only ~/.aws/credentials. These tests use a fake helper
 * script in a temp dir; no real AWS and no real credentials are involved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearCredentialProcessCache } from '@ts-cloud/core'
import { AWSClient } from '../src/aws/client'
import { resolveCredentials } from '../src/aws/credentials'

const originalFetch = globalThis.fetch
let savedEnv: Record<string, string | undefined> = {}
let dir = ''

beforeEach(() => {
  savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AWS_')))
  for (const key of Object.keys(savedEnv)) delete process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'ts-cloud-awsproc-'))
  clearCredentialProcessCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_'))
      delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  rmSync(dir, { recursive: true, force: true })
  clearCredentialProcessCache()
})

function helper(body: string): string {
  const path = join(dir, 'helper')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function useProfile(command: string): void {
  const config = join(dir, 'config')
  const credentials = join(dir, 'credentials')
  writeFileSync(config, `[profile ts-cloud]\ncredential_process = ${command}\n`)
  writeFileSync(credentials, '')
  process.env.AWS_CONFIG_FILE = config
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentials
  process.env.AWS_PROFILE = 'ts-cloud'
}

/** Record the Authorization headers of every request and answer 200 with an empty JSON object. */
function recordRequests(): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization') ?? '')
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return seen
}

const request = (client: AWSClient) =>
  client.request({ service: 'bedrock', region: 'us-east-1', method: 'GET', path: '/foundation-models', retries: 3 })

describe('AWSClient with a credential_process profile', () => {
  it('signs requests with the keys the helper printed, and runs it once', async () => {
    const counter = join(dir, 'runs')
    useProfile(helper(`echo x >> '${counter}'\necho '{"Version":1,"AccessKeyId":"AKIAFROMPROCESS","SecretAccessKey":"fake-secret","SessionToken":"fake-token"}'`))
    const seen = recordRequests()

    const client = new AWSClient()
    await request(client)
    await request(client)

    expect(seen).toHaveLength(2)
    for (const authorization of seen)
      expect(authorization).toContain('Credential=AKIAFROMPROCESS/')
    expect(readFileSync(counter, 'utf-8').trim().split('\n')).toHaveLength(1)
  })

  it('keeps the precedence: explicit credentials, then env keys, then the profile', async () => {
    useProfile(helper(`echo '{"Version":1,"AccessKeyId":"AKIAFROMPROCESS","SecretAccessKey":"fake-secret"}'`))
    const seen = recordRequests()

    await request(new AWSClient({ accessKeyId: 'AKIAEXPLICIT', secretAccessKey: 'e' }))
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFROMENV'
    process.env.AWS_SECRET_ACCESS_KEY = 'v'
    await request(new AWSClient())
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    await request(new AWSClient())

    expect(seen[0]).toContain('Credential=AKIAEXPLICIT/')
    expect(seen[1]).toContain('Credential=AKIAFROMENV/')
    expect(seen[2]).toContain('Credential=AKIAFROMPROCESS/')
  })

  it('fails once, naming the profile and command, when the helper fails, and does not retry it', async () => {
    const counter = join(dir, 'runs')
    const path = helper(`echo x >> '${counter}'\necho "token expired" >&2\nexit 2`)
    useProfile(path)
    recordRequests()

    const error = await request(new AWSClient()).catch(e => e)
    expect(error.name).toBe('CredentialProcessError')
    expect(error.message).toContain('"ts-cloud"')
    expect(error.message).toContain(path)
    expect(error.message).toContain('token expired')
    expect(readFileSync(counter, 'utf-8').trim().split('\n')).toHaveLength(1)
  })

  it('does not run the helper when the client is built, only when it first signs', () => {
    const marker = join(dir, 'ran')
    useProfile(helper(`touch '${marker}'\necho '{"Version":1,"AccessKeyId":"A","SecretAccessKey":"s"}'`))
    new AWSClient()
    expect(existsSync(marker)).toBe(false)
  })
})

describe('resolveCredentials (the synchronous callers)', () => {
  it('runs the profile credential_process for an explicit profile', () => {
    useProfile(helper(`echo '{"Version":1,"AccessKeyId":"AKIASYNC","SecretAccessKey":"fake-secret","SessionToken":"t"}'`))
    expect(resolveCredentials('ts-cloud')).toEqual({ accessKeyId: 'AKIASYNC', secretAccessKey: 'fake-secret', sessionToken: 't' })
    expect(resolveCredentials().accessKeyId).toBe('AKIASYNC')
  })

  it('still throws for an explicit profile that does not exist', () => {
    useProfile(helper('exit 0'))
    expect(() => resolveCredentials('nope')).toThrow('AWS profile \'nope\' not found')
  })
})
