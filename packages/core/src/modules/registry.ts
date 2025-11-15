import type { ECRRepository, ECRLifecyclePolicy } from '@ts-cloud/aws-types'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@ts-cloud/types'

export interface RegistryOptions {
  name: string
  slug: string
  environment: EnvironmentType
  scanOnPush?: boolean
  imageMutability?: 'MUTABLE' | 'IMMUTABLE'
  encryption?: 'AES256' | 'KMS'
  kmsKey?: string
  lifecyclePolicy?: LifecyclePolicyConfig
  tags?: Record<string, string>
}

export interface LifecyclePolicyConfig {
  maxImageCount?: number
  maxImageAgeDays?: number
  untaggedImageExpireDays?: number
}

/**
 * Registry Module - ECR Container Registry Management
 * Provides clean API for creating and configuring ECR repositories
 */
export class Registry {
  /**
   * Create an ECR repository with the specified options
   */
  static createRepository(options: RegistryOptions): { repository: ECRRepository, logicalId: string } {
    const {
      name,
      slug,
      environment,
      scanOnPush = true,
      imageMutability = 'MUTABLE',
      encryption = 'AES256',
      kmsKey,
      lifecyclePolicy,
      tags,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'ecr',
      suffix: name,
    })

    const logicalId = generateLogicalId(resourceName)

    const repository: ECRRepository = {
      Type: 'AWS::ECR::Repository',
      Properties: {
        RepositoryName: resourceName,
        ImageTagMutability: imageMutability,
        ImageScanningConfiguration: {
          ScanOnPush: scanOnPush,
        },
        EncryptionConfiguration: {
          EncryptionType: encryption,
          ...(kmsKey && encryption === 'KMS' ? { KmsKey: kmsKey } : {}),
        },
      },
    }

    // Add lifecycle policy if specified
    if (lifecyclePolicy) {
      repository.Properties!.LifecyclePolicy = {
        LifecyclePolicyText: JSON.stringify(
          Registry.generateLifecyclePolicy(lifecyclePolicy),
        ),
      }
    }

    // Add tags if specified
    if (tags) {
      repository.Properties!.Tags = Object.entries(tags).map(([Key, Value]) => ({
        Key,
        Value,
      }))
    }

    return {
      repository,
      logicalId,
    }
  }

  /**
   * Generate lifecycle policy from config
   */
  private static generateLifecyclePolicy(config: LifecyclePolicyConfig): ECRLifecyclePolicy {
    const rules: ECRLifecyclePolicy['rules'] = []

    // Rule for untagged images
    if (config.untaggedImageExpireDays !== undefined) {
      rules.push({
        rulePriority: 1,
        description: 'Delete untagged images',
        selection: {
          tagStatus: 'untagged',
          countType: 'sinceImagePushed',
          countNumber: config.untaggedImageExpireDays,
          countUnit: 'days',
        },
        action: {
          type: 'expire',
        },
      })
    }

    // Rule for max image count
    if (config.maxImageCount !== undefined) {
      rules.push({
        rulePriority: rules.length + 1,
        description: 'Keep only most recent images',
        selection: {
          tagStatus: 'any',
          countType: 'imageCountMoreThan',
          countNumber: config.maxImageCount,
        },
        action: {
          type: 'expire',
        },
      })
    }

    // Rule for max image age
    if (config.maxImageAgeDays !== undefined) {
      rules.push({
        rulePriority: rules.length + 1,
        description: 'Delete images older than specified days',
        selection: {
          tagStatus: 'any',
          countType: 'sinceImagePushed',
          countNumber: config.maxImageAgeDays,
          countUnit: 'days',
        },
        action: {
          type: 'expire',
        },
      })
    }

    return { rules }
  }

  /**
   * Common lifecycle policy presets
   */
  static readonly LifecyclePolicies = {
    /**
     * Keep only the 10 most recent images, delete untagged after 7 days
     */
    production: {
      maxImageCount: 10,
      untaggedImageExpireDays: 7,
    },

    /**
     * Keep only the 5 most recent images, delete untagged after 3 days
     */
    development: {
      maxImageCount: 5,
      untaggedImageExpireDays: 3,
    },

    /**
     * Aggressive cleanup - keep 3 images, delete untagged after 1 day
     */
    minimal: {
      maxImageCount: 3,
      untaggedImageExpireDays: 1,
    },

    /**
     * Long-term storage - keep 50 images, delete untagged after 30 days
     */
    archive: {
      maxImageCount: 50,
      untaggedImageExpireDays: 30,
    },
  }

  /**
   * Enable immutable tags on an existing repository
   */
  static enableImmutableTags(repository: ECRRepository): ECRRepository {
    if (!repository.Properties) {
      repository.Properties = {}
    }

    repository.Properties.ImageTagMutability = 'IMMUTABLE'

    return repository
  }

  /**
   * Enable scan on push
   */
  static enableScanOnPush(repository: ECRRepository): ECRRepository {
    if (!repository.Properties) {
      repository.Properties = {}
    }

    repository.Properties.ImageScanningConfiguration = {
      ScanOnPush: true,
    }

    return repository
  }

  /**
   * Set lifecycle policy on an existing repository
   */
  static setLifecyclePolicy(
    repository: ECRRepository,
    config: LifecyclePolicyConfig,
  ): ECRRepository {
    if (!repository.Properties) {
      repository.Properties = {}
    }

    repository.Properties.LifecyclePolicy = {
      LifecyclePolicyText: JSON.stringify(Registry.generateLifecyclePolicy(config)),
    }

    return repository
  }

  /**
   * Add repository policy for cross-account access
   */
  static addCrossAccountAccess(
    repository: ECRRepository,
    accountIds: string[],
  ): ECRRepository {
    if (!repository.Properties) {
      repository.Properties = {}
    }

    repository.Properties.RepositoryPolicyText = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'CrossAccountPull',
          Effect: 'Allow',
          Principal: {
            AWS: accountIds.map(id => `arn:aws:iam::${id}:root`),
          },
          Action: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:BatchCheckLayerAvailability',
          ],
        },
      ],
    }

    return repository
  }

  /**
   * Add repository policy for Lambda service access
   */
  static addLambdaAccess(repository: ECRRepository): ECRRepository {
    if (!repository.Properties) {
      repository.Properties = {}
    }

    repository.Properties.RepositoryPolicyText = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'LambdaECRImageRetrievalPolicy',
          Effect: 'Allow',
          Principal: {
            Service: 'lambda.amazonaws.com',
          },
          Action: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
          ],
        },
      ],
    }

    return repository
  }
}
