/**
 * AWS Cognito Types
 * CloudFormation resource types for Amazon Cognito
*/

import type { CloudFormationResource } from './index'

export interface CognitoUserPool extends CloudFormationResource {
  Type: 'AWS::Cognito::UserPool'
  Properties?: {
    UserPoolName?: string
    Policies?: {
      PasswordPolicy?: {
        MinimumLength?: number
        RequireLowercase?: boolean
        RequireUppercase?: boolean
        RequireNumbers?: boolean
        RequireSymbols?: boolean
        TemporaryPasswordValidityDays?: number
      }
    }
    MfaConfiguration?: 'OFF' | 'ON' | 'OPTIONAL'
    UsernameAttributes?: ('email' | 'phone_number')[]
    AutoVerifiedAttributes?: ('email' | 'phone_number')[]
    Schema?: Array<{
      Name: string
      AttributeDataType?: 'String' | 'Number' | 'DateTime' | 'Boolean'
      Required?: boolean
      Mutable?: boolean
      StringAttributeConstraints?: {
        MinLength?: string
        MaxLength?: string
      }
      NumberAttributeConstraints?: {
        MinValue?: string
        MaxValue?: string
      }
    }>
    EmailConfiguration?: {
      EmailSendingAccount?: 'COGNITO_DEFAULT' | 'DEVELOPER'
      From?: string
      ReplyToEmailAddress?: string
      SourceArn?: string
      ConfigurationSet?: string
    }
    SmsConfiguration?: {
      ExternalId?: string
      SnsCallerArn?: string
    }
    LambdaConfig?: {
      PreSignUp?: string
      PostConfirmation?: string
      PreAuthentication?: string
      PostAuthentication?: string
      CustomMessage?: string
      DefineAuthChallenge?: string
      CreateAuthChallenge?: string
      VerifyAuthChallengeResponse?: string
      PreTokenGeneration?: string
      UserMigration?: string
    }
    UserPoolAddOns?: {
      AdvancedSecurityMode?: 'OFF' | 'AUDIT' | 'ENFORCED'
    }
    AccountRecoverySetting?: {
      RecoveryMechanisms?: Array<{
        Name?: 'verified_email' | 'verified_phone_number' | 'admin_only'
        Priority?: number
      }>
    }
    AdminCreateUserConfig?: {
      AllowAdminCreateUserOnly?: boolean
      InviteMessageTemplate?: {
        EmailMessage?: string
        EmailSubject?: string
        SMSMessage?: string
      }
    }
    Tags?: Array<{
      Key: string
      Value: string
    }>
  }
}

export interface CognitoUserPoolClient extends CloudFormationResource {
  Type: 'AWS::Cognito::UserPoolClient'
  Properties: {
    ClientName?: string
    UserPoolId: string | { Ref: string }
    GenerateSecret?: boolean
    RefreshTokenValidity?: number
    AccessTokenValidity?: number
    IdTokenValidity?: number
    TokenValidityUnits?: {
      RefreshToken?: 'seconds' | 'minutes' | 'hours' | 'days'
      AccessToken?: 'seconds' | 'minutes' | 'hours' | 'days'
      IdToken?: 'seconds' | 'minutes' | 'hours' | 'days'
    }
    ReadAttributes?: string[]
    WriteAttributes?: string[]
    ExplicitAuthFlows?: string[]
    PreventUserExistenceErrors?: 'ENABLED' | 'LEGACY'
    EnableTokenRevocation?: boolean
    CallbackURLs?: string[]
    LogoutURLs?: string[]
    AllowedOAuthFlows?: ('code' | 'implicit' | 'client_credentials')[]
    AllowedOAuthScopes?: string[]
    AllowedOAuthFlowsUserPoolClient?: boolean
    SupportedIdentityProviders?: string[]
    DefaultRedirectURI?: string
    AnalyticsConfiguration?: {
      ApplicationArn?: string
      ApplicationId?: string
      ExternalId?: string
      RoleArn?: string
      UserDataShared?: boolean
    }
  }
}

export interface CognitoUserPoolDomain extends CloudFormationResource {
  Type: 'AWS::Cognito::UserPoolDomain'
  Properties: {
    Domain: string
    UserPoolId: string | { Ref: string }
    CustomDomainConfig?: {
      CertificateArn?: string
    }
  }
}

export interface CognitoIdentityPool extends CloudFormationResource {
  Type: 'AWS::Cognito::IdentityPool'
  Properties: {
    IdentityPoolName?: string
    AllowUnauthenticatedIdentities: boolean
    CognitoIdentityProviders?: Array<{
      ClientId?: string
      ProviderName?: string
      ServerSideTokenCheck?: boolean
    }>
    SupportedLoginProviders?: Record<string, string>
    SamlProviderARNs?: string[]
    OpenIdConnectProviderARNs?: string[]
    CognitoStreams?: {
      StreamingStatus?: 'ENABLED' | 'DISABLED'
      StreamName?: string
      RoleArn?: string
    }
    PushSync?: {
      ApplicationArns?: string[]
      RoleArn?: string
    }
    CognitoEvents?: Record<string, string>
    DeveloperProviderName?: string
    AllowClassicFlow?: boolean
  }
}

export interface CognitoIdentityPoolRoleAttachment extends CloudFormationResource {
  Type: 'AWS::Cognito::IdentityPoolRoleAttachment'
  Properties: {
    IdentityPoolId: string | { Ref: string }
    Roles?: Record<string, string>
    RoleMappings?: Record<string, {
      Type?: 'Token' | 'Rules'
      AmbiguousRoleResolution?: 'AuthenticatedRole' | 'Deny'
      IdentityProvider?: string
      RulesConfiguration?: {
        Rules?: Array<{
          Claim?: string
          MatchType?: 'Equals' | 'Contains' | 'StartsWith' | 'NotEqual'
          Value?: string
          RoleARN?: string
        }>
      }
    }>
  }
}

export interface CognitoUserPoolGroup extends CloudFormationResource {
  Type: 'AWS::Cognito::UserPoolGroup'
  Properties: {
    GroupName: string
    UserPoolId: string | { Ref: string }
    Description?: string
    Precedence?: number
    RoleArn?: string
  }
}

export interface CognitoUserPoolResourceServer extends CloudFormationResource {
  Type: 'AWS::Cognito::UserPoolResourceServer'
  Properties: {
    Identifier: string
    Name: string
    UserPoolId: string | { Ref: string }
    Scopes?: Array<{
      ScopeName: string
      ScopeDescription: string
    }>
  }
}

export interface CognitoUserPoolIdentityProvider extends CloudFormationResource {
  Type: 'AWS::Cognito::UserPoolIdentityProvider'
  Properties: {
    ProviderName: string
    ProviderType: 'SAML' | 'Facebook' | 'Google' | 'LoginWithAmazon' | 'SignInWithApple' | 'OIDC'
    UserPoolId: string | { Ref: string }
    AttributeMapping?: Record<string, string>
    ProviderDetails?: Record<string, string>
    IdpIdentifiers?: string[]
  }
}
