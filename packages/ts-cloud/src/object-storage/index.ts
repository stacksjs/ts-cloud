/**
 * Multi-provider object storage.
 *
 * AWS S3, Backblaze B2 and Hetzner Object Storage all speak the S3 API and
 * authenticate with AWS Signature V4, so a single {@link S3Client} drives all
 * three — the only differences are the endpoint host, the addressing style and
 * where the credentials come from. This module resolves those differences from
 * a small config object (or environment variables) and hands back a ready
 * {@link S3Client}.
 *
 * @example
 * ```ts
 * // Backblaze B2 from explicit config
 * const s3 = createObjectStorageClient({
 *   provider: 'backblaze',
 *   region: 'us-west-004',
 *   credentials: { accessKeyId: keyId, secretAccessKey: appKey },
 * })
 * await s3.putObject({ bucket: 'my-bucket', key: 'a.txt', body: 'hi' })
 *
 * // Or entirely from env (OBJECT_STORAGE_PROVIDER=backblaze, B2_* vars set)
 * const s3 = createObjectStorageClient()
 * ```
 */
import type { S3ClientOptions } from '../aws/s3'
import { S3Client } from '../aws/s3'

export * from './migrate'

export type ObjectStorageProvider = 'aws' | 'backblaze' | 'hetzner'

export interface ObjectStorageCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface ObjectStorageConfig {
  /** Storage provider. Defaults to `OBJECT_STORAGE_PROVIDER`/`STORAGE_PROVIDER` env, then `'aws'`. */
  provider?: ObjectStorageProvider
  /** Region / location slug. Provider-specific default if omitted (see {@link resolveObjectStorage}). */
  region?: string
  /** Endpoint host override (no scheme). Defaults to the provider's standard endpoint for the region. */
  endpoint?: string
  /** Force path-style addressing. Defaults to virtual-hosted, which all three providers support. */
  forcePathStyle?: boolean
  /** Explicit credentials. When omitted, resolved from provider-specific env vars (see below). */
  credentials?: ObjectStorageCredentials
  /** AWS named profile (AWS provider only) — ignored by B2/Hetzner. */
  profile?: string
}

export interface ResolvedObjectStorage {
  provider: ObjectStorageProvider
  region: string
  /** Endpoint host (no scheme), or undefined for AWS S3 (uses the default AWS endpoint). */
  endpoint?: string
  forcePathStyle: boolean
  credentials?: ObjectStorageCredentials
  profile?: string
  /** Public HTTPS base URL for a bucket (no trailing slash). */
  publicBaseUrl: (bucket: string) => string
}

const DEFAULT_REGION: Record<ObjectStorageProvider, string> = {
  aws: 'us-east-1',
  backblaze: 'us-west-004',
  hetzner: 'fsn1',
}

/** Standard endpoint host for a provider+region (undefined ⇒ use AWS default). */
export function providerEndpoint(provider: ObjectStorageProvider, region: string): string | undefined {
  switch (provider) {
    case 'backblaze':
      return `s3.${region}.backblazeb2.com`
    case 'hetzner':
      return `${region}.your-objectstorage.com`
    case 'aws':
    default:
      return undefined
  }
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  return undefined
}

/**
 * Resolve credentials for a provider from explicit config, then provider-specific
 * env vars, falling back to the generic `S3_*` / AWS chain. Returns undefined
 * when nothing is set so the AWS provider can use its profile/instance-role chain.
 */
function resolveCredentials(
  provider: ObjectStorageProvider,
  explicit?: ObjectStorageCredentials,
): ObjectStorageCredentials | undefined {
  if (explicit?.accessKeyId && explicit.secretAccessKey) return explicit

  let accessKeyId: string | undefined
  let secretAccessKey: string | undefined

  if (provider === 'backblaze') {
    accessKeyId = env('B2_APPLICATION_KEY_ID', 'B2_KEY_ID', 'S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID')
    secretAccessKey = env('B2_APPLICATION_KEY', 'B2_SECRET_KEY', 'S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY')
  } else if (provider === 'hetzner') {
    accessKeyId = env('HETZNER_S3_ACCESS_KEY', 'HETZNER_ACCESS_KEY', 'S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID')
    secretAccessKey = env(
      'HETZNER_S3_SECRET_KEY',
      'HETZNER_SECRET_KEY',
      'S3_SECRET_ACCESS_KEY',
      'AWS_SECRET_ACCESS_KEY',
    )
  } else {
    // AWS: let S3Client's own profile/env/instance-role chain handle it.
    accessKeyId = env('S3_ACCESS_KEY_ID')
    secretAccessKey = env('S3_SECRET_ACCESS_KEY')
  }

  if (accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, sessionToken: env('AWS_SESSION_TOKEN') }
  }
  return undefined
}

/**
 * Resolve a full object-storage configuration from explicit values + environment.
 * Pure and side-effect free — useful for diagnostics and for building both the
 * client and the public URLs consistently.
 */
export function resolveObjectStorage(config: ObjectStorageConfig = {}): ResolvedObjectStorage {
  const provider =
    config.provider ||
    (env('OBJECT_STORAGE_PROVIDER', 'STORAGE_PROVIDER') as ObjectStorageProvider | undefined) ||
    'aws'

  const region =
    config.region ||
    (provider === 'backblaze' ? env('B2_REGION') : undefined) ||
    (provider === 'hetzner' ? env('HETZNER_S3_REGION', 'HETZNER_REGION') : undefined) ||
    env('S3_REGION', 'AWS_REGION', 'AWS_DEFAULT_REGION') ||
    DEFAULT_REGION[provider]

  const endpoint = config.endpoint || env('S3_ENDPOINT') || providerEndpoint(provider, region)

  // Virtual-hosted by default. Env opt-in for path-style (e.g. S3_FORCE_PATH_STYLE=true).
  const forcePathStyle = config.forcePathStyle ?? env('S3_FORCE_PATH_STYLE') === 'true'

  const credentials = resolveCredentials(provider, config.credentials)

  const publicBaseUrl = (bucket: string): string => {
    const base = endpoint || `s3.${region}.amazonaws.com`
    return forcePathStyle ? `https://${base}/${bucket}` : `https://${bucket}.${base}`
  }

  return {
    provider,
    region,
    endpoint,
    forcePathStyle,
    credentials,
    profile: config.profile,
    publicBaseUrl,
  }
}

/**
 * Create an {@link S3Client} for any supported provider. AWS S3 with no config
 * behaves exactly as `new S3Client()` did before.
 */
export function createObjectStorageClient(config: ObjectStorageConfig = {}): S3Client {
  const resolved = resolveObjectStorage(config)
  const options: S3ClientOptions = {
    endpoint: resolved.endpoint,
    forcePathStyle: resolved.forcePathStyle,
    credentials: resolved.credentials,
  }
  return new S3Client(resolved.region, resolved.profile, options)
}
