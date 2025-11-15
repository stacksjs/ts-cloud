/**
 * Secrets Manager Module
 * Clean API for AWS Secrets Manager
 */

import type { SecretsManagerSecret, SecretsManagerSecretTargetAttachment, SecretsManagerRotationSchedule } from '@ts-cloud/aws-types'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface SecretOptions {
  slug: string
  environment: string
  secretName?: string
  description?: string
  secretString?: string
  kmsKeyId?: string
  tags?: Record<string, string>
}

export interface GeneratedSecretOptions {
  slug: string
  environment: string
  secretName?: string
  description?: string
  excludeCharacters?: string
  excludeLowercase?: boolean
  excludeNumbers?: boolean
  excludePunctuation?: boolean
  excludeUppercase?: boolean
  passwordLength?: number
  requireEachIncludedType?: boolean
  kmsKeyId?: string
  tags?: Record<string, string>
}

export interface SecretTargetAttachmentOptions {
  slug: string
  environment: string
  secretId: string
  targetId: string
  targetType: 'AWS::RDS::DBInstance' | 'AWS::RDS::DBCluster' | 'AWS::Redshift::Cluster' | 'AWS::DocDB::DBInstance' | 'AWS::DocDB::DBCluster'
}

export interface SecretRotationOptions {
  slug: string
  environment: string
  secretId: string
  rotationLambdaArn?: string
  automaticallyAfterDays?: number
  rotationType?: string
  kmsKeyArn?: string
  vpcSecurityGroupIds?: string
  vpcSubnetIds?: string
}

/**
 * Secrets Manager Module
 */
