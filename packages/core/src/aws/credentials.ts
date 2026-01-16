/**
 * AWS Credentials Resolution
 * Load credentials from environment variables, ~/.aws/credentials, or IAM roles
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface AWSCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region?: string
}

export interface AWSProfile {
  name: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  region?: string
  roleArn?: string
  sourceProfile?: string
}

/**
 * Resolve AWS credentials from various sources
 * Priority:
 * 1. Explicit credentials passed in
 * 2. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
 * 3. AWS credentials file (~/.aws/credentials)
 * 4. IAM role (EC2 instance metadata)
 */
export async function resolveCredentials(
  profile: string = 'default',
  providedCredentials?: Partial<AWSCredentials>,
): Promise<AWSCredentials> {
  // 1. Use provided credentials if available
  if (providedCredentials?.accessKeyId && providedCredentials?.secretAccessKey) {
    return {
      accessKeyId: providedCredentials.accessKeyId,
      secretAccessKey: providedCredentials.secretAccessKey,
      sessionToken: providedCredentials.sessionToken,
      region: providedCredentials.region || await resolveRegion(),
    }
  }

  // 2. Try environment variables
  const envCredentials = getCredentialsFromEnv()
  if (envCredentials) {
    return {
      ...envCredentials,
      region: envCredentials.region || await resolveRegion(),
    }
  }

  // 3. Try AWS credentials file
  const fileCredentials = getCredentialsFromFile(profile)
  if (fileCredentials) {
    return {
      ...fileCredentials,
      region: fileCredentials.region || await resolveRegion(),
    }
  }

  // 4. Try IAM role from EC2 instance metadata
  const iamCredentials = await getCredentialsFromIAM()
  if (iamCredentials) {
    return {
      ...iamCredentials,
      region: iamCredentials.region || await resolveRegion(),
    }
  }

  throw new Error(
    'Unable to resolve AWS credentials. Please configure credentials via:\n'
    + '  1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)\n'
    + '  2. AWS credentials file (~/.aws/credentials)\n'
    + '  3. IAM role (for EC2 instances)',
  )
}

/**
 * Get credentials from environment variables
 */
function getCredentialsFromEnv(): AWSCredentials | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = process.env.AWS_SESSION_TOKEN
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION

  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      region,
    }
  }

  return null
}

/**
 * Get credentials from ~/.aws/credentials file
 */
function getCredentialsFromFile(profile: string): AWSCredentials | null {
  const credentialsPath = join(homedir(), '.aws', 'credentials')
  const configPath = join(homedir(), '.aws', 'config')

  if (!existsSync(credentialsPath)) {
    return null
  }

  try {
    const credentials = parseIniFile(readFileSync(credentialsPath, 'utf-8'))
    const profileData = credentials[profile]

    if (!profileData) {
      return null
    }

    let region = profileData.region

    // Also check config file for region
    if (!region && existsSync(configPath)) {
      const config = parseIniFile(readFileSync(configPath, 'utf-8'))
      const configProfile = config[`profile ${profile}`] || config[profile]
      region = configProfile?.region
    }

    if (profileData.aws_access_key_id && profileData.aws_secret_access_key) {
      return {
        accessKeyId: profileData.aws_access_key_id,
        secretAccessKey: profileData.aws_secret_access_key,
        sessionToken: profileData.aws_session_token,
        region,
      }
    }
  }
  catch (error) {
    console.error('Error reading AWS credentials file:', error)
  }

  return null
}

/**
 * Get credentials from EC2 instance metadata (IAM role)
 */
async function getCredentialsFromIAM(): Promise<AWSCredentials | null> {
  try {
    // EC2 metadata endpoint
    const metadataEndpoint = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'

    // Get role name
    const roleResponse = await fetch(metadataEndpoint, {
      signal: AbortSignal.timeout(1000), // 1 second timeout
    })

    if (!roleResponse.ok) {
      return null
    }

    const roleName = await roleResponse.text()

    // Get credentials for role
    const credentialsResponse = await fetch(`${metadataEndpoint}${roleName}`, {
      signal: AbortSignal.timeout(1000),
    })

    if (!credentialsResponse.ok) {
      return null
    }

    const data = await credentialsResponse.json() as {
      AccessKeyId: string
      SecretAccessKey: string
      Token: string
    }

    return {
      accessKeyId: data.AccessKeyId,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.Token,
    }
  }
  catch {
    // Not running on EC2 or metadata service unavailable
    return null
  }
}

/**
 * Resolve AWS region from various sources
 */
export async function resolveRegion(): Promise<string> {
  // 1. Environment variable
  const envRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
  if (envRegion) {
    return envRegion
  }

  // 2. AWS config file
  const configPath = join(homedir(), '.aws', 'config')
  if (existsSync(configPath)) {
    try {
      const config = parseIniFile(readFileSync(configPath, 'utf-8'))
      const defaultProfile = config.default || config['profile default']
      if (defaultProfile?.region) {
        return defaultProfile.region
      }
    }
    catch {
      // Ignore parse errors
    }
  }

  // 3. EC2 instance metadata
  try {
    const response = await fetch(
      'http://169.254.169.254/latest/meta-data/placement/region',
      { signal: AbortSignal.timeout(1000) },
    )

    if (response.ok) {
      return await response.text()
    }
  }
  catch {
    // Not on EC2
  }

  // Default to us-east-1
  return 'us-east-1'
}

/**
 * Parse INI file format (used by AWS credentials and config files)
 */
function parseIniFile(content: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  let currentSection = ''

  for (const line of content.split('\n')) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue
    }

    // Section header
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1)
      result[currentSection] = {}
      continue
    }

    // Key-value pair
    const equalIndex = trimmed.indexOf('=')
    if (equalIndex > 0 && currentSection) {
      const key = trimmed.slice(0, equalIndex).trim()
      const value = trimmed.slice(equalIndex + 1).trim()
      result[currentSection][key] = value
    }
  }

  return result
}

/**
 * Get account ID from STS GetCallerIdentity
 */
export async function getAccountId(credentials: AWSCredentials): Promise<string> {
  const { signRequest } = await import('./signature')

  const signedRequest = signRequest({
    method: 'POST',
    url: 'https://sts.amazonaws.com/',
    service: 'sts',
    region: credentials.region || 'us-east-1',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: 'Action=GetCallerIdentity&Version=2011-06-15',
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  })

  const response = await fetch(signedRequest.url, {
    method: signedRequest.method,
    headers: signedRequest.headers,
    body: signedRequest.body,
  })

  if (!response.ok) {
    throw new Error(`Failed to get account ID: ${await response.text()}`)
  }

  const text = await response.text()

  // Parse account ID from XML response
  const match = text.match(/<Account>(\d+)<\/Account>/)
  if (match) {
    return match[1]
  }

  throw new Error('Failed to extract account ID from response')
}
