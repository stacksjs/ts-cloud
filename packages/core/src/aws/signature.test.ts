/**
 * AWS Signature V4 Tests
 */

import { describe, expect, it } from 'bun:test'
import { signRequest } from './signature'

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
