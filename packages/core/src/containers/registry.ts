/**
 * Private Container Registry
 * ECR repository management and access control
*/

export interface ContainerRegistry {
  id: string
  name: string
  registryType: 'ecr' | 'dockerhub' | 'gcr' | 'acr'
  repositoryUri: string
  region?: string
  encryption?: RegistryEncryption
  scanning?: ScanningConfig
  lifecycle?: LifecyclePolicy
  replication?: ReplicationConfig
}

export interface RegistryEncryption {
  encryptionType: 'AES256' | 'KMS'
  kmsKeyId?: string
}

export interface ScanningConfig {
  scanOnPush: boolean
  scanFilters?: ScanFilter[]
}

export interface ScanFilter {
  tagPattern: string
  scanFrequency: 'on_push' | 'daily' | 'weekly'
}

export interface LifecyclePolicy {
  id: string
  rules: LifecycleRule[]
}

export interface LifecycleRule {
  rulePriority: number
  description: string
  selection: {
    tagStatus: 'tagged' | 'untagged' | 'any'
    tagPrefixList?: string[]
    countType: 'imageCountMoreThan' | 'sinceImagePushed'
    countNumber: number
    countUnit?: 'days'
  }
  action: {
    type: 'expire'
  }
}

export interface ReplicationConfig {
  enabled: boolean
  destinations: ReplicationDestination[]
  rules?: ReplicationRule[]
}

export interface ReplicationDestination {
  region: string
  registryId?: string
}

export interface ReplicationRule {
  repositoryFilter: string[]
  destinations: ReplicationDestination[]
}

export interface RegistryCredentials {
  id: string
  registryId: string
  username: string
  passwordSecretArn: string
  expiresAt?: Date
}

/**
 * Container registry manager
*/
export class ContainerRegistryManager {
  private registries: Map<string, ContainerRegistry> = new Map()
  private credentials: Map<string, RegistryCredentials> = new Map()
  private registryCounter = 0
  private credentialsCounter = 0

  /**
   * Create registry
  */
  createRegistry(registry: Omit<ContainerRegistry, 'id'>): ContainerRegistry {
    const id = `registry-${Date.now()}-${this.registryCounter++}`

    const containerRegistry: ContainerRegistry = {
      id,
      ...registry,
    }

    this.registries.set(id, containerRegistry)

    return containerRegistry
  }

  /**
   * Create ECR repository
  */
  createECRRepository(options: {
    name: string
    region?: string
    scanOnPush?: boolean
    encryption?: 'AES256' | 'KMS'
    kmsKeyId?: string
  }): ContainerRegistry {
    return this.createRegistry({
      name: options.name,
      registryType: 'ecr',
      repositoryUri: `123456789012.dkr.ecr.${options.region || 'us-east-1'}.amazonaws.com/${options.name}`,
      region: options.region || 'us-east-1',
      encryption: {
        encryptionType: options.encryption || 'AES256',
        kmsKeyId: options.kmsKeyId,
      },
      scanning: {
        scanOnPush: options.scanOnPush ?? true,
      },
    })
  }

  /**
   * Create private registry with lifecycle policy
  */
  createManagedRepository(options: {
    name: string
    region?: string
    maxImageCount?: number
    maxImageAgeDays?: number
  }): ContainerRegistry {
    const registry = this.createECRRepository({
      name: options.name,
      region: options.region,
      scanOnPush: true,
      encryption: 'KMS',
    })

    // Add lifecycle policy
    registry.lifecycle = {
      id: `lifecycle-${Date.now()}`,
      rules: [
        {
          rulePriority: 1,
          description: 'Keep only last N images',
          selection: {
            tagStatus: 'any',
            countType: 'imageCountMoreThan',
            countNumber: options.maxImageCount || 10,
          },
          action: {
            type: 'expire',
          },
        },
        {
          rulePriority: 2,
          description: 'Remove images older than N days',
          selection: {
            tagStatus: 'untagged',
            countType: 'sinceImagePushed',
            countNumber: options.maxImageAgeDays || 30,
            countUnit: 'days',
          },
          action: {
            type: 'expire',
          },
        },
      ],
    }

    return registry
  }

  /**
   * Enable cross-region replication
  */
  enableReplication(
    registryId: string,
    destinations: ReplicationDestination[]
  ): ContainerRegistry {
    const registry = this.registries.get(registryId)

    if (!registry) {
      throw new Error(`Registry not found: ${registryId}`)
    }

    registry.replication = {
      enabled: true,
      destinations,
    }

    return registry
  }

  /**
   * Create registry credentials
  */
  createCredentials(credentials: Omit<RegistryCredentials, 'id'>): RegistryCredentials {
    const id = `creds-${Date.now()}-${this.credentialsCounter++}`

    const registryCredentials: RegistryCredentials = {
      id,
      ...credentials,
    }

    this.credentials.set(id, registryCredentials)

    return registryCredentials
  }

  /**
   * Get registry
  */
  getRegistry(id: string): ContainerRegistry | undefined {
    return this.registries.get(id)
  }

  /**
   * List registries
  */
  listRegistries(): ContainerRegistry[] {
    return Array.from(this.registries.values())
  }

  /**
   * Generate CloudFormation for ECR repository
  */
  generateECRRepositoryCF(registry: ContainerRegistry): any {
    return {
      Type: 'AWS::ECR::Repository',
      Properties: {
        RepositoryName: registry.name,
        ImageScanningConfiguration: {
          ScanOnPush: registry.scanning?.scanOnPush ?? false,
        },
        EncryptionConfiguration: {
          EncryptionType: registry.encryption?.encryptionType || 'AES256',
          ...(registry.encryption?.kmsKeyId && {
            KmsKey: registry.encryption.kmsKeyId,
          }),
        },
        ImageTagMutability: 'MUTABLE',
        ...(registry.lifecycle && {
          LifecyclePolicy: {
            LifecyclePolicyText: JSON.stringify({
              rules: registry.lifecycle.rules,
            }),
          },
        }),
      },
    }
  }

  /**
   * Generate CloudFormation for replication configuration
  */
  generateReplicationConfigCF(replication: ReplicationConfig): any {
    return {
      Type: 'AWS::ECR::ReplicationConfiguration',
      Properties: {
        ReplicationConfiguration: {
          Rules: replication.destinations.map(dest => ({
            Destinations: [
              {
                Region: dest.region,
                ...(dest.registryId && { RegistryId: dest.registryId }),
              },
            ],
          })),
        },
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.registries.clear()
    this.credentials.clear()
    this.registryCounter = 0
    this.credentialsCounter = 0
  }
}

/**
 * Global container registry manager instance
*/
export const containerRegistryManager: ContainerRegistryManager = new ContainerRegistryManager()
