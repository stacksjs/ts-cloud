import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CloudConfig, EnvironmentType } from '@ts-cloud/types'

/**
 * Default configuration values
 */
export const defaultConfig: Partial<CloudConfig> = {
  project: {
    name: 'my-project',
    slug: 'my-project',
    region: 'us-east-1',
  },
  mode: 'serverless',
  environments: {
    production: {
      type: 'production',
    },
  },
}

/**
 * Configuration file search paths (in order of preference)
 */
const CONFIG_FILES = [
  'cloud.config.ts',
  'cloud.config.js',
  'cloud.config.mjs',
  '.cloudrc.ts',
  '.cloudrc.js',
]

/**
 * Find cloud configuration file in the current directory
 */
export function findConfigFile(cwd: string = process.cwd()): string | null {
  for (const configFile of CONFIG_FILES) {
    const configPath = join(cwd, configFile)
    if (existsSync(configPath)) {
      return configPath
    }
  }
  return null
}

/**
 * Validate cloud configuration
 */
export function validateConfig(config: Partial<CloudConfig>): CloudConfig {
  // Validate project config
  if (!config.project) {
    throw new Error('Missing required field: project')
  }

  if (!config.project.name) {
    throw new Error('Missing required field: project.name')
  }

  if (!config.project.slug) {
    throw new Error('Missing required field: project.slug')
  }

  if (!config.project.region) {
    throw new Error('Missing required field: project.region')
  }

  // Validate mode
  if (!config.mode) {
    throw new Error('Missing required field: mode')
  }

  if (!['server', 'serverless', 'hybrid'].includes(config.mode)) {
    throw new Error(`Invalid mode: ${config.mode}. Must be 'server', 'serverless', or 'hybrid'`)
  }

  // Validate environments
  if (!config.environments || Object.keys(config.environments).length === 0) {
    throw new Error('At least one environment must be defined')
  }

  // Validate each environment
  for (const [envName, envConfig] of Object.entries(config.environments)) {
    if (!envConfig.type) {
      throw new Error(`Missing type for environment: ${envName}`)
    }

    const validTypes: EnvironmentType[] = ['production', 'staging', 'development']
    if (!validTypes.includes(envConfig.type)) {
      throw new Error(`Invalid type for environment ${envName}: ${envConfig.type}`)
    }
  }

  return config as CloudConfig
}

/**
 * Merge user config with defaults
 */
export function mergeConfig(userConfig: Partial<CloudConfig>): CloudConfig {
  const merged: CloudConfig = {
    ...defaultConfig,
    ...userConfig,
    project: {
      ...defaultConfig.project,
      ...userConfig.project,
    } as CloudConfig['project'],
    environments: {
      ...defaultConfig.environments,
      ...userConfig.environments,
    },
  }

  // Deep merge infrastructure if provided
  if (userConfig.infrastructure) {
    merged.infrastructure = {
      ...defaultConfig.infrastructure,
      ...userConfig.infrastructure,
    }
  }

  // Deep merge sites if provided
  if (userConfig.sites) {
    merged.sites = {
      ...defaultConfig.sites,
      ...userConfig.sites,
    }
  }

  return merged
}

/**
 * Load cloud configuration from file
 */
export async function loadCloudConfig(cwd: string = process.cwd()): Promise<CloudConfig> {
  const configPath = findConfigFile(cwd)

  if (!configPath) {
    console.warn('⚠️  No cloud.config.ts found, using default configuration')
    console.warn('   Run `cloud init` to create a configuration file')
    return validateConfig(defaultConfig)
  }

  try {
    // Use Bun's native import for TypeScript files
    const configModule = await import(configPath)
    const userConfig = configModule.default || configModule

    // Merge with defaults
    const config = mergeConfig(userConfig)

    // Validate
    return validateConfig(config)
  }
  catch (error) {
    if (error instanceof Error && error.message.includes('Missing required field')) {
      throw error
    }

    console.error(`Failed to load config from ${configPath}:`, error)
    throw new Error(`Invalid configuration file: ${configPath}`)
  }
}

/**
 * Get configuration for a specific environment
 */
export function getEnvironmentConfig(
  config: CloudConfig,
  environment: string,
): CloudConfig['environments'][string] {
  const envConfig = config.environments[environment]

  if (!envConfig) {
    throw new Error(`Environment '${environment}' not found in configuration`)
  }

  return envConfig
}

/**
 * Get the active environment (from env var or default to 'production')
 */
export function getActiveEnvironment(): string {
  return process.env.CLOUD_ENV || process.env.NODE_ENV || 'production'
}

/**
 * Load config and get current environment
 */
export async function loadConfigWithEnvironment(cwd?: string): Promise<{
  config: CloudConfig
  environment: string
  environmentConfig: CloudConfig['environments'][string]
}> {
  const config = await loadCloudConfig(cwd)
  const environment = getActiveEnvironment()
  const environmentConfig = getEnvironmentConfig(config, environment)

  return {
    config,
    environment,
    environmentConfig,
  }
}

/**
 * Resolve region for a specific environment
 */
export function resolveRegion(
  config: CloudConfig,
  environment: string,
): string {
  const envConfig = getEnvironmentConfig(config, environment)
  return envConfig.region || config.project.region
}
