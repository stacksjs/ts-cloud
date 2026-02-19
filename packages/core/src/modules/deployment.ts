import type {
  CodeDeployApplication,
  CodeDeployDeploymentGroup,
  CodeDeployDeploymentConfig,
} from 'ts-cloud-aws-types'
import type { EnvironmentType } from 'ts-cloud-types'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { join, basename, dirname, extname } from 'node:path'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

/**
 * Asset file with hash information
 */
export interface HashedAsset {
  originalPath: string
  hashedPath: string
  hash: string
  size: number
  contentType: string
}

/**
 * Asset manifest for deployment
 */
export interface AssetManifest {
  version: string
  timestamp: string
  assets: HashedAsset[]
  hashMap: Record<string, string> // original -> hashed path mapping
}

export interface CodeDeployApplicationOptions {
  slug: string
  environment: EnvironmentType
  applicationName?: string
  computePlatform: 'Server' | 'Lambda' | 'ECS'
}

export interface CodeDeployDeploymentGroupOptions {
  slug: string
  environment: EnvironmentType
  deploymentGroupName?: string
  serviceRoleArn: string
  autoScalingGroups?: string[]
  ec2TagFilters?: Array<{
    key?: string
    value?: string
    type?: 'KEY_ONLY' | 'VALUE_ONLY' | 'KEY_AND_VALUE'
  }>
  deploymentConfigName?: string
  autoRollbackConfiguration?: {
    enabled: boolean
    events?: ('DEPLOYMENT_FAILURE' | 'DEPLOYMENT_STOP_ON_ALARM' | 'DEPLOYMENT_STOP_ON_REQUEST')[]
  }
  alarmConfiguration?: {
    enabled: boolean
    alarms?: Array<{
      name: string
    }>
    ignorePollAlarmFailure?: boolean
  }
  loadBalancerInfo?: {
    targetGroupInfoList?: Array<{
      name: string
    }>
    elbInfoList?: Array<{
      name: string
    }>
  }
  blueGreenDeploymentConfiguration?: {
    terminateBlueInstancesOnDeploymentSuccess?: {
      action?: 'TERMINATE' | 'KEEP_ALIVE'
      terminationWaitTimeInMinutes?: number
    }
    deploymentReadyOption?: {
      actionOnTimeout?: 'CONTINUE_DEPLOYMENT' | 'STOP_DEPLOYMENT'
      waitTimeInMinutes?: number
    }
    greenFleetProvisioningOption?: {
      action?: 'DISCOVER_EXISTING' | 'COPY_AUTO_SCALING_GROUP'
    }
  }
}

export interface CodeDeployDeploymentConfigOptions {
  slug: string
  environment: EnvironmentType
  deploymentConfigName?: string
  minimumHealthyHosts?: {
    type: 'HOST_COUNT' | 'FLEET_PERCENT'
    value: number
  }
  trafficRoutingConfig?: {
    type: 'TimeBasedCanary' | 'TimeBasedLinear' | 'AllAtOnce'
    timeBasedCanary?: {
      canaryPercentage: number
      canaryInterval: number
    }
    timeBasedLinear?: {
      linearPercentage: number
      linearInterval: number
    }
  }
}

export interface DeploymentStrategyOptions {
  type: 'rolling' | 'blue-green' | 'canary' | 'all-at-once'
  batchSize?: number
  batchPercentage?: number
  canaryPercentage?: number
  canaryInterval?: number
}

/**
 * Deployment Module - CodeDeploy and Deployment Utilities
 * Provides clean API for deployment infrastructure and strategies
 */
