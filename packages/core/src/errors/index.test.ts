/**
 * Error Handling Tests
*/

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import {
  CloudError,
  ConfigurationError,
  CredentialError,
  DeploymentError,
  ValidationError,
  AWSAPIError,
  ErrorCodes,
  getErrorDetails,
  createError,
  DebugLogger,
  validateConfiguration,
  detectMisconfigurations,
} from './index'

describe('CloudError', () => {
  it('should create a CloudError with message, code, and solution', () => {
    const error = new CloudError(
      'Test error message',
      'TEST_ERROR',
      'This is the solution',
      { detail1: 'value1' },
    )

    expect(error.message).toBe('Test error message')
    expect(error.code).toBe('TEST_ERROR')
    expect(error.solution).toBe('This is the solution')
    expect(error.details).toEqual({ detail1: 'value1' })
    expect(error.name).toBe('CloudError')
  })

  it('should format toString() with solution and details', () => {
    const error = new CloudError(
      'Test error',
      'TEST_ERROR',
      'Fix it like this',
      { key: 'value' },
    )

    const str = error.toString()
    expect(str).toContain('CloudError [TEST_ERROR]: Test error')
    expect(str).toContain('💡 Solution: Fix it like this')
    expect(str).toContain('Details:')
    expect(str).toContain('key: "value"')
  })

  it('should work without solution and details', () => {
    const error = new CloudError('Simple error', 'SIMPLE_ERROR')

    const str = error.toString()
    expect(str).toBe('CloudError [SIMPLE_ERROR]: Simple error')
  })
})

describe('Specialized Error Classes', () => {
  it('should create ConfigurationError', () => {
    const error = new ConfigurationError('Config is wrong', 'Fix your config')

    expect(error.name).toBe('ConfigurationError')
    expect(error.code).toBe('CONFIG_ERROR')
    expect(error.message).toBe('Config is wrong')
    expect(error.solution).toBe('Fix your config')
  })

  it('should create CredentialError', () => {
    const error = new CredentialError('Bad credentials', 'Update your keys')

    expect(error.name).toBe('CredentialError')
    expect(error.code).toBe('CREDENTIAL_ERROR')
    expect(error.message).toBe('Bad credentials')
  })

  it('should create DeploymentError', () => {
    const error = new DeploymentError('Deploy failed', 'Check CloudFormation')

    expect(error.name).toBe('DeploymentError')
    expect(error.code).toBe('DEPLOYMENT_ERROR')
  })

  it('should create ValidationError', () => {
    const error = new ValidationError('Invalid input', 'Check your data')

    expect(error.name).toBe('ValidationError')
    expect(error.code).toBe('VALIDATION_ERROR')
  })

  it('should create AWSAPIError with status code', () => {
    const error = new AWSAPIError('API failed', 403, 'Check permissions')

    expect(error.name).toBe('AWSAPIError')
    expect(error.code).toBe('AWS_API_ERROR')
    expect(error.statusCode).toBe(403)
  })
})

describe('ErrorCodes', () => {
  it('should have predefined error codes', () => {
    expect(ErrorCodes.NO_CREDENTIALS).toBeDefined()
    expect(ErrorCodes.INVALID_CREDENTIALS).toBeDefined()
    expect(ErrorCodes.MISSING_CONFIG).toBeDefined()
    expect(ErrorCodes.INVALID_REGION).toBeDefined()
  })

  it('should provide message and solution for each error code', () => {
    const error = ErrorCodes.NO_CREDENTIALS

    expect(error.message).toBe('AWS credentials not found')
    expect(error.solution).toContain('Configure AWS credentials')
    expect(error.solution).toContain('AWS_ACCESS_KEY_ID')
  })
})

describe('getErrorDetails', () => {
  it('should return error details by code', () => {
    const details = getErrorDetails('INVALID_CREDENTIALS')

    expect(details.message).toBe('AWS credentials are invalid')
    expect(details.solution).toContain('AWS_ACCESS_KEY_ID')
  })
})

describe('createError', () => {
  it('should create error from error code', () => {
    const error = createError('MISSING_CONFIG', { path: '/path/to/config' })

    expect(error.message).toBe('Configuration file not found')
    expect(error.code).toBe('MISSING_CONFIG')
    expect(error.solution).toContain('cloud.config.ts')
    expect(error.details).toEqual({ path: '/path/to/config' })
  })

  it('should work without additional details', () => {
    const error = createError('INVALID_REGION')

    expect(error.message).toBe('AWS region is invalid')
    expect(error.code).toBe('INVALID_REGION')
    expect(error.details).toBeUndefined()
  })
})

