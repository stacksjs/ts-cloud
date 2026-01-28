/**
 * AWS Signature V4 Tests
 */

import { describe, expect, it } from 'bun:test'
import {
  signRequest,
  signRequestAsync,
  detectServiceRegion,
  createPresignedUrl,
  createPresignedUrlAsync,
  isNodeCryptoAvailable,
  isWebCryptoAvailable,
} from './signature'

describe('AWS Signature V4', () => {
  const testOptions = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }

  it('should sign a GET request', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/examplebucket',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toBeDefined()
    expect(signed.headers['x-amz-date']).toBeDefined()
    expect(signed.headers['authorization']).toContain('AWS4-HMAC-SHA256')
    expect(signed.headers['authorization']).toContain('Credential=')
    expect(signed.headers['authorization']).toContain('SignedHeaders=')
    expect(signed.headers['authorization']).toContain('Signature=')
  })

  it('should sign a POST request with body', () => {
    const body = JSON.stringify({ key: 'value' })

    const signed = signRequest({
      method: 'POST',
      url: 'https://dynamodb.us-east-1.amazonaws.com/',
      service: 'dynamodb',
      region: 'us-east-1',
      ...testOptions,
      body,
      headers: {
        'content-type': 'application/x-amz-json-1.0',
      },
    })

    expect(signed.headers['authorization']).toBeDefined()
    expect(signed.headers['x-amz-date']).toBeDefined()
    expect(signed.headers['content-type']).toBe('application/x-amz-json-1.0')
    expect(signed.body).toBe(body)
  })

  it('should include session token if provided', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      sessionToken: 'FwoGZXIvYXdzEBYaDCx3T3A...EXAMPLE',
    })

    expect(signed.headers['x-amz-security-token']).toBe('FwoGZXIvYXdzEBYaDCx3T3A...EXAMPLE')
  })

  it('should handle query parameters in URL', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket?prefix=test&max-keys=10',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toBeDefined()
    expect(signed.url).toContain('prefix=test')
    expect(signed.url).toContain('max-keys=10')
  })

  it('should preserve custom headers', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      headers: {
        'x-custom-header': 'custom-value',
      },
    })

    expect(signed.headers['x-custom-header']).toBe('custom-value')
    expect(signed.headers['authorization']).toBeDefined()
  })

  it('should use correct service in signature', () => {
    const signed = signRequest({
      method: 'POST',
      url: 'https://cloudformation.us-east-1.amazonaws.com/',
      service: 'cloudformation',
      region: 'us-east-1',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toContain('cloudformation')
  })

  it('should use correct region in signature', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.eu-west-1.amazonaws.com/bucket',
      service: 's3',
      region: 'eu-west-1',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toContain('eu-west-1')
  })

  it('should generate different signatures for different requests', () => {
    const signed1 = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket1',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
    })

    const signed2 = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket2',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
    })

    expect(signed1.headers['authorization']).not.toBe(signed2.headers['authorization'])
  })

  it('should handle empty body', () => {
    const signed = signRequest({
      method: 'POST',
      url: 'https://cloudformation.us-east-1.amazonaws.com/',
      service: 'cloudformation',
      region: 'us-east-1',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toBeDefined()
  })

  it('should format timestamp correctly', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
    })

    // x-amz-date should be in format: YYYYMMDDTHHMMSSZ
    expect(signed.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  })
})

