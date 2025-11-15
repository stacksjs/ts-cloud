import { describe, expect, it } from 'bun:test'
import { CDN } from '../src/modules/cdn'
import { TemplateBuilder } from '../src/template-builder'

describe('CDN Module', () => {
  describe('createDistribution', () => {
    it('should create a basic CloudFront distribution with S3 origin', () => {
      const { distribution, originAccessControl, logicalId } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
      })

      expect(distribution.Type).toBe('AWS::CloudFront::Distribution')
      expect(distribution.Properties.DistributionConfig.Enabled).toBe(true)
      expect(distribution.Properties.DistributionConfig.Origins).toHaveLength(1)
      expect(distribution.Properties.DistributionConfig.Origins[0].DomainName).toBe('my-bucket.s3.amazonaws.com')
      expect(originAccessControl).toBeDefined()
      expect(originAccessControl?.Type).toBe('AWS::CloudFront::OriginAccessControl')
    })

    it('should create distribution with custom domain and certificate', () => {
      const { distribution } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
        customDomain: 'www.example.com',
        certificateArn: 'arn:aws:acm:us-east-1:123456789:certificate/abc',
      })

      expect(distribution.Properties.DistributionConfig.Aliases).toContain('www.example.com')
      expect(distribution.Properties.DistributionConfig.ViewerCertificate?.AcmCertificateArn).toBe(
        'arn:aws:acm:us-east-1:123456789:certificate/abc',
      )
      expect(distribution.Properties.DistributionConfig.ViewerCertificate?.SslSupportMethod).toBe('sni-only')
    })

    it('should create distribution with ALB origin', () => {
      const { distribution, originAccessControl } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 'alb',
          domainName: 'my-alb.us-east-1.elb.amazonaws.com',
        },
      })

      expect(distribution.Properties.DistributionConfig.Origins[0].CustomOriginConfig).toBeDefined()
      expect(distribution.Properties.DistributionConfig.Origins[0].CustomOriginConfig?.OriginProtocolPolicy).toBe(
        'https-only',
      )
      expect(originAccessControl).toBeUndefined() // ALB doesn't use OAC
    })

    it('should configure error pages for SPA', () => {
      const { distribution } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
        errorPages: [
          { errorCode: 404, responseCode: 200, responsePagePath: '/index.html' },
          { errorCode: 403, responseCode: 200, responsePagePath: '/index.html' },
        ],
      })

      expect(distribution.Properties.DistributionConfig.CustomErrorResponses).toHaveLength(2)
      expect(distribution.Properties.DistributionConfig.CustomErrorResponses?.[0].ErrorCode).toBe(404)
      expect(distribution.Properties.DistributionConfig.CustomErrorResponses?.[0].ResponsePagePath).toBe('/index.html')
    })

    it('should enable HTTP/3 when specified', () => {
      const { distribution } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
        http3: true,
      })

      expect(distribution.Properties.DistributionConfig.HttpVersion).toBe('http2and3')
    })

    it('should configure Lambda@Edge functions', () => {
      const { distribution } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
        edgeFunctions: [
          {
            event: 'origin-request',
            functionArn: 'arn:aws:lambda:us-east-1:123456789:function:my-function:1',
          },
        ],
      })

      expect(
        distribution.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations,
      ).toHaveLength(1)
      expect(
        distribution.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations?.[0].EventType,
      ).toBe('origin-request')
    })
  })

  describe('createSpaDistribution', () => {
    it('should create SPA distribution with 404/403 → index.html mapping', () => {
      const { distribution } = CDN.createSpaDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
      })

      const errorResponses = distribution.Properties.DistributionConfig.CustomErrorResponses
      expect(errorResponses).toHaveLength(2)
      expect(errorResponses?.find(r => r.ErrorCode === 404)?.ResponseCode).toBe(200)
      expect(errorResponses?.find(r => r.ErrorCode === 403)?.ResponseCode).toBe(200)
    })
  })

  describe('setCustomDomain', () => {
    it('should add custom domain to existing distribution', () => {
      const { distribution } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
      })

      const updated = CDN.setCustomDomain(
        distribution,
        'cdn.example.com',
        'arn:aws:acm:us-east-1:123456789:certificate/xyz',
      )

      expect(updated.Properties.DistributionConfig.Aliases).toContain('cdn.example.com')
      expect(updated.Properties.DistributionConfig.ViewerCertificate?.AcmCertificateArn).toContain('certificate/xyz')
    })
  })

  describe('enableHttp3', () => {
    it('should enable HTTP/3 on existing distribution', () => {
      const { distribution } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
      })

      const updated = CDN.enableHttp3(distribution)

      expect(updated.Properties.DistributionConfig.HttpVersion).toBe('http2and3')
    })
  })

  describe('addEdgeFunction', () => {
    it('should add Lambda@Edge function to existing distribution', () => {
      const { distribution } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
      })

      const updated = CDN.addEdgeFunction(
        distribution,
        'viewer-request',
        'arn:aws:lambda:us-east-1:123456789:function:auth:1',
      )

      const associations = updated.Properties.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations
      expect(associations).toHaveLength(1)
      expect(associations?.[0].EventType).toBe('viewer-request')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should integrate with CloudFormation template', () => {
      const template = new TemplateBuilder('CDN Infrastructure')

      const { distribution, originAccessControl, logicalId } = CDN.createDistribution({
        slug: 'my-app',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'my-bucket.s3.amazonaws.com',
        },
        customDomain: 'www.example.com',
        certificateArn: 'arn:aws:acm:us-east-1:123456789:certificate/abc',
      })

      template.addResource(logicalId, distribution)

      if (originAccessControl) {
        template.addResource(`${logicalId}OAC`, originAccessControl)
      }

      const result = template.build()

      expect(result.Resources[logicalId]).toBeDefined()
      expect(result.Resources[logicalId].Type).toBe('AWS::CloudFront::Distribution')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('CDN Test')

      const { distribution, logicalId } = CDN.createSpaDistribution({
        slug: 'spa',
        environment: 'production',
        origin: {
          type: 's3',
          domainName: 'spa-bucket.s3.amazonaws.com',
        },
      })

      template.addResource(logicalId, distribution)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::CloudFront::Distribution')
      expect(parsed.Resources[logicalId].Properties.DistributionConfig.CustomErrorResponses).toHaveLength(2)
    })
  })
})
