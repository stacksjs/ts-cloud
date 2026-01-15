/**
 * Lambda Versions and Aliases
 * Immutable versions and mutable aliases for Lambda functions
 */

export interface LambdaVersion {
  id: string
  functionName: string
  version: string
  functionArn: string
  codeHash: string
  description?: string
  runtime: string
  memorySize: number
  timeout: number
  publishedAt: Date
}

export interface LambdaAlias {
  id: string
  functionName: string
  aliasName: string
  aliasArn: string
  functionVersion: string
  description?: string
  routingConfig?: RoutingConfig
  revisionId?: string
}

export interface RoutingConfig {
  additionalVersionWeights?: Record<string, number>
}

export interface VersionDeployment {
  id: string
  functionName: string
  fromVersion: string
  toVersion: string
  aliasName: string
  strategy: 'all_at_once' | 'linear' | 'canary'
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  startedAt?: Date
  completedAt?: Date
}

/**
 * Lambda versions manager
 */
export class LambdaVersionsManager {
  private versions: Map<string, LambdaVersion> = new Map()
  private aliases: Map<string, LambdaAlias> = new Map()
  private deployments: Map<string, VersionDeployment> = new Map()
  private versionCounter = 0
  private aliasCounter = 0
  private deploymentCounter = 0

  /**
   * Publish function version
   */
  publishVersion(options: {
    functionName: string
    description?: string
    runtime: string
    memorySize: number
    timeout: number
  }): LambdaVersion {
    const id = `version-${Date.now()}-${this.versionCounter++}`
    const versionNumber = this.getNextVersionNumber(options.functionName)

    const version: LambdaVersion = {
      id,
      functionName: options.functionName,
      version: versionNumber.toString(),
      functionArn: `arn:aws:lambda:us-east-1:123456789012:function:${options.functionName}:${versionNumber}`,
      codeHash: this.generateHash(),
      description: options.description,
      runtime: options.runtime,
      memorySize: options.memorySize,
      timeout: options.timeout,
      publishedAt: new Date(),
    }

    this.versions.set(id, version)

    return version
  }

  /**
   * Get next version number
   */
  private getNextVersionNumber(functionName: string): number {
    const existingVersions = Array.from(this.versions.values())
      .filter(v => v.functionName === functionName)
      .map(v => parseInt(v.version))

    return existingVersions.length > 0 ? Math.max(...existingVersions) + 1 : 1
  }

  /**
   * Create alias
   */
  createAlias(alias: Omit<LambdaAlias, 'id' | 'aliasArn' | 'revisionId'>): LambdaAlias {
    const id = `alias-${Date.now()}-${this.aliasCounter++}`

    const lambdaAlias: LambdaAlias = {
      id,
      aliasArn: `arn:aws:lambda:us-east-1:123456789012:function:${alias.functionName}:${alias.aliasName}`,
      revisionId: this.generateHash(),
      ...alias,
    }

    this.aliases.set(id, lambdaAlias)

    return lambdaAlias
  }

  /**
   * Create production alias
   */
  createProductionAlias(options: {
    functionName: string
    version: string
  }): LambdaAlias {
    return this.createAlias({
      functionName: options.functionName,
      aliasName: 'production',
      functionVersion: options.version,
      description: 'Production alias',
    })
  }

  /**
   * Create staging alias
   */
  createStagingAlias(options: {
    functionName: string
    version: string
  }): LambdaAlias {
    return this.createAlias({
      functionName: options.functionName,
      aliasName: 'staging',
      functionVersion: options.version,
      description: 'Staging alias',
    })
  }

  /**
   * Update alias
   */
  updateAlias(aliasId: string, newVersion: string): LambdaAlias {
    const alias = this.aliases.get(aliasId)

    if (!alias) {
      throw new Error(`Alias not found: ${aliasId}`)
    }

    alias.functionVersion = newVersion
    alias.revisionId = this.generateHash()

    return alias
  }

  /**
   * Configure weighted routing
   */
  configureWeightedRouting(
    aliasId: string,
    weights: Record<string, number>
  ): LambdaAlias {
    const alias = this.aliases.get(aliasId)

    if (!alias) {
      throw new Error(`Alias not found: ${aliasId}`)
    }

    alias.routingConfig = {
      additionalVersionWeights: weights,
    }

    return alias
  }

