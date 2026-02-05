import type { ECRRepository, ECRLifecyclePolicy } from '@stacksjs/ts-cloud-aws-types'
import { generateLogicalId, generateResourceName } from '../resource-naming'
import type { EnvironmentType } from '@stacksjs/ts-cloud-types'

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

  /**
   * Generate a Dockerfile for Bun-based applications
  */
  static generateBunDockerfile(options: {
    baseImage?: string
    serverPath: string
    port?: number
    additionalDirs?: string[]
    healthCheckEndpoint?: string
    nodeCompatible?: boolean
    envVars?: Record<string, string>
    buildCommands?: string[]
    runCommand?: string
  }): string {
    const {
      baseImage = 'oven/bun:1-debian',
      serverPath,
      port = 3000,
      additionalDirs = [],
      healthCheckEndpoint = '/health',
      nodeCompatible = false,
      envVars = {},
      buildCommands = [],
      runCommand,
    } = options

    const copyDirs = ['app', 'config', ...additionalDirs]
    const entrypoint = runCommand || `bun run ${serverPath}`

    let dockerfile = `# Multi-stage build for Bun application
# Generated by ts-cloud

# Builder stage
FROM ${baseImage} AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Production stage
FROM ${baseImage} AS release

WORKDIR /app

# Create non-root user
RUN groupadd -r app && useradd -r -g app app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY package.json ./
`

    // Copy each directory
    for (const dir of copyDirs) {
      dockerfile += `COPY ${dir} ./${dir}\n`
    }

    // Copy the server file
    dockerfile += `COPY ${serverPath} ./${serverPath}\n`

    // Add build commands if any
    if (buildCommands.length > 0) {
      dockerfile += '\n# Build commands\n'
      for (const cmd of buildCommands) {
        dockerfile += `RUN ${cmd}\n`
      }
    }

    // Environment variables
    dockerfile += '\n# Environment variables\n'
    dockerfile += `ENV NODE_ENV=production\n`
    dockerfile += `ENV PORT=${port}\n`

    for (const [key, value] of Object.entries(envVars)) {
      dockerfile += `ENV ${key}=${value}\n`
    }

    // Node compatibility mode
    if (nodeCompatible) {
      dockerfile += 'ENV BUN_INSTALL_FORCE_NODE_API=1\n'
    }

    // Storage directory
    dockerfile += `
# Create storage directory
RUN mkdir -p /app/storage && chown -R app:app /app/storage

# Switch to non-root user
USER app

# Expose port
EXPOSE ${port}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost:${port}${healthCheckEndpoint} || exit 1

# Start application
CMD ["bun", "run", "${serverPath}"]
`

    return dockerfile
  }

  /**
   * Generate Docker build commands
  */
  static generateDockerBuildCommands(options: {
    repositoryUri: string
    tag?: string
    dockerfilePath?: string
    context?: string
    additionalTags?: string[]
    buildArgs?: Record<string, string>
    platform?: string
    noCache?: boolean
  }): {
    build: string
    tag: string[]
    push: string[]
    all: string[]
  } {
    const {
      repositoryUri,
      tag = 'latest',
      dockerfilePath = 'Dockerfile',
      context = '.',
      additionalTags = [],
      buildArgs = {},
      platform = 'linux/amd64',
      noCache = false,
    } = options

    const imageUri = `${repositoryUri}:${tag}`
    const allTags = [tag, ...additionalTags]

    // Build command
    let buildCmd = `docker build -f ${dockerfilePath} -t ${imageUri}`

    if (platform) {
      buildCmd += ` --platform ${platform}`
    }

    if (noCache) {
      buildCmd += ' --no-cache'
    }

    for (const [key, value] of Object.entries(buildArgs)) {
      buildCmd += ` --build-arg ${key}=${value}`
    }

    buildCmd += ` ${context}`

    // Tag commands
    const tagCommands = allTags.slice(1).map(t =>
      `docker tag ${imageUri} ${repositoryUri}:${t}`,
    )

    // Push commands
    const pushCommands = allTags.map(t =>
      `docker push ${repositoryUri}:${t}`,
    )

    return {
      build: buildCmd,
      tag: tagCommands,
      push: pushCommands,
      all: [buildCmd, ...tagCommands, ...pushCommands],
    }
  }

  /**
   * Generate ECR login command
  */
  static generateEcrLoginCommand(region: string, accountId: string): string {
    return `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.${region}.amazonaws.com`
  }

  /**
   * Build ECR repository URI
  */
  static buildRepositoryUri(options: {
    accountId: string
    region: string
    repositoryName: string
  }): string {
    return `${options.accountId}.dkr.ecr.${options.region}.amazonaws.com/${options.repositoryName}`
  }

  /**
   * Generate image tags based on deployment info
  */
  static generateImageTags(options: {
    version?: string
    gitSha?: string
    gitBranch?: string
    environment?: string
    timestamp?: boolean
  }): string[] {
    const tags: string[] = ['latest']

    if (options.version) {
      tags.push(options.version)
      // Also add semantic version components
      const parts = options.version.split('.')
      if (parts.length >= 2) {
        tags.push(`${parts[0]}.${parts[1]}`) // major.minor
      }
      if (parts.length >= 1) {
        tags.push(parts[0]) // major
      }
    }

    if (options.gitSha) {
      tags.push(options.gitSha.substring(0, 7)) // Short SHA
      tags.push(options.gitSha) // Full SHA
    }

    if (options.gitBranch) {
      // Sanitize branch name for Docker tag
      const sanitizedBranch = options.gitBranch
        .replace(/[^a-zA-Z0-9.-]/g, '-')
        .replace(/^-+|-+$/g, '')
      tags.push(sanitizedBranch)
    }

    if (options.environment) {
      tags.push(options.environment)
    }

    if (options.timestamp) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      tags.push(ts)
    }

    return [...new Set(tags)] // Remove duplicates
  }

  /**
   * Docker deployment workflow steps
  */
  static readonly DeploymentWorkflow = {
    /**
     * Generate a complete deployment script
    */
    generateDeployScript: (options: {
      region: string
      accountId: string
      repositoryName: string
      dockerfilePath?: string
      serverPath: string
      tags?: string[]
    }): string => {
      const repositoryUri = Registry.buildRepositoryUri({
        accountId: options.accountId,
        region: options.region,
        repositoryName: options.repositoryName,
      })

      const tags = options.tags || ['latest']
      const primaryTag = tags[0]

      return `#!/bin/bash
set -e

# Configuration
REGION="${options.region}"
ACCOUNT_ID="${options.accountId}"
REPOSITORY="${options.repositoryName}"
IMAGE_URI="${repositoryUri}"
DOCKERFILE="${options.dockerfilePath || 'Dockerfile'}"

echo "=== ECR Login ==="
${Registry.generateEcrLoginCommand(options.region, options.accountId)}

echo "=== Building Image ==="
docker build -f $DOCKERFILE -t $IMAGE_URI:${primaryTag} --platform linux/amd64 .

${tags.slice(1).map(t => `echo "=== Tagging: ${t} ===" && docker tag $IMAGE_URI:${primaryTag} $IMAGE_URI:${t}`).join('\n')}

echo "=== Pushing Images ==="
${tags.map(t => `docker push $IMAGE_URI:${t}`).join('\n')}

echo "=== Deployment Complete ==="
echo "Image: $IMAGE_URI:${primaryTag}"
`
    },

    /**
     * Generate GitHub Actions workflow for ECR deployment
    */
    generateGitHubActionsWorkflow: (options: {
      region: string
      repositoryName: string
      dockerfilePath?: string
      ecsCluster?: string
      ecsService?: string
    }): string => {
      const workflow = {
        name: 'Deploy to ECR',
        on: {
          push: {
            branches: ['main'],
          },
        },
        env: {
          AWS_REGION: options.region,
          ECR_REPOSITORY: options.repositoryName,
        },
        jobs: {
          deploy: {
            'runs-on': 'ubuntu-latest',
            permissions: {
              'id-token': 'write',
              'contents': 'read',
            },
            steps: [
              {
                name: 'Checkout',
                uses: 'actions/checkout@v4',
              },
              {
                name: 'Configure AWS credentials',
                uses: 'aws-actions/configure-aws-credentials@v4',
                with: {
                  'role-to-assume': '${{ secrets.AWS_ROLE_ARN }}',
                  'aws-region': '${{ env.AWS_REGION }}',
                },
              },
              {
                name: 'Login to Amazon ECR',
                id: 'login-ecr',
                uses: 'aws-actions/amazon-ecr-login@v2',
              },
              {
                name: 'Build, tag, and push image to Amazon ECR',
                env: {
                  ECR_REGISTRY: '${{ steps.login-ecr.outputs.registry }}',
                  IMAGE_TAG: '${{ github.sha }}',
                },
                run: `docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG -t $ECR_REGISTRY/$ECR_REPOSITORY:latest ${options.dockerfilePath ? `-f ${options.dockerfilePath}` : ''} .
docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
docker push $ECR_REGISTRY/$ECR_REPOSITORY:latest`,
              },
              ...(options.ecsCluster && options.ecsService
                ? [{
                    name: 'Deploy to ECS',
                    run: `aws ecs update-service --cluster ${options.ecsCluster} --service ${options.ecsService} --force-new-deployment`,
                  }]
                : []),
            ],
          },
        },
      }

      return `# Generated by ts-cloud
${JSON.stringify(workflow, null, 2).replace(/"/g, '').replace(/,\n/g, '\n')}`
    },
  }

  /**
   * Common Dockerfile templates
  */
  static readonly DockerfileTemplates = {
    /**
     * Minimal Bun server
    */
    bunServer: (serverPath: string, port = 3000): string => Registry.generateBunDockerfile({
      serverPath,
      port,
    }),

    /**
     * Bun with build step
    */
    bunWithBuild: (serverPath: string, buildCommand: string, port = 3000): string => Registry.generateBunDockerfile({
      serverPath,
      port,
      buildCommands: [buildCommand],
    }),

    /**
     * Full-stack Bun app with static files
    */
    bunFullStack: (serverPath: string, port = 3000): string => Registry.generateBunDockerfile({
      serverPath,
      port,
      additionalDirs: ['public', 'views', 'dist'],
      buildCommands: ['bun run build'],
    }),

    /**
     * API-only Bun server
    */
    bunApi: (serverPath: string, port = 3000): string => Registry.generateBunDockerfile({
      serverPath,
      port,
      healthCheckEndpoint: '/api/health',
    }),
  }
}
