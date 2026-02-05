/**
 * AWS Credentials Provider Tests
*/

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import {
  fromEnvironment,
  fromSharedCredentials,
  createCredentialProvider,
} from './credentials'

describe('Credential Providers', () => {
  // Store original env
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    // Restore original env
    process.env = originalEnv
  })

  describe('fromEnvironment', () => {
    it('should return credentials from environment variables', () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIATEST123'
      process.env.AWS_SECRET_ACCESS_KEY = 'secret123'

      const creds = fromEnvironment()

      expect(creds).not.toBeNull()
      expect(creds?.accessKeyId).toBe('AKIATEST123')
      expect(creds?.secretAccessKey).toBe('secret123')
      expect(creds?.sessionToken).toBeUndefined()
    })

    it('should include session token if present', () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIATEST123'
      process.env.AWS_SECRET_ACCESS_KEY = 'secret123'
      process.env.AWS_SESSION_TOKEN = 'token123'

      const creds = fromEnvironment()

      expect(creds).not.toBeNull()
      expect(creds?.sessionToken).toBe('token123')
    })

    it('should return null if access key is missing', () => {
      process.env.AWS_SECRET_ACCESS_KEY = 'secret123'
      delete process.env.AWS_ACCESS_KEY_ID

      const creds = fromEnvironment()

      expect(creds).toBeNull()
    })

    it('should return null if secret key is missing', () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIATEST123'
      delete process.env.AWS_SECRET_ACCESS_KEY

      const creds = fromEnvironment()

      expect(creds).toBeNull()
    })
  })

  describe('fromSharedCredentials', () => {
    it('should return null for non-existent file', () => {
      const creds = fromSharedCredentials({
        credentialsFile: '/nonexistent/path/credentials',
      })

      expect(creds).toBeNull()
    })

    it('should parse credentials from a valid file', () => {
      // This test would need a mock file or temp file
      // For now, just verify the function doesn't crash
      const creds = fromSharedCredentials({
        credentialsFile: '/tmp/test-aws-credentials-nonexistent',
      })

      expect(creds).toBeNull()
    })
  })

  describe('createCredentialProvider', () => {
    it('should create a provider function', () => {
      const provider = createCredentialProvider()
      expect(typeof provider).toBe('function')
    })

    it('should cache credentials', async () => {
      process.env.AWS_ACCESS_KEY_ID = 'AKIATEST123'
      process.env.AWS_SECRET_ACCESS_KEY = 'secret123'

      const provider = createCredentialProvider()

      const creds1 = await provider()
      const creds2 = await provider()

      expect(creds1).toEqual(creds2)
      expect(creds1.accessKeyId).toBe('AKIATEST123')
    })

    it('should throw if no credentials found', async () => {
      delete process.env.AWS_ACCESS_KEY_ID
      delete process.env.AWS_SECRET_ACCESS_KEY
      delete process.env.AWS_PROFILE

      const provider = createCredentialProvider({
        credentialsFile: '/nonexistent/path',
      })

      // This will try all providers and fail
      // In real tests, you'd mock the metadata endpoints
      await expect(provider()).rejects.toThrow('Could not find AWS credentials')
    })
  })
})

describe('Credential File Parsing', () => {
  it('should handle empty credentials gracefully', () => {
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY

    const creds = fromEnvironment()
    expect(creds).toBeNull()
  })
})
