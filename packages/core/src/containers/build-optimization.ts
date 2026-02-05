/**
 * Container Build Optimization
 * Multi-stage builds, layer caching, and build performance
 */

export interface BuildConfig {
  id: string
  name: string
  dockerfile: string
  context: string
  target?: string // Multi-stage build target
  buildArgs?: Record<string, string>
  labels?: Record<string, string>
  cacheStrategy: CacheStrategy
  platform?: string
}

export interface CacheStrategy {
  type: 'inline' | 'registry' | 'local' | 's3'
  cacheFrom?: string[]
  cacheTo?: string
  maxCacheAge?: number // days
}

export interface MultiStageConfig {
  id: string
  name: string
  stages: BuildStage[]
  targetStage?: string
}

export interface BuildStage {
  name: string
  baseImage: string
  commands: string[]
  copyFrom?: string[] // Copy artifacts from other stages
  workdir?: string
  env?: Record<string, string>
}

export interface BuildOptimization {
  id: string
  name: string
  recommendations: OptimizationRecommendation[]
  estimatedSavings: BuildSavings
}

export interface OptimizationRecommendation {
  type: 'layer_reduction' | 'cache_optimization' | 'base_image' | 'dependencies'
  priority: 'high' | 'medium' | 'low'
  title: string
  description: string
  example?: string
  impact: string
}

export interface BuildSavings {
  sizeBefore: number // MB
  sizeAfter: number // MB
  timeBefore: number // seconds
  timeAfter: number // seconds
}

export interface LayerAnalysis {
  id: string
  imageId: string
  layers: ImageLayer[]
  totalSize: number
  unnecessaryLayers: number
}

export interface ImageLayer {
  index: number
  command: string
  size: number // MB
  created: Date
  cacheable: boolean
}

/**
 * Build optimization manager
 */
export class BuildOptimizationManager {
  private configs: Map<string, BuildConfig> = new Map()
  private multiStageConfigs: Map<string, MultiStageConfig> = new Map()
  private optimizations: Map<string, BuildOptimization> = new Map()
  private analyses: Map<string, LayerAnalysis> = new Map()
  private configCounter = 0
  private multiStageCounter = 0
  private optimizationCounter = 0
  private analysisCounter = 0

  /**
   * Create build config
   */
  createBuildConfig(config: Omit<BuildConfig, 'id'>): BuildConfig {
    const id = `build-config-${Date.now()}-${this.configCounter++}`

    const buildConfig: BuildConfig = {
      id,
      ...config,
    }

    this.configs.set(id, buildConfig)

    return buildConfig
  }

  /**
   * Create optimized build config
   */
  createOptimizedBuildConfig(options: {
    name: string
    dockerfile: string
    enableCache?: boolean
    registry?: string
  }): BuildConfig {
    const cacheStrategy: CacheStrategy = {
      type: options.enableCache ? 'registry' : 'inline',
      cacheFrom: options.registry ? [`${options.registry}/cache`] : undefined,
      cacheTo: options.registry ? `${options.registry}/cache` : undefined,
      maxCacheAge: 7,
    }

    return this.createBuildConfig({
      name: options.name,
      dockerfile: options.dockerfile,
      context: '.',
      cacheStrategy,
      buildArgs: {
        BUILDKIT_INLINE_CACHE: '1',
      },
    })
  }

  /**
   * Create multi-stage config
   */
  createMultiStageConfig(config: Omit<MultiStageConfig, 'id'>): MultiStageConfig {
    const id = `multi-stage-${Date.now()}-${this.multiStageCounter++}`

    const multiStageConfig: MultiStageConfig = {
      id,
      ...config,
    }

    this.multiStageConfigs.set(id, multiStageConfig)

    return multiStageConfig
  }

  /**
   * Create Node.js multi-stage build
   */
  createNodeMultiStageBuild(options: {
    name: string
    nodeVersion?: string
    targetStage?: 'production' | 'development'
  }): MultiStageConfig {
    const nodeVersion = options.nodeVersion || '18-alpine'

    return this.createMultiStageConfig({
      name: options.name,
      targetStage: options.targetStage || 'production',
      stages: [
        {
          name: 'dependencies',
          baseImage: `node:${nodeVersion}`,
          workdir: '/app',
          commands: [
            'COPY package*.json ./',
            'RUN npm ci --only=production',
          ],
        },
        {
          name: 'build',
          baseImage: `node:${nodeVersion}`,
          workdir: '/app',
          commands: [
            'COPY package*.json ./',
            'RUN npm ci',
            'COPY . .',
            'RUN npm run build',
          ],
        },
        {
          name: 'production',
          baseImage: `node:${nodeVersion}`,
          workdir: '/app',
          copyFrom: ['dependencies:/app/node_modules', 'build:/app/dist'],
          commands: [
            'COPY package*.json ./',
            'ENV NODE_ENV=production',
            'CMD ["node", "dist/index.js"]',
          ],
        },
      ],
    })
  }

