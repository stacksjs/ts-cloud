/**
 * AWS Credential Providers
 *
 * Automatically load AWS credentials from various sources:
 * - Environment variables
 * - Shared credentials file (~/.aws/credentials)
 * - EC2 instance metadata
 * - ECS task metadata
 * - Web identity token (for Kubernetes/IRSA)
 */

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AWSCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  expiration?: Date
}

export interface CredentialProviderOptions {
  /** Profile name for shared credentials file (default: 'default' or AWS_PROFILE env var) */
  profile?: string
  /** Path to credentials file (default: ~/.aws/credentials) */
  credentialsFile?: string
  /** Path to config file (default: ~/.aws/config) */
  configFile?: string
  /** Timeout for metadata requests in ms (default: 1000) */
  timeout?: number
}

/**
 * Get credentials from environment variables
 * Checks: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
 */
export function fromEnvironment(): AWSCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    return null
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  }
}

/**
 * Get credentials from shared credentials file (~/.aws/credentials)
 */
export function fromSharedCredentials(options?: CredentialProviderOptions): AWSCredentials | null {
  const profile = options?.profile || process.env.AWS_PROFILE || 'default'
  const credentialsPath = options?.credentialsFile || join(homedir(), '.aws', 'credentials')

  if (!existsSync(credentialsPath)) {
    return null
  }

  try {
    const content = readFileSync(credentialsPath, 'utf-8')
    return parseCredentialsFile(content, profile)
  } catch {
    return null
  }
}

/**
 * Parse INI-style credentials file
 */
function parseCredentialsFile(content: string, profile: string): AWSCredentials | null {
  const lines = content.split('\n')
  let currentProfile: string | null = null
  let accessKeyId: string | undefined
  let secretAccessKey: string | undefined
  let sessionToken: string | undefined

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue
    }

    // Check for profile header
    const profileMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (profileMatch) {
      // If we were processing the target profile, we're done
      if (currentProfile === profile && accessKeyId && secretAccessKey) {
        return { accessKeyId, secretAccessKey, sessionToken }
      }
      currentProfile = profileMatch[1]
      accessKeyId = undefined
      secretAccessKey = undefined
      sessionToken = undefined
      continue
    }

    // Parse key-value pairs
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

  // Check if we found credentials for the target profile
  if (currentProfile === profile && accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, sessionToken }
  }

  return null
}

/**
 * Get credentials from EC2 instance metadata service (IMDSv2)
 */
export async function fromEC2Metadata(options?: CredentialProviderOptions): Promise<AWSCredentials | null> {
  const timeout = options?.timeout ?? 1000
  const metadataUrl = 'http://169.254.169.254'

  try {
    // Step 1: Get IMDSv2 token
    const tokenResponse = await fetchWithTimeout(
      `${metadataUrl}/latest/api/token`,
      {
        method: 'PUT',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      },
      timeout,
    )

    if (!tokenResponse.ok) {
      return null
    }

    const token = await tokenResponse.text()

    // Step 2: Get IAM role name
    const roleResponse = await fetchWithTimeout(
      `${metadataUrl}/latest/meta-data/iam/security-credentials/`,
      { headers: { 'X-aws-ec2-metadata-token': token } },
      timeout,
    )

    if (!roleResponse.ok) {
      return null
    }

    const roleName = (await roleResponse.text()).trim()

    // Step 3: Get credentials for the role
    const credentialsResponse = await fetchWithTimeout(
      `${metadataUrl}/latest/meta-data/iam/security-credentials/${roleName}`,
      { headers: { 'X-aws-ec2-metadata-token': token } },
      timeout,
    )

    if (!credentialsResponse.ok) {
      return null
    }

    const data = await credentialsResponse.json() as {
      AccessKeyId: string
      SecretAccessKey: string
      Token: string
      Expiration: string
    }

    return {
      accessKeyId: data.AccessKeyId,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.Token,
      expiration: new Date(data.Expiration),
    }
  } catch {
    return null
  }
}

/**
 * Get credentials from ECS task metadata
 */
export async function fromECSMetadata(options?: CredentialProviderOptions): Promise<AWSCredentials | null> {
  const timeout = options?.timeout ?? 1000

  // Check for ECS metadata URI
  const relativeUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  const fullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI

  let credentialsUrl: string | null = null

  if (relativeUri) {
    credentialsUrl = `http://169.254.170.2${relativeUri}`
  } else if (fullUri) {
    credentialsUrl = fullUri
  }

  if (!credentialsUrl) {
    return null
  }

  try {
    const headers: Record<string, string> = {}

    // Add authorization token if present
    const authToken = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN
    if (authToken) {
      headers['Authorization'] = authToken
    }

    const response = await fetchWithTimeout(credentialsUrl, { headers }, timeout)

    if (!response.ok) {
      return null
    }

    const data = await response.json() as {
      AccessKeyId: string
      SecretAccessKey: string
      Token: string
      Expiration: string
    }

    return {
      accessKeyId: data.AccessKeyId,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.Token,
      expiration: new Date(data.Expiration),
    }
  } catch {
    return null
  }
}

/**
 * Get credentials from web identity token (for Kubernetes/IRSA)
 */
