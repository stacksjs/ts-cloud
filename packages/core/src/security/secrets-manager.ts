/**
 * Secrets Management
 * Versioning, audit logging, and external secret manager integration
 */

export interface SecretVersion {
  id: string
  secretId: string
  versionId: string
  versionStages: string[] // AWSCURRENT, AWSPENDING, AWSPREVIOUS
  value?: string
  createdAt: Date
  deprecatedAt?: Date
}

export interface SecretAudit {
  id: string
  secretId: string
  action: SecretAction
  actor: string
  versionId?: string
  timestamp: Date
  ipAddress?: string
  userAgent?: string
  success: boolean
  error?: string
}

export type SecretAction =
  | 'CREATE'
  | 'READ'
  | 'UPDATE'
  | 'DELETE'
  | 'ROTATE'
  | 'RESTORE'
  | 'REPLICATE'

export interface ExternalSecretManager {
  id: string
  type: 'vault' | 'onepassword' | 'azure_keyvault' | 'gcp_secretmanager'
  name: string
  endpoint?: string
  authentication: ExternalAuthConfig
  syncEnabled?: boolean
  syncInterval?: number // minutes
}

export interface ExternalAuthConfig {
  type: 'token' | 'iam' | 'certificate' | 'apikey'
  credentials?: Record<string, string>
  roleArn?: string
  certificateArn?: string
}

export interface SecretReplication {
  id: string
  secretId: string
  sourceRegion: string
  replicaRegions: string[]
  kmsKeyIds?: Record<string, string> // region -> KMS key ID
  status: 'replicating' | 'completed' | 'failed'
}

export interface SecretPolicy {
  id: string
  secretId: string
  policy: PolicyDocument
}

export interface PolicyDocument {
  Version: string
  Statement: PolicyStatement[]
}

export interface PolicyStatement {
  Effect: 'Allow' | 'Deny'
  Principal: {
    AWS?: string | string[]
    Service?: string | string[]
  }
  Action: string | string[]
  Resource?: string | string[]
  Condition?: Record<string, any>
}

/**
 * Secrets manager
 */
export class SecretsManager {
  private versions: Map<string, SecretVersion> = new Map()
  private audits: Map<string, SecretAudit> = new Map()
  private externalManagers: Map<string, ExternalSecretManager> = new Map()
  private replications: Map<string, SecretReplication> = new Map()
  private policies: Map<string, SecretPolicy> = new Map()
  private versionCounter = 0
  private auditCounter = 0
  private managerCounter = 0
  private replicationCounter = 0
  private policyCounter = 0

  /**
   * Create secret version
   */
  createVersion(version: Omit<SecretVersion, 'id'>): SecretVersion {
    const id = `version-${Date.now()}-${this.versionCounter++}`

    const secretVersion: SecretVersion = {
      id,
      ...version,
    }

    this.versions.set(id, secretVersion)

    // Audit the action
    this.auditAction({
      secretId: version.secretId,
      action: 'CREATE',
      actor: 'system',
      versionId: version.versionId,
      success: true,
    })

    return secretVersion
  }

  /**
   * Get secret version by stage
   */
  getVersionByStage(secretId: string, stage: string): SecretVersion | undefined {
    return Array.from(this.versions.values()).find(
      v => v.secretId === secretId && v.versionStages.includes(stage)
    )
  }

