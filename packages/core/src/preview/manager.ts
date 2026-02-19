/**
 * Preview Environment Manager
 * Manages ephemeral environments for PR previews
 */

import type { CloudConfig } from 'ts-cloud-types'

export interface PreviewEnvironment {
  id: string
  name: string
  branch: string
  pr?: number
  commitSha: string
  createdAt: Date
  expiresAt: Date
  url?: string
  status: 'creating' | 'active' | 'failed' | 'destroying' | 'destroyed'
  stackName: string
  region: string
  resources: string[]
  cost?: number
}

export interface PreviewEnvironmentOptions {
  branch: string
  pr?: number
  commitSha: string
  ttl?: number // Time to live in hours
  baseConfig: CloudConfig
  region?: string
}

export interface PreviewCleanupOptions {
  maxAge?: number // Max age in hours
  keepCount?: number // Keep N most recent environments
  dryRun?: boolean
}

/**
 * Preview Environment Manager
 */
export class PreviewEnvironmentManager {
  private environments: Map<string, PreviewEnvironment> = new Map()

  /**
   * Create a new preview environment
   */
  async createPreviewEnvironment(options: PreviewEnvironmentOptions): Promise<PreviewEnvironment> {
    const {
      branch,
      pr,
      commitSha,
      ttl = 24, // Default: 24 hours
      baseConfig,
      region = 'us-east-1',
    } = options

    // Generate unique ID for preview environment
    const id = this.generatePreviewId(branch, pr, commitSha)
    const name = this.generatePreviewName(branch, pr)
    const stackName = `preview-${name}`

    // Calculate expiration
    const createdAt = new Date()
    const expiresAt = new Date(createdAt.getTime() + ttl * 60 * 60 * 1000)

    const environment: PreviewEnvironment = {
      id,
      name,
      branch,
      pr,
      commitSha,
      createdAt,
      expiresAt,
      status: 'creating',
      stackName,
      region,
      resources: [],
    }

    this.environments.set(id, environment)

    try {
      // Create modified config for preview environment
      const _previewConfig = this.createPreviewConfig(baseConfig, name)

      // Deploy preview environment (implementation would use CloudFormation)
      // This is a placeholder - actual implementation would:
      // 1. Generate CloudFormation template
      // 2. Deploy stack
      // 3. Wait for completion
      // 4. Extract outputs (URL, etc.)

      environment.status = 'active'
      environment.url = `https://${name}.preview.example.com`

      return environment
    }
    catch (error) {
      environment.status = 'failed'
      throw error
    }
  }

  /**
   * Destroy a preview environment
   */
  async destroyPreviewEnvironment(id: string): Promise<void> {
    const environment = this.environments.get(id)

    if (!environment) {
      throw new Error(`Preview environment ${id} not found`)
    }

    environment.status = 'destroying'

    try {
      // Delete CloudFormation stack
      // This is a placeholder - actual implementation would:
      // 1. Delete CloudFormation stack
      // 2. Wait for deletion
      // 3. Clean up any remaining resources

      environment.status = 'destroyed'
      this.environments.delete(id)
    }
    catch (error) {
      throw new Error(`Failed to destroy preview environment: ${error}`)
    }
  }

  /**
   * Get preview environment by ID
   */
  getPreviewEnvironment(id: string): PreviewEnvironment | undefined {
    return this.environments.get(id)
  }

  /**
   * Get preview environment by branch
   */
  getPreviewEnvironmentByBranch(branch: string): PreviewEnvironment | undefined {
    return Array.from(this.environments.values()).find(env => env.branch === branch)
  }

  /**
   * Get preview environment by PR number
   */
  getPreviewEnvironmentByPR(pr: number): PreviewEnvironment | undefined {
    return Array.from(this.environments.values()).find(env => env.pr === pr)
  }

  /**
   * List all preview environments
   */
  listPreviewEnvironments(): PreviewEnvironment[] {
    return Array.from(this.environments.values())
  }