export class Deployment {
  /**
   * Create a CodeDeploy Application
   */
  static createApplication(options: CodeDeployApplicationOptions): {
    application: CodeDeployApplication
    logicalId: string
  } {
    const {
      slug,
      environment,
      applicationName,
      computePlatform,
    } = options

    const resourceName = applicationName || generateResourceName({
      slug,
      environment,
      resourceType: 'deploy-app',
    })

    const logicalId = generateLogicalId(resourceName)

    const application: CodeDeployApplication = {
      Type: 'AWS::CodeDeploy::Application',
      Properties: {
        ApplicationName: resourceName,
        ComputePlatform: computePlatform,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { application, logicalId }
  }

  /**
   * Create a CodeDeploy Deployment Group
   */
  static createDeploymentGroup(
    applicationLogicalId: string,
    options: CodeDeployDeploymentGroupOptions,
  ): {
      deploymentGroup: CodeDeployDeploymentGroup
      logicalId: string
    } {
    const {
      slug,
      environment,
      deploymentGroupName,
      serviceRoleArn,
      autoScalingGroups,
      ec2TagFilters,
      deploymentConfigName,
      autoRollbackConfiguration,
      alarmConfiguration,
      loadBalancerInfo,
      blueGreenDeploymentConfiguration,
    } = options

    const resourceName = deploymentGroupName || generateResourceName({
      slug,
      environment,
      resourceType: 'deploy-group',
    })

    const logicalId = generateLogicalId(resourceName)

    const deploymentGroup: CodeDeployDeploymentGroup = {
      Type: 'AWS::CodeDeploy::DeploymentGroup',
      Properties: {
        ApplicationName: Fn.Ref(applicationLogicalId) as unknown as string,
        DeploymentGroupName: resourceName,
        ServiceRoleArn: serviceRoleArn,
        AutoScalingGroups: autoScalingGroups,
        Ec2TagFilters: ec2TagFilters?.map(f => ({
          Key: f.key,
          Value: f.value,
          Type: f.type,
        })),
        DeploymentConfigName: deploymentConfigName,
        AutoRollbackConfiguration: autoRollbackConfiguration ? {
          Enabled: autoRollbackConfiguration.enabled,
          Events: autoRollbackConfiguration.events,
        } : undefined,
        AlarmConfiguration: alarmConfiguration ? {
          Enabled: alarmConfiguration.enabled,
          Alarms: alarmConfiguration.alarms?.map(a => ({ Name: a.name })),
          IgnorePollAlarmFailure: alarmConfiguration.ignorePollAlarmFailure,
        } : undefined,
        LoadBalancerInfo: loadBalancerInfo ? {
          TargetGroupInfoList: loadBalancerInfo.targetGroupInfoList?.map(t => ({ Name: t.name })),
          ElbInfoList: loadBalancerInfo.elbInfoList?.map(e => ({ Name: e.name })),
        } : undefined,
        BlueGreenDeploymentConfiguration: blueGreenDeploymentConfiguration ? {
          TerminateBlueInstancesOnDeploymentSuccess: blueGreenDeploymentConfiguration.terminateBlueInstancesOnDeploymentSuccess ? {
            Action: blueGreenDeploymentConfiguration.terminateBlueInstancesOnDeploymentSuccess.action,
            TerminationWaitTimeInMinutes: blueGreenDeploymentConfiguration.terminateBlueInstancesOnDeploymentSuccess.terminationWaitTimeInMinutes,
          } : undefined,
          DeploymentReadyOption: blueGreenDeploymentConfiguration.deploymentReadyOption ? {
            ActionOnTimeout: blueGreenDeploymentConfiguration.deploymentReadyOption.actionOnTimeout,
            WaitTimeInMinutes: blueGreenDeploymentConfiguration.deploymentReadyOption.waitTimeInMinutes,
          } : undefined,
          GreenFleetProvisioningOption: blueGreenDeploymentConfiguration.greenFleetProvisioningOption ? {
            Action: blueGreenDeploymentConfiguration.greenFleetProvisioningOption.action,
          } : undefined,
        } : undefined,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { deploymentGroup, logicalId }
  }

  /**
   * Create a CodeDeploy Deployment Configuration
   */
  static createDeploymentConfig(options: CodeDeployDeploymentConfigOptions): {
    deploymentConfig: CodeDeployDeploymentConfig
    logicalId: string
  } {
    const {
      slug,
      environment,
      deploymentConfigName,
      minimumHealthyHosts,
      trafficRoutingConfig,
    } = options

    const resourceName = deploymentConfigName || generateResourceName({
      slug,
      environment,
      resourceType: 'deploy-config',
    })

    const logicalId = generateLogicalId(resourceName)

    const deploymentConfig: CodeDeployDeploymentConfig = {
      Type: 'AWS::CodeDeploy::DeploymentConfig',
      Properties: {
        DeploymentConfigName: resourceName,
        MinimumHealthyHosts: minimumHealthyHosts ? {
          Type: minimumHealthyHosts.type,
          Value: minimumHealthyHosts.value,
        } : undefined,
        TrafficRoutingConfig: trafficRoutingConfig ? {
          Type: trafficRoutingConfig.type,
          TimeBasedCanary: trafficRoutingConfig.timeBasedCanary ? {
            CanaryPercentage: trafficRoutingConfig.timeBasedCanary.canaryPercentage,
            CanaryInterval: trafficRoutingConfig.timeBasedCanary.canaryInterval,
          } : undefined,
          TimeBasedLinear: trafficRoutingConfig.timeBasedLinear ? {
            LinearPercentage: trafficRoutingConfig.timeBasedLinear.linearPercentage,
            LinearInterval: trafficRoutingConfig.timeBasedLinear.linearInterval,
          } : undefined,
        } : undefined,
      },
    }

    return { deploymentConfig, logicalId }
  }

  /**
   * Common deployment configurations
   */
  static readonly DeploymentConfigs = {
    /**
     * All at once deployment (fastest, but downtime)
     */
    allAtOnce: (): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type: 'FLEET_PERCENT',
      value: 0,
    }),

    /**
     * Half at a time deployment
     */
    halfAtATime: (): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type: 'FLEET_PERCENT',
      value: 50,
    }),

    /**
     * One at a time deployment (slowest, but safest)
     */
    oneAtATime: (): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type: 'HOST_COUNT',
      value: 1,
    }),

    /**
     * Custom deployment configuration
     */
    custom: (
      type: 'HOST_COUNT' | 'FLEET_PERCENT',
      value: number,
    ): CodeDeployDeploymentConfigOptions['minimumHealthyHosts'] => ({
      type,
      value,
    }),
  } as const

  /**
   * Traffic routing configurations
   */
  static readonly TrafficRouting = {
    /**
     * All traffic at once
     */
    allAtOnce: (): CodeDeployDeploymentConfigOptions['trafficRoutingConfig'] => ({
      type: 'AllAtOnce',
    }),

    /**
     * Canary deployment (shift traffic in two steps)
     */
    canary: (
      canaryPercentage: number,
      canaryInterval: number,
    ): CodeDeployDeploymentConfigOptions['trafficRoutingConfig'] => ({
      type: 'TimeBasedCanary',
      timeBasedCanary: {
        canaryPercentage,
        canaryInterval,
      },
    }),

    /**
     * Linear deployment (shift traffic gradually)
     */
    linear: (
      linearPercentage: number,
      linearInterval: number,
    ): CodeDeployDeploymentConfigOptions['trafficRoutingConfig'] => ({
      type: 'TimeBasedLinear',
      timeBasedLinear: {
        linearPercentage,
        linearInterval,
      },
    }),
  } as const

  /**
   * Rollback configurations
   */
  static readonly RollbackConfigs = {
    /**
     * Auto rollback on deployment failure
     */
    onFailure: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: true,
      events: ['DEPLOYMENT_FAILURE'],
    }),

    /**
     * Auto rollback on alarm or failure
     */
    onAlarmOrFailure: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: true,
      events: ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM'],
    }),

    /**
     * Auto rollback on all events
     */
    onAllEvents: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: true,
      events: ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM', 'DEPLOYMENT_STOP_ON_REQUEST'],
    }),

    /**
     * No auto rollback
     */
    disabled: (): CodeDeployDeploymentGroupOptions['autoRollbackConfiguration'] => ({
      enabled: false,
    }),
  } as const

  /**
   * Blue/Green deployment configurations
   */
  static readonly BlueGreenConfigs = {
    /**
     * Standard blue/green with immediate termination
     */
    standard: (): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
        terminationWaitTimeInMinutes: 5,
      },
      deploymentReadyOption: {
        actionOnTimeout: 'CONTINUE_DEPLOYMENT',
        waitTimeInMinutes: 0,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),

    /**
     * Blue/green with delayed termination
     */
    withDelay: (
      terminationWaitTimeInMinutes: number,
    ): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
        terminationWaitTimeInMinutes,
      },
      deploymentReadyOption: {
        actionOnTimeout: 'CONTINUE_DEPLOYMENT',
        waitTimeInMinutes: 0,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),

    /**
     * Blue/green with manual approval
     */
    withManualApproval: (
      waitTimeInMinutes: number,
    ): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'TERMINATE',
        terminationWaitTimeInMinutes: 5,
      },
      deploymentReadyOption: {
        actionOnTimeout: 'STOP_DEPLOYMENT',
        waitTimeInMinutes,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),

    /**
     * Blue/green keeping old instances
     */
    keepBlue: (): CodeDeployDeploymentGroupOptions['blueGreenDeploymentConfiguration'] => ({
      terminateBlueInstancesOnDeploymentSuccess: {
        action: 'KEEP_ALIVE',
      },
      deploymentReadyOption: {
        actionOnTimeout: 'CONTINUE_DEPLOYMENT',
        waitTimeInMinutes: 0,
      },
      greenFleetProvisioningOption: {
        action: 'COPY_AUTO_SCALING_GROUP',
      },
    }),
  } as const

  /**
   * Common use cases
   */
  static readonly UseCases = {
    /**
     * Create basic EC2 deployment
     */
    ec2Deployment: (
      slug: string,
      environment: EnvironmentType,
      serviceRoleArn: string,
      autoScalingGroups: string[],
    ): {
      application: CodeDeployApplication
      appId: string
      deploymentGroup: CodeDeployDeploymentGroup
      groupId: string
    } => {
      const { application, logicalId: appId } = Deployment.createApplication({
        slug,
        environment,
        computePlatform: 'Server',
      })

      const { deploymentGroup, logicalId: groupId } = Deployment.createDeploymentGroup(appId, {
        slug,
        environment,
        serviceRoleArn,
        autoScalingGroups,
        deploymentConfigName: 'CodeDeployDefault.OneAtATime',
        autoRollbackConfiguration: Deployment.RollbackConfigs.onFailure(),
      })

      return { application, appId, deploymentGroup, groupId }
    },

    /**
     * Create Lambda deployment with canary
     */
    lambdaCanaryDeployment: (
      slug: string,
      environment: EnvironmentType,
      serviceRoleArn: string,
      canaryPercentage: number = 10,
      canaryInterval: number = 5,
    ): {
      application: CodeDeployApplication
      appId: string
      deploymentConfig: CodeDeployDeploymentConfig
      configId: string
      deploymentGroup: CodeDeployDeploymentGroup
      groupId: string
    } => {
      const { application, logicalId: appId } = Deployment.createApplication({
        slug,
        environment,
        computePlatform: 'Lambda',
      })

      const { deploymentConfig, logicalId: configId } = Deployment.createDeploymentConfig({
        slug,
        environment,
        trafficRoutingConfig: Deployment.TrafficRouting.canary(canaryPercentage, canaryInterval),
      })

      const { deploymentGroup, logicalId: groupId } = Deployment.createDeploymentGroup(appId, {
        slug,
        environment,
        serviceRoleArn,
        deploymentConfigName: Fn.Ref(configId) as unknown as string,
        autoRollbackConfiguration: Deployment.RollbackConfigs.onAlarmOrFailure(),
      })

      return { application, appId, deploymentConfig, configId, deploymentGroup, groupId }
    },

    /**
     * Create ECS blue/green deployment
     */
    ecsBlueGreenDeployment: (
      slug: string,
      environment: EnvironmentType,
      serviceRoleArn: string,
      targetGroupName: string,
    ): {
      application: CodeDeployApplication
      appId: string
      deploymentGroup: CodeDeployDeploymentGroup
      groupId: string
    } => {
      const { application, logicalId: appId } = Deployment.createApplication({
        slug,
        environment,
        computePlatform: 'ECS',
      })

      const { deploymentGroup, logicalId: groupId } = Deployment.createDeploymentGroup(appId, {
        slug,
        environment,
        serviceRoleArn,
        loadBalancerInfo: {
          targetGroupInfoList: [{ name: targetGroupName }],
        },
        blueGreenDeploymentConfiguration: Deployment.BlueGreenConfigs.standard(),
        autoRollbackConfiguration: Deployment.RollbackConfigs.onFailure(),
      })

      return { application, appId, deploymentGroup, groupId }
    },
  } as const

  /**
   * Deployment strategy helpers
   */
  static readonly Strategies = {
    /**
     * Rolling deployment strategy
     */
    rolling: (batchPercentage: number = 25): DeploymentStrategyOptions => ({
      type: 'rolling',
      batchPercentage,
    }),

    /**
     * Blue-green deployment strategy
     */
    blueGreen: (): DeploymentStrategyOptions => ({
      type: 'blue-green',
    }),

    /**
     * Canary deployment strategy
     */
    canary: (canaryPercentage: number = 10, canaryInterval: number = 5): DeploymentStrategyOptions => ({
      type: 'canary',
      canaryPercentage,
      canaryInterval,
    }),

    /**
     * All at once deployment strategy
     */
    allAtOnce: (): DeploymentStrategyOptions => ({
      type: 'all-at-once',
    }),
  } as const
}