describe('DebugLogger', () => {
  let consoleLog: typeof console.log
  let consoleWarn: typeof console.warn
  let consoleError: typeof console.error
  let logs: string[] = []

  beforeEach(() => {
    logs = []
    consoleLog = console.log
    consoleWarn = console.warn
    consoleError = console.error

    console.log = (...args: any[]) => logs.push(args.join(' '))
    console.warn = (...args: any[]) => logs.push(args.join(' '))
    console.error = (...args: any[]) => logs.push(args.join(' '))

    DebugLogger.setVerbose(false)
    DebugLogger.setDebug(false)
  })

  afterEach(() => {
    console.log = consoleLog
    console.warn = consoleWarn
    console.error = consoleError
  })

  it('should log verbose messages when verbose mode is enabled', () => {
    DebugLogger.setVerbose(true)
    DebugLogger.verbose('Verbose message')

    expect(logs).toContain('[VERBOSE] Verbose message')
  })

  it('should not log verbose messages when verbose mode is disabled', () => {
    DebugLogger.setVerbose(false)
    DebugLogger.verbose('Verbose message')

    expect(logs).not.toContain('[VERBOSE] Verbose message')
  })

  it('should log debug messages when debug mode is enabled', () => {
    DebugLogger.setDebug(true)
    DebugLogger.debug('Debug message')

    expect(logs).toContain('[DEBUG] Debug message')
  })

  it('should not log debug messages when debug mode is disabled', () => {
    DebugLogger.setDebug(false)
    DebugLogger.debug('Debug message')

    expect(logs).not.toContain('[DEBUG] Debug message')
  })

  it('should always log info messages', () => {
    DebugLogger.info('Info message')

    expect(logs.some(log => log.includes('Info message'))).toBe(true)
  })

  it('should always log warning messages', () => {
    DebugLogger.warn('Warning message')

    expect(logs.some(log => log.includes('Warning message'))).toBe(true)
  })

  it('should always log error messages', () => {
    DebugLogger.error('Error message')

    expect(logs.some(log => log.includes('Error message'))).toBe(true)
  })

  it('should log CloudError with formatted output', () => {
    const error = new CloudError('Test error', 'TEST', 'Test solution')
    DebugLogger.error('Something failed', error)

    expect(logs.some(log => log.includes('Something failed'))).toBe(true)
    expect(logs.some(log => log.includes('Test error'))).toBe(true)
  })

  it('should log stack trace in debug mode', () => {
    DebugLogger.setDebug(true)
    const error = new Error('Test error')
    DebugLogger.error('Failed', error)

    expect(logs.some(log => log.includes('Stack trace'))).toBe(true)
  })

  it('should log success messages', () => {
    DebugLogger.success('Success message')

    expect(logs.some(log => log.includes('Success message'))).toBe(true)
  })
})

describe('validateConfiguration', () => {
  it('should throw error if config is null', () => {
    expect(() => validateConfiguration(null)).toThrow()
  })

  it('should throw error if config is undefined', () => {
    expect(() => validateConfiguration(undefined)).toThrow()
  })

  it('should throw error if project is missing', () => {
    expect(() => validateConfiguration({})).toThrow(ConfigurationError)
    expect(() => validateConfiguration({})).toThrow('Missing required field: project')
  })

  it('should throw error if project.name is missing', () => {
    expect(() => validateConfiguration({ project: {} })).toThrow(ConfigurationError)
    expect(() => validateConfiguration({ project: {} })).toThrow('project.name')
  })

  it('should throw error if project.slug is missing', () => {
    expect(() => validateConfiguration({ project: { name: 'Test' } })).toThrow(ConfigurationError)
    expect(() => validateConfiguration({ project: { name: 'Test' } })).toThrow('project.slug')
  })

  it('should throw error if slug format is invalid', () => {
    expect(() =>
      validateConfiguration({
        project: { name: 'Test', slug: 'Invalid_Slug' },
      }),
    ).toThrow(ValidationError)
  })

  it('should accept valid slug format', () => {
    expect(() =>
      validateConfiguration({
        project: { name: 'Test', slug: 'valid-slug-123' },
      }),
    ).not.toThrow()
  })

  it('should throw error for invalid region', () => {
    expect(() =>
      validateConfiguration({
        project: { name: 'Test', slug: 'test', region: 'invalid-region' },
      }),
    ).toThrow('AWS region is invalid')
  })

  it('should accept valid regions', () => {
    const validRegions = [
      'us-east-1',
      'us-west-2',
      'eu-west-1',
      'eu-central-1',
      'ap-southeast-1',
    ]

    for (const region of validRegions) {
      expect(() =>
        validateConfiguration({
          project: { name: 'Test', slug: 'test', region },
        }),
      ).not.toThrow()
    }
  })

  it('should accept config without region', () => {
    expect(() =>
      validateConfiguration({
        project: { name: 'Test', slug: 'test' },
      }),
    ).not.toThrow()
  })
})

describe('detectMisconfigurations', () => {
  it('should return empty array for minimal config', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
    })

    expect(Array.isArray(warnings)).toBe(true)
  })

  it('should warn about production database without Multi-AZ', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
      environments: {
        production: {},
      },
      infrastructure: {
        database: {
          postgres: {
            instanceClass: 'db.t3.micro',
          },
        },
      },
    })

    expect(warnings).toContain('Production database should use Multi-AZ for high availability')
  })

  it('should not warn if Multi-AZ is enabled', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
      environments: {
        production: {},
      },
      infrastructure: {
        database: {
          postgres: {
            instanceClass: 'db.t3.micro',
            multiAZ: true,
          },
        },
      },
    })

    expect(warnings).not.toContain(
      'Production database should use Multi-AZ for high availability',
    )
  })

  it('should warn about unencrypted storage', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        storage: {
          uploads: {
            encryption: false,
          },
        },
      },
    })

    expect(warnings.some(w => w.includes('not encrypted'))).toBe(true)
  })

  it('should warn about public S3 buckets', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        storage: {
          assets: {
            public: true,
          },
        },
      },
    })

    expect(warnings.some(w => w.includes('publicly accessible'))).toBe(true)
  })

  it('should warn about low backup retention', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        database: {
          postgres: {
            backupRetentionDays: 3,
          },
        },
      },
    })

    expect(warnings.some(w => w.includes('backup retention'))).toBe(true)
  })

  it('should warn about missing monitoring', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        compute: {
          server: {},
        },
      },
    })

    expect(warnings.some(w => w.includes('No monitoring configured'))).toBe(true)
  })

  it('should not warn if monitoring is configured', () => {
    const warnings = detectMisconfigurations({
      project: { name: 'Test', slug: 'test' },
      infrastructure: {
        monitoring: {
          alarms: [],
        },
      },
    })

    expect(warnings).not.toContain('No monitoring configured')
  })
})