  /**
   * Create canary deployment
   */
  createCanaryDeployment(options: {
    functionName: string
    fromVersion: string
    toVersion: string
    aliasName: string
    canaryWeight: number
  }): VersionDeployment {
    const id = `deployment-${Date.now()}-${this.deploymentCounter++}`

    // Find or create alias
    let alias = Array.from(this.aliases.values()).find(
      a => a.functionName === options.functionName && a.aliasName === options.aliasName
    )

    if (!alias) {
      alias = this.createAlias({
        functionName: options.functionName,
        aliasName: options.aliasName,
        functionVersion: options.fromVersion,
      })
    }

    // Configure weighted routing
    this.configureWeightedRouting(alias.id, {
      [options.toVersion]: options.canaryWeight,
    })

    const deployment: VersionDeployment = {
      id,
      functionName: options.functionName,
      fromVersion: options.fromVersion,
      toVersion: options.toVersion,
      aliasName: options.aliasName,
      strategy: 'canary',
      status: 'in_progress',
      startedAt: new Date(),
    }

    this.deployments.set(id, deployment)

    return deployment
  }

  /**
   * Complete deployment
   */
  completeDeployment(deploymentId: string): VersionDeployment {
    const deployment = this.deployments.get(deploymentId)

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    // Update alias to point to new version
    const alias = Array.from(this.aliases.values()).find(
      a =>
        a.functionName === deployment.functionName &&
        a.aliasName === deployment.aliasName
    )

    if (alias) {
      alias.functionVersion = deployment.toVersion
      alias.routingConfig = undefined // Remove weighted routing
    }

    deployment.status = 'completed'
    deployment.completedAt = new Date()

    return deployment
  }

  /**
   * Rollback deployment
   */
  rollbackDeployment(deploymentId: string): VersionDeployment {
    const deployment = this.deployments.get(deploymentId)

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`)
    }

    // Revert alias to previous version
    const alias = Array.from(this.aliases.values()).find(
      a =>
        a.functionName === deployment.functionName &&
        a.aliasName === deployment.aliasName
    )

    if (alias) {
      alias.functionVersion = deployment.fromVersion
      alias.routingConfig = undefined
    }

    deployment.status = 'failed'
    deployment.completedAt = new Date()

    return deployment
  }

  /**
   * Generate hash
   */
  private generateHash(): string {
    return Math.random().toString(36).substring(2, 15)
  }

  /**
   * Get version
   */
  getVersion(id: string): LambdaVersion | undefined {
    return this.versions.get(id)
  }

  /**
   * List versions
   */
  listVersions(functionName?: string): LambdaVersion[] {
    const versions = Array.from(this.versions.values())
    return functionName ? versions.filter(v => v.functionName === functionName) : versions
  }

  /**
   * Get alias
   */
  getAlias(id: string): LambdaAlias | undefined {
    return this.aliases.get(id)
  }

  /**
   * List aliases
   */
  listAliases(functionName?: string): LambdaAlias[] {
    const aliases = Array.from(this.aliases.values())
    return functionName ? aliases.filter(a => a.functionName === functionName) : aliases
  }

  /**
   * Generate CloudFormation for version
   */
  generateVersionCF(version: LambdaVersion): any {
    return {
      Type: 'AWS::Lambda::Version',
      Properties: {
        FunctionName: version.functionName,
        Description: version.description,
      },
    }
  }

  /**
   * Generate CloudFormation for alias
   */
  generateAliasCF(alias: LambdaAlias): any {
    return {
      Type: 'AWS::Lambda::Alias',
      Properties: {
        FunctionName: alias.functionName,
        Name: alias.aliasName,
        FunctionVersion: alias.functionVersion,
        Description: alias.description,
        ...(alias.routingConfig && {
          RoutingConfig: {
            AdditionalVersionWeights: Object.entries(
              alias.routingConfig.additionalVersionWeights || {}
            ).map(([version, weight]) => ({
              FunctionVersion: version,
              FunctionWeight: weight,
            })),
          },
        }),
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.versions.clear()
    this.aliases.clear()
    this.deployments.clear()
    this.versionCounter = 0
    this.aliasCounter = 0
    this.deploymentCounter = 0
  }
}

/**
 * Global Lambda versions manager instance
 */
export const lambdaVersionsManager: LambdaVersionsManager = new LambdaVersionsManager()
