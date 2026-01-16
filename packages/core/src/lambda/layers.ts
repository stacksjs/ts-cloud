/**
 * Lambda Layers Management
 * Reusable code and dependencies for Lambda functions
 */

export interface LambdaLayer {
  id: string
  layerName: string
  layerArn: string
  version: number
  description?: string
  compatibleRuntimes: string[]
  licenseInfo?: string
  content: LayerContent
  size: number // bytes
}

export interface LayerContent {
  type: 's3' | 'zip'
  s3Bucket?: string
  s3Key?: string
  s3ObjectVersion?: string
  zipFile?: string
}

export interface LayerVersion {
  id: string
  layerName: string
  version: number
  createdAt: Date
  compatibleRuntimes: string[]
  size: number
  codeHash: string
}

export interface LayerPermission {
  id: string
  layerName: string
  version: number
  principal: string
  action: 'lambda:GetLayerVersion'
  organizationId?: string
}

/**
 * Lambda layers manager
 */
export class LambdaLayersManager {
  private layers: Map<string, LambdaLayer> = new Map()
  private versions: Map<string, LayerVersion> = new Map()
  private permissions: Map<string, LayerPermission> = new Map()
  private layerCounter = 0
  private versionCounter = 0
  private permissionCounter = 0

  /**
   * Create Lambda layer
   */
  createLayer(layer: Omit<LambdaLayer, 'id' | 'layerArn' | 'version'>): LambdaLayer {
    const id = `layer-${Date.now()}-${this.layerCounter++}`
    const version = 1

    const lambdaLayer: LambdaLayer = {
      id,
      layerArn: `arn:aws:lambda:us-east-1:123456789012:layer:${layer.layerName}:${version}`,
      version,
      ...layer,
    }

    this.layers.set(id, lambdaLayer)

    return lambdaLayer
  }

  /**
   * Create Node.js dependencies layer
   */
  createNodeDependenciesLayer(options: {
    layerName: string
    nodeVersion: string
    s3Bucket: string
    s3Key: string
  }): LambdaLayer {
    return this.createLayer({
      layerName: options.layerName,
      description: 'Node.js dependencies layer',
      compatibleRuntimes: [`nodejs${options.nodeVersion}`],
      content: {
        type: 's3',
        s3Bucket: options.s3Bucket,
        s3Key: options.s3Key,
      },
      size: 5 * 1024 * 1024, // 5MB
    })
  }

  /**
   * Create shared utilities layer
   */
  createUtilitiesLayer(options: {
    layerName: string
    runtimes: string[]
    s3Bucket: string
    s3Key: string
  }): LambdaLayer {
    return this.createLayer({
      layerName: options.layerName,
      description: 'Shared utilities and helpers',
      compatibleRuntimes: options.runtimes,
      content: {
        type: 's3',
        s3Bucket: options.s3Bucket,
        s3Key: options.s3Key,
      },
      size: 1 * 1024 * 1024, // 1MB
    })
  }

  /**
   * Publish layer version
   */
  publishVersion(layerId: string): LayerVersion {
    const layer = this.layers.get(layerId)

    if (!layer) {
      throw new Error(`Layer not found: ${layerId}`)
    }

    const id = `version-${Date.now()}-${this.versionCounter++}`
    const version = layer.version + 1

    const layerVersion: LayerVersion = {
      id,
      layerName: layer.layerName,
      version,
      createdAt: new Date(),
      compatibleRuntimes: layer.compatibleRuntimes,
      size: layer.size,
      codeHash: this.generateHash(),
    }

    this.versions.set(id, layerVersion)

    // Update layer version
    layer.version = version
    layer.layerArn = `arn:aws:lambda:us-east-1:123456789012:layer:${layer.layerName}:${version}`

    return layerVersion
  }

  /**
   * Add layer permission
   */
  addPermission(options: {
    layerName: string
    version: number
    principal: string
    organizationId?: string
  }): LayerPermission {
    const id = `permission-${Date.now()}-${this.permissionCounter++}`

    const permission: LayerPermission = {
      id,
      layerName: options.layerName,
      version: options.version,
      principal: options.principal,
      action: 'lambda:GetLayerVersion',
      organizationId: options.organizationId,
    }

    this.permissions.set(id, permission)

    return permission
  }

  /**
   * Generate hash
   */
  private generateHash(): string {
    return Math.random().toString(36).substring(2, 15)
  }

  /**
   * Get layer
   */
  getLayer(id: string): LambdaLayer | undefined {
    return this.layers.get(id)
  }

  /**
   * List layers
   */
  listLayers(): LambdaLayer[] {
    return Array.from(this.layers.values())
  }

  /**
   * Get layer versions
   */
  getLayerVersions(layerName: string): LayerVersion[] {
    return Array.from(this.versions.values()).filter(v => v.layerName === layerName)
  }

  /**
   * Generate CloudFormation for layer
   */
  generateLayerCF(layer: LambdaLayer): any {
    return {
      Type: 'AWS::Lambda::LayerVersion',
      Properties: {
        LayerName: layer.layerName,
        Description: layer.description,
        Content: layer.content.type === 's3'
          ? {
              S3Bucket: layer.content.s3Bucket,
              S3Key: layer.content.s3Key,
              ...(layer.content.s3ObjectVersion && {
                S3ObjectVersion: layer.content.s3ObjectVersion,
              }),
            }
          : {
              ZipFile: layer.content.zipFile,
            },
        CompatibleRuntimes: layer.compatibleRuntimes,
        ...(layer.licenseInfo && { LicenseInfo: layer.licenseInfo }),
      },
    }
  }

  /**
   * Generate CloudFormation for layer permission
   */
  generateLayerPermissionCF(permission: LayerPermission): any {
    return {
      Type: 'AWS::Lambda::LayerVersionPermission',
      Properties: {
        LayerVersionArn: `arn:aws:lambda:us-east-1:123456789012:layer:${permission.layerName}:${permission.version}`,
        Action: permission.action,
        Principal: permission.principal,
        ...(permission.organizationId && {
          OrganizationId: permission.organizationId,
        }),
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.layers.clear()
    this.versions.clear()
    this.permissions.clear()
    this.layerCounter = 0
    this.versionCounter = 0
    this.permissionCounter = 0
  }
}

/**
 * Global Lambda layers manager instance
 */
export const lambdaLayersManager: LambdaLayersManager = new LambdaLayersManager()