/**
 * Asset Hashing Utilities
 * Provides content-based hashing for cache invalidation
 */
export class AssetHasher {
  /**
   * Common content types by file extension
   */
  static readonly ContentTypes: Record<string, string> = {
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.map': 'application/json',
  }

  /**
   * Files that should NOT be hashed (typically entry points)
   */
  static readonly NoHashPatterns: RegExp[] = [
    /^index\.html$/,
    /^favicon\.ico$/,
    /^robots\.txt$/,
    /^sitemap\.xml$/,
    /^manifest\.json$/,
    /^\.well-known\//,
    /^_redirects$/,
    /^_headers$/,
  ]

  /**
   * Compute hash for a file's contents
   */
  static computeFileHash(filePath: string, algorithm: 'md5' | 'sha256' | 'sha1' = 'md5'): string {
    const content = readFileSync(filePath)
    return createHash(algorithm).update(content).digest('hex')
  }

  /**
   * Compute short hash (first 8 characters)
   */
  static computeShortHash(filePath: string): string {
    return AssetHasher.computeFileHash(filePath).slice(0, 8)
  }

  /**
   * Get content type for a file
   */
  static getContentType(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    return AssetHasher.ContentTypes[ext] || 'application/octet-stream'
  }

  /**
   * Check if a file should be hashed
   */
  static shouldHashFile(relativePath: string, customNoHashPatterns?: RegExp[]): boolean {
    const patterns = [...AssetHasher.NoHashPatterns, ...(customNoHashPatterns || [])]
    return !patterns.some(pattern => pattern.test(relativePath))
  }

