/**
 * Shared AWS credential resolution for the clients that need credentials
 * before their first request (S3 presigning, Cost Explorer, CloudWatch).
 *
 * Two modes:
 *   - Explicit profile (caller passed a profile name): strict - use only that
 *     profile, throw if it defines no credentials. Mirrors the AWS CLI's
 *     behavior with `--profile`.
 *   - Implicit (no profile passed): standard precedence -
 *       AWS_ACCESS_KEY_ID/SECRET env vars > AWS_PROFILE > 'default'.
 *
 * A profile is the merge of ~/.aws/credentials and ~/.aws/config, and may get its
 * keys from a `credential_process`; the file parsing and the process handling
 * live in @ts-cloud/core's shared-config, the one implementation.
 */
import type { AWSCredentials } from './client'
import { loadProfileCredentialsSync, resolveProfileName } from '@ts-cloud/core'

export function resolveCredentials(profile?: string): AWSCredentials {
  if (profile) {
    const creds = loadProfileCredentialsSync({ profile })
    if (!creds) {
      throw new Error(`AWS profile '${profile}' not found in ~/.aws/credentials or ~/.aws/config`)
    }
    return toClientCredentials(creds)
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

  const creds = loadProfileCredentialsSync({ profile: resolveProfileName() })
  return creds ? toClientCredentials(creds) : { accessKeyId: '', secretAccessKey: '' }
}

function toClientCredentials(creds: { accessKeyId: string, secretAccessKey: string, sessionToken?: string }): AWSCredentials {
  return { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken }
}
