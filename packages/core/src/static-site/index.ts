/**
 * Static Site Advanced Features
 * Asset optimization, image optimization, SSG support, and prerendering
 */

export interface AssetOptimization {
  id: string
  name: string
  minify: boolean
  compress: boolean
  compressionType: 'gzip' | 'brotli' | 'both'
  sourceMaps: boolean
  cacheControl: string
}

export interface ImageOptimization {
  id: string
  formats: Array<'webp' | 'avif' | 'jpeg' | 'png'>
  quality: number
  responsive: boolean
  lazy: boolean
  sizes: number[]
}

export interface SSGConfig {
  id: string
  framework: 'next' | 'gatsby' | 'astro' | 'hugo' | 'eleventy'
  outputDir: string
  buildCommand: string
  routes: string[]
}

export interface PrerenderConfig {
  id: string
  routes: string[]
  fallback: 'blocking' | 'static' | false
  revalidate?: number
}

export class StaticSiteManager {
  private optimizations: Map<string, AssetOptimization> = new Map()
  private imageConfigs: Map<string, ImageOptimization> = new Map()
  private ssgConfigs: Map<string, SSGConfig> = new Map()
  private prerenderConfigs: Map<string, PrerenderConfig> = new Map()
  private counter = 0

  createAssetOptimization(config: Omit<AssetOptimization, 'id'>): AssetOptimization {
    const id = `asset-opt-${Date.now()}-${this.counter++}`
    const optimization = { id, ...config }
    this.optimizations.set(id, optimization)
    return optimization
  }

  createImageOptimization(config: Omit<ImageOptimization, 'id'>): ImageOptimization {
    const id = `image-opt-${Date.now()}-${this.counter++}`
    const optimization = { id, ...config }
    this.imageConfigs.set(id, optimization)
    return optimization
  }

  createSSGConfig(config: Omit<SSGConfig, 'id'>): SSGConfig {
    const id = `ssg-${Date.now()}-${this.counter++}`
    const ssgConfig = { id, ...config }
    this.ssgConfigs.set(id, ssgConfig)
    return ssgConfig
  }

  createPrerenderConfig(config: Omit<PrerenderConfig, 'id'>): PrerenderConfig {
    const id = `prerender-${Date.now()}-${this.counter++}`
    const prerenderConfig = { id, ...config }
    this.prerenderConfigs.set(id, prerenderConfig)
    return prerenderConfig
  }

  listOptimizations(): AssetOptimization[] { return Array.from(this.optimizations.values()) }
  listImageConfigs(): ImageOptimization[] { return Array.from(this.imageConfigs.values()) }
  clear(): void {
    this.optimizations.clear()
    this.imageConfigs.clear()
    this.ssgConfigs.clear()
    this.prerenderConfigs.clear()
  }
}

export const staticSiteManager: StaticSiteManager = new StaticSiteManager()