  /**
   * List versions for secret
   */
  listVersions(secretId: string): SecretVersion[] {
    return Array.from(this.versions.values())
      .filter(v => v.secretId === secretId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  /**
   * Deprecate version
   */
  deprecateVersion(versionId: string): void {
    const version = Array.from(this.versions.values()).find(v => v.versionId === versionId)

    if (version) {
      version.deprecatedAt = new Date()
      version.versionStages = version.versionStages.filter(s => s !== 'AWSCURRENT')

      this.auditAction({
        secretId: version.secretId,
        action: 'UPDATE',
        actor: 'system',
        versionId,
        success: true,
      })
    }
  }

  /**
   * Restore version
   */
  restoreVersion(versionId: string): void {
    const version = Array.from(this.versions.values()).find(v => v.versionId === versionId)

    if (version) {
      // Remove AWSCURRENT from other versions
      Array.from(this.versions.values())
        .filter(v => v.secretId === version.secretId && v.versionId !== versionId)
        .forEach(v => {
          v.versionStages = v.versionStages.filter(s => s !== 'AWSCURRENT')
        })

      // Set this version as current
      version.versionStages.push('AWSCURRENT')
      version.deprecatedAt = undefined

      this.auditAction({
        secretId: version.secretId,
        action: 'RESTORE',
        actor: 'system',
        versionId,
        success: true,
      })
    }
  }

  /**
   * Audit secret action
   */
  auditAction(audit: Omit<SecretAudit, 'id' | 'timestamp'>): SecretAudit {
    const id = `audit-${Date.now()}-${this.auditCounter++}`

    const secretAudit: SecretAudit = {
      id,
      timestamp: new Date(),
      ...audit,
    }

    this.audits.set(id, secretAudit)

    return secretAudit
  }

  /**
   * Get audit trail for secret
   */
  getAuditTrail(secretId: string, limit: number = 100): SecretAudit[] {
    return Array.from(this.audits.values())
      .filter(audit => audit.secretId === secretId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit)
  }

  /**
   * Get failed access attempts
   */
  getFailedAccesses(secretId: string, hours: number = 24): SecretAudit[] {
    const cutoffTime = Date.now() - hours * 60 * 60 * 1000

    return Array.from(this.audits.values()).filter(
      audit =>
        audit.secretId === secretId &&
        !audit.success &&
        audit.timestamp.getTime() > cutoffTime
    )
  }

  /**
   * Register external secret manager
   */
  registerExternalManager(manager: Omit<ExternalSecretManager, 'id'>): ExternalSecretManager {
    const id = `ext-manager-${Date.now()}-${this.managerCounter++}`

    const externalManager: ExternalSecretManager = {
      id,
      ...manager,
    }

    this.externalManagers.set(id, externalManager)

    return externalManager
  }

  /**
   * Register HashiCorp Vault
   */
  registerVault(options: {
    name: string
    endpoint: string
    token?: string
    roleArn?: string
    syncEnabled?: boolean
  }): ExternalSecretManager {
    return this.registerExternalManager({
      type: 'vault',
      name: options.name,
      endpoint: options.endpoint,
      authentication: {
        type: options.token ? 'token' : 'iam',
        credentials: options.token ? { token: options.token } : undefined,
        roleArn: options.roleArn,
      },
      syncEnabled: options.syncEnabled || false,
      syncInterval: 60,
    })
  }

  /**
   * Register 1Password
   */
  registerOnePassword(options: {
    name: string
    endpoint?: string
    apiKey: string
    syncEnabled?: boolean
  }): ExternalSecretManager {
    return this.registerExternalManager({
      type: 'onepassword',
      name: options.name,
      endpoint: options.endpoint || 'https://my.1password.com',
      authentication: {
        type: 'apikey',
        credentials: { apiKey: options.apiKey },
      },
      syncEnabled: options.syncEnabled || false,
      syncInterval: 30,
    })
  }

  /**
   * Enable secret replication
   */
  enableReplication(options: {
    secretId: string
    sourceRegion: string
    replicaRegions: string[]
    kmsKeyIds?: Record<string, string>
  }): SecretReplication {
    const id = `replication-${Date.now()}-${this.replicationCounter++}`

    const replication: SecretReplication = {
      id,
      secretId: options.secretId,
      sourceRegion: options.sourceRegion,
      replicaRegions: options.replicaRegions,
      kmsKeyIds: options.kmsKeyIds,
      status: 'replicating',
    }

    this.replications.set(id, replication)

    this.auditAction({
      secretId: options.secretId,
      action: 'REPLICATE',
      actor: 'system',
      success: true,
    })

    // Simulate replication
    setTimeout(() => {
      replication.status = 'completed'
    }, 100)

    return replication
  }

  /**
   * Create secret policy
   */
  createPolicy(options: {
    secretId: string
    allowedPrincipals: string[]
    allowedActions: string[]
  }): SecretPolicy {
    const id = `policy-${Date.now()}-${this.policyCounter++}`

    const policy: SecretPolicy = {
      id,
      secretId: options.secretId,
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: options.allowedPrincipals,
            },
            Action: options.allowedActions,
            Resource: '*',
          },
        ],
      },
    }

    this.policies.set(id, policy)

    return policy
  }

  /**
   * Create cross-account access policy
   */
  createCrossAccountPolicy(options: {
    secretId: string
    accountId: string
    roleNames: string[]
  }): SecretPolicy {
    const principals = options.roleNames.map(
      role => `arn:aws:iam::${options.accountId}:role/${role}`
    )

    return this.createPolicy({
      secretId: options.secretId,
      allowedPrincipals: principals,
      allowedActions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    })
  }

  /**
   * Get version
   */
  getVersion(id: string): SecretVersion | undefined {
    return this.versions.get(id)
  }

  /**
   * Get external manager
   */
  getExternalManager(id: string): ExternalSecretManager | undefined {
    return this.externalManagers.get(id)
  }

  /**
   * List external managers
   */
  listExternalManagers(): ExternalSecretManager[] {
    return Array.from(this.externalManagers.values())
  }

  /**
   * Get replication
   */
  getReplication(id: string): SecretReplication | undefined {
    return this.replications.get(id)
  }

  /**
   * List replications
   */
  listReplications(): SecretReplication[] {
    return Array.from(this.replications.values())
  }

  /**
   * Generate CloudFormation for secret
   */
  generateSecretCF(options: {
    name: string
    description?: string
    kmsKeyId?: string
    replicaRegions?: string[]
  }): any {
    return {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Name: options.name,
        Description: options.description,
        ...(options.kmsKeyId && { KmsKeyId: options.kmsKeyId }),
        ...(options.replicaRegions && {
          ReplicaRegions: options.replicaRegions.map(region => ({
            Region: region,
          })),
        }),
      },
    }
  }

  /**
   * Generate CloudFormation for secret policy
   */
  generateSecretPolicyCF(policy: SecretPolicy): any {
    return {
      Type: 'AWS::SecretsManager::ResourcePolicy',
      Properties: {
        SecretId: policy.secretId,
        ResourcePolicy: policy.policy,
      },
    }
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.versions.clear()
    this.audits.clear()
    this.externalManagers.clear()
    this.replications.clear()
    this.policies.clear()
    this.versionCounter = 0
    this.auditCounter = 0
    this.managerCounter = 0
    this.replicationCounter = 0
    this.policyCounter = 0
  }
}

/**
 * Global secrets manager instance
 */
export const secretsManager = new SecretsManager()
