/**
 * File hashing utilities for deployment optimization
 * Fast hashing for detecting changed files
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface FileHash {
  path: string
  hash: string
  size: number
  mtime: number
}

export interface HashOptions {
  algorithm?: 'md5' | 'sha1' | 'sha256'
  chunkSize?: number
  ignorePatterns?: string[]
}

/**
 * Hash a file using streaming for large files
 */
export async function hashFile(
  filePath: string,
  options: HashOptions = {},
): Promise<string> {
  const algorithm = options.algorithm || 'sha256'
  const chunkSize = options.chunkSize || 64 * 1024 // 64KB chunks

  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm)
    const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize })

    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Hash a string
 */
export function hashString(content: string, algorithm: 'md5' | 'sha1' | 'sha256' = 'sha256'): string {
  return createHash(algorithm).update(content).digest('hex')
}

/**
 * Hash a buffer
 */
export function hashBuffer(buffer: Buffer, algorithm: 'md5' | 'sha1' | 'sha256' = 'sha256'): string {
  return createHash(algorithm).update(buffer).digest('hex')
}

/**
 * Hash all files in a directory
 */
export async function hashDirectory(
  dirPath: string,
  options: HashOptions = {},
): Promise<FileHash[]> {
  const ignorePatterns = options.ignorePatterns || [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.ts-cloud',
  ]

  const files: FileHash[] = []

  async function walk(dir: string): Promise<void> {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(dirPath, fullPath)

      // Skip ignored patterns
      if (ignorePatterns.some(pattern => relativePath.includes(pattern))) {
        continue
      }

      if (entry.isDirectory()) {
        await walk(fullPath)
      }
      else if (entry.isFile()) {
        const stats = fs.statSync(fullPath)
        const hash = await hashFile(fullPath, options)

        files.push({
          path: relativePath,
          hash,
          size: stats.size,
          mtime: stats.mtimeMs,
        })
      }
    }
  }

  await walk(dirPath)

  return files
}

/**
 * Create a manifest hash from multiple file hashes
 * Useful for detecting if any file in a directory has changed
 */
export function hashManifest(fileHashes: FileHash[]): string {
  const sorted = [...fileHashes].sort((a, b) => a.path.localeCompare(b.path))
  const content = sorted.map(f => `${f.path}:${f.hash}`).join('\n')
  return hashString(content)
}

/**
 * Fast hash using file metadata (size + mtime)
 * Much faster than content hash, but less reliable
 * Use for quick change detection
 */
export function quickHash(filePath: string): string {
  const stats = fs.statSync(filePath)
  return hashString(`${filePath}:${stats.size}:${stats.mtimeMs}`)
}

/**
 * Compare two sets of file hashes to find changes
 */
export function findChangedFiles(
  oldHashes: FileHash[],
  newHashes: FileHash[],
): {
    added: FileHash[]
    modified: FileHash[]
    deleted: FileHash[]
  } {
  const oldMap = new Map(oldHashes.map(f => [f.path, f]))
  const newMap = new Map(newHashes.map(f => [f.path, f]))

  const added: FileHash[] = []
  const modified: FileHash[] = []
  const deleted: FileHash[] = []

  // Find added and modified
  for (const [path, newFile] of newMap) {
    const oldFile = oldMap.get(path)

    if (!oldFile) {
      added.push(newFile)
    }
    else if (oldFile.hash !== newFile.hash) {
      modified.push(newFile)
    }
  }

  // Find deleted
  for (const [path, oldFile] of oldMap) {
    if (!newMap.has(path)) {
      deleted.push(oldFile)
    }
  }

  return { added, modified, deleted }
}

/**
 * Cache for file hashes
 */
export class HashCache {
  private cache: Map<string, { hash: string, mtime: number, size: number }>

  constructor() {
    this.cache = new Map()
  }

  /**
   * Get cached hash if file hasn't changed
   */
  get(filePath: string): string | undefined {
    const stats = fs.statSync(filePath)
    const cached = this.cache.get(filePath)

    if (cached && cached.mtime === stats.mtimeMs && cached.size === stats.size) {
      return cached.hash
    }

    return undefined
  }

  /**
   * Cache a file hash
   */
  set(filePath: string, hash: string): void {
    const stats = fs.statSync(filePath)

    this.cache.set(filePath, {
      hash,
      mtime: stats.mtimeMs,
      size: stats.size,
    })
  }

  /**
   * Get or compute hash
   */
  async getOrCompute(filePath: string, options: HashOptions = {}): Promise<string> {
    const cached = this.get(filePath)

    if (cached) {
      return cached
    }

    const hash = await hashFile(filePath, options)
    this.set(filePath, hash)

    return hash
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear()
  }
}
