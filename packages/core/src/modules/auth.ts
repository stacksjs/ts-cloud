import type {
  CognitoUserPool,
  CognitoUserPoolClient,
  CognitoUserPoolDomain,
  CognitoIdentityPool,
  CognitoIdentityPoolRoleAttachment,
  IAMRole,
} from 'ts-cloud-aws-types'
import type { EnvironmentType } from 'ts-cloud-types'
import { Fn } from '../intrinsic-functions'
import { generateLogicalId, generateResourceName } from '../resource-naming'

export interface UserPoolOptions {
  slug: string
  environment: EnvironmentType
  userPoolName?: string
  aliasAttributes?: ('email' | 'phone_number')[]
  autoVerifiedAttributes?: ('email' | 'phone_number')[]
  passwordPolicy?: PasswordPolicyOptions
  mfaConfiguration?: 'OFF' | 'ON' | 'OPTIONAL'
  emailConfiguration?: EmailConfigurationOptions
  smsConfiguration?: SmsConfigurationOptions
  lambdaTriggers?: LambdaTriggersOptions
  userPoolAddOns?: {
    advancedSecurityMode?: 'OFF' | 'AUDIT' | 'ENFORCED'
  }
  accountRecoverySetting?: {
    recoveryMechanisms: Array<{
      Name: 'verified_email' | 'verified_phone_number' | 'admin_only'
      Priority: number
    }>
  }
}

export interface PasswordPolicyOptions {
  minimumLength?: number
  requireLowercase?: boolean
  requireUppercase?: boolean
  requireNumbers?: boolean
  requireSymbols?: boolean
  temporaryPasswordValidityDays?: number
}

export interface EmailConfigurationOptions {
  emailSendingAccount?: 'COGNITO_DEFAULT' | 'DEVELOPER'
  from?: string
  replyToEmailAddress?: string
  sourceArn?: string
  configurationSet?: string
}

export interface SmsConfigurationOptions {
  externalId: string
  snsCallerArn: string
}

export interface LambdaTriggersOptions {
  preSignUp?: string
  postConfirmation?: string
  preAuthentication?: string
  postAuthentication?: string
  customMessage?: string
  defineAuthChallenge?: string
  createAuthChallenge?: string
  verifyAuthChallengeResponse?: string
  preTokenGeneration?: string
  userMigration?: string
}

export interface UserPoolClientOptions {
  slug: string
  environment: EnvironmentType
  clientName?: string
  generateSecret?: boolean
  refreshTokenValidity?: number
  accessTokenValidity?: number
  idTokenValidity?: number
  tokenValidityUnits?: {
    RefreshToken?: 'seconds' | 'minutes' | 'hours' | 'days'
    AccessToken?: 'seconds' | 'minutes' | 'hours' | 'days'
    IdToken?: 'seconds' | 'minutes' | 'hours' | 'days'
  }
  readAttributes?: string[]
  writeAttributes?: string[]
  explicitAuthFlows?: string[]
  preventUserExistenceErrors?: 'ENABLED' | 'LEGACY'
  enableTokenRevocation?: boolean
  callbackURLs?: string[]
  logoutURLs?: string[]
  allowedOAuthFlows?: ('code' | 'implicit' | 'client_credentials')[]
  allowedOAuthScopes?: string[]
  allowedOAuthFlowsUserPoolClient?: boolean
  supportedIdentityProviders?: string[]
}

export interface UserPoolDomainOptions {
  slug: string
  environment: EnvironmentType
  domain: string
  customDomainConfig?: {
    CertificateArn: string
  }
}

export interface IdentityPoolOptions {
  slug: string
  environment: EnvironmentType
  identityPoolName?: string
  allowUnauthenticatedIdentities?: boolean
  cognitoIdentityProviders?: Array<{
    ClientId: string
    ProviderName: string
    ServerSideTokenCheck?: boolean
  }>
  supportedLoginProviders?: Record<string, string>
  samlProviderARNs?: string[]
  openIdConnectProviderARNs?: string[]
}