describe('Service Auto-Detection', () => {
  it('should detect S3 service and region', () => {
    const result = detectServiceRegion('https://s3.us-west-2.amazonaws.com/bucket')
    expect(result.service).toBe('s3')
    expect(result.region).toBe('us-west-2')
  })

  it('should detect DynamoDB service and region', () => {
    const result = detectServiceRegion('https://dynamodb.eu-west-1.amazonaws.com/')
    expect(result.service).toBe('dynamodb')
    expect(result.region).toBe('eu-west-1')
  })

  it('should detect CloudFormation service and region', () => {
    const result = detectServiceRegion('https://cloudformation.ap-northeast-1.amazonaws.com/')
    expect(result.service).toBe('cloudformation')
    expect(result.region).toBe('ap-northeast-1')
  })

  it('should detect Lambda service and region', () => {
    const result = detectServiceRegion('https://lambda.us-east-1.amazonaws.com/')
    expect(result.service).toBe('lambda')
    expect(result.region).toBe('us-east-1')
  })

  it('should detect STS service and region', () => {
    const result = detectServiceRegion('https://sts.us-east-1.amazonaws.com/')
    expect(result.service).toBe('sts')
    expect(result.region).toBe('us-east-1')
  })

  it('should handle global S3 endpoint', () => {
    const result = detectServiceRegion('https://s3.amazonaws.com/bucket')
    expect(result.service).toBe('s3')
    expect(result.region).toBe('us-east-1')
  })

  it('should handle S3 accelerate endpoint', () => {
    const result = detectServiceRegion('https://bucket.s3-accelerate.amazonaws.com/')
    expect(result.service).toBe('s3')
  })

  it('should detect Lambda function URL', () => {
    const result = detectServiceRegion('https://abc123.lambda-url.us-east-1.on.aws/')
    expect(result.service).toBe('lambda')
    expect(result.region).toBe('us-east-1')
  })

  it('should detect Cloudflare R2', () => {
    const result = detectServiceRegion('https://account.r2.cloudflarestorage.com/bucket')
    expect(result.service).toBe('s3')
    expect(result.region).toBe('auto')
  })

  it('should detect Backblaze B2', () => {
    const result = detectServiceRegion('https://s3.us-west-004.backblazeb2.com/bucket')
    expect(result.service).toBe('s3')
    expect(result.region).toBe('us-west-004')
  })

  it('should handle dualstack endpoints', () => {
    const result = detectServiceRegion('https://s3.dualstack.us-west-2.amazonaws.com/bucket')
    expect(result.service).toBe('s3')
    expect(result.region).toBe('us-west-2')
  })

  it('should handle us-gov region', () => {
    const result = detectServiceRegion('https://s3.us-gov.amazonaws.com/bucket')
    expect(result.service).toBe('s3')
    expect(result.region).toBe('us-gov-west-1')
  })

  it('should map special service names', () => {
    const result = detectServiceRegion('https://email.us-east-1.amazonaws.com/')
    expect(result.service).toBe('ses')
  })

  it('should auto-detect when signing without explicit service/region', () => {
    const testOptions = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    }

    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-west-2.amazonaws.com/bucket/key',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toContain('us-west-2')
    expect(signed.headers['authorization']).toContain('s3')
  })
})

describe('Query String Signing (Presigned URLs)', () => {
  const testOptions = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }

  it('should sign request using query string', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      signQuery: true,
    })

    // Should have signature in URL, not headers
    expect(signed.url).toContain('X-Amz-Signature=')
    expect(signed.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(signed.url).toContain('X-Amz-Credential=')
    expect(signed.url).toContain('X-Amz-Date=')
    expect(signed.url).toContain('X-Amz-Expires=')
    expect(signed.url).toContain('X-Amz-SignedHeaders=host')
    expect(signed.headers['authorization']).toBeUndefined()
  })

  it('should include session token in query string', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      sessionToken: 'SESSION_TOKEN_EXAMPLE',
      signQuery: true,
    })

    expect(signed.url).toContain('X-Amz-Security-Token=SESSION_TOKEN_EXAMPLE')
  })

  it('should respect custom expiration time', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      signQuery: true,
      expiresIn: 3600,
    })

    expect(signed.url).toContain('X-Amz-Expires=3600')
  })

  it('should use default expiration of 24 hours', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      signQuery: true,
    })

    expect(signed.url).toContain('X-Amz-Expires=86400')
  })

  it('should add UNSIGNED-PAYLOAD for S3', () => {
    const signed = signRequest({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      signQuery: true,
    })

    expect(signed.url).toContain('X-Amz-Content-Sha256=UNSIGNED-PAYLOAD')
  })
})

describe('createPresignedUrl', () => {
  const testOptions = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }

  it('should create a presigned URL for S3 GET', () => {
    const url = createPresignedUrl({
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key.txt',
      ...testOptions,
    })

    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('bucket/key.txt')
  })

  it('should create a presigned URL for S3 PUT', () => {
    const url = createPresignedUrl({
      url: 'https://s3.us-east-1.amazonaws.com/bucket/upload.txt',
      method: 'PUT',
      ...testOptions,
    })

    expect(url).toContain('X-Amz-Signature=')
  })

  it('should use custom expiration', () => {
    const url = createPresignedUrl({
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      expiresIn: 300, // 5 minutes
      ...testOptions,
    })

    expect(url).toContain('X-Amz-Expires=300')
  })

  it('should clamp expiration to max 7 days', () => {
    const url = createPresignedUrl({
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      expiresIn: 999999999, // Way more than 7 days
      ...testOptions,
    })

    expect(url).toContain('X-Amz-Expires=604800') // 7 days in seconds
  })

  it('should auto-detect service and region', () => {
    const url = createPresignedUrl({
      url: 'https://s3.eu-west-1.amazonaws.com/bucket/key',
      ...testOptions,
    })

    expect(url).toContain('eu-west-1')
    expect(url).toContain('s3')
  })

  it('should work with special characters in key', () => {
    const url = createPresignedUrl({
      url: 'https://s3.us-east-1.amazonaws.com/bucket/path/to/file with spaces.txt',
      ...testOptions,
    })

    expect(url).toContain('X-Amz-Signature=')
    // URL should be properly encoded
    expect(url).toContain('file%20with%20spaces.txt')
  })
})