  /**
   * Generate a hashed filename
   * e.g., "styles.css" -> "styles.a1b2c3d4.css"
   */
  static generateHashedFilename(filePath: string, hash: string): string {
    const ext = extname(filePath)
    const name = basename(filePath, ext)
    const dir = dirname(filePath)

    if (dir === '.') {
      return `${name}.${hash}${ext}`
    }
    return join(dir, `${name}.${hash}${ext}`)
  }

  /**
   * Collect all files in a directory recursively
   */
  static collectFiles(directory: string, relativeTo?: string): string[] {
    const files: string[] = []
    const baseDir = relativeTo || directory

    if (!existsSync(directory)) {
      return files
    }

    const entries = readdirSync(directory, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(directory, entry.name)

      if (entry.isDirectory()) {
        files.push(...AssetHasher.collectFiles(fullPath, baseDir))
      }
      else if (entry.isFile()) {
        files.push(fullPath)
      }
    }

    return files
  }

  /**
   * Hash all assets in a directory
   */
  static hashDirectory(options: {
    sourceDir: string
    outputDir?: string
    excludePatterns?: RegExp[]
    hashAlgorithm?: 'md5' | 'sha256' | 'sha1'
    copyUnhashed?: boolean
  }): AssetManifest {
    const {
      sourceDir,
      outputDir,
      excludePatterns = [],
      hashAlgorithm = 'md5',
      copyUnhashed = true,
    } = options

    const files = AssetHasher.collectFiles(sourceDir)
    const assets: HashedAsset[] = []
    const hashMap: Record<string, string> = {}

    for (const filePath of files) {
      const relativePath = filePath.replace(sourceDir, '').replace(/^[/\\]/, '')
      const shouldHash = AssetHasher.shouldHashFile(relativePath, excludePatterns)
      const stats = statSync(filePath)
      const hash = shouldHash ? AssetHasher.computeFileHash(filePath, hashAlgorithm).slice(0, 8) : ''
      const hashedRelativePath = shouldHash
        ? AssetHasher.generateHashedFilename(relativePath, hash)
        : relativePath

      const asset: HashedAsset = {
        originalPath: relativePath,
        hashedPath: hashedRelativePath,
        hash,
        size: stats.size,
        contentType: AssetHasher.getContentType(filePath),
      }

      assets.push(asset)
      hashMap[relativePath] = hashedRelativePath

      // Copy to output directory if specified
      if (outputDir) {
        const destPath = join(outputDir, hashedRelativePath)
        const destDir = dirname(destPath)

        // Ensure destination directory exists
        if (!existsSync(destDir)) {
          const { mkdirSync } = require('node:fs')
          mkdirSync(destDir, { recursive: true })
        }

        if (shouldHash || copyUnhashed) {
          copyFileSync(filePath, destPath)
        }
      }
    }

    const manifest: AssetManifest = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      assets,
      hashMap,
    }