export interface IdentityPoolRoleAttachmentOptions {
  slug: string
  environment: EnvironmentType
  authenticatedRole: string
  unauthenticatedRole?: string
  roleMappings?: Record<string, {
    Type: 'Token' | 'Rules'
    AmbiguousRoleResolution?: 'AuthenticatedRole' | 'Deny'
    RulesConfiguration?: {
      Rules: Array<{
        Claim: string
        MatchType: 'Equals' | 'Contains' | 'StartsWith' | 'NotEqual'
        Value: string
        RoleARN: string
      }>
    }
  }>
}

/**
 * Authentication Module - Cognito
 * Provides clean API for user authentication and identity management
 */
export class Auth {
  /**
   * Create a Cognito User Pool
   */
  static createUserPool(options: UserPoolOptions): {
    userPool: CognitoUserPool
    logicalId: string
  } {
    const {
      slug,
      environment,
      userPoolName,
      aliasAttributes,
      autoVerifiedAttributes,
      passwordPolicy,
      mfaConfiguration,
      emailConfiguration,
      smsConfiguration,
      lambdaTriggers,
      userPoolAddOns,
      accountRecoverySetting,
    } = options

    const resourceName = userPoolName || generateResourceName({
      slug,
      environment,
      resourceType: 'user-pool',
    })

    const logicalId = generateLogicalId(resourceName)

    const userPool: CognitoUserPool = {
      Type: 'AWS::Cognito::UserPool',
      Properties: {
        UserPoolName: resourceName,
        Policies: passwordPolicy
          ? {
              PasswordPolicy: {
                MinimumLength: passwordPolicy.minimumLength,
                RequireLowercase: passwordPolicy.requireLowercase,
                RequireUppercase: passwordPolicy.requireUppercase,
                RequireNumbers: passwordPolicy.requireNumbers,
                RequireSymbols: passwordPolicy.requireSymbols,
                TemporaryPasswordValidityDays: passwordPolicy.temporaryPasswordValidityDays,
              },
            }
          : undefined,
        MfaConfiguration: mfaConfiguration,
        Schema: [
          {
            Name: 'email',
            AttributeDataType: 'String',
            Required: true,
            Mutable: false,
          },
        ],
      },
    }

    if (aliasAttributes && aliasAttributes.length > 0) {
      userPool.Properties!.UsernameAttributes = aliasAttributes
    }

    if (autoVerifiedAttributes && autoVerifiedAttributes.length > 0) {
      userPool.Properties!.AutoVerifiedAttributes = autoVerifiedAttributes
    }

    if (emailConfiguration) {
      userPool.Properties!.EmailConfiguration = {
        EmailSendingAccount: emailConfiguration.emailSendingAccount,
        From: emailConfiguration.from,
        ReplyToEmailAddress: emailConfiguration.replyToEmailAddress,
        SourceArn: emailConfiguration.sourceArn,
        ConfigurationSet: emailConfiguration.configurationSet,
      }
    }

    if (smsConfiguration) {
      userPool.Properties!.SmsConfiguration = {
        ExternalId: smsConfiguration.externalId,
        SnsCallerArn: smsConfiguration.snsCallerArn,
      }
    }

    if (lambdaTriggers) {
      userPool.Properties!.LambdaConfig = {
        PreSignUp: lambdaTriggers.preSignUp,
        PostConfirmation: lambdaTriggers.postConfirmation,
        PreAuthentication: lambdaTriggers.preAuthentication,
        PostAuthentication: lambdaTriggers.postAuthentication,
        CustomMessage: lambdaTriggers.customMessage,
        DefineAuthChallenge: lambdaTriggers.defineAuthChallenge,
        CreateAuthChallenge: lambdaTriggers.createAuthChallenge,
        VerifyAuthChallengeResponse: lambdaTriggers.verifyAuthChallengeResponse,
        PreTokenGeneration: lambdaTriggers.preTokenGeneration,
        UserMigration: lambdaTriggers.userMigration,
      }
    }

    if (userPoolAddOns) {
      userPool.Properties!.UserPoolAddOns = {
        AdvancedSecurityMode: userPoolAddOns.advancedSecurityMode,
      }
    }

    if (accountRecoverySetting) {
      userPool.Properties!.AccountRecoverySetting = {
        RecoveryMechanisms: accountRecoverySetting.recoveryMechanisms,
      }
    }

    return { userPool, logicalId }
  }

