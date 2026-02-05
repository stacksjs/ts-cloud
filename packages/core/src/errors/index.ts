/**
 * Error Handling & Debugging
 * Clear error messages with solutions and debugging support
 */

export class CloudError extends Error {
  constructor(
    message: string,
    public code: string,
    public solution?: string | undefined,
    public details?: Record<string, any> | undefined,
  ) {
    super(message)
    this.name = 'CloudError'
    Error.captureStackTrace?.(this, CloudError)
  }

  toString(): string {
    let output = `${this.name} [${this.code}]: ${this.message}`

    if (this.solution) {
      output += `\n\n💡 Solution: ${this.solution}`
    }

    if (this.details && Object.keys(this.details).length > 0) {
      output += `\n\nDetails:`
      for (const [key, value] of Object.entries(this.details)) {
        output += `\n  ${key}: ${JSON.stringify(value)}`
      }
    }

    return output
  }
}

/**
 * Configuration errors
 */
export class ConfigurationError extends CloudError {
  constructor(message: string, solution?: string, details?: Record<string, any>) {
    super(message, 'CONFIG_ERROR', solution, details)
    this.name = 'ConfigurationError'
  }
}

/**
 * AWS credential errors
 */
export class CredentialError extends CloudError {
  constructor(message: string, solution?: string, details?: Record<string, any>) {
    super(message, 'CREDENTIAL_ERROR', solution, details)
    this.name = 'CredentialError'
  }
}

/**
 * Deployment errors
 */
export class DeploymentError extends CloudError {
  constructor(message: string, solution?: string, details?: Record<string, any>) {
    super(message, 'DEPLOYMENT_ERROR', solution, details)
    this.name = 'DeploymentError'
  }
}

/**
 * Validation errors
 */
export class ValidationError extends CloudError {
  constructor(message: string, solution?: string, details?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', solution, details)
    this.name = 'ValidationError'
  }
}

/**
 * AWS API errors
 */
export class AWSAPIError extends CloudError {
  constructor(
    message: string,
    public statusCode?: number,
    solution?: string,
    details?: Record<string, any>,
  ) {
    super(message, 'AWS_API_ERROR', solution, details)
    this.name = 'AWSAPIError'
  }
}

/**
 * Common error scenarios with solutions
 */
