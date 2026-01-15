import { describe, expect, it } from 'bun:test'
import { AI } from '../src/modules/ai'
import { TemplateBuilder } from '../src/template-builder'

describe('AI Module', () => {
  describe('createBedrockRole', () => {
    it('should create IAM role for Bedrock with default settings', () => {
      const { role, logicalId } = AI.createBedrockRole('lambda.amazonaws.com', {
        slug: 'my-app',
        environment: 'production',
      })

      expect(role.Type).toBe('AWS::IAM::Role')
      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe('lambda.amazonaws.com')
      expect(role.Properties!.Policies).toHaveLength(1)
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModel')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModelWithResponseStream')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Resource).toContain('arn:aws:bedrock:*::foundation-model/*')
      expect(logicalId).toBeDefined()
    })

    it('should support specific models', () => {
      const { role } = AI.createBedrockRole('lambda.amazonaws.com', {
        slug: 'my-app',
        environment: 'production',
        models: [AI.Models.Claude3_5_Sonnet, AI.Models.TitanTextG1Express],
      })

      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Resource).toHaveLength(2)
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Resource).toContain('arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Resource).toContain('arn:aws:bedrock:*::foundation-model/amazon.titan-text-express-v1')
    })

    it('should disable streaming when requested', () => {
      const { role } = AI.createBedrockRole('lambda.amazonaws.com', {
        slug: 'my-app',
        environment: 'production',
        allowStreaming: false,
      })

      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toEqual(['bedrock:InvokeModel'])
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).not.toContain('bedrock:InvokeModelWithResponseStream')
    })

    it('should support custom role name', () => {
      const { role } = AI.createBedrockRole('lambda.amazonaws.com', {
        slug: 'my-app',
        environment: 'production',
        name: 'custom-bedrock-role',
      })

      expect(role.Properties.RoleName).toBe('custom-bedrock-role')
    })
  })

  describe('createBedrockPolicy', () => {
    it('should create IAM policy for Bedrock with default settings', () => {
      const { policy, logicalId } = AI.createBedrockPolicy({
        slug: 'my-app',
        environment: 'production',
      })

      expect(policy.Type).toBe('AWS::IAM::ManagedPolicy')
      expect(policy.Properties.PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModel')
      expect(policy.Properties.PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModelWithResponseStream')
      expect(policy.Properties.PolicyDocument.Statement[0].Resource).toContain('arn:aws:bedrock:*::foundation-model/*')
      expect(logicalId).toBeDefined()
    })

    it('should support specific permissions', () => {
      const { policy } = AI.createBedrockPolicy({
        slug: 'my-app',
        environment: 'production',
        allowInvoke: true,
        allowStreaming: false,
        allowAsync: true,
      })

      expect(policy.Properties.PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModel')
      expect(policy.Properties.PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModelAsync')
      expect(policy.Properties.PolicyDocument.Statement[0].Action).not.toContain('bedrock:InvokeModelWithResponseStream')
    })

    it('should support specific models', () => {
      const { policy } = AI.createBedrockPolicy({
        slug: 'my-app',
        environment: 'production',
        models: [AI.Models.Claude3_Opus],
      })

      expect(policy.Properties.PolicyDocument.Statement[0].Resource).toEqual([
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-opus-20240229-v1:0',
      ])
    })
  })

  describe('enableBedrockForLambda', () => {
    it('should create Lambda-specific Bedrock role', () => {
      const { role } = AI.enableBedrockForLambda({
        slug: 'my-app',
        environment: 'production',
      })

      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe('lambda.amazonaws.com')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModel')
    })
  })

  describe('enableBedrockForEcs', () => {
    it('should create ECS-specific Bedrock role', () => {
      const { role } = AI.enableBedrockForEcs({
        slug: 'my-app',
        environment: 'production',
      })

      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe('ecs-tasks.amazonaws.com')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModel')
    })
  })

  describe('enableBedrockForEc2', () => {
    it('should create EC2-specific Bedrock role', () => {
      const { role } = AI.enableBedrockForEc2({
        slug: 'my-app',
        environment: 'production',
      })

      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Service).toBe('ec2.amazonaws.com')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModel')
    })
  })

  describe('addBedrockPermissions', () => {
    it('should add Bedrock permissions to existing role', () => {
      // Create a basic role first
      const { role } = AI.createBedrockRole('lambda.amazonaws.com', {
        slug: 'my-app',
        environment: 'production',
        models: [],
        allowStreaming: false,
      })

      // Clear policies to simulate a role without Bedrock permissions
      role.Properties.Policies = []

      // Add Bedrock permissions
      AI.addBedrockPermissions(role, [AI.Models.Claude3_5_Sonnet], true)

      expect(role.Properties!.Policies).toHaveLength(1)
      expect(role.Properties!.Policies![0].PolicyName).toBe('bedrock-permissions')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModel')
      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toContain('bedrock:InvokeModelWithResponseStream')
    })

    it('should add Bedrock permissions without streaming', () => {
      const { role } = AI.createBedrockRole('lambda.amazonaws.com', {
        slug: 'my-app',
        environment: 'production',
        models: [],
      })

      role.Properties.Policies = []

      AI.addBedrockPermissions(role, ['*'], false)

      expect(role.Properties!.Policies![0].PolicyDocument.Statement[0].Action).toEqual(['bedrock:InvokeModel'])
    })
  })

  describe('Models', () => {
    it('should provide Claude model IDs', () => {
      expect(AI.Models.Claude3_5_Sonnet).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0')
      expect(AI.Models.Claude3_5_Haiku).toBe('anthropic.claude-3-5-haiku-20241022-v1:0')
      expect(AI.Models.Claude3_Opus).toBe('anthropic.claude-3-opus-20240229-v1:0')
      expect(AI.Models.Claude3_Sonnet).toBe('anthropic.claude-3-sonnet-20240229-v1:0')
      expect(AI.Models.Claude3_Haiku).toBe('anthropic.claude-3-haiku-20240307-v1:0')
    })

    it('should provide Titan model IDs', () => {
      expect(AI.Models.TitanTextG1Express).toBe('amazon.titan-text-express-v1')
      expect(AI.Models.TitanTextG1Lite).toBe('amazon.titan-text-lite-v1')
      expect(AI.Models.TitanEmbedG1Text).toBe('amazon.titan-embed-text-v1')
      expect(AI.Models.TitanImageG1).toBe('amazon.titan-image-generator-v1')
    })

    it('should provide Llama model IDs', () => {
      expect(AI.Models.Llama3_2_1B).toBe('meta.llama3-2-1b-instruct-v1:0')
      expect(AI.Models.Llama3_2_90B).toBe('meta.llama3-2-90b-instruct-v1:0')
      expect(AI.Models.Llama3_1_405B).toBe('meta.llama3-1-405b-instruct-v1:0')
    })

    it('should provide other model IDs', () => {
      expect(AI.Models.Mistral7B).toBeDefined()
      expect(AI.Models.StableDiffusionXL).toBeDefined()
    })
  })

  describe('ModelGroups', () => {
    it('should provide AllClaude group', () => {
      expect(AI.ModelGroups.AllClaude).toHaveLength(5)
      expect(AI.ModelGroups.AllClaude).toContain(AI.Models.Claude3_5_Sonnet)
      expect(AI.ModelGroups.AllClaude).toContain(AI.Models.Claude3_Opus)
    })

    it('should provide AllTitan group', () => {
      expect(AI.ModelGroups.AllTitan).toHaveLength(4)
      expect(AI.ModelGroups.AllTitan).toContain(AI.Models.TitanTextG1Express)
      expect(AI.ModelGroups.AllTitan).toContain(AI.Models.TitanImageG1)
    })

    it('should provide AllLlama group', () => {
      expect(AI.ModelGroups.AllLlama).toHaveLength(7)
      expect(AI.ModelGroups.AllLlama).toContain(AI.Models.Llama3_2_11B)
      expect(AI.ModelGroups.AllLlama).toContain(AI.Models.Llama3_1_405B)
    })

    it('should provide TextModels group', () => {
      expect(AI.ModelGroups.TextModels.length).toBeGreaterThan(0)
      expect(AI.ModelGroups.TextModels).toContain(AI.Models.Claude3_5_Sonnet)
    })

    it('should provide EmbeddingModels group', () => {
      expect(AI.ModelGroups.EmbeddingModels).toContain(AI.Models.TitanEmbedG1Text)
      expect(AI.ModelGroups.EmbeddingModels).toContain(AI.Models.EmbedEnglish)
    })

    it('should provide ImageModels group', () => {
      expect(AI.ModelGroups.ImageModels).toContain(AI.Models.TitanImageG1)
      expect(AI.ModelGroups.ImageModels).toContain(AI.Models.StableDiffusionXL)
    })
  })

  describe('Integration with TemplateBuilder', () => {
    it('should create Lambda function with Bedrock permissions', () => {
      const template = new TemplateBuilder('Lambda with Bedrock')

      // Create Bedrock role for Lambda
      const { role, logicalId } = AI.enableBedrockForLambda({
        slug: 'my-app',
        environment: 'production',
        models: [AI.Models.Claude3_5_Sonnet],
      })

      template.addResource(logicalId, role)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId].Type).toBe('AWS::IAM::Role')
      expect(result.Resources[logicalId]!.Properties!.Policies).toHaveLength(1)
    })

    it('should create ECS task with Bedrock permissions', () => {
      const template = new TemplateBuilder('ECS with Bedrock')

      // Create Bedrock role for ECS
      const { role, logicalId } = AI.enableBedrockForEcs({
        slug: 'my-app',
        environment: 'production',
        models: [...AI.ModelGroups.AllClaude],
      })

      template.addResource(logicalId, role)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(((result.Resources[logicalId]!.Properties!.Policies as any)[0].PolicyDocument.Statement[0].Resource as string[]).length).toHaveLength(5)
    })

    it('should create standalone Bedrock policy', () => {
      const template = new TemplateBuilder('Bedrock Policy')

      const { policy, logicalId } = AI.createBedrockPolicy({
        slug: 'my-app',
        environment: 'production',
        models: [...AI.ModelGroups.TextModels],
        allowStreaming: true,
      })

      template.addResource(logicalId, policy)

      const result = template.build()

      expect(Object.keys(result.Resources)).toHaveLength(1)
      expect(result.Resources[logicalId].Type).toBe('AWS::IAM::ManagedPolicy')
    })

    it('should create role with multiple model groups', () => {
      const template = new TemplateBuilder('Multi-Model Bedrock')

      const allModels = [
        ...AI.ModelGroups.TextModels,
        ...AI.ModelGroups.EmbeddingModels,
      ]

      const { role, logicalId } = AI.enableBedrockForLambda({
        slug: 'my-app',
        environment: 'production',
        models: allModels,
      })

      template.addResource(logicalId, role)

      const result = template.build()

      expect(((result.Resources[logicalId]!.Properties!.Policies as any)[0].PolicyDocument.Statement[0].Resource as string[]).length).toBeGreaterThan(1)
    })

    it('should generate valid JSON template', () => {
      const template = new TemplateBuilder('Bedrock Test')

      const { role, logicalId } = AI.enableBedrockForLambda({
        slug: 'test',
        environment: 'development',
      })

      template.addResource(logicalId, role)

      const json = template.toJSON()
      const parsed = JSON.parse(json)

      expect(parsed.Resources[logicalId].Type).toBe('AWS::IAM::Role')
      expect(parsed.Resources[logicalId].Properties.Policies).toBeDefined()
    })
  })
})