  /**
   * Create a Cognito User Pool Client
   */
  static createUserPoolClient(
    userPoolLogicalId: string,
    options: UserPoolClientOptions,
  ): {
      client: CognitoUserPoolClient
      logicalId: string
    } {
    const {
      slug,
      environment,
      clientName,
      generateSecret = false,
      refreshTokenValidity,
      accessTokenValidity,
      idTokenValidity,
      tokenValidityUnits,
      readAttributes,
      writeAttributes,
      explicitAuthFlows,
      preventUserExistenceErrors,
      enableTokenRevocation,
      callbackURLs,
      logoutURLs,
      allowedOAuthFlows,
      allowedOAuthScopes,
      allowedOAuthFlowsUserPoolClient,
      supportedIdentityProviders,
    } = options

    const resourceName = clientName || generateResourceName({
      slug,
      environment,
      resourceType: 'user-pool-client',
    })

    const logicalId = generateLogicalId(resourceName)

    const client: CognitoUserPoolClient = {
      Type: 'AWS::Cognito::UserPoolClient',
      Properties: {
        ClientName: resourceName,
        UserPoolId: Fn.Ref(userPoolLogicalId) as unknown as string,
        GenerateSecret: generateSecret,
        RefreshTokenValidity: refreshTokenValidity,
        AccessTokenValidity: accessTokenValidity,
        IdTokenValidity: idTokenValidity,
        TokenValidityUnits: tokenValidityUnits,
        ReadAttributes: readAttributes,
        WriteAttributes: writeAttributes,
        ExplicitAuthFlows: explicitAuthFlows,
        PreventUserExistenceErrors: preventUserExistenceErrors,
        EnableTokenRevocation: enableTokenRevocation,
        CallbackURLs: callbackURLs,
        LogoutURLs: logoutURLs,
        AllowedOAuthFlows: allowedOAuthFlows,
        AllowedOAuthScopes: allowedOAuthScopes,
        AllowedOAuthFlowsUserPoolClient: allowedOAuthFlowsUserPoolClient,
        SupportedIdentityProviders: supportedIdentityProviders,
      },
    }

    return { client, logicalId }
  }

  /**
   * Create a Cognito User Pool Domain
   */
  static createUserPoolDomain(
    userPoolLogicalId: string,
    options: UserPoolDomainOptions,
  ): {
      domain: CognitoUserPoolDomain
      logicalId: string
    } {
    const {
      slug,
      environment,
      domain,
      customDomainConfig,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'user-pool-domain',
    })

    const logicalId = generateLogicalId(resourceName)

    const userPoolDomain: CognitoUserPoolDomain = {
      Type: 'AWS::Cognito::UserPoolDomain',
      Properties: {
        Domain: domain,
        UserPoolId: Fn.Ref(userPoolLogicalId) as unknown as string,
        CustomDomainConfig: customDomainConfig,
      },
    }

