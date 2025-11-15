import type {
  IAMRole,
  IAMPolicy,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface BedrockRoleOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  models?: string[]
  allowStreaming?: boolean
}

export interface BedrockPolicyOptions {
  slug: string
  environment: EnvironmentType
  name?: string
  models?: string[]
  allowInvoke?: boolean
  allowStreaming?: boolean
  allowAsync?: boolean
}

/**
 * AI Module - Amazon Bedrock
 * Provides clean API for setting up Bedrock permissions and roles
 */
export class AI {
  /**
   * Create an IAM role for Bedrock access
   */
  static createBedrockRole(
    servicePrincipal: string,
    options: BedrockRoleOptions,
  ): {
      role: IAMRole
      logicalId: string
    } {
    const {
      slug,
      environment,
      name,
      models = ['*'],
      allowStreaming = true,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'bedrock-role',
    })

    const logicalId = generateLogicalId(resourceName)

    // Build actions array
    const actions = ['bedrock:InvokeModel']
    if (allowStreaming) {
      actions.push('bedrock:InvokeModelWithResponseStream')
    }

    // Build resource ARNs for models
    const modelArns = models.map(model =>
      model === '*'
        ? 'arn:aws:bedrock:*::foundation-model/*'
        : `arn:aws:bedrock:*::foundation-model/${model}`,
    )