  /**
   * List active preview environments
   */
  listActivePreviewEnvironments(): PreviewEnvironment[] {
    return this.listPreviewEnvironments().filter(env => env.status === 'active')
  }

  /**
   * Clean up expired preview environments
   */
  async cleanupExpiredEnvironments(options: PreviewCleanupOptions = {}): Promise<{
    destroyed: string[]
    failed: string[]
  }> {
    const { maxAge, keepCount, dryRun = false } = options

    const destroyed: string[] = []
    const failed: string[] = []
    const now = new Date()

    // Get all environments sorted by creation date (newest first)
    const environments = this.listPreviewEnvironments().sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )

    for (let i = 0; i < environments.length; i++) {
      const env = environments[i]

      // Skip if not active or already being destroyed
      if (env.status !== 'active') {
        continue
      }

      let shouldDestroy = false

      // Check if expired by TTL
      if (env.expiresAt < now) {
        shouldDestroy = true
      }

      // Check if older than maxAge
      if (maxAge) {
        const ageHours = (now.getTime() - env.createdAt.getTime()) / (1000 * 60 * 60)
        if (ageHours > maxAge) {
          shouldDestroy = true
        }
      }

      // Keep only N most recent environments
      if (keepCount && i >= keepCount) {
        shouldDestroy = true
      }

      if (shouldDestroy) {
        if (dryRun) {
          destroyed.push(env.id)
        }
        else {
          try {
            await this.destroyPreviewEnvironment(env.id)
            destroyed.push(env.id)
          }
          catch (error) {
            failed.push(env.id)
          }
        }
      }
    }

    return { destroyed, failed }
  }

  /**
   * Update preview environment from new commit
   */
  async updatePreviewEnvironment(id: string, commitSha: string): Promise<PreviewEnvironment> {
    const environment = this.environments.get(id)

    if (!environment) {
      throw new Error(`Preview environment ${id} not found`)
    }

    environment.commitSha = commitSha
    environment.status = 'creating'

    try {
      // Update CloudFormation stack
      // This is a placeholder - actual implementation would:
      // 1. Generate updated CloudFormation template
      // 2. Update stack
      // 3. Wait for completion

      environment.status = 'active'

      return environment
    }
    catch (error) {
      environment.status = 'failed'
      throw error
    }
  }

  /**
   * Get cost estimate for preview environments
   */
  async getPreviewEnvironmentsCost(): Promise<{
    total: number
    byEnvironment: Record<string, number>
  }> {
    const byEnvironment: Record<string, number> = {}
    let total = 0

    for (const env of this.environments.values()) {
      // This is a placeholder - actual implementation would:
      // 1. Query AWS Cost Explorer API
      // 2. Filter by stack tags
      // 3. Sum costs
      const cost = 0 // Placeholder

      byEnvironment[env.id] = cost
      total += cost
    }

    return { total, byEnvironment }
  }

  /**
   * Generate preview environment ID
   */
  private generatePreviewId(branch: string, pr?: number, commitSha?: string): string {
    const sanitizedBranch = branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
    const shortSha = commitSha?.substring(0, 7) || Date.now().toString()

    return pr ? `pr-${pr}-${shortSha}` : `${sanitizedBranch}-${shortSha}`
  }

  /**
   * Generate preview environment name
   */
  private generatePreviewName(branch: string, pr?: number): string {
    const sanitizedBranch = branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase()

    return pr ? `pr-${pr}` : sanitizedBranch
  }

  /**
   * Create modified config for preview environment
   */
  private createPreviewConfig(baseConfig: CloudConfig, name: string): CloudConfig {
    return {
      ...baseConfig,
      project: {
        ...baseConfig.project,
        name: `${baseConfig.project.name} Preview (${name})`,
        slug: `${baseConfig.project.slug}-preview-${name}`,
      },
      // Add preview-specific tags
      // Add cost allocation tags
      // Reduce resource sizes for cost optimization
    }
  }
}

/**
 * Global preview environment manager instance
 */
export const previewManager: PreviewEnvironmentManager = new PreviewEnvironmentManager()