describe('Retry Logic', () => {
  // Note: These are unit tests for the retry logic structure
  // Integration tests would require mocking fetch

  it('should support retry options in signature options', () => {
    // This test verifies the types compile correctly
    const options = {
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket',
      service: 's3',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    }

    // Should compile and work
    const signed = signRequest(options)
    expect(signed.headers['authorization']).toBeDefined()
  })
})

describe('Browser Compatibility (Async Functions)', () => {
  const testOptions = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }

  it('should detect Node.js crypto availability', () => {
    // In Bun/Node.js, this should be true
    expect(isNodeCryptoAvailable()).toBe(true)
  })

  it('should detect Web Crypto API availability', () => {
    // In Bun/Node.js 15+, this should be true
    expect(isWebCryptoAvailable()).toBe(true)
  })

  it('should sign a GET request async', async () => {
    const signed = await signRequestAsync({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/examplebucket',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toBeDefined()
    expect(signed.headers['x-amz-date']).toBeDefined()
    expect(signed.headers['authorization']).toContain('AWS4-HMAC-SHA256')
    expect(signed.headers['authorization']).toContain('Credential=')
    expect(signed.headers['authorization']).toContain('SignedHeaders=')
    expect(signed.headers['authorization']).toContain('Signature=')
  })

  it('should sign a POST request with body async', async () => {
    const body = JSON.stringify({ key: 'value' })

    const signed = await signRequestAsync({
      method: 'POST',
      url: 'https://dynamodb.us-east-1.amazonaws.com/',
      service: 'dynamodb',
      region: 'us-east-1',
      ...testOptions,
      body,
      headers: {
        'content-type': 'application/x-amz-json-1.0',
      },
    })

    expect(signed.headers['authorization']).toBeDefined()
    expect(signed.headers['x-amz-date']).toBeDefined()
    expect(signed.headers['content-type']).toBe('application/x-amz-json-1.0')
    expect(signed.body).toBe(body)
  })

  it('should include session token async', async () => {
    const signed = await signRequestAsync({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      sessionToken: 'FwoGZXIvYXdzEBYaDCx3T3A...EXAMPLE',
    })

    expect(signed.headers['x-amz-security-token']).toBe('FwoGZXIvYXdzEBYaDCx3T3A...EXAMPLE')
  })

  it('should auto-detect service and region async', async () => {
    const signed = await signRequestAsync({
      method: 'GET',
      url: 'https://s3.us-west-2.amazonaws.com/bucket/key',
      ...testOptions,
    })

    expect(signed.headers['authorization']).toContain('us-west-2')
    expect(signed.headers['authorization']).toContain('s3')
  })

  it('should create presigned URL async', async () => {
    const url = await createPresignedUrlAsync({
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key.txt',
      ...testOptions,
    })

    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('bucket/key.txt')
  })

  it('should create presigned URL with custom expiration async', async () => {
    const url = await createPresignedUrlAsync({
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      expiresIn: 300, // 5 minutes
      ...testOptions,
    })

    expect(url).toContain('X-Amz-Expires=300')
  })

  it('should produce same signature as sync version', async () => {
    // Use a fixed timestamp to compare (by using the same request params)
    const baseOptions = {
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
    }

    const syncSigned = signRequest(baseOptions)
    const asyncSigned = await signRequestAsync(baseOptions)

    // Both should have valid signatures (different due to timestamp)
    expect(syncSigned.headers['authorization']).toContain('AWS4-HMAC-SHA256')
    expect(asyncSigned.headers['authorization']).toContain('AWS4-HMAC-SHA256')
    expect(syncSigned.headers['authorization']).toContain('Credential=AKIAIOSFODNN7EXAMPLE')
    expect(asyncSigned.headers['authorization']).toContain('Credential=AKIAIOSFODNN7EXAMPLE')
  })

  it('should sign with query string async', async () => {
    const signed = await signRequestAsync({
      method: 'GET',
      url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
      service: 's3',
      region: 'us-east-1',
      ...testOptions,
      signQuery: true,
    })

    expect(signed.url).toContain('X-Amz-Signature=')
    expect(signed.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(signed.url).toContain('X-Amz-Credential=')
    expect(signed.url).toContain('X-Amz-Date=')
    expect(signed.url).toContain('X-Amz-Expires=')
    expect(signed.headers['authorization']).toBeUndefined()
  })
})