export const ErrorCodes = {
  // Credential errors
  NO_CREDENTIALS: {
    message: 'AWS credentials not found',
    solution: `Configure AWS credentials using one of these methods:
  1. Set environment variables: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
  2. Create ~/.aws/credentials file with your credentials
  3. Use an IAM role (for EC2 instances)
  4. Run 'aws configure' if you have AWS CLI installed`,
  },

  INVALID_CREDENTIALS: {
    message: 'AWS credentials are invalid',
    solution: 'Verify your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are correct. Run: aws sts get-caller-identity',
  },

  EXPIRED_CREDENTIALS: {
    message: 'AWS credentials have expired',
    solution: 'Refresh your AWS credentials. If using temporary credentials, generate new ones.',
  },

  // Configuration errors
  MISSING_CONFIG: {
    message: 'Configuration file not found',
    solution: 'Create a cloud.config.ts file in your project root. Use: cloud init',
  },

  INVALID_CONFIG: {
    message: 'Configuration is invalid',
    solution: 'Check your cloud.config.ts file for syntax errors. Use: cloud config:validate',
  },

  MISSING_REQUIRED_FIELD: {
    message: 'Required configuration field is missing',
    solution: 'Add the missing field to your cloud.config.ts file',
  },

  INVALID_REGION: {
    message: 'AWS region is invalid',
    solution: 'Use a valid AWS region like us-east-1, us-west-2, eu-west-1, etc.',
  },

  // Deployment errors
  STACK_ALREADY_EXISTS: {
    message: 'CloudFormation stack already exists',
    solution: 'Use: cloud deploy --update to update the existing stack, or cloud destroy to delete it first',
  },

  STACK_IN_PROGRESS: {
    message: 'Stack operation already in progress',
    solution: 'Wait for the current operation to complete, or cancel it in the AWS Console',
  },

  INSUFFICIENT_PERMISSIONS: {
    message: 'Insufficient IAM permissions',
    solution: 'Ensure your IAM user/role has the necessary permissions for CloudFormation and the resources you\'re deploying',
  },

  RESOURCE_LIMIT_EXCEEDED: {
    message: 'AWS service limit exceeded',
    solution: 'Request a service limit increase in the AWS Console, or clean up unused resources',
  },

  ROLLBACK_COMPLETE: {
    message: 'Stack creation failed and rolled back',
    solution: 'Check the CloudFormation events to see which resource failed. Fix the issue and try again.',
  },

  // Validation errors
  CIRCULAR_DEPENDENCY: {
    message: 'Circular dependency detected in resources',
    solution: 'Review your resource dependencies and remove the circular reference',
  },

  INVALID_RESOURCE_NAME: {
    message: 'Resource name contains invalid characters',
    solution: 'Use only alphanumeric characters and hyphens in resource names',
  },

  DUPLICATE_RESOURCE: {
    message: 'Duplicate resource name detected',
    solution: 'Ensure all resource names are unique in your configuration',
  },

  // Network errors
  VPC_CIDR_CONFLICT: {
    message: 'VPC CIDR block conflicts with existing VPC',
    solution: 'Use a different CIDR block that doesn\'t overlap with existing VPCs',
  },

  SUBNET_CIDR_INVALID: {
    message: 'Subnet CIDR block is invalid or outside VPC range',
    solution: 'Ensure subnet CIDR is within the VPC CIDR range and properly sized',
  },

  // Database errors
  DB_INSTANCE_LIMIT: {
    message: 'RDS instance limit reached',
    solution: 'Delete unused RDS instances or request a limit increase',
  },

  INVALID_DB_NAME: {
    message: 'Database name contains invalid characters',
    solution: 'Use only alphanumeric characters and underscores, starting with a letter',
  },

  // S3 errors
  BUCKET_ALREADY_EXISTS: {
    message: 'S3 bucket name already exists globally',
    solution: 'S3 bucket names must be globally unique. Try a different name with your organization prefix',
  },

  INVALID_BUCKET_NAME: {
    message: 'S3 bucket name is invalid',
    solution: 'Use lowercase letters, numbers, and hyphens. Must start/end with letter/number. 3-63 characters.',
  },

  // CloudFormation errors
  TEMPLATE_TOO_LARGE: {
    message: 'CloudFormation template exceeds size limit',
    solution: 'Split your infrastructure into multiple stacks or use nested stacks',
  },

  INVALID_TEMPLATE: {
    message: 'CloudFormation template is invalid',
    solution: 'Validate your template with: cloud config:validate',
  },

  PARAMETER_NOT_FOUND: {
    message: 'CloudFormation parameter not found',
    solution: 'Check that all referenced parameters are defined in your template',
  },
} as const

/**
 * Get error details by code
 */
export function getErrorDetails(code: keyof typeof ErrorCodes): { message: string; solution: string } {
  return ErrorCodes[code]
}

/**
 * Create error from code
 */
export function createError(
  code: keyof typeof ErrorCodes,
  additionalDetails?: Record<string, any>,
): CloudError {
  const errorDetails = getErrorDetails(code)
  return new CloudError(
    errorDetails.message,
    code,
    errorDetails.solution,
    additionalDetails,
  )
}

/**
 * Debug logger
 */
export class DebugLogger {
  private static verboseMode = false
  private static debugMode = false

  static setVerbose(enabled: boolean): void {
    this.verboseMode = enabled
  }

  static setDebug(enabled: boolean): void {
    this.debugMode = enabled
  }

