/**
 * Cross-provider object-storage migration.
 *
 * Copies objects from one S3-compatible bucket to another — AWS S3, Backblaze
 * B2, Hetzner Object Storage, in any direction. Both sides are driven by the
 * same {@link createObjectStorageClient}, so the only thing that changes per
 * side is the provider/region/endpoint/credentials.
 *
 * Bytes are copied (not strings) via {@link S3Client.getObjectBytes}, so binary
 * payloads (images, archives, mail attachments) survive intact. Content-Type is
 * preserved when the source reports it.
 *
 * The copy is idempotent: an object already present at the destination with the
 * same size is skipped unless `force` is set. Keys may be remapped by stripping
 * `fromPrefix` and prepending `toPrefix`, and filtered with include/exclude
 * prefix lists so an operator can clearly see what was migrated vs. deliberately
 * left behind.
 */
import type { S3Client, S3Object } from '../aws/s3'
import type { ObjectStorageProvider } from './index'
import { createObjectStorageClient } from './index'

/** One side (source or destination) of a migration. */
export interface MigrateEndpoint {
  provider: ObjectStorageProvider
  bucket: string
  region?: string
  /** Endpoint host override (no scheme). Defaults to the provider's standard endpoint. */
  endpoint?: string
  forcePathStyle?: boolean
  /** Key prefix. On the source it scopes/strips; on the dest it is prepended. */
  prefix?: string
  /** Explicit credentials. When omitted, resolved from the provider's env vars. */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  /** Pre-built client (used by tests to inject an in-memory mock). */
  client?: S3Client
}

export interface MigrateOptions {
  from: MigrateEndpoint
  to: MigrateEndpoint
  /** Only copy keys whose (source) key starts with one of these prefixes. */
  include?: string[]
  /** Skip keys whose (source) key starts with one of these prefixes. */
  exclude?: string[]
  /** Plan only — do not write to the destination. */
  dryRun?: boolean
  /** Re-copy even if the destination already has an object of the same size. */
  force?: boolean
  /** Delete destination keys (within the dest prefix) that are not in the copied set. Default OFF. */
  deleteExtraneous?: boolean
  /** Max in-flight copies. Default 8. */
  concurrency?: number
  /** After copying, re-list the destination and assert counts + sizes match the copied set. */
  verify?: boolean
  /** Optional progress callback, invoked per object after it is copied/skipped. */
  onProgress?: (event: MigrateProgress) => void
}

export interface MigrateProgress {
  /** Source key. */
  key: string
  /** Destination key the object maps to. */
  destKey: string
  size: number
  action: 'copied' | 'skipped' | 'excluded' | 'error' | 'planned'
  /** 1-based index of this object within the full source listing. */
  index: number
  total: number
}

export interface MigrateError {
  key: string
  message: string
}

export interface MigratePlanItem {
  key: string
  destKey: string
  size: number
}

export interface MigrateResult {
  copied: number
  skipped: number
  excluded: number
  bytesCopied: number
  errors: MigrateError[]
  /** Keys that were excluded by include/exclude filters (source keys). */
  excludedKeys: string[]
  /** Keys deleted from the destination via `deleteExtraneous`. */
  deleted: string[]
  /** When `dryRun` is set, the objects that would be copied. */
  plan?: MigratePlanItem[]
  /** Verification outcome when `verify` is set. */
  verification?: MigrateVerification
}

export interface MigrateVerification {
  ok: boolean
  /** Number of (key,size) pairs that matched at the destination. */
  matched: number
  /** Copied keys missing at the destination. */
  missing: string[]
  /** Copied keys present at the destination but with a different size. */
  sizeMismatches: Array<{ key: string; expected: number; actual: number }>
}

