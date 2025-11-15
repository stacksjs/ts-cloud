import { describe, expect, it } from 'bun:test'
import { Storage } from '../src/modules/storage'
import { TemplateBuilder } from '../src/template-builder'

describe('Storage Module', () => {
  describe('createBucket', () => {
    it('should create a basic private bucket', () => {
      const { bucket, logicalId } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      expect(bucket.Type).toBe('AWS::S3::Bucket')
      expect(bucket.Properties?.BucketName).toBe('my-app-production-s3-test')
      expect(logicalId).toBe('MyAppProductionS3Test')
      expect(bucket.Properties?.PublicAccessBlockConfiguration).toBeDefined()
      expect(bucket.Properties?.BucketEncryption).toBeDefined()
    })

    it('should create a public bucket with policy', () => {
      const { bucket, bucketPolicy, logicalId } = Storage.createBucket({
        name: 'website',
        slug: 'my-app',
        environment: 'production',
        public: true,
      })

      expect(bucket.Properties?.PublicAccessBlockConfiguration).toBeUndefined()
      expect(bucketPolicy).toBeDefined()
      expect(bucketPolicy?.Type).toBe('AWS::S3::BucketPolicy')
      expect(bucketPolicy?.Properties.PolicyDocument.Statement[0].Effect).toBe('Allow')
      expect(bucketPolicy?.Properties.PolicyDocument.Statement[0].Action).toContain('s3:GetObject')
    })

    it('should enable versioning when specified', () => {
      const { bucket } = Storage.createBucket({
        name: 'versioned',
        slug: 'my-app',
        environment: 'production',
        versioning: true,
      })

      expect(bucket.Properties?.VersioningConfiguration?.Status).toBe('Enabled')
    })

    it('should enable website hosting when specified', () => {
      const { bucket } = Storage.createBucket({
        name: 'website',
        slug: 'my-app',
        environment: 'production',
        website: true,
      })

      expect(bucket.Properties?.WebsiteConfiguration).toBeDefined()
      expect(bucket.Properties?.WebsiteConfiguration?.IndexDocument).toBe('index.html')
      expect(bucket.Properties?.WebsiteConfiguration?.ErrorDocument).toBe('error.html')
    })

    it('should configure CORS rules', () => {
      const { bucket } = Storage.createBucket({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        cors: [
          {
            allowedOrigins: ['https://example.com'],
            allowedMethods: ['GET', 'POST'],
            allowedHeaders: ['*'],
            maxAge: 3600,
          },
        ],
      })

      expect(bucket.Properties?.CorsConfiguration?.CorsRules).toHaveLength(1)
      expect(bucket.Properties?.CorsConfiguration?.CorsRules[0].AllowedOrigins).toContain('https://example.com')
    })

    it('should configure lifecycle rules', () => {
      const { bucket } = Storage.createBucket({
        name: 'logs',
        slug: 'my-app',
        environment: 'production',
        lifecycleRules: [
          {
            id: 'DeleteOldLogs',
            enabled: true,
            expirationDays: 30,
          },
        ],
      })

      expect(bucket.Properties?.LifecycleConfiguration?.Rules).toHaveLength(1)
      expect(bucket.Properties?.LifecycleConfiguration?.Rules[0].ExpirationInDays).toBe(30)
      expect(bucket.Properties?.LifecycleConfiguration?.Rules[0].Status).toBe('Enabled')
    })
  })

  describe('enableVersioning', () => {
    it('should enable versioning on existing bucket', () => {
      const { bucket } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.enableVersioning(bucket)

      expect(updated.Properties?.VersioningConfiguration?.Status).toBe('Enabled')
    })
  })

  describe('enableWebsiteHosting', () => {
    it('should enable website hosting with default documents', () => {
      const { bucket } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.enableWebsiteHosting(bucket)

      expect(updated.Properties?.WebsiteConfiguration?.IndexDocument).toBe('index.html')
      expect(updated.Properties?.WebsiteConfiguration?.ErrorDocument).toBe('error.html')
    })

    it('should enable website hosting with custom documents', () => {
      const { bucket } = Storage.createBucket({
        name: 'test',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Storage.enableWebsiteHosting(bucket, 'main.html', '404.html')

      expect(updated.Properties?.WebsiteConfiguration?.IndexDocument).toBe('main.html')
      expect(updated.Properties?.WebsiteConfiguration?.ErrorDocument).toBe('404.html')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should integrate with CloudFormation template', () => {
      const template = new TemplateBuilder('Test Infrastructure')

      const { bucket, bucketPolicy, logicalId } = Storage.createBucket({
        name: 'website',
        slug: 'my-app',
        environment: 'production',
        public: true,
        website: true,
        versioning: true,
      })

      template.addResource(logicalId, bucket)

      if (bucketPolicy) {
        template.addResource(`${logicalId}Policy`, bucketPolicy)
      }

      const result = template.build()

      expect(result.Resources[logicalId]).toBeDefined()
      expect(result.Resources[`${logicalId}Policy`]).toBeDefined()
      expect(result.AWSTemplateFormatVersion).toBe('2010-09-09')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Test S3')

      const { bucket, logicalId } = Storage.createBucket({
        name: 'data',
        slug: 'test',
        environment: 'development',
        encryption: true,
      })

      template.addResource(logicalId, bucket)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::S3::Bucket')
      expect(parsed.Resources[logicalId].Properties.BucketEncryption).toBeDefined()
    })
  })
})
