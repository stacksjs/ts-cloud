/**
 * Local development configuration
 * Configures TS Cloud to use LocalStack and local services
 */

export interface LocalConfig {
  enabled: boolean
  localstackEndpoint: string
  postgresUrl: string
  redisUrl: string
  dynamodbEndpoint: string
  s3Endpoint: string
  emailEndpoint: string
  awsRegion: string
  awsAccessKeyId: string
  awsSecretAccessKey: string
}

/**
 * Default local development configuration
 */
export const defaultLocalConfig: LocalConfig = {
  enabled: process.env.TS_CLOUD_LOCAL === 'true' || process.env.NODE_ENV === 'development',
  localstackEndpoint: process.env.LOCALSTACK_ENDPOINT || 'http://localhost:4566',
  postgresUrl: process.env.POSTGRES_URL || 'postgresql://tscloud:tscloud@localhost:5432/tscloud',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  dynamodbEndpoint: process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000',
  s3Endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
  emailEndpoint: process.env.EMAIL_ENDPOINT || 'smtp://localhost:1025',
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
}

/**
 * Get local configuration
 */
export function getLocalConfig(): LocalConfig {
  return defaultLocalConfig
}

/**
 * Check if running in local development mode
 */
export function isLocalDevelopment(): boolean {
  return defaultLocalConfig.enabled
}

/**
 * Get AWS endpoint for service in local mode
 */
export function getLocalEndpoint(service: string): string {
  const config = getLocalConfig()

  if (!config.enabled) {
    return ''
  }

  switch (service.toLowerCase()) {
    case 'dynamodb':
      return config.dynamodbEndpoint
    case 's3':
      return config.s3Endpoint
    case 'localstack':
    case 'cloudformation':
    case 'lambda':
    case 'apigateway':
    case 'sns':
    case 'sqs':
    case 'cloudwatch':
    case 'iam':
    case 'sts':
      return config.localstackEndpoint
    default:
      return config.localstackEndpoint
  }
}

/**
 * Get local credentials
 */
export function getLocalCredentials(): {
  accessKeyId: string
  secretAccessKey: string
  region: string
} {
  const config = getLocalConfig()

  return {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey,
    region: config.awsRegion,
  }
}

/**
 * Create local environment variables for AWS CLI
 */
export function getLocalEnvVars(): Record<string, string> {
  const config = getLocalConfig()

  if (!config.enabled) {
    return {}
  }

  return {
    AWS_ACCESS_KEY_ID: config.awsAccessKeyId,
    AWS_SECRET_ACCESS_KEY: config.awsSecretAccessKey,
    AWS_REGION: config.awsRegion,
    AWS_ENDPOINT_URL: config.localstackEndpoint,
    LOCALSTACK_ENDPOINT: config.localstackEndpoint,
    TS_CLOUD_LOCAL: 'true',
  }
}
