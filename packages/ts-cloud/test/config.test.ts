import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  findConfigFile,
  getActiveEnvironment,
  getEnvironmentConfig,
  loadCloudConfig,
  mergeConfig,
  resolveRegion,
  validateConfig,
} from '../src/config'
import type { CloudConfig } from '@ts-cloud/types'

describe('Config System', () => {
  describe('validateConfig', () => {
    it('should validate a valid config', () => {
      const config: Partial<CloudConfig> = {
        project: {
          name: 'test-project',
          slug: 'test-project',
          region: 'us-east-1',
        },
        mode: 'serverless',
        environments: {
          production: {
            type: 'production',
          },
        },
      }

      const validated = validateConfig(config)
      expect(validated.project.name).toBe('test-project')
      expect(validated.mode).toBe('serverless')
    })

    it('should throw error for missing project', () => {
      const config: Partial<CloudConfig> = {
        mode: 'serverless',
        environments: {
          production: { type: 'production' },
        },
      } as any

      expect(() => validateConfig(config)).toThrow('Missing required field: project')
    })

    it('should throw error for missing project.name', () => {
      const config: Partial<CloudConfig> = {
        project: {
          slug: 'test',
          region: 'us-east-1',
        } as any,
        mode: 'serverless',
        environments: {
          production: { type: 'production' },
        },
      }

      expect(() => validateConfig(config)).toThrow('Missing required field: project.name')
    })

    it('should throw error for missing project.slug', () => {
      const config: Partial<CloudConfig> = {
        project: {
          name: 'test',
          region: 'us-east-1',
        } as any,
        mode: 'serverless',
        environments: {
          production: { type: 'production' },
        },
      }

      expect(() => validateConfig(config)).toThrow('Missing required field: project.slug')
    })

    it('should throw error for missing project.region', () => {
      const config: Partial<CloudConfig> = {
        project: {
          name: 'test',
          slug: 'test',
        } as any,
        mode: 'serverless',
        environments: {
          production: { type: 'production' },
        },
      }

      expect(() => validateConfig(config)).toThrow('Missing required field: project.region')
    })

    it('should throw error for invalid mode', () => {
      const config: Partial<CloudConfig> = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'invalid' as any,
        environments: {
          production: { type: 'production' },
        },
      }

      expect(() => validateConfig(config)).toThrow('Invalid mode: invalid')
    })

    it('should throw error for missing environments', () => {
      const config: Partial<CloudConfig> = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'serverless',
      } as any

      expect(() => validateConfig(config)).toThrow('At least one environment must be defined')
    })

    it('should throw error for environment missing type', () => {
      const config: Partial<CloudConfig> = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'serverless',
        environments: {
          production: {} as any,
        },
      }

      expect(() => validateConfig(config)).toThrow('Missing type for environment: production')
    })

    it('should throw error for invalid environment type', () => {
      const config: Partial<CloudConfig> = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'serverless',
        environments: {
          production: { type: 'invalid' as any },
        },
      }

      expect(() => validateConfig(config)).toThrow('Invalid type for environment production: invalid')
    })
  })

  describe('mergeConfig', () => {
    it('should merge user config with defaults', () => {
      const userConfig: Partial<CloudConfig> = {
        project: {
          name: 'my-app',
          slug: 'my-app',
          region: 'eu-west-1',
        },
        mode: 'server',
        environments: {
          production: {
            type: 'production',
          },
        },
      }

      const merged = mergeConfig(userConfig)
      expect(merged.project.name).toBe('my-app')
      expect(merged.project.region).toBe('eu-west-1')
      expect(merged.mode).toBe('server')
    })

    it('should preserve infrastructure config', () => {
      const userConfig: Partial<CloudConfig> = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'serverless',
        environments: {
          production: { type: 'production' },
        },
        infrastructure: {
          vpc: {
            cidr: '10.0.0.0/16',
            zones: 3,
          },
        },
      }

      const merged = mergeConfig(userConfig)
      expect(merged.infrastructure?.vpc?.cidr).toBe('10.0.0.0/16')
      expect(merged.infrastructure?.vpc?.zones).toBe(3)
    })

    it('should preserve sites config', () => {
      const userConfig: Partial<CloudConfig> = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'serverless',
        environments: {
          production: { type: 'production' },
        },
        sites: {
          main: {
            root: '/var/www',
            path: '/',
            domain: 'example.com',
          },
        },
      }

      const merged = mergeConfig(userConfig)
      expect(merged.sites?.main.domain).toBe('example.com')
    })
  })

  describe('getEnvironmentConfig', () => {
    const config: CloudConfig = {
      project: {
        name: 'test',
        slug: 'test',
        region: 'us-east-1',
      },
      mode: 'serverless',
      environments: {
        production: {
          type: 'production',
          region: 'us-east-1',
        },
        staging: {
          type: 'staging',
          region: 'eu-west-1',
        },
      },
    }

    it('should get environment config', () => {
      const envConfig = getEnvironmentConfig(config, 'production')
      expect(envConfig.type).toBe('production')
      expect(envConfig.region).toBe('us-east-1')
    })

    it('should throw error for non-existent environment', () => {
      expect(() => getEnvironmentConfig(config, 'nonexistent'))
        .toThrow('Environment \'nonexistent\' not found in configuration')
    })
  })

  describe('resolveRegion', () => {
    it('should use environment-specific region', () => {
      const config: CloudConfig = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'serverless',
        environments: {
          production: {
            type: 'production',
            region: 'eu-west-1',
          },
        },
      }

      const region = resolveRegion(config, 'production')
      expect(region).toBe('eu-west-1')
    })

    it('should fallback to project region', () => {
      const config: CloudConfig = {
        project: {
          name: 'test',
          slug: 'test',
          region: 'us-east-1',
        },
        mode: 'serverless',
        environments: {
          production: {
            type: 'production',
          },
        },
      }

      const region = resolveRegion(config, 'production')
      expect(region).toBe('us-east-1')
    })
  })

  describe('getActiveEnvironment', () => {
    it('should return CLOUD_ENV when set', () => {
      const originalCloudEnv = process.env.CLOUD_ENV
      process.env.CLOUD_ENV = 'staging'

      const env = getActiveEnvironment()
      expect(env).toBe('staging')

      // Restore
      if (originalCloudEnv) {
        process.env.CLOUD_ENV = originalCloudEnv
      }
      else {
        delete process.env.CLOUD_ENV
      }
    })

    it('should fallback to NODE_ENV', () => {
      const originalCloudEnv = process.env.CLOUD_ENV
      const originalNodeEnv = process.env.NODE_ENV

      delete process.env.CLOUD_ENV
      process.env.NODE_ENV = 'development'

      const env = getActiveEnvironment()
      expect(env).toBe('development')

      // Restore
      if (originalCloudEnv) {
        process.env.CLOUD_ENV = originalCloudEnv
      }
      if (originalNodeEnv) {
        process.env.NODE_ENV = originalNodeEnv
      }
    })

    it('should default to production', () => {
      const originalCloudEnv = process.env.CLOUD_ENV
      const originalNodeEnv = process.env.NODE_ENV

      delete process.env.CLOUD_ENV
      delete process.env.NODE_ENV

      const env = getActiveEnvironment()
      expect(env).toBe('production')

      // Restore
      if (originalCloudEnv) {
        process.env.CLOUD_ENV = originalCloudEnv
      }
      if (originalNodeEnv) {
        process.env.NODE_ENV = originalNodeEnv
      }
    })
  })

  describe('findConfigFile', () => {
    it('should find cloud.config.ts in root', () => {
      const rootDir = join(__dirname, '../../..')
      const configPath = findConfigFile(rootDir)

      expect(configPath).toBeTruthy()
      expect(configPath).toContain('cloud.config.ts')
    })

    it('should return null when no config file found', () => {
      const nonExistentDir = '/tmp/nonexistent-dir-for-testing'
      const configPath = findConfigFile(nonExistentDir)

      expect(configPath).toBeNull()
    })
  })

  describe('loadCloudConfig', () => {
    it('should load config from root directory', async () => {
      const rootDir = join(__dirname, '../../..')
      const config = await loadCloudConfig(rootDir)

      expect(config.project).toBeDefined()
      expect(config.project.name).toBe('TS Cloud')
      expect(config.project.slug).toBe('ts-cloud')
      expect(config.mode).toBe('serverless')
    })

    it('should validate loaded config', async () => {
      const rootDir = join(__dirname, '../../..')
      const config = await loadCloudConfig(rootDir)

      // Should not throw
      expect(() => validateConfig(config)).not.toThrow()
    })
  })
})