  /**
   * Generate Dockerfile from multi-stage config
   */
  generateDockerfile(configId: string): string {
    const config = this.multiStageConfigs.get(configId)

    if (!config) {
      throw new Error(`Multi-stage config not found: ${configId}`)
    }

    const lines: string[] = []

    for (const stage of config.stages) {
      lines.push(`# Stage: ${stage.name}`)
      lines.push(`FROM ${stage.baseImage} AS ${stage.name}`)

      if (stage.workdir) {
        lines.push(`WORKDIR ${stage.workdir}`)
      }

      if (stage.env) {
        for (const [key, value] of Object.entries(stage.env)) {
          lines.push(`ENV ${key}=${value}`)
        }
      }

      for (const command of stage.commands) {
        lines.push(command)
      }

      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * Analyze image layers
   */
  analyzeImage(imageId: string, layers: Omit<ImageLayer, 'cacheable'>[]): LayerAnalysis {
    const id = `analysis-${Date.now()}-${this.analysisCounter++}`

    const analyzedLayers: ImageLayer[] = layers.map(layer => ({
      ...layer,
      cacheable: this.isLayerCacheable(layer.command),
    }))

    const totalSize = analyzedLayers.reduce((sum, layer) => sum + layer.size, 0)
    const unnecessaryLayers = analyzedLayers.filter(
      layer => !layer.cacheable && layer.size > 100
    ).length

    const analysis: LayerAnalysis = {
      id,
      imageId,
      layers: analyzedLayers,
      totalSize,
      unnecessaryLayers,
    }

    this.analyses.set(id, analysis)

    return analysis
  }

  /**
   * Check if layer is cacheable
   */
  private isLayerCacheable(command: string): boolean {
    const cacheableCommands = ['FROM', 'RUN', 'COPY', 'ADD', 'WORKDIR', 'ENV']
    const nonCacheableCommands = ['CMD', 'ENTRYPOINT', 'LABEL']

    for (const cmd of cacheableCommands) {
      if (command.startsWith(cmd)) return true
    }

    for (const cmd of nonCacheableCommands) {
      if (command.startsWith(cmd)) return false
    }

    return false
  }

  /**
   * Generate optimization recommendations
   */
  generateOptimizations(analysisId: string): BuildOptimization {
    const analysis = this.analyses.get(analysisId)

    if (!analysis) {
      throw new Error(`Analysis not found: ${analysisId}`)
    }

    const id = `optimization-${Date.now()}-${this.optimizationCounter++}`

    const recommendations: OptimizationRecommendation[] = []

    // Check for layer reduction opportunities
    const runLayers = analysis.layers.filter(l => l.command.startsWith('RUN'))
    if (runLayers.length > 5) {
      recommendations.push({
        type: 'layer_reduction',
        priority: 'high',
        title: 'Combine RUN commands',
        description: `${runLayers.length} RUN commands found. Combine them to reduce layers.`,
        example: 'RUN apt-get update && apt-get install -y package1 package2',
        impact: 'Reduce image size by 20-30% and improve build time',
      })
    }

    // Check for base image optimization
    const baseLayer = analysis.layers[0]
    if (baseLayer.command.includes('ubuntu') || baseLayer.command.includes('debian')) {
      recommendations.push({
        type: 'base_image',
        priority: 'medium',
        title: 'Use Alpine base image',
        description: 'Switch to Alpine Linux for smaller image size',
        example: 'FROM node:18-alpine',
        impact: 'Reduce image size by 50-70%',
      })
    }

    // Check for cache optimization
    const copyLayers = analysis.layers.filter(l => l.command.startsWith('COPY'))
    if (copyLayers.length > 0 && copyLayers[0].index > 3) {
      recommendations.push({
        type: 'cache_optimization',
        priority: 'high',
        title: 'Copy dependencies first',
        description: 'Copy package files before source code to leverage layer caching',
        example: 'COPY package*.json ./\nRUN npm install\nCOPY . .',
        impact: 'Improve build time by 60-80% on subsequent builds',
      })
    }

    const estimatedSavings: BuildSavings = {
      sizeBefore: analysis.totalSize,
      sizeAfter: analysis.totalSize * 0.6, // Estimated 40% reduction
      timeBefore: 300, // 5 minutes
      timeAfter: 120, // 2 minutes
    }

    const optimization: BuildOptimization = {
      id,
      name: `Optimization for ${analysis.imageId}`,
      recommendations,
      estimatedSavings,
    }

    this.optimizations.set(id, optimization)

    return optimization
  }

  /**
   * Get build config
   */
  getBuildConfig(id: string): BuildConfig | undefined {
    return this.configs.get(id)
  }

  /**
   * List build configs
   */
  listBuildConfigs(): BuildConfig[] {
    return Array.from(this.configs.values())
  }

  /**
   * Get multi-stage config
   */
  getMultiStageConfig(id: string): MultiStageConfig | undefined {
    return this.multiStageConfigs.get(id)
  }

  /**
   * List multi-stage configs
   */
  listMultiStageConfigs(): MultiStageConfig[] {
    return Array.from(this.multiStageConfigs.values())
  }

  /**
   * Get optimization
   */
  getOptimization(id: string): BuildOptimization | undefined {
    return this.optimizations.get(id)
  }

  /**
   * List optimizations
   */
  listOptimizations(): BuildOptimization[] {
    return Array.from(this.optimizations.values())
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.configs.clear()
    this.multiStageConfigs.clear()
    this.optimizations.clear()
    this.analyses.clear()
    this.configCounter = 0
    this.multiStageCounter = 0
    this.optimizationCounter = 0
    this.analysisCounter = 0
  }
}

/**
 * Global build optimization manager instance
 */
export const buildOptimizationManager: BuildOptimizationManager = new BuildOptimizationManager()