/** Strip a leading prefix from a key (no-op when prefix is empty or absent). */
function stripPrefix(key: string, prefix?: string): string {
  if (!prefix) return key
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

/**
 * Compute the destination key for a source key: strip the source prefix, then
 * prepend the destination prefix. Exported for unit testing.
 */
export function remapKey(sourceKey: string, fromPrefix?: string, toPrefix?: string): string {
  const stripped = stripPrefix(sourceKey, fromPrefix)
  return `${toPrefix ?? ''}${stripped}`
}

/**
 * Decide whether a source key passes the include/exclude prefix filters.
 * `include` (when non-empty) is a whitelist; `exclude` always wins. Exported for
 * unit testing.
 */
export function keyMatchesFilters(key: string, include?: string[], exclude?: string[]): boolean {
  if (exclude && exclude.some((p) => key.startsWith(p))) return false
  if (include && include.length > 0) return include.some((p) => key.startsWith(p))
  return true
}

/** Run an async mapper over items with bounded concurrency, preserving order of side effects. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners: Promise<void>[] = []
  const size = Math.max(1, Math.min(limit, items.length || 1))
  for (let i = 0; i < size; i++) {
    runners.push(
      (async () => {
        while (true) {
          const index = cursor++
          if (index >= items.length) return
          await worker(items[index], index)
        }
      })(),
    )
  }
  await Promise.all(runners)
}

function clientFor(endpoint: MigrateEndpoint): S3Client {
  if (endpoint.client) return endpoint.client
  return createObjectStorageClient({
    provider: endpoint.provider,
    region: endpoint.region,
    endpoint: endpoint.endpoint,
    forcePathStyle: endpoint.forcePathStyle,
    credentials: endpoint.credentials,
  })
}

/**
 * Migrate objects from one S3-compatible bucket to another.
 *
 * @returns a structured {@link MigrateResult} so callers (CLI, buddy, scripts)
 * can report exactly what was copied, skipped, excluded, deleted and verified.
 */
export async function migrateObjectStorage(options: MigrateOptions): Promise<MigrateResult> {
  const concurrency = options.concurrency ?? 8
  const fromClient = clientFor(options.from)
  const toClient = clientFor(options.to)

  // List every source object (paginated internally — handles >1000 keys).
  const sourceObjects = await fromClient.listAllObjects({
    bucket: options.from.bucket,
    prefix: options.from.prefix,
  })

  const result: MigrateResult = {
    copied: 0,
    skipped: 0,
    excluded: 0,
    bytesCopied: 0,
    errors: [],
    excludedKeys: [],
    deleted: [],
  }

  // Partition into "to copy" vs "excluded" via the include/exclude filters.
  const toCopy: Array<{ source: S3Object; destKey: string }> = []
  for (const obj of sourceObjects) {
    if (!keyMatchesFilters(obj.Key, options.include, options.exclude)) {
      result.excluded++
      result.excludedKeys.push(obj.Key)
      continue
    }
    toCopy.push({ source: obj, destKey: remapKey(obj.Key, options.from.prefix, options.to.prefix) })
  }

  // Dry run: produce the plan, fire 'planned'/'excluded' progress, and stop.
  if (options.dryRun) {
    result.plan = toCopy.map(({ source, destKey }) => ({ key: source.Key, destKey, size: source.Size }))
    const total = sourceObjects.length
    let index = 0
    for (const obj of sourceObjects) {
      index++
      const excluded = !keyMatchesFilters(obj.Key, options.include, options.exclude)
      options.onProgress?.({
        key: obj.Key,
        destKey: excluded ? '' : remapKey(obj.Key, options.from.prefix, options.to.prefix),
        size: obj.Size,
        action: excluded ? 'excluded' : 'planned',
        index,
        total,
      })
    }
    return result
  }

  const total = toCopy.length
  let processed = 0
  await mapWithConcurrency(toCopy, concurrency, async ({ source, destKey }) => {
    const myIndex = ++processed
    try {
      // Idempotency: skip when the destination already has an object of the same size.
      if (!options.force) {
        const head = await toClient.headObject(options.to.bucket, destKey)
        if (head && head.ContentLength === source.Size) {
          result.skipped++
          options.onProgress?.({
            key: source.Key,
            destKey,
            size: source.Size,
            action: 'skipped',
            index: myIndex,
            total,
          })
          return
        }
      }

      const { body, contentType } = await fromClient.getObjectBytes(options.from.bucket, source.Key)
      await toClient.putObject({
        bucket: options.to.bucket,
        key: destKey,
        body,
        contentType,
      })
      result.copied++
      result.bytesCopied += body.byteLength
      options.onProgress?.({ key: source.Key, destKey, size: source.Size, action: 'copied', index: myIndex, total })
    } catch (err: any) {
      result.errors.push({ key: source.Key, message: err?.message ?? String(err) })
      options.onProgress?.({ key: source.Key, destKey, size: source.Size, action: 'error', index: myIndex, total })
    }
  })

  const copiedDestKeys = new Set(toCopy.map((c) => c.destKey))

  // Optionally remove destination keys (within the dest prefix) not in the copied set.
  if (options.deleteExtraneous) {
    const destObjects = await toClient.listAllObjects({ bucket: options.to.bucket, prefix: options.to.prefix })
    const extraneous = destObjects.filter((o) => !copiedDestKeys.has(o.Key)).map((o) => o.Key)
    for (const key of extraneous) {
      try {
        await toClient.deleteObject(options.to.bucket, key)
        result.deleted.push(key)
      } catch (err: any) {
        result.errors.push({ key, message: `delete failed: ${err?.message ?? String(err)}` })
      }
    }
  }

  // Optionally verify: re-list the destination and assert the copied set is present with matching sizes.
  if (options.verify) {
    const destObjects = await toClient.listAllObjects({ bucket: options.to.bucket, prefix: options.to.prefix })
    const destBySizeKey = new Map(destObjects.map((o) => [o.Key, o.Size]))
    const missing: string[] = []
    const sizeMismatches: Array<{ key: string; expected: number; actual: number }> = []
    let matched = 0
    for (const { source, destKey } of toCopy) {
      if (!destBySizeKey.has(destKey)) {
        missing.push(destKey)
        continue
      }
      const actual = destBySizeKey.get(destKey)!
      if (actual !== source.Size) {
        sizeMismatches.push({ key: destKey, expected: source.Size, actual })
        continue
      }
      matched++
    }
    result.verification = {
      ok: missing.length === 0 && sizeMismatches.length === 0,
      matched,
      missing,
      sizeMismatches,
    }
  }

  return result
}
