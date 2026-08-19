/**
 * Shared AWS credential resolution.
 *
 * Two modes:
 *   - Explicit profile (caller passed a profile name): strict — use only that
 *     profile, throw if it isn't in the credentials file. Mirrors the AWS CLI's
 *     behavior with `--profile`.
 *   - Implicit (no profile passed): standard precedence —
 *       AWS_ACCESS_KEY_ID/SECRET env vars > AWS_PROFILE > 'default'.
 */
import type { AWSCredentials } from './client'

export function resolveCredentials(profile?: string): AWSCredentials {
  if (profile) {
    const creds = loadProfileFromFile(profile)
    if (!creds) {
      throw new Error(`AWS profile '${profile}' not found in ~/.aws/credentials`)
    }
    return creds
  }

  const envAccessKey = process.env.AWS_ACCESS_KEY_ID
  const envSecretKey = process.env.AWS_SECRET_ACCESS_KEY
  if (envAccessKey && envSecretKey) {
    return {
      accessKeyId: envAccessKey,
      secretAccessKey: envSecretKey,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    }
  }

  return loadProfileFromFile(process.env.AWS_PROFILE || 'default') ?? { accessKeyId: '', secretAccessKey: '' }
}

function loadProfileFromFile(profile: string): AWSCredentials | null {
  const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
  const { homedir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')

  const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), '.aws', 'credentials')
  if (!existsSync(credentialsPath)) return null

  const content = readFileSync(credentialsPath, 'utf-8')
  let currentProfile: string | null = null
  let accessKeyId: string | undefined
  let secretAccessKey: string | undefined
  let sessionToken: string | undefined

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue

    const profileMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (profileMatch) {
      if (currentProfile === profile && accessKeyId && secretAccessKey) {
        return { accessKeyId, secretAccessKey, sessionToken }
      }
      currentProfile = profileMatch[1]
      accessKeyId = undefined
      secretAccessKey = undefined
      sessionToken = undefined
      continue
    }

    if (currentProfile === profile) {
      const [key, ...valueParts] = trimmed.split('=')
      const value = valueParts.join('=').trim()
      switch (key.trim().toLowerCase()) {
        case 'aws_access_key_id':
          accessKeyId = value
          break
        case 'aws_secret_access_key':
          secretAccessKey = value
          break
        case 'aws_session_token':
          sessionToken = value
          break
      }
    }
  }

  if (currentProfile === profile && accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, sessionToken }
  }

  return null
}
