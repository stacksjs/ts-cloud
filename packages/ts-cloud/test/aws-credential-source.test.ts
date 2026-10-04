/**
 * `cloud cdn:status <id>` failed with a bare InvalidClientTokenId, and the
 * global `--profile` flag that should have let you pick other credentials was
 * declared and read by nothing. Two things made that hard to see:
 *
 * - AWSClient tries env keys, then a profile, then EC2 metadata, and the first
 *   one wins silently. Run from the repo root, Bun loads `.env` and its keys win;
 *   run from packages/ts-cloud, the `default` profile does. The rejection named
 *   neither, so a stale profile and a stale .env key looked identical.
 * - `--profile` reached no command, and an explicit profile would anyway have
 *   lost to `.env` keys, unlike the AWS CLI's `--profile`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyGlobalAwsOptions } from '../bin/global-options'
import { AWSClient } from '../src/aws/client'

const originalFetch = globalThis.fetch
let savedEnv: Record<string, string | undefined> = {}
let dir = ''

beforeEach(() => {
  savedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AWS_')))
  for (const key of Object.keys(savedEnv)) delete process.env[key]
  dir = mkdtempSync(join(tmpdir(), 'ts-cloud-creds-'))
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_'))
      delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  rmSync(dir, { recursive: true, force: true })
})

/** Answer every request the way STS answers a key it does not recognize. */
function rejectCredentials(code = 'InvalidClientTokenId'): void {
  globalThis.fetch = (async () => new Response(
    `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${code}</Code><Message>The security token included in the request is invalid.</Message></Error><RequestId>4fb0a9b4-a8f7-4ed3-9a6f-d0f6a5d3b2c1</RequestId></ErrorResponse>`,
    { status: 403 },
  )) as unknown as typeof fetch
}

async function callerIdentity(client: AWSClient): Promise<Error> {
  try {
    await client.request({ service: 'sts', region: 'us-east-1', method: 'POST', path: '/', body: 'Action=GetCallerIdentity&Version=2011-06-15', retries: 0 })
  }
  catch (error) {
    return error as Error
  }
  throw new Error('expected the request to be rejected')
}

function credentialsFile(profiles: Record<string, string>): string {
  const path = join(dir, 'credentials')
  writeFileSync(path, Object.entries(profiles)
    .map(([name, key]) => `[${name}]\naws_access_key_id = ${key}\naws_secret_access_key = secret-${key}\n`)
    .join('\n'))
  return path
}

describe('a credential rejection names where the credentials came from', () => {
  it('names environment keys', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEENV'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    rejectCredentials()
    const error = await callerIdentity(new AWSClient())
    expect(error.message).toContain('InvalidClientTokenId')
    expect(error.message).toContain('(credentials from AWS_ACCESS_KEY_ID in the environment)')
  })

  it('names the profile and the file it was read from', async () => {
    process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile({ default: 'AKIADEFAULT', stacks: 'AKIASTACKS' })
    process.env.AWS_PROFILE = 'stacks'
    rejectCredentials()
    const error = await callerIdentity(new AWSClient())
    expect(error.message).toContain(`(credentials from profile "stacks" in ${process.env.AWS_SHARED_CREDENTIALS_FILE})`)
  })

  it('names credentials handed to the client', async () => {
    rejectCredentials('SignatureDoesNotMatch')
    const error = await callerIdentity(new AWSClient({ accessKeyId: 'AKIAPASSED', secretAccessKey: 'secret' }))
    expect(error.message).toContain('(credentials from credentials passed to AWSClient)')
  })

  it('recognizes a namespaced JSON-protocol code', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEENV'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ __type: 'com.amazon.coral.service#UnrecognizedClientException', message: 'The security token included in the request is invalid.' }),
      { status: 400 },
    )) as unknown as typeof fetch
    const error = await callerIdentity(new AWSClient())
    expect(error.message).toContain('(credentials from AWS_ACCESS_KEY_ID in the environment)')
  })

  it('leaves errors that are not about the credentials alone', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEENV'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    rejectCredentials('AccessDenied')
    const error = await callerIdentity(new AWSClient())
    expect(error.message).not.toContain('credentials from')
  })
})

describe('the global --profile and --region flags', () => {
  const awsProfile = { options: [{ name: 'profile', description: 'AWS credential profile' }] }
  const sshProfile = { options: [{ name: 'profile', description: 'raspberry-pi or generic (default: ssh.profile, then generic)' }] }
  const ownRegion = { options: [{ name: 'region', description: 'AWS region' }] }

  it('makes --profile win over keys already in the environment, as the AWS CLI does', async () => {
    const env: Record<string, string | undefined> = { AWS_ACCESS_KEY_ID: 'AKIAFROMDOTENV', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' }
    applyGlobalAwsOptions({ profile: 'stacks' }, { options: [] }, env)
    expect(env).toEqual({ AWS_PROFILE: 'stacks' })
  })

  it('then resolves to that profile rather than the environment keys', async () => {
    process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile({ stacks: 'AKIASTACKS' })
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFROMDOTENV'
    process.env.AWS_SECRET_ACCESS_KEY = 'secret'
    applyGlobalAwsOptions({ profile: 'stacks' }, undefined)
    rejectCredentials()
    const error = await callerIdentity(new AWSClient())
    expect(error.message).toContain('(credentials from profile "stacks"')
  })

  it('applies to a command that declares its own AWS --profile', () => {
    const env: Record<string, string | undefined> = { AWS_ACCESS_KEY_ID: 'AKIAFROMDOTENV', AWS_SECRET_ACCESS_KEY: 's' }
    applyGlobalAwsOptions({ profile: 'prod' }, awsProfile, env)
    expect(env).toEqual({ AWS_PROFILE: 'prod' })
  })

  it('leaves a non-AWS --profile (ssh:preflight) to its command', () => {
    const env: Record<string, string | undefined> = { AWS_ACCESS_KEY_ID: 'AKIAFROMDOTENV', AWS_SECRET_ACCESS_KEY: 's' }
    applyGlobalAwsOptions({ profile: 'raspberry-pi' }, sshProfile, env)
    expect(env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIAFROMDOTENV', AWS_SECRET_ACCESS_KEY: 's' })
  })

  it('sets the region for commands without their own --region', () => {
    const env: Record<string, string | undefined> = {}
    applyGlobalAwsOptions({ region: 'eu-west-1' }, { options: [] }, env)
    expect(env).toEqual({ AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1' })
  })

  it('does not overwrite AWS_REGION with a command\'s own --region default', () => {
    const env: Record<string, string | undefined> = { AWS_REGION: 'ap-southeast-2' }
    applyGlobalAwsOptions({ region: 'us-east-1' }, ownRegion, env)
    expect(env).toEqual({ AWS_REGION: 'ap-southeast-2' })
  })

  it('changes nothing when neither flag is given', () => {
    const env: Record<string, string | undefined> = { AWS_ACCESS_KEY_ID: 'AKIAFROMDOTENV', AWS_SECRET_ACCESS_KEY: 's' }
    applyGlobalAwsOptions({}, { options: [] }, env)
    expect(env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIAFROMDOTENV', AWS_SECRET_ACCESS_KEY: 's' })
  })
})