    return { domain: userPoolDomain, logicalId }
  }

  /**
   * Create a Cognito Identity Pool
   */
  static createIdentityPool(options: IdentityPoolOptions): {
    identityPool: CognitoIdentityPool
    logicalId: string
  } {
    const {
      slug,
      environment,
      identityPoolName,
      allowUnauthenticatedIdentities = false,
      cognitoIdentityProviders,
      supportedLoginProviders,
      samlProviderARNs,
      openIdConnectProviderARNs,
    } = options

    const resourceName = identityPoolName || generateResourceName({
      slug,
      environment,
      resourceType: 'identity-pool',
    })

    const logicalId = generateLogicalId(resourceName)

    const identityPool: CognitoIdentityPool = {
      Type: 'AWS::Cognito::IdentityPool',
      Properties: {
        IdentityPoolName: resourceName,
        AllowUnauthenticatedIdentities: allowUnauthenticatedIdentities,
        CognitoIdentityProviders: cognitoIdentityProviders,
        SupportedLoginProviders: supportedLoginProviders,
        SamlProviderARNs: samlProviderARNs,
        OpenIdConnectProviderARNs: openIdConnectProviderARNs,
      },
    }

    return { identityPool, logicalId }
  }

  /**
   * Create an Identity Pool Role Attachment
   */
  static createIdentityPoolRoleAttachment(
    identityPoolLogicalId: string,
    options: IdentityPoolRoleAttachmentOptions,
  ): {
      attachment: CognitoIdentityPoolRoleAttachment
      logicalId: string
    } {
    const {
      slug,
      environment,
      authenticatedRole,
      unauthenticatedRole,
      roleMappings,
    } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'identity-pool-role-attachment',
    })

    const logicalId = generateLogicalId(resourceName)

    const roles: Record<string, string> = {
      authenticated: authenticatedRole,
    }

    if (unauthenticatedRole) {
      roles.unauthenticated = unauthenticatedRole
    }

    const attachment: CognitoIdentityPoolRoleAttachment = {
      Type: 'AWS::Cognito::IdentityPoolRoleAttachment',
      Properties: {
        IdentityPoolId: Fn.Ref(identityPoolLogicalId) as unknown as string,
        Roles: roles,
        RoleMappings: roleMappings,
      },
    }

    return { attachment, logicalId }
  }

  /**
   * Create IAM role for authenticated users
   */
  static createAuthenticatedRole(options: {
    slug: string
    environment: EnvironmentType
    identityPoolLogicalId: string
  }): {
    role: IAMRole
    logicalId: string
  } {
    const { slug, environment, identityPoolLogicalId } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'cognito-authenticated-role',
    })

    const logicalId = generateLogicalId(resourceName)

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
                Federated: 'cognito-identity.amazonaws.com',
              },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'cognito-identity.amazonaws.com:aud': Fn.Ref(identityPoolLogicalId) as unknown as string,
                },
                'ForAnyValue:StringLike': {
                  'cognito-identity.amazonaws.com:amr': 'authenticated',
                },
              },
            },
          ],
        },
        Policies: [
          {
            PolicyName: 'CognitoAuthenticatedPolicy',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: [
                    'cognito-sync:*',
                    'cognito-identity:*',
                  ],
                  Resource: '*',
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
   * Create IAM role for unauthenticated users
   */
  static createUnauthenticatedRole(options: {
    slug: string
    environment: EnvironmentType
    identityPoolLogicalId: string
  }): {
    role: IAMRole
    logicalId: string
  } {
    const { slug, environment, identityPoolLogicalId } = options

    const resourceName = generateResourceName({
      slug,
      environment,
      resourceType: 'cognito-unauthenticated-role',
    })

    const logicalId = generateLogicalId(resourceName)

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
                Federated: 'cognito-identity.amazonaws.com',
              },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'cognito-identity.amazonaws.com:aud': Fn.Ref(identityPoolLogicalId) as unknown as string,
                },
                'ForAnyValue:StringLike': {
                  'cognito-identity.amazonaws.com:amr': 'unauthenticated',
                },
              },
            },
          ],
        },
        Policies: [
          {
            PolicyName: 'CognitoUnauthenticatedPolicy',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: [
                    'cognito-sync:*',
                  ],
                  Resource: '*',
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
   * Common password policies
   */
  static readonly PasswordPolicies = {
    /**
     * Relaxed password policy for development
     */
    relaxed: (): PasswordPolicyOptions => ({
      minimumLength: 8,
      requireLowercase: false,
      requireUppercase: false,
      requireNumbers: false,
      requireSymbols: false,
      temporaryPasswordValidityDays: 7,
    }),

    /**
     * Standard password policy
     */
    standard: (): PasswordPolicyOptions => ({
      minimumLength: 8,
      requireLowercase: true,
      requireUppercase: true,
      requireNumbers: true,
      requireSymbols: false,
      temporaryPasswordValidityDays: 3,
    }),

    /**
     * Strict password policy for production
     */
    strict: (): PasswordPolicyOptions => ({
      minimumLength: 12,
      requireLowercase: true,
      requireUppercase: true,
      requireNumbers: true,
      requireSymbols: true,
      temporaryPasswordValidityDays: 1,
    }),
  } as const

  /**
   * Common authentication flows
   */
  static readonly AuthFlows = {
    /**
     * Standard auth flows (SRP, refresh token)
     */
    standard: [
      'ALLOW_USER_SRP_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ],

    /**
     * Admin auth flows (for server-side authentication)
     */
    admin: [
      'ALLOW_ADMIN_USER_PASSWORD_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ],

    /**
     * Custom auth flows
     */
    custom: [
      'ALLOW_CUSTOM_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ],

    /**
     * All auth flows (not recommended for production)
     */
    all: [
      'ALLOW_USER_SRP_AUTH',
      'ALLOW_USER_PASSWORD_AUTH',
      'ALLOW_ADMIN_USER_PASSWORD_AUTH',
      'ALLOW_CUSTOM_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ],
  } as const

  /**
   * Common OAuth scopes
   */
  static readonly OAuthScopes = {
    /**
     * Basic OAuth scopes
     */
    basic: [
      'openid',
      'email',
      'profile',
    ],

    /**
     * All standard scopes
     */
    all: [
      'openid',
      'email',
      'profile',
      'phone',
      'aws.cognito.signin.user.admin',
    ],
  } as const

  /**
   * Common use cases
   */
  static readonly UseCases = {
    /**
     * Create a basic user pool for web application
     */
    webApp: (slug: string, environment: EnvironmentType, callbackUrl: string): {
      userPool: CognitoUserPool
      poolId: string
      client: CognitoUserPoolClient
      clientId: string
    } => {
      const { userPool, logicalId: poolId } = Auth.createUserPool({
        slug,
        environment,
        aliasAttributes: ['email'],
        autoVerifiedAttributes: ['email'],
        passwordPolicy: Auth.PasswordPolicies.standard(),
        mfaConfiguration: 'OPTIONAL',
      })

      const { client, logicalId: clientId } = Auth.createUserPoolClient(poolId, {
        slug,
        environment,
        explicitAuthFlows: [...Auth.AuthFlows.standard],
        callbackURLs: [callbackUrl],
        allowedOAuthFlows: ['code'],
        allowedOAuthScopes: [...Auth.OAuthScopes.basic],
        allowedOAuthFlowsUserPoolClient: true,
      })

      return { userPool, poolId, client, clientId }
    },

    /**
     * Create a user pool with identity pool for mobile app
     */
    mobileApp: (slug: string, environment: EnvironmentType): {
      userPool: CognitoUserPool
      poolId: string
      client: CognitoUserPoolClient
      clientId: string
      identityPool: CognitoIdentityPool
      identityPoolId: string
      authRole: IAMRole
      authRoleId: string
      attachment: CognitoIdentityPoolRoleAttachment
      attachmentId: string
    } => {
      const { userPool, logicalId: poolId } = Auth.createUserPool({
        slug,
        environment,
        aliasAttributes: ['email'],
        autoVerifiedAttributes: ['email'],
        passwordPolicy: Auth.PasswordPolicies.standard(),
        mfaConfiguration: 'OPTIONAL',
      })

      const { client, logicalId: clientId } = Auth.createUserPoolClient(poolId, {
        slug,
        environment,
        explicitAuthFlows: [...Auth.AuthFlows.standard],
      })

      const { identityPool, logicalId: identityPoolId } = Auth.createIdentityPool({
        slug,
        environment,
        allowUnauthenticatedIdentities: false,
        cognitoIdentityProviders: [
          {
            ClientId: Fn.Ref(clientId) as unknown as string,
            ProviderName: Fn.GetAtt(poolId, 'ProviderName') as unknown as string,
          },
        ],
      })

      const { role: authRole, logicalId: authRoleId } = Auth.createAuthenticatedRole({
        slug,
        environment,
        identityPoolLogicalId: identityPoolId,
      })

      const { attachment, logicalId: attachmentId } = Auth.createIdentityPoolRoleAttachment(
        identityPoolId,
        {
          slug,
          environment,
          authenticatedRole: Fn.GetAtt(authRoleId, 'Arn') as unknown as string,
        },
      )

      return {
        userPool,
        poolId,
        client,
        clientId,
        identityPool,
        identityPoolId,
        authRole,
        authRoleId,
        attachment,
        attachmentId,
      }
    },
  } as const
}