    // Write manifest to output directory
    if (outputDir) {
      const manifestPath = join(outputDir, 'asset-manifest.json')
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    }

    return manifest
  }

  /**
   * Get paths that need CloudFront invalidation
   * Compares old and new manifests to find changed files
   */
  static getInvalidationPaths(
    oldManifest: AssetManifest | null,
    newManifest: AssetManifest,
  ): string[] {
    const invalidationPaths: string[] = []

    if (!oldManifest) {
      // If no old manifest, invalidate everything
      return ['/*']
    }

    const oldHashMap = oldManifest.hashMap
    const newHashMap = newManifest.hashMap

    // Find changed and new files
    for (const [originalPath, newHashedPath] of Object.entries(newHashMap)) {
      const oldHashedPath = oldHashMap[originalPath]

      if (!oldHashedPath || oldHashedPath !== newHashedPath) {
        // File is new or changed
        invalidationPaths.push(`/${originalPath}`)
        if (oldHashedPath && oldHashedPath !== newHashedPath) {
          // Also invalidate old hashed path
          invalidationPaths.push(`/${oldHashedPath}`)
        }
      }
    }

    // Find deleted files
    for (const [originalPath, oldHashedPath] of Object.entries(oldHashMap)) {
      if (!newHashMap[originalPath]) {
        invalidationPaths.push(`/${originalPath}`)
        invalidationPaths.push(`/${oldHashedPath}`)
      }
    }

    // If too many paths, just invalidate everything
    if (invalidationPaths.length > 100) {
      return ['/*']
    }

    return [...new Set(invalidationPaths)] // Remove duplicates
  }

  /**
   * Update HTML files to reference hashed assets
   */
  static updateHtmlReferences(options: {
    htmlDir: string
    manifest: AssetManifest
    basePath?: string
  }): void {
    const { htmlDir, manifest, basePath = '' } = options

    const htmlFiles = AssetHasher.collectFiles(htmlDir)
      .filter(f => f.endsWith('.html') || f.endsWith('.htm'))

    for (const htmlFile of htmlFiles) {
      let content = readFileSync(htmlFile, 'utf-8')

      // Replace references to original paths with hashed paths
      for (const [originalPath, hashedPath] of Object.entries(manifest.hashMap)) {
        if (originalPath === hashedPath) continue // Skip unhashed files

        // Handle various reference formats
        const patterns = [
          // src="path" or href="path"
          new RegExp(`(src|href)=["']${basePath}/?${AssetHasher.escapeRegExp(originalPath)}["']`, 'g'),
          // url(path)
          new RegExp(`url\\(["']?${basePath}/?${AssetHasher.escapeRegExp(originalPath)}["']?\\)`, 'g'),
        ]

        for (const pattern of patterns) {
          content = content.replace(pattern, (match) => {
            return match.replace(originalPath, hashedPath)
          })
        }
      }

      writeFileSync(htmlFile, content)
    }
  }

  /**
   * Update CSS files to reference hashed assets
   */
  static updateCssReferences(options: {
    cssDir: string
    manifest: AssetManifest
    basePath?: string
  }): void {
    const { cssDir, manifest, basePath = '' } = options

    const cssFiles = AssetHasher.collectFiles(cssDir)
      .filter(f => f.endsWith('.css'))

    for (const cssFile of cssFiles) {
      let content = readFileSync(cssFile, 'utf-8')

      // Replace url() references
      for (const [originalPath, hashedPath] of Object.entries(manifest.hashMap)) {
        if (originalPath === hashedPath) continue

        const pattern = new RegExp(
          `url\\(["']?${basePath}/?${AssetHasher.escapeRegExp(originalPath)}["']?\\)`,
          'g',
        )

        content = content.replace(pattern, `url(${basePath}/${hashedPath})`)
      }

      writeFileSync(cssFile, content)
    }
  }

  /**
   * Escape special regex characters
   */
  private static escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Generate a deployment manifest for S3
   */
  static generateS3DeploymentManifest(options: {
    sourceDir: string
    bucketName: string
    keyPrefix?: string
    excludePatterns?: RegExp[]
    cacheControl?: {
      hashed?: string
      unhashed?: string
      html?: string
    }
  }): Array<{
    localPath: string
    s3Key: string
    contentType: string
    cacheControl: string
    hash: string
  }> {
    const {
      sourceDir,
      keyPrefix = '',
      excludePatterns = [],
      cacheControl = {
        hashed: 'public, max-age=31536000, immutable', // 1 year for hashed files
        unhashed: 'public, max-age=3600', // 1 hour for unhashed
        html: 'public, max-age=0, must-revalidate', // Always revalidate HTML
      },
    } = options

    const manifest = AssetHasher.hashDirectory({
      sourceDir,
      excludePatterns,
    })

    return manifest.assets.map((asset) => {
      const isHashed = asset.hash !== ''
      const isHtml = asset.contentType === 'text/html'

      let cc = cacheControl.unhashed || 'public, max-age=3600'
      if (isHtml) {
        cc = cacheControl.html || 'public, max-age=0, must-revalidate'
      }
      else if (isHashed) {
        cc = cacheControl.hashed || 'public, max-age=31536000, immutable'
      }

      return {
        localPath: join(sourceDir, asset.originalPath),
        s3Key: keyPrefix ? `${keyPrefix}/${asset.hashedPath}` : asset.hashedPath,
        contentType: asset.contentType,
        cacheControl: cc,
        hash: asset.hash,
      }
    })
  }

  /**
   * Compare two asset manifests to detect changes
   */
  static compareManifests(oldManifest: AssetManifest, newManifest: AssetManifest): {
    added: string[]
    removed: string[]
    changed: string[]
    unchanged: string[]
  } {
    const result = {
      added: [] as string[],
      removed: [] as string[],
      changed: [] as string[],
      unchanged: [] as string[],
    }

    const oldPaths = new Set(Object.keys(oldManifest.hashMap))
    const newPaths = new Set(Object.keys(newManifest.hashMap))

    // Find added files
    for (const path of newPaths) {
      if (!oldPaths.has(path)) {
        result.added.push(path)
      }
    }

    // Find removed files
    for (const path of oldPaths) {
      if (!newPaths.has(path)) {
        result.removed.push(path)
      }
    }

    // Find changed and unchanged files
    for (const path of newPaths) {
      if (oldPaths.has(path)) {
        if (oldManifest.hashMap[path] !== newManifest.hashMap[path]) {
          result.changed.push(path)
        }
        else {
          result.unchanged.push(path)
        }
      }
    }

    return result
  }

  /**
   * Load an existing asset manifest from a file
   */
  static loadManifest(manifestPath: string): AssetManifest | null {
    if (!existsSync(manifestPath)) {
      return null
    }

    try {
      const content = readFileSync(manifestPath, 'utf-8')
      return JSON.parse(content) as AssetManifest
    }
    catch {
      return null
    }
  }

  /**
   * Save an asset manifest to a file
   */
  static saveManifest(manifest: AssetManifest, manifestPath: string): void {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  }
}