    const role: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: resourceName,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: servicePrincipal,
              },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        Policies: [
          {
            PolicyName: `${resourceName}-policy`,
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: actions,
                  Resource: modelArns,
                },
              ],
            },
          },
        ],
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    return { role, logicalId }
  }

  /**
   * Create an IAM policy for Bedrock model invocation
   */
  static createBedrockPolicy(options: BedrockPolicyOptions): {
    policy: IAMPolicy
    logicalId: string
  } {
    const {
      slug,
      environment,
      name,
      models = ['*'],
      allowInvoke = true,
      allowStreaming = true,
      allowAsync = false,
    } = options

    const resourceName = name || generateResourceName({
      slug,
      environment,
      resourceType: 'bedrock-policy',
    })

    const logicalId = generateLogicalId(resourceName)

    // Build actions array
    const actions: string[] = []
    if (allowInvoke) {
      actions.push('bedrock:InvokeModel')
    }
    if (allowStreaming) {
      actions.push('bedrock:InvokeModelWithResponseStream')
    }
    if (allowAsync) {
      actions.push('bedrock:InvokeModelAsync')
    }

    // Build resource ARNs for models
    const modelArns = models.map(model =>
      model === '*'
        ? 'arn:aws:bedrock:*::foundation-model/*'
        : `arn:aws:bedrock:*::foundation-model/${model}`,
    )

    const policy: IAMPolicy = {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        ManagedPolicyName: resourceName,
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'BedrockModelInvocation',
              Effect: 'Allow',
              Action: actions,
              Resource: modelArns,
            },
          ],
        },
      },
    }

    return { policy, logicalId }
  }

  /**
   * Enable Bedrock for Lambda function
   * Returns a role with Bedrock permissions
   */
  static enableBedrockForLambda(options: BedrockRoleOptions): {
    role: IAMRole
    logicalId: string
  } {
    return AI.createBedrockRole('lambda.amazonaws.com', options)
  }

  /**
   * Enable Bedrock for ECS task
   * Returns a role with Bedrock permissions
   */
  static enableBedrockForEcs(options: BedrockRoleOptions): {
    role: IAMRole
    logicalId: string
  } {
    return AI.createBedrockRole('ecs-tasks.amazonaws.com', options)
  }

  /**
   * Enable Bedrock for EC2 instance
   * Returns a role with Bedrock permissions
   */
  static enableBedrockForEc2(options: BedrockRoleOptions): {
    role: IAMRole
    logicalId: string
  } {
    return AI.createBedrockRole('ec2.amazonaws.com', options)
  }

  /**
   * Add Bedrock permissions to an existing role
   */
  static addBedrockPermissions(
    role: IAMRole,
    models: string[] = ['*'],
    allowStreaming = true,
  ): IAMRole {
    // Build actions array
    const actions = ['bedrock:InvokeModel']
    if (allowStreaming) {
      actions.push('bedrock:InvokeModelWithResponseStream')
    }

    // Build resource ARNs for models
    const modelArns = models.map(model =>
      model === '*'
        ? 'arn:aws:bedrock:*::foundation-model/*'
        : `arn:aws:bedrock:*::foundation-model/${model}`,
    )

    if (!role.Properties.Policies) {
      role.Properties.Policies = []
    }

    // Add Bedrock policy
    role.Properties.Policies.push({
      PolicyName: 'bedrock-permissions',
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: actions,
            Resource: modelArns,
          },
        ],
      },
    })

    return role
  }

  /**
   * Common Bedrock model IDs
   */
  static readonly Models = {
    // Anthropic Claude Models
    Claude3_5_Sonnet: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    Claude3_5_Haiku: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    Claude3_Opus: 'anthropic.claude-3-opus-20240229-v1:0',
    Claude3_Sonnet: 'anthropic.claude-3-sonnet-20240229-v1:0',
    Claude3_Haiku: 'anthropic.claude-3-haiku-20240307-v1:0',

    // Amazon Titan Models
    TitanTextG1Express: 'amazon.titan-text-express-v1',
    TitanTextG1Lite: 'amazon.titan-text-lite-v1',
    TitanEmbedG1Text: 'amazon.titan-embed-text-v1',
    TitanImageG1: 'amazon.titan-image-generator-v1',

    // AI21 Labs Models
    JurassicUltra: 'ai21.j2-ultra-v1',
    JurassicMid: 'ai21.j2-mid-v1',

    // Cohere Models
    CommandText: 'cohere.command-text-v14',
    CommandLight: 'cohere.command-light-text-v14',
    EmbedEnglish: 'cohere.embed-english-v3',
    EmbedMultilingual: 'cohere.embed-multilingual-v3',

    // Meta Llama Models
    Llama3_2_1B: 'meta.llama3-2-1b-instruct-v1:0',
    Llama3_2_3B: 'meta.llama3-2-3b-instruct-v1:0',
    Llama3_2_11B: 'meta.llama3-2-11b-instruct-v1:0',
    Llama3_2_90B: 'meta.llama3-2-90b-instruct-v1:0',
    Llama3_1_8B: 'meta.llama3-1-8b-instruct-v1:0',
    Llama3_1_70B: 'meta.llama3-1-70b-instruct-v1:0',
    Llama3_1_405B: 'meta.llama3-1-405b-instruct-v1:0',

    // Mistral AI Models
    Mistral7B: 'mistral.mistral-7b-instruct-v0:2',
    Mixtral8x7B: 'mistral.mixtral-8x7b-instruct-v0:1',
    MistralLarge: 'mistral.mistral-large-2402-v1:0',

    // Stability AI Models
    StableDiffusionXL: 'stability.stable-diffusion-xl-v1',
  } as const

  /**
   * Common model groups for easier permission management
   */
  static readonly ModelGroups = {
    AllClaude: [
      AI.Models.Claude3_5_Sonnet,
      AI.Models.Claude3_5_Haiku,
      AI.Models.Claude3_Opus,
      AI.Models.Claude3_Sonnet,
      AI.Models.Claude3_Haiku,
    ],
    AllTitan: [
      AI.Models.TitanTextG1Express,
      AI.Models.TitanTextG1Lite,
      AI.Models.TitanEmbedG1Text,
      AI.Models.TitanImageG1,
    ],
    AllLlama: [
      AI.Models.Llama3_2_1B,
      AI.Models.Llama3_2_3B,
      AI.Models.Llama3_2_11B,
      AI.Models.Llama3_2_90B,
      AI.Models.Llama3_1_8B,
      AI.Models.Llama3_1_70B,
      AI.Models.Llama3_1_405B,
    ],
    TextModels: [
      AI.Models.Claude3_5_Sonnet,
      AI.Models.Claude3_5_Haiku,
      AI.Models.TitanTextG1Express,
      AI.Models.Llama3_2_11B,
      AI.Models.Mistral7B,
    ],
    EmbeddingModels: [
      AI.Models.TitanEmbedG1Text,
      AI.Models.EmbedEnglish,
      AI.Models.EmbedMultilingual,
    ],
    ImageModels: [
      AI.Models.TitanImageG1,
      AI.Models.StableDiffusionXL,
    ],
  } as const
}