  static verbose(message: string, ...args: any[]): void {
    if (this.verboseMode) {
      console.log(`[VERBOSE] ${message}`, ...args)
    }
  }

  static debug(message: string, ...args: any[]): void {
    if (this.debugMode) {
      console.log(`[DEBUG] ${message}`, ...args)
    }
  }

  static info(message: string, ...args: any[]): void {
    console.log(`ℹ ${message}`, ...args)
  }

  static warn(message: string, ...args: any[]): void {
    console.warn(`⚠ ${message}`, ...args)
  }

  static error(message: string, error?: Error): void {
    console.error(`✖ ${message}`)

    if (error) {
      if (error instanceof CloudError) {
        console.error(error.toString())
      }
      else {
        console.error(error.message)
      }

      if (this.debugMode && error.stack) {
        console.error('\nStack trace:')
        console.error(error.stack)
      }
    }
  }

  static success(message: string): void {
    console.log(`✔ ${message}`)
  }
}

/**
 * Validate configuration
 */
export function validateConfiguration(config: any): void {
  if (!config) {
    throw createError('MISSING_CONFIG')
  }

  if (!config.project) {
    throw new ConfigurationError(
      'Missing required field: project',
      'Add a project configuration with name, slug, and region',
      { field: 'project' },
    )
  }

  if (!config.project.name) {
    throw new ConfigurationError(
      'Missing required field: project.name',
      'Add a project name to your configuration',
      { field: 'project.name' },
    )
  }

  if (!config.project.slug) {
    throw new ConfigurationError(
      'Missing required field: project.slug',
      'Add a project slug (lowercase, alphanumeric with hyphens)',
      { field: 'project.slug' },
    )
  }

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(config.project.slug)) {
    throw new ValidationError(
      'Invalid project slug format',
      'Use only lowercase letters, numbers, and hyphens',
      { slug: config.project.slug },
    )
  }

  // Validate region
  if (config.project.region) {
    const validRegions = [
      'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
      'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
      'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
      'sa-east-1', 'ca-central-1',
    ]

    if (!validRegions.includes(config.project.region)) {
      throw createError('INVALID_REGION', { region: config.project.region })
    }
  }

  DebugLogger.success('Configuration validation passed')
}

/**
 * Detect common misconfigurations
 */
export function detectMisconfigurations(config: any): string[] {
  const warnings: string[] = []

  // Check for production without Multi-AZ
  if (config.environments?.production && config.infrastructure?.database) {
    const db = config.infrastructure.database
    if ((db.postgres || db.mysql) && !db.postgres?.multiAZ && !db.mysql?.multiAZ) {
      warnings.push('Production database should use Multi-AZ for high availability')
    }
  }

  // Check for unencrypted storage
  if (config.infrastructure?.storage) {
    for (const [name, storageConfig] of Object.entries(config.infrastructure.storage)) {
      if ((storageConfig as any).encryption === false) {
        warnings.push(`Storage "${name}" is not encrypted - consider enabling encryption for security`)
      }
    }
  }

  // Check for public S3 buckets
  if (config.infrastructure?.storage) {
    for (const [name, storageConfig] of Object.entries(config.infrastructure.storage)) {
      if ((storageConfig as any).public === true) {
        warnings.push(`Storage "${name}" is publicly accessible - ensure this is intentional`)
      }
    }
  }

  // Check for missing backups
  if (config.infrastructure?.database) {
    const db = config.infrastructure.database
    if (db.postgres || db.mysql) {
      const backupRetention = db.postgres?.backupRetentionDays || db.mysql?.backupRetentionDays
      if (!backupRetention || backupRetention < 7) {
        warnings.push('Database backup retention is less than 7 days - consider increasing for production')
      }
    }
  }

  // Check for missing monitoring
  if (!config.infrastructure?.monitoring) {
    warnings.push('No monitoring configured - consider adding CloudWatch alarms')
  }

  return warnings
}
