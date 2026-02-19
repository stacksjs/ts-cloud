import type { EnvironmentType } from 'ts-cloud-types'

export interface NamingOptions {
  slug: string
  environment: EnvironmentType
  timestamp?: string
  resourceType: string
  suffix?: string
}

/**
 * Generate a consistent resource name following the naming convention:
 * {slug}-{environment}-{resourceType}-{timestamp}
 */
export function generateResourceName(options: NamingOptions): string {
  const { slug, environment, resourceType, timestamp, suffix } = options

  const parts = [
    slug,
    environment,
    resourceType,
  ]

  if (timestamp) {
    parts.push(timestamp)
  }

  if (suffix) {
    parts.push(suffix)
  }

  return parts.join('-')
}

/**
 * Generate a logical ID for CloudFormation resources
 * Converts to PascalCase and removes hyphens
 */
export function generateLogicalId(name: string): string {
  return name
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Get current timestamp for resource naming
 */
export function getTimestamp(): string {
  return Date.now().toString()
}

/**
 * Sanitize a name to be CloudFormation-compatible
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
}
