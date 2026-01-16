import { describe, expect, it } from 'bun:test'
import { Registry } from '../src/modules/registry'
import { TemplateBuilder } from '../src/template-builder'

describe('Registry Module', () => {
  describe('createRepository', () => {
    it('should create a basic ECR repository', () => {
      const { repository, logicalId } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
      })

      expect(repository.Type).toBe('AWS::ECR::Repository')
      expect(repository.Properties?.RepositoryName).toBe('my-app-production-ecr-api')
      expect(logicalId).toBe('MyAppProductionEcrApi')
      expect(repository.Properties?.ImageScanningConfiguration?.ScanOnPush).toBe(true)
      expect(repository.Properties?.ImageTagMutability).toBe('MUTABLE')
      expect(repository.Properties?.EncryptionConfiguration?.EncryptionType).toBe('AES256')
    })

    it('should create repository with immutable tags', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        imageMutability: 'IMMUTABLE',
      })

      expect(repository.Properties?.ImageTagMutability).toBe('IMMUTABLE')
    })

    it('should create repository with KMS encryption', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        encryption: 'KMS',
        kmsKey: 'arn:aws:kms:us-east-1:123456789:key/12345',
      })

      expect(repository.Properties?.EncryptionConfiguration?.EncryptionType).toBe('KMS')
      expect(repository.Properties?.EncryptionConfiguration?.KmsKey).toBe('arn:aws:kms:us-east-1:123456789:key/12345')
    })

    it('should create repository with scan on push disabled', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        scanOnPush: false,
      })

      expect(repository.Properties?.ImageScanningConfiguration?.ScanOnPush).toBe(false)
    })

    it('should create repository with lifecycle policy', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        lifecyclePolicy: {
          maxImageCount: 10,
          untaggedImageExpireDays: 7,
        },
      })

      expect(repository.Properties?.LifecyclePolicy).toBeDefined()
      expect(repository.Properties?.LifecyclePolicy?.LifecyclePolicyText).toBeDefined()

      const policy = JSON.parse(repository.Properties!.LifecyclePolicy!.LifecyclePolicyText!)
      expect(policy.rules).toHaveLength(2)
      expect(policy.rules[0].selection.tagStatus).toBe('untagged')
      expect(policy.rules[0].selection.countNumber).toBe(7)
      expect(policy.rules[1].selection.countNumber).toBe(10)
    })

    it('should create repository with tags', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        tags: {
          Owner: 'Platform Team',
          Project: 'MyApp',
        },
      })

      expect(repository.Properties?.Tags).toHaveLength(2)
      expect(repository.Properties?.Tags).toContainEqual({ Key: 'Owner', Value: 'Platform Team' })
      expect(repository.Properties?.Tags).toContainEqual({ Key: 'Project', Value: 'MyApp' })
    })

    it('should create repository with production lifecycle preset', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        lifecyclePolicy: Registry.LifecyclePolicies.production,
      })

      const policy = JSON.parse(repository.Properties!.LifecyclePolicy!.LifecyclePolicyText!)
      expect(policy.rules).toHaveLength(2)
    })

    it('should create repository with development lifecycle preset', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'development',
        lifecyclePolicy: Registry.LifecyclePolicies.development,
      })

      const policy = JSON.parse(repository.Properties!.LifecyclePolicy!.LifecyclePolicyText!)
      expect(policy.rules[0].selection.countNumber).toBe(3)
      expect(policy.rules[1].selection.countNumber).toBe(5)
    })
  })

  describe('LifecyclePolicies presets', () => {
    it('should provide production preset', () => {
      const preset = Registry.LifecyclePolicies.production

      expect(preset.maxImageCount).toBe(10)
      expect(preset.untaggedImageExpireDays).toBe(7)
    })

    it('should provide development preset', () => {
      const preset = Registry.LifecyclePolicies.development

      expect(preset.maxImageCount).toBe(5)
      expect(preset.untaggedImageExpireDays).toBe(3)
    })

    it('should provide minimal preset', () => {
      const preset = Registry.LifecyclePolicies.minimal

      expect(preset.maxImageCount).toBe(3)
      expect(preset.untaggedImageExpireDays).toBe(1)
    })

    it('should provide archive preset', () => {
      const preset = Registry.LifecyclePolicies.archive

      expect(preset.maxImageCount).toBe(50)
      expect(preset.untaggedImageExpireDays).toBe(30)
    })
  })

  describe('enableImmutableTags', () => {
    it('should enable immutable tags on existing repository', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Registry.enableImmutableTags(repository)

      expect(updated.Properties?.ImageTagMutability).toBe('IMMUTABLE')
    })
  })

  describe('enableScanOnPush', () => {
    it('should enable scan on push on existing repository', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        scanOnPush: false,
      })

      const updated = Registry.enableScanOnPush(repository)

      expect(updated.Properties?.ImageScanningConfiguration?.ScanOnPush).toBe(true)
    })
  })

  describe('setLifecyclePolicy', () => {
    it('should set lifecycle policy on existing repository', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Registry.setLifecyclePolicy(repository, {
        maxImageCount: 20,
        untaggedImageExpireDays: 14,
      })

      expect(updated.Properties?.LifecyclePolicy).toBeDefined()
      const policy = JSON.parse(updated.Properties!.LifecyclePolicy!.LifecyclePolicyText!)
      expect(policy.rules).toHaveLength(2)
      expect(policy.rules[0].selection.countNumber).toBe(14)
      expect(policy.rules[1].selection.countNumber).toBe(20)
    })
  })

  describe('addCrossAccountAccess', () => {
    it('should add cross-account access policy', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Registry.addCrossAccountAccess(repository, ['123456789012', '210987654321'])

      expect(updated.Properties?.RepositoryPolicyText).toBeDefined()
      expect(updated.Properties?.RepositoryPolicyText?.Statement).toHaveLength(1)
      expect(updated.Properties?.RepositoryPolicyText?.Statement[0].Effect).toBe('Allow')
      const principal = updated.Properties?.RepositoryPolicyText?.Statement[0].Principal as { AWS?: string | string[] }
      expect(principal.AWS).toContain('arn:aws:iam::123456789012:root')
      expect(principal.AWS).toContain('arn:aws:iam::210987654321:root')
      expect(updated.Properties?.RepositoryPolicyText?.Statement[0].Action).toContain('ecr:GetDownloadUrlForLayer')
    })
  })

  describe('addLambdaAccess', () => {
    it('should add Lambda service access policy', () => {
      const { repository } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
      })

      const updated = Registry.addLambdaAccess(repository)

      expect(updated.Properties?.RepositoryPolicyText).toBeDefined()
      expect(updated.Properties?.RepositoryPolicyText?.Statement).toHaveLength(1)
      expect(updated.Properties?.RepositoryPolicyText?.Statement[0].Effect).toBe('Allow')
      const principal = updated.Properties?.RepositoryPolicyText?.Statement[0].Principal as { Service?: string | string[] }
      expect(principal.Service).toBe('lambda.amazonaws.com')
      expect(updated.Properties?.RepositoryPolicyText?.Statement[0].Action).toContain('ecr:GetDownloadUrlForLayer')
      expect(updated.Properties?.RepositoryPolicyText?.Statement[0].Action).toContain('ecr:BatchGetImage')
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should integrate with CloudFormation template', () => {
      const template = new TemplateBuilder('Container Infrastructure')

      const { repository, logicalId } = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
        imageMutability: 'IMMUTABLE',
        lifecyclePolicy: Registry.LifecyclePolicies.production,
      })

      template.addResource(logicalId, repository)

      const result = template.build()

      expect(result.Resources[logicalId]).toBeDefined()
      expect(result.Resources[logicalId].Type).toBe('AWS::ECR::Repository')
      expect(result.AWSTemplateFormatVersion).toBe('2010-09-09')
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Test ECR')

      const { repository, logicalId } = Registry.createRepository({
        name: 'web',
        slug: 'test',
        environment: 'development',
        encryption: 'KMS',
        kmsKey: 'alias/ecr-key',
      })

      template.addResource(logicalId, repository)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::ECR::Repository')
      expect(parsed.Resources[logicalId].Properties.EncryptionConfiguration.EncryptionType).toBe('KMS')
    })

    it('should create multiple repositories in same template', () => {
      const template = new TemplateBuilder('Multi-Service Infrastructure')

      const api = Registry.createRepository({
        name: 'api',
        slug: 'my-app',
        environment: 'production',
      })

      const worker = Registry.createRepository({
        name: 'worker',
        slug: 'my-app',
        environment: 'production',
      })

      template.addResource(api.logicalId, api.repository)
      template.addResource(worker.logicalId, worker.repository)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(2)
      expect(result.Resources[api.logicalId]).toBeDefined()
      expect(result.Resources[worker.logicalId]).toBeDefined()
    })
  })
})
