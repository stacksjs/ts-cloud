import type {
  IAMAccessKey,
  IAMGroup,
  IAMInstanceProfile,
  IAMManagedPolicy,
  IAMRole,
  IAMUser,
} from '@ts-cloud/aws-types'
import type { EnvironmentType } from '@ts-cloud/types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface PolicyStatement {
  sid?: string
  effect?: 'Allow' | 'Deny'
  actions: string | string[]
  resources: string | string[]
  conditions?: Record<string, unknown>
}

export interface UserOptions {
  slug: string
  environment: EnvironmentType
  userName?: string
  groups?: string[]
  managedPolicyArns?: string[]
}

export interface RoleOptions {
  slug: string
  environment: EnvironmentType
  roleName?: string
  servicePrincipal?: string | string[]
  awsPrincipal?: string | string[]
  managedPolicyArns?: string[]
}

export interface GroupOptions {
  slug: string
  environment: EnvironmentType
  groupName?: string
  managedPolicyArns?: string[]
}

export interface ManagedPolicyOptions {
  slug: string
  environment: EnvironmentType
  policyName?: string
  description?: string
  statements: PolicyStatement[]
}

/**
 * Permissions Module - IAM (Identity and Access Management)
 * Provides clean API for creating users, roles, policies, and groups
 */