export async function fromWebIdentity(options?: CredentialProviderOptions): Promise<AWSCredentials | null> {
  const timeout = options?.timeout ?? 5000

  const tokenFile = process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  const roleArn = process.env.AWS_ROLE_ARN
  const sessionName = process.env.AWS_ROLE_SESSION_NAME || 'ts-cloud-session'

  if (!tokenFile || !roleArn) {
    return null
  }

  try {
    // Read the web identity token
    const token = readFileSync(tokenFile, 'utf-8').trim()

    // Determine region for STS endpoint
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
    const stsEndpoint = region.startsWith('us-gov')
      ? `https://sts.${region}.amazonaws.com`
      : region === 'us-east-1'
        ? 'https://sts.amazonaws.com'
        : `https://sts.${region}.amazonaws.com`

    // Call STS AssumeRoleWithWebIdentity
    const params = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      WebIdentityToken: token,
    })

    const response = await fetchWithTimeout(
      `${stsEndpoint}/?${params.toString()}`,
      { method: 'POST' },
      timeout,
    )

    if (!response.ok) {
      return null
    }

    const text = await response.text()

    // Parse XML response
    const accessKeyId = extractXmlValue(text, 'AccessKeyId')
    const secretAccessKey = extractXmlValue(text, 'SecretAccessKey')
    const sessionToken = extractXmlValue(text, 'SessionToken')
    const expiration = extractXmlValue(text, 'Expiration')

    if (!accessKeyId || !secretAccessKey) {
      return null
    }

    return {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiration: expiration ? new Date(expiration) : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Get credentials using the default credential chain
 * Tries providers in order: Environment -> Shared Credentials -> Web Identity -> ECS -> EC2
 */
export async function getCredentials(options?: CredentialProviderOptions): Promise<AWSCredentials> {
  // 1. Environment variables (fastest, most common in containers)
  const envCreds = fromEnvironment()
  if (envCreds) {
    return envCreds
  }

  // 2. Shared credentials file (common for local development)
  const sharedCreds = fromSharedCredentials(options)
  if (sharedCreds) {
    return sharedCreds
  }

  // 3. Web identity token (Kubernetes/IRSA)
  const webIdentityCreds = await fromWebIdentity(options)
  if (webIdentityCreds) {
    return webIdentityCreds
  }

  // 4. ECS task metadata
  const ecsCreds = await fromECSMetadata(options)
  if (ecsCreds) {
    return ecsCreds
  }

  // 5. EC2 instance metadata
  const ec2Creds = await fromEC2Metadata(options)
  if (ec2Creds) {
    return ec2Creds
  }

  throw new Error(
    'Could not find AWS credentials. ' +
    'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables, ' +
    'or configure ~/.aws/credentials, or run on an EC2 instance with an IAM role.',
  )
}

/**
 * Create a credential provider that caches and auto-refreshes credentials
 */
export function createCredentialProvider(options?: CredentialProviderOptions): () => Promise<AWSCredentials> {
  let cachedCredentials: AWSCredentials | null = null
  let refreshPromise: Promise<AWSCredentials> | null = null

  return async () => {
    // Check if credentials are still valid (with 5 minute buffer)
    if (cachedCredentials) {
      if (!cachedCredentials.expiration) {
        return cachedCredentials
      }
      const bufferMs = 5 * 60 * 1000 // 5 minutes
      if (cachedCredentials.expiration.getTime() - Date.now() > bufferMs) {
        return cachedCredentials
      }
    }

    // Avoid multiple concurrent refresh calls
    if (refreshPromise) {
      return refreshPromise
    }

    refreshPromise = getCredentials(options)
      .then((creds) => {
        cachedCredentials = creds
        refreshPromise = null
        return creds
      })
      .catch((err) => {
        refreshPromise = null
        throw err
      })

    return refreshPromise
  }
}

/**
 * Helper to fetch with timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

/**
 * Extract value from XML element
 */
function extractXmlValue(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}>([^<]+)</${tagName}>`)
  const match = xml.match(regex)
  return match ? match[1] : null
}

// ============================================================================
// Backwards Compatibility Exports
// ============================================================================

export interface AWSProfile {
  name: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region?: string
}

/**
 * Resolve AWS credentials from various sources
 * @deprecated Use getCredentials() instead
 */
export async function resolveCredentials(profile?: string): Promise<AWSCredentials> {
  return getCredentials({ profile })
}

/**
 * Resolve AWS region from environment or config
 */
export function resolveRegion(profile?: string): string {
  // Check environment variables first
  const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
  if (envRegion) {
    return envRegion
  }

  // Try to read from config file
  const configPath = join(homedir(), '.aws', 'config')
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8')
      const targetProfile = profile || process.env.AWS_PROFILE || 'default'
      const profileHeader = targetProfile === 'default' ? '[default]' : `[profile ${targetProfile}]`

      const lines = content.split('\n')
      let inProfile = false

      for (const line of lines) {
        const trimmed = line.trim()

        if (trimmed.startsWith('[')) {
          inProfile = trimmed === profileHeader
          continue
        }

        if (inProfile && trimmed.startsWith('region')) {
          const [, value] = trimmed.split('=')
          if (value) {
            return value.trim()
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // Default to us-east-1
  return 'us-east-1'
}

/**
 * Get AWS account ID using STS GetCallerIdentity
 */
export async function getAccountId(credentials?: AWSCredentials): Promise<string> {
  const creds = credentials || await getCredentials()
  const region = resolveRegion()

  // Import signRequest dynamically to avoid circular dependency
  const { signRequest } = await import('./signature')

  const stsEndpoint = region.startsWith('us-gov')
    ? `https://sts.${region}.amazonaws.com`
    : region === 'us-east-1'
      ? 'https://sts.amazonaws.com'
      : `https://sts.${region}.amazonaws.com`

  const body = 'Action=GetCallerIdentity&Version=2011-06-15'

  const signed = signRequest({
    method: 'POST',
    url: stsEndpoint,
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    ...creds,
    service: 'sts',
    region,
  })

  const response = await fetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
  })

  if (!response.ok) {
    throw new Error(`Failed to get account ID: ${await response.text()}`)
  }

  const xml = await response.text()
  const accountId = extractXmlValue(xml, 'Account')

  if (!accountId) {
    throw new Error('Failed to parse account ID from response')
  }

  return accountId
}