export class Secrets {
  /**
   * Create a secret with explicit value
   */
  static createSecret(options: SecretOptions): {
    secret: SecretsManagerSecret
    logicalId: string
  } {
    const {
      slug,
      environment,
      secretName,
      description,
      secretString,
      kmsKeyId,
      tags,
    } = options

    const resourceName = secretName || generateResourceName({
      slug,
      environment,
      resourceType: 'secret',
    })

    const logicalId = generateLogicalId(resourceName)

    const secret: SecretsManagerSecret = {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Name: resourceName,
        Description: description,
        SecretString: secretString,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          ...(tags ? Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) : []),
        ],
      },
    }

    if (kmsKeyId) {
      secret.Properties.KmsKeyId = kmsKeyId
    }

    return { secret, logicalId }
  }

  /**
   * Create a secret with auto-generated value
   */
  static createGeneratedSecret(options: GeneratedSecretOptions): {
    secret: SecretsManagerSecret
    logicalId: string
  } {
    const {
      slug,
      environment,
      secretName,
      description,
      excludeCharacters,
      excludeLowercase,
      excludeNumbers,
      excludePunctuation,
      excludeUppercase,
      passwordLength,
      requireEachIncludedType,
      kmsKeyId,
      tags,
    } = options

    const resourceName = secretName || generateResourceName({
      slug,
      environment,
      resourceType: 'secret',
    })

    const logicalId = generateLogicalId(resourceName)

    const secret: SecretsManagerSecret = {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Name: resourceName,
        Description: description,
        GenerateSecretString: {
          ExcludeCharacters: excludeCharacters,
          ExcludeLowercase: excludeLowercase,
          ExcludeNumbers: excludeNumbers,
          ExcludePunctuation: excludePunctuation,
          ExcludeUppercase: excludeUppercase,
          PasswordLength: passwordLength || 32,
          RequireEachIncludedType: requireEachIncludedType !== false,
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          ...(tags ? Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) : []),
        ],
      },
    }

    if (kmsKeyId) {
      secret.Properties.KmsKeyId = kmsKeyId
    }

    return { secret, logicalId }
  }

  /**
   * Create a database secret with username and password
   */
  static createDatabaseSecret(options: {
    slug: string
    environment: string
    secretName?: string
    username: string
    dbname?: string
    engine?: string
    host?: string
    port?: number
    kmsKeyId?: string
  }): {
    secret: SecretsManagerSecret
    logicalId: string
  } {
    const {
      slug,
      environment,
      secretName,
      username,
      dbname,
      engine,
      host,
      port,
      kmsKeyId,
    } = options

    const resourceName = secretName || generateResourceName({
      slug,
      environment,
      resourceType: 'db-secret',
    })

    const logicalId = generateLogicalId(resourceName)

    const secretTemplate: Record<string, any> = {
      username,
    }

    if (dbname)
      secretTemplate.dbname = dbname
    if (engine)
      secretTemplate.engine = engine
    if (host)
      secretTemplate.host = host
    if (port)
      secretTemplate.port = port

    const secret: SecretsManagerSecret = {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Name: resourceName,
        Description: `Database credentials for ${username}`,
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify(secretTemplate),
          GenerateStringKey: 'password',
          PasswordLength: 32,
          ExcludeCharacters: '"@/\\',
          RequireEachIncludedType: true,
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Type', Value: 'database' },
        ],
      },
    }

    if (kmsKeyId) {
      secret.Properties.KmsKeyId = kmsKeyId
    }

    return { secret, logicalId }
  }

  /**
   * Attach secret to RDS database for automatic rotation
   */
  static attachToDatabase(options: SecretTargetAttachmentOptions): {
    attachment: SecretsManagerSecretTargetAttachment
    logicalId: string
  } {
    const {
      slug,
      environment,
      secretId,
      targetId,
      targetType,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'secret-attachment',
    })

    const logicalId = generateLogicalId(resourceName)

    const attachment: SecretsManagerSecretTargetAttachment = {
      Type: 'AWS::SecretsManager::SecretTargetAttachment',
      Properties: {
        SecretId: secretId,
        TargetId: targetId,
        TargetType: targetType,
      },
    }

    return { attachment, logicalId }
  }

  /**
   * Enable automatic rotation for a secret
   */
  static enableRotation(options: SecretRotationOptions): {
    rotation: SecretsManagerRotationSchedule
    logicalId: string
  } {
    const {
      slug,
      environment,
      secretId,
      rotationLambdaArn,
      automaticallyAfterDays,
      rotationType,
      kmsKeyArn,
      vpcSecurityGroupIds,
      vpcSubnetIds,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'secret-rotation',
    })

    const logicalId = generateLogicalId(resourceName)

    const rotation: SecretsManagerRotationSchedule = {
      Type: 'AWS::SecretsManager::RotationSchedule',
      Properties: {
        SecretId: secretId,
        RotationRules: {
          AutomaticallyAfterDays: automaticallyAfterDays || 30,
        },
      },
    }

    if (rotationLambdaArn) {
      rotation.Properties.RotationLambdaARN = rotationLambdaArn
    }
    else if (rotationType) {
      // Use hosted rotation Lambda
      rotation.Properties.HostedRotationLambda = {
        RotationType: rotationType,
        KmsKeyArn: kmsKeyArn,
        VpcSecurityGroupIds: vpcSecurityGroupIds,
        VpcSubnetIds: vpcSubnetIds,
      }
    }

    return { rotation, logicalId }
  }

  /**
   * Common secret types
   */
  static readonly SecretTypes = {
    /**
     * API key secret (32 chars, alphanumeric only)
     */
    apiKey: (slug: string, environment: string, serviceName: string) => {
      return Secrets.createGeneratedSecret({
        slug,
        environment,
        secretName: `${slug}-${environment}-${serviceName}-api-key`,
        description: `API key for ${serviceName}`,
        passwordLength: 32,
        excludePunctuation: true,
        excludeLowercase: false,
        excludeUppercase: false,
        excludeNumbers: false,
      })
    },

    /**
     * OAuth client secret (strong password)
     */
    oauthClientSecret: (slug: string, environment: string, clientName: string) => {
      return Secrets.createGeneratedSecret({
        slug,
        environment,
        secretName: `${slug}-${environment}-${clientName}-oauth-secret`,
        description: `OAuth client secret for ${clientName}`,
        passwordLength: 64,
        excludeCharacters: '"\'`\\/@',
        requireEachIncludedType: true,
      })
    },

    /**
     * JWT signing secret
     */
    jwtSecret: (slug: string, environment: string) => {
      return Secrets.createGeneratedSecret({
        slug,
        environment,
        secretName: `${slug}-${environment}-jwt-secret`,
        description: 'JWT signing secret',
        passwordLength: 64,
        excludePunctuation: true,
      })
    },

    /**
     * Encryption key (base64-compatible)
     */
    encryptionKey: (slug: string, environment: string) => {
      return Secrets.createGeneratedSecret({
        slug,
        environment,
        secretName: `${slug}-${environment}-encryption-key`,
        description: 'Data encryption key',
        passwordLength: 64,
        excludeCharacters: '+/=',
        excludePunctuation: true,
      })
    },
  }

  /**
   * Common rotation types for hosted rotation
   */
  static readonly RotationTypes = {
    MySQLSingleUser: 'MySQLSingleUser',
    MySQLMultiUser: 'MySQLMultiUser',
    PostgreSQLSingleUser: 'PostgreSQLSingleUser',
    PostgreSQLMultiUser: 'PostgreSQLMultiUser',
    OracleSingleUser: 'OracleSingleUser',
    OracleMultiUser: 'OracleMultiUser',
    MariaDBSingleUser: 'MariaDBSingleUser',
    MariaDBMultiUser: 'MariaDBMultiUser',
    SQLServerSingleUser: 'SQLServerSingleUser',
    SQLServerMultiUser: 'SQLServerMultiUser',
    RedshiftSingleUser: 'RedshiftSingleUser',
    RedshiftMultiUser: 'RedshiftMultiUser',
    MongoDBSingleUser: 'MongoDBSingleUser',
    MongoDBMultiUser: 'MongoDBMultiUser',
  }
}
