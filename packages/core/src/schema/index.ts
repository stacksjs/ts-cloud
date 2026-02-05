/**
 * JSON Schema export for IDE integration
*/

import schema from './cloud-config.schema.json'

export { schema as cloudConfigSchema }

/**
 * Validate configuration against JSON schema
*/
export function validateAgainstSchema(config: any): {
  valid: boolean
  errors: string[]
} {
  // Basic validation - in production this would use a proper JSON schema validator
  const errors: string[] = []

  // Check required fields
  if (!config.project) {
    errors.push('Missing required field: project')
  }
  else {
    if (!config.project.name) {
      errors.push('Missing required field: project.name')
    }
    if (!config.project.slug) {
      errors.push('Missing required field: project.slug')
    }
  }

  // Validate slug format
  if (config.project?.slug && !/^[a-z0-9-]+$/.test(config.project.slug)) {
    errors.push('Invalid project.slug: must contain only lowercase letters, numbers, and hyphens')
  }

  // Validate region if provided
  const validRegions = [
    'us-east-1',
    'us-east-2',
    'us-west-1',
    'us-west-2',
    'eu-west-1',
    'eu-west-2',
    'eu-west-3',
    'eu-central-1',
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'ap-northeast-2',
    'sa-east-1',
    'ca-central-1',
  ]

  if (config.project?.region && !validRegions.includes(config.project.region)) {
    errors.push(`Invalid region: ${config.project.region}. Must be one of: ${validRegions.join(', ')}`)
  }

  // Validate mode if provided
  if (config.mode && !['server', 'serverless', 'hybrid'].includes(config.mode)) {
    errors.push('Invalid mode: must be one of server, serverless, or hybrid')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
