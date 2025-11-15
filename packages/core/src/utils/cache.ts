/**
 * Caching utilities for performance optimization
 * Caches CloudFormation templates, credentials, and other data
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface CacheOptions {
  ttl?: number // Time to live in milliseconds
  maxSize?: number // Maximum cache size
}

export interface CacheEntry<T> {
  value: T
  timestamp: number
  hash?: string
}

/**
 * Simple in-memory cache with TTL support
 */
export class Cache<T = any> {
  private cache: Map<string, CacheEntry<T>>
  private ttl: number
  private maxSize: number

  constructor(options: CacheOptions = {}) {
    this.cache = new Map()
    this.ttl = options.ttl || 5 * 60 * 1000 // Default: 5 minutes
    this.maxSize = options.maxSize || 100 // Default: 100 entries
  }

  /**
   * Get value from cache
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key)

    if (!entry) {
      return undefined
    }

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key)
      return undefined
    }

    return entry.value
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, hash?: string): void {
    // If cache is full, remove oldest entry
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      hash,
    })
  }

  /**
   * Check if cache has key and it's not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Remove expired entries
   */
  prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Get cache stats
   */
  stats(): { size: number, ttl: number, maxSize: number } {
    return {
      size: this.cache.size,
      ttl: this.ttl,
      maxSize: this.maxSize,
    }
  }
}

/**
 * File-based cache for persistent caching
 */
export class FileCache<T = any> {
  private cacheDir: string
  private ttl: number

  constructor(cacheDir: string, options: CacheOptions = {}) {
    this.cacheDir = cacheDir
    this.ttl = options.ttl || 24 * 60 * 60 * 1000 // Default: 24 hours

    // Create cache directory if it doesn't exist
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }
  }

  /**
   * Get cache file path for key
   */
  private getCachePath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex')
    return path.join(this.cacheDir, `${hash}.json`)
  }

  /**
   * Get value from cache
   */
  get(key: string): T | undefined {
    const cachePath = this.getCachePath(key)

    if (!fs.existsSync(cachePath)) {
      return undefined
    }

    try {
      const data = fs.readFileSync(cachePath, 'utf-8')
      const entry: CacheEntry<T> = JSON.parse(data)

      // Check if entry has expired
      if (Date.now() - entry.timestamp > this.ttl) {
        fs.unlinkSync(cachePath)
        return undefined
      }

      return entry.value
    }
    catch {
      // If cache file is corrupted, delete it
      fs.unlinkSync(cachePath)
      return undefined
    }
  }

  /**
   * Set value in cache
   */
  set(key: string, value: T, hash?: string): void {
    const cachePath = this.getCachePath(key)

    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      hash,
    }

    fs.writeFileSync(cachePath, JSON.stringify(entry), 'utf-8')
  }

  /**
   * Check if cache has key and it's not expired
   */
  has(key: string): boolean {
    return this.get(key) !== undefined
  }

  /**
   * Clear all cache files
   */
  clear(): void {
    const files = fs.readdirSync(this.cacheDir)
    for (const file of files) {
      fs.unlinkSync(path.join(this.cacheDir, file))
    }
  }

  /**
   * Remove expired entries
   */
  prune(): void {
    const files = fs.readdirSync(this.cacheDir)
    const now = Date.now()

    for (const file of files) {
      const filePath = path.join(this.cacheDir, file)

      try {
        const data = fs.readFileSync(filePath, 'utf-8')
        const entry: CacheEntry<any> = JSON.parse(data)

        if (now - entry.timestamp > this.ttl) {
          fs.unlinkSync(filePath)
        }
      }
      catch {
        // If file is corrupted, delete it
        fs.unlinkSync(filePath)
      }
    }
  }
}

/**
 * Template cache for CloudFormation templates
 */
export class TemplateCache {
  private cache: FileCache<string>

  constructor(cacheDir: string = '.ts-cloud/cache/templates') {
    this.cache = new FileCache<string>(cacheDir, {
      ttl: 24 * 60 * 60 * 1000, // 24 hours
    })
  }

  /**
   * Get template from cache
   */
  getTemplate(stackName: string): string | undefined {
    return this.cache.get(`template:${stackName}`)
  }

  /**
   * Save template to cache
   */
  setTemplate(stackName: string, template: string): void {
    const hash = this.hashTemplate(template)
    this.cache.set(`template:${stackName}`, template, hash)
  }

  /**
   * Check if template has changed
   */
  hasChanged(stackName: string, newTemplate: string): boolean {
    const cached = this.cache.get(`template:${stackName}`)

    if (!cached) {
      return true
    }

    const cachedHash = this.hashTemplate(cached)
    const newHash = this.hashTemplate(newTemplate)

    return cachedHash !== newHash
  }

  /**
   * Hash template for comparison
   */
  private hashTemplate(template: string): string {
    return createHash('sha256').update(template).digest('hex')
  }

  /**
   * Clear all templates
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Prune expired templates
   */
  prune(): void {
    this.cache.prune()
  }
}

/**
 * Global template cache instance
 */
export const templateCache = new TemplateCache()