export class Permissions {
  /**
   * Create an IAM user
   */
  static createUser(options: UserOptions): {
    user: IAMUser
    logicalId: string
  } {
    const {
      slug,
      environment,
      userName,
      groups,
      managedPolicyArns,
    } = options

    const resourceName = userName || generateResourceName({
      slug,
      environment,
      resourceType: 'user',
    })

    const logicalId = generateLogicalId(resourceName)

    const user: IAMUser = {
      Type: 'AWS::IAM::User',
      Properties: {
        UserName: resourceName,
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (groups && groups.length > 0) {
      user.Properties.Groups = groups
    }

    if (managedPolicyArns && managedPolicyArns.length > 0) {
      user.Properties.ManagedPolicyArns = managedPolicyArns
    }

    return { user, logicalId }
  }

  /**
   * Create an IAM role
   */
  static createRole(options: RoleOptions): {
    role: IAMRole
    logicalId: string
  } {
    const {
      slug,
      environment,
      roleName,
      servicePrincipal,
      awsPrincipal,
      managedPolicyArns,
    } = options

    const resourceName = roleName || generateResourceName({
      slug,
      environment,
      resourceType: 'role',
    })

    const logicalId = generateLogicalId(resourceName)

    const principal: IAMRole['Properties']['AssumeRolePolicyDocument']['Statement'][0]['Principal'] = {}

    if (servicePrincipal) {
      principal.Service = servicePrincipal
    }

    if (awsPrincipal) {
      principal.AWS = awsPrincipal
    }

    const role: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: resourceName,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: principal,
              Action: 'sts:AssumeRole',
            },
          ],
        },
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
        ],
      },
    }

    if (managedPolicyArns && managedPolicyArns.length > 0) {
      role.Properties.ManagedPolicyArns = managedPolicyArns
    }

    return { role, logicalId }
  }

  /**
   * Create an IAM group
   */
  static createGroup(options: GroupOptions): {
    group: IAMGroup
    logicalId: string
  } {
    const {
      slug,
      environment,
      groupName,
      managedPolicyArns,
    } = options

    const resourceName = groupName || generateResourceName({
      slug,
      environment,
      resourceType: 'group',
    })

    const logicalId = generateLogicalId(resourceName)

    const group: IAMGroup = {
      Type: 'AWS::IAM::Group',
      Properties: {
        GroupName: resourceName,
      },
    }

    if (managedPolicyArns && managedPolicyArns.length > 0) {
      group.Properties.ManagedPolicyArns = managedPolicyArns
    }

    return { group, logicalId }
  }

  /**
   * Create a managed policy
   */
  static createPolicy(options: ManagedPolicyOptions): {
    policy: IAMManagedPolicy
    logicalId: string
  } {
    const {
      slug,
      environment,
      policyName,
      description,
      statements,
    } = options

    const resourceName = policyName || generateResourceName({
      slug,
      environment,
      resourceType: 'policy',
    })

    const logicalId = generateLogicalId(resourceName)

    const policyStatements = statements.map(stmt => ({
      Sid: stmt.sid,
      Effect: stmt.effect || 'Allow',
      Action: stmt.actions,
      Resource: stmt.resources,
      Condition: stmt.conditions,
    }))

    const policy: IAMManagedPolicy = {
      Type: 'AWS::IAM::ManagedPolicy',
      Properties: {
        ManagedPolicyName: resourceName,
        Description: description || `Managed policy for ${resourceName}`,
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: policyStatements,
        },
      },
    }

    return { policy, logicalId }
  }

  /**
   * Attach a policy to a role
   */
  static attachPolicyToRole(
    role: IAMRole,
    policyArn: string,
  ): IAMRole {
    if (!role.Properties.ManagedPolicyArns) {
      role.Properties.ManagedPolicyArns = []
    }

    if (!role.Properties.ManagedPolicyArns.includes(policyArn)) {
      role.Properties.ManagedPolicyArns.push(policyArn)
    }

    return role
  }

  /**
   * Attach a policy to a user
   */
  static attachPolicyToUser(
    user: IAMUser,
    policyArn: string,
  ): IAMUser {
    if (!user.Properties.ManagedPolicyArns) {
      user.Properties.ManagedPolicyArns = []
    }

    if (!user.Properties.ManagedPolicyArns.includes(policyArn)) {
      user.Properties.ManagedPolicyArns.push(policyArn)
    }

    return user
  }

  /**
   * Attach a policy to a group
   */
  static attachPolicyToGroup(
    group: IAMGroup,
    policyArn: string,
  ): IAMGroup {
    if (!group.Properties.ManagedPolicyArns) {
      group.Properties.ManagedPolicyArns = []
    }

    if (!group.Properties.ManagedPolicyArns.includes(policyArn)) {
      group.Properties.ManagedPolicyArns.push(policyArn)
    }

    return group
  }

  /**
   * Add inline policy to a role
   */
  static addInlinePolicyToRole(
    role: IAMRole,
    policyName: string,
    statements: PolicyStatement[],
  ): IAMRole {
    if (!role.Properties.Policies) {
      role.Properties.Policies = []
    }

    const policyStatements = statements.map(stmt => ({
      Effect: stmt.effect || 'Allow',
      Action: stmt.actions,
      Resource: stmt.resources,
    }))

    role.Properties.Policies.push({
      PolicyName: policyName,
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: policyStatements,
      },
    })

    return role
  }

  /**
   * Add inline policy to a user
   */
  static addInlinePolicyToUser(
    user: IAMUser,
    policyName: string,
    statements: PolicyStatement[],
  ): IAMUser {
    if (!user.Properties.Policies) {
      user.Properties.Policies = []
    }

    const policyStatements = statements.map(stmt => ({
      Effect: stmt.effect || 'Allow',
      Action: stmt.actions,
      Resource: stmt.resources,
    }))

    user.Properties.Policies.push({
      PolicyName: policyName,
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: policyStatements,
      },
    })

    return user
  }

  /**
   * Create an access key for programmatic access
   */
  static createAccessKey(
    userLogicalId: string,
    options: {
      slug: string
      environment: EnvironmentType
      status?: 'Active' | 'Inactive'
    },
  ): {
      accessKey: IAMAccessKey
      logicalId: string
    } {
    const { slug, environment, status = 'Active' } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'access-key',
    })

    const logicalId = generateLogicalId(resourceName)

    const accessKey: IAMAccessKey = {
      Type: 'AWS::IAM::AccessKey',
      Properties: {
        UserName: Fn.Ref(userLogicalId) as unknown as string,
        Status: status,
      },
    }

    return { accessKey, logicalId }
  }

  /**
   * Create an instance profile for EC2
   */
  static createInstanceProfile(
    roleLogicalId: string,
    options: {
      slug: string
      environment: EnvironmentType
      profileName?: string
    },
  ): {
      instanceProfile: IAMInstanceProfile
      logicalId: string
    } {
    const { slug, environment, profileName } = options

    const resourceName = profileName || generateResourceName({
      slug,
      environment,
      resourceType: 'instance-profile',
    })

    const logicalId = generateLogicalId(resourceName)

    const instanceProfile: IAMInstanceProfile = {
      Type: 'AWS::IAM::InstanceProfile',
      Properties: {
        InstanceProfileName: resourceName,
        Roles: [Fn.Ref(roleLogicalId) as unknown as string],
      },
    }

    return { instanceProfile, logicalId }
  }

  /**
   * AWS Managed Policies (common)
   */
  static readonly ManagedPolicies = {
    // Administrator Access
    AdministratorAccess: 'arn:aws:iam::aws:policy/AdministratorAccess',

    // Power User
    PowerUserAccess: 'arn:aws:iam::aws:policy/PowerUserAccess',

    // Read Only
    ReadOnlyAccess: 'arn:aws:iam::aws:policy/ReadOnlyAccess',

    // S3
    S3FullAccess: 'arn:aws:iam::aws:policy/AmazonS3FullAccess',
    S3ReadOnlyAccess: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',

    // DynamoDB
    DynamoDBFullAccess: 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess',
    DynamoDBReadOnlyAccess: 'arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess',

    // RDS
    RDSFullAccess: 'arn:aws:iam::aws:policy/AmazonRDSFullAccess',
    RDSReadOnlyAccess: 'arn:aws:iam::aws:policy/AmazonRDSReadOnlyAccess',

    // Lambda
    LambdaFullAccess: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess',
    LambdaReadOnlyAccess: 'arn:aws:iam::aws:policy/AWSLambda_ReadOnlyAccess',
    LambdaBasicExecutionRole: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    LambdaVPCAccessExecutionRole: 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole',

    // EC2
    EC2FullAccess: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
    EC2ReadOnlyAccess: 'arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess',
    EC2ContainerRegistryReadOnly: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
    EC2ContainerRegistryPowerUser: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser',

    // ECS
    ECSTaskExecutionRole: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    ECSFullAccess: 'arn:aws:iam::aws:policy/AmazonECS_FullAccess',

    // CloudWatch
    CloudWatchFullAccess: 'arn:aws:iam::aws:policy/CloudWatchFullAccess',
    CloudWatchLogsFullAccess: 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess',

    // SES
    SESFullAccess: 'arn:aws:iam::aws:policy/AmazonSESFullAccess',

    // SNS
    SNSFullAccess: 'arn:aws:iam::aws:policy/AmazonSNSFullAccess',

    // SQS
    SQSFullAccess: 'arn:aws:iam::aws:policy/AmazonSQSFullAccess',

    // Secrets Manager
    SecretsManagerReadWrite: 'arn:aws:iam::aws:policy/SecretsManagerReadWrite',
  } as const

  /**
   * Common service principals
   */
  static readonly ServicePrincipals = {
    Lambda: 'lambda.amazonaws.com',
    EC2: 'ec2.amazonaws.com',
    ECS: 'ecs.amazonaws.com',
    ECSTaskExecution: 'ecs-tasks.amazonaws.com',
    APIGateway: 'apigateway.amazonaws.com',
    Events: 'events.amazonaws.com',
    States: 'states.amazonaws.com',
    CodeBuild: 'codebuild.amazonaws.com',
    CodeDeploy: 'codedeploy.amazonaws.com',
    CloudFormation: 'cloudformation.amazonaws.com',
  } as const

  /**
   * Create a CI/CD user with deployment permissions
   */
  static createCiCdUser(options: {
    slug: string
    environment: EnvironmentType
    permissions: {
      s3Buckets?: string[]
      cloudFrontDistributions?: string[]
      ecrRepositories?: string[]
      ecsServices?: string[]
      cloudFormationStacks?: string[]
      lambdaFunctions?: string[]
      secretsManagerSecrets?: string[]
    }
    createAccessKey?: boolean
  }): {
    user: IAMUser
    accessKey?: IAMAccessKey
    policy: IAMManagedPolicy
    userLogicalId: string
    accessKeyLogicalId?: string
    policyLogicalId: string
    resources: Record<string, any>
  } {
    const {
      slug,
      environment,
      permissions,
      createAccessKey = true,
    } = options

    const resources: Record<string, any> = {}

    // Build policy statements based on permissions
    const statements: PolicyStatement[] = []

    // S3 permissions
    if (permissions.s3Buckets && permissions.s3Buckets.length > 0) {
      statements.push({
        sid: 'S3Access',
        actions: [
          's3:GetBucketLocation',
          's3:ListBucket',
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucketMultipartUploads',
          's3:AbortMultipartUpload',
        ],
        resources: [
          ...permissions.s3Buckets,
          ...permissions.s3Buckets.map(b => `${b}/*`),
        ],
      })
    }

    // CloudFront permissions
    if (permissions.cloudFrontDistributions && permissions.cloudFrontDistributions.length > 0) {
      statements.push({
        sid: 'CloudFrontAccess',
        actions: [
          'cloudfront:CreateInvalidation',
          'cloudfront:GetInvalidation',
          'cloudfront:ListInvalidations',
          'cloudfront:GetDistribution',
        ],
        resources: permissions.cloudFrontDistributions,
      })
    }

    // ECR permissions
    if (permissions.ecrRepositories && permissions.ecrRepositories.length > 0) {
      statements.push({
        sid: 'ECRAccess',
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:GetRepositoryPolicy',
          'ecr:DescribeRepositories',
          'ecr:ListImages',
          'ecr:DescribeImages',
          'ecr:BatchGetImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
        ],
        resources: permissions.ecrRepositories,
      })

      // ECR login requires permission on all resources
      statements.push({
        sid: 'ECRLogin',
        actions: ['ecr:GetAuthorizationToken'],
        resources: '*',
      })
    }

    // ECS permissions
    if (permissions.ecsServices && permissions.ecsServices.length > 0) {
      statements.push({
        sid: 'ECSAccess',
        actions: [
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'ecs:DescribeTasks',
          'ecs:ListTasks',
          'ecs:RegisterTaskDefinition',
          'ecs:UpdateService',
          'ecs:RunTask',
          'ecs:StopTask',
        ],
        resources: permissions.ecsServices,
      })

      // Task definition registration requires broader permissions
      statements.push({
        sid: 'ECSTaskDefinitions',
        actions: [
          'ecs:RegisterTaskDefinition',
          'ecs:DeregisterTaskDefinition',
        ],
        resources: '*',
      })

      // IAM PassRole for ECS
      statements.push({
        sid: 'ECSPassRole',
        actions: ['iam:PassRole'],
        resources: '*',
        conditions: {
          StringLike: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
        },
      })
    }

    // CloudFormation permissions
    if (permissions.cloudFormationStacks && permissions.cloudFormationStacks.length > 0) {
      statements.push({
        sid: 'CloudFormationAccess',
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:ListStackResources',
          'cloudformation:ValidateTemplate',
        ],
        resources: permissions.cloudFormationStacks,
      })
    }

    // Lambda permissions
    if (permissions.lambdaFunctions && permissions.lambdaFunctions.length > 0) {
      statements.push({
        sid: 'LambdaAccess',
        actions: [
          'lambda:GetFunction',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:PublishVersion',
          'lambda:UpdateAlias',
          'lambda:CreateAlias',
        ],
        resources: permissions.lambdaFunctions,
      })
    }

    // Secrets Manager permissions
    if (permissions.secretsManagerSecrets && permissions.secretsManagerSecrets.length > 0) {
      statements.push({
        sid: 'SecretsManagerAccess',
        actions: [
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        resources: permissions.secretsManagerSecrets,
      })
    }

    // Create the policy
    const { policy, logicalId: policyLogicalId } = Permissions.createPolicy({
      slug,
      environment,
      policyName: generateResourceName({
        slug,
        environment,
        resourceType: 'cicd-policy',
      }),
      description: `CI/CD deployment policy for ${slug} (${environment})`,
      statements,
    })
    resources[policyLogicalId] = policy

    // Create the user
    const { user, logicalId: userLogicalId } = Permissions.createUser({
      slug,
      environment,
      userName: generateResourceName({
        slug,
        environment,
        resourceType: 'cicd-user',
      }),
      managedPolicyArns: [Fn.Ref(policyLogicalId) as unknown as string],
    })
    resources[userLogicalId] = user

    // Create access key if requested
    let accessKey: IAMAccessKey | undefined
    let accessKeyLogicalId: string | undefined

    if (createAccessKey) {
      const keyResult = Permissions.createAccessKey(userLogicalId, { slug, environment })
      accessKey = keyResult.accessKey
      accessKeyLogicalId = keyResult.logicalId
      resources[accessKeyLogicalId] = accessKey
    }

    return {
      user,
      accessKey,
      policy,
      userLogicalId,
      accessKeyLogicalId,
      policyLogicalId,
      resources,
    }
  }

  /**
   * Create a cross-account access role
   */
  static createCrossAccountRole(options: {
    slug: string
    environment: EnvironmentType
    trustedAccountIds: string[]
    externalId?: string
    permissions: PolicyStatement[]
    maxSessionDuration?: number
  }): {
    role: IAMRole
    policy: IAMManagedPolicy
    roleLogicalId: string
    policyLogicalId: string
    resources: Record<string, any>
  } {
    const {
      slug,
      environment,
      trustedAccountIds,
      externalId,
      permissions,
      maxSessionDuration = 3600,
    } = options

    const resources: Record<string, any> = {}

    // Create the policy
    const { policy, logicalId: policyLogicalId } = Permissions.createPolicy({
      slug,
      environment,
      policyName: generateResourceName({
        slug,
        environment,
        resourceType: 'cross-account-policy',
      }),
      description: `Cross-account access policy for ${slug} (${environment})`,
      statements: permissions,
    })
    resources[policyLogicalId] = policy

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'cross-account-role',
    })

    const roleLogicalId = generateLogicalId(resourceName)

    // Build trust policy
    const conditions: Record<string, any> = {}
    if (externalId) {
      conditions.StringEquals = {
        'sts:ExternalId': externalId,
      }
    }

    const role: IAMRole = {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: resourceName,
        MaxSessionDuration: maxSessionDuration,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: {
              AWS: trustedAccountIds.map(id => `arn:aws:iam::${id}:root`),
            },
            Action: 'sts:AssumeRole',
            ...(Object.keys(conditions).length > 0 ? { Condition: conditions } : {}),
          }],
        },
        ManagedPolicyArns: [Fn.Ref(policyLogicalId) as unknown as string],
        Tags: [
          { Key: 'Name', Value: resourceName },
          { Key: 'Environment', Value: environment },
          { Key: 'Purpose', Value: 'Cross-Account Access' },
        ],
      },
    }
    resources[roleLogicalId] = role

    return {
      role,
      policy,
      roleLogicalId,
      policyLogicalId,
      resources,
    }
  }

  /**
   * Create a CLI access user with minimal permissions
   */
  static createCliUser(options: {
    slug: string
    environment: EnvironmentType
    permissions?: 'readonly' | 'deploy' | 'admin'
  }): {
    user: IAMUser
    accessKey: IAMAccessKey
    policy?: IAMManagedPolicy
    userLogicalId: string
    accessKeyLogicalId: string
    policyLogicalId?: string
    resources: Record<string, any>
  } {
    const {
      slug,
      environment,
      permissions = 'readonly',
    } = options

    const resources: Record<string, any> = {}

    // Define statements based on permission level
    let statements: PolicyStatement[] = []
    let managedPolicyArns: string[] = []

    switch (permissions) {
      case 'readonly':
        managedPolicyArns = [Permissions.ManagedPolicies.ReadOnlyAccess]
        break

      case 'deploy':
        statements = [
          {
            sid: 'S3Deploy',
            actions: ['s3:*'],
            resources: '*',
          },
          {
            sid: 'CloudFrontDeploy',
            actions: ['cloudfront:*'],
            resources: '*',
          },
          {
            sid: 'ECSDeploy',
            actions: ['ecs:*'],
            resources: '*',
          },
          {
            sid: 'ECRDeploy',
            actions: ['ecr:*'],
            resources: '*',
          },
          {
            sid: 'LambdaDeploy',
            actions: ['lambda:*'],
            resources: '*',
          },
          {
            sid: 'CloudFormationDeploy',
            actions: ['cloudformation:*'],
            resources: '*',
          },
          {
            sid: 'IAMPassRole',
            actions: ['iam:PassRole'],
            resources: '*',
          },
        ]
        break

      case 'admin':
        managedPolicyArns = [Permissions.ManagedPolicies.AdministratorAccess]
        break
    }

    // Create policy if needed
    let policy: IAMManagedPolicy | undefined
    let policyLogicalId: string | undefined

    if (statements.length > 0) {
      const policyResult = Permissions.createPolicy({
        slug,
        environment,
        policyName: generateResourceName({
          slug,
          environment,
          resourceType: 'cli-policy',
        }),
        description: `CLI access policy for ${slug} (${environment})`,
        statements,
      })
      policy = policyResult.policy
      policyLogicalId = policyResult.logicalId
      resources[policyLogicalId] = policy
      managedPolicyArns = [Fn.Ref(policyLogicalId) as unknown as string]
    }

    // Create user
    const { user, logicalId: userLogicalId } = Permissions.createUser({
      slug,
      environment,
      userName: generateResourceName({
        slug,
        environment,
        resourceType: 'cli-user',
      }),
      managedPolicyArns,
    })
    resources[userLogicalId] = user

    // Create access key
    const { accessKey, logicalId: accessKeyLogicalId } = Permissions.createAccessKey(
      userLogicalId,
      { slug, environment },
    )
    resources[accessKeyLogicalId] = accessKey

    return {
      user,
      accessKey,
      policy,
      userLogicalId,
      accessKeyLogicalId,
      policyLogicalId,
      resources,
    }
  }

  /**
   * Common CI/CD policy templates
   */
  static readonly CiCdPolicies = {
    /**
     * S3 static site deployment policy
     */
    s3Deployment: (bucketArns: string[]): PolicyStatement[] => [
      {
        sid: 'S3ListBuckets',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: bucketArns,
      },
      {
        sid: 'S3Objects',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: bucketArns.map(arn => `${arn}/*`),
      },
    ],

    /**
     * CloudFront invalidation policy
     */
    cloudFrontInvalidation: (distributionArns: string[]): PolicyStatement[] => [
      {
        sid: 'CloudFrontInvalidation',
        actions: [
          'cloudfront:CreateInvalidation',
          'cloudfront:GetInvalidation',
          'cloudfront:ListInvalidations',
        ],
        resources: distributionArns,
      },
    ],

    /**
     * ECS deployment policy
     */
    ecsDeployment: (): PolicyStatement[] => [
      {
        sid: 'ECSServices',
        actions: [
          'ecs:DescribeServices',
          'ecs:UpdateService',
          'ecs:DescribeTaskDefinition',
          'ecs:RegisterTaskDefinition',
        ],
        resources: '*',
      },
      {
        sid: 'ECSPassRole',
        actions: ['iam:PassRole'],
        resources: '*',
        conditions: {
          StringLike: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
        },
      },
    ],

    /**
     * ECR push policy
     */
    ecrPush: (repositoryArns: string[]): PolicyStatement[] => [
      {
        sid: 'ECRAuth',
        actions: ['ecr:GetAuthorizationToken'],
        resources: '*',
      },
      {
        sid: 'ECRPush',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
        ],
        resources: repositoryArns,
      },
    ],

    /**
     * Lambda deployment policy
     */
    lambdaDeployment: (functionArns: string[]): PolicyStatement[] => [
      {
        sid: 'LambdaDeploy',
        actions: [
          'lambda:GetFunction',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:PublishVersion',
        ],
        resources: functionArns,
      },
    ],

    /**
     * CloudFormation deployment policy
     */
    cloudFormationDeployment: (stackArns: string[]): PolicyStatement[] => [
      {
        sid: 'CloudFormationDeploy',
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:GetTemplate',
        ],
        resources: stackArns,
      },
    ],
  }
}
